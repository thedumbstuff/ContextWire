//! Localhost endpoint that Claude Code hooks post to (via `ContextWire.exe --hook`).
//!
//! Binds 127.0.0.1 on a random port and writes `{port, token}` to the endpoint
//! file so the hook client can find it. Requests without the token are refused.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TOKEN_HEADER: &str = "X-ContextWire-Token";
const MAX_BODY: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// `%APPDATA%\ContextWire\endpoint.json`, overridable for tests.
pub fn endpoint_file() -> PathBuf {
    if let Ok(p) = std::env::var("CONTEXTWIRE_ENDPOINT_FILE") {
        return PathBuf::from(p);
    }
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("ContextWire").join("endpoint.json")
}

pub fn read_endpoint(path: &Path) -> Option<Endpoint> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Start the server on a background thread. `on_event` gets every accepted
/// hook payload (the JSON Claude Code sent to the hook, plus `cw_tab`).
pub fn start(endpoint_path: &Path, on_event: impl Fn(Value) + Send + 'static) -> Result<Endpoint, String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no ip listen address")?;
    let ep = Endpoint { port, token: uuid::Uuid::new_v4().simple().to_string(), pid: std::process::id() };
    if let Some(dir) = endpoint_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    std::fs::write(endpoint_path, serde_json::to_vec_pretty(&ep).unwrap())
        .map_err(|e| format!("write {}: {e}", endpoint_path.display()))?;

    let token = ep.token.clone();
    std::thread::Builder::new()
        .name("hookserver".into())
        .spawn(move || {
            for mut req in server.incoming_requests() {
                let authed = req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv(TOKEN_HEADER) && h.value.as_str() == token);
                let status = if req.method() != &tiny_http::Method::Post || req.url() != "/hook" {
                    404
                } else if !authed {
                    403
                } else {
                    let mut body = String::new();
                    match req.as_reader().take(MAX_BODY).read_to_string(&mut body) {
                        Ok(_) => match serde_json::from_str::<Value>(&body) {
                            Ok(v) => {
                                on_event(v);
                                204
                            }
                            Err(_) => 400,
                        },
                        Err(_) => 400,
                    }
                };
                let _ = req.respond(tiny_http::Response::empty(status));
            }
        })
        .map_err(|e| format!("thread: {e}"))?;
    Ok(ep)
}
