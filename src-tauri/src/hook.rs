//! Hook client: `ContextWire.exe --hook`.
//!
//! Claude Code runs this for each registered hook event and pipes the event
//! JSON on stdin. We forward it to the running app and exit 0 immediately.
//! This must NEVER block or fail Claude: tight timeouts, no output, exit 0
//! even when the app is not running.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde_json::Value;

use crate::hookserver::{self, Endpoint, TOKEN_HEADER};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const IO_TIMEOUT: Duration = Duration::from_millis(700);
const MAX_STDIN: u64 = 2 * 1024 * 1024;

pub fn run_client() -> i32 {
    let mut raw = String::new();
    let _ = std::io::stdin().take(MAX_STDIN).read_to_string(&mut raw);
    let mut payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    if let (Some(obj), Ok(tab)) = (payload.as_object_mut(), std::env::var("CONTEXTWIRE_TAB")) {
        obj.insert("cw_tab".into(), Value::String(tab));
    }
    if let Some(ep) = hookserver::read_endpoint(&hookserver::endpoint_file()) {
        let _ = post(&ep, &payload);
    }
    0
}

/// POST the payload to the app. Returns the HTTP status code.
pub fn post(ep: &Endpoint, payload: &Value) -> std::io::Result<u16> {
    let body = serde_json::to_vec(payload)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], ep.port));
    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    s.set_write_timeout(Some(IO_TIMEOUT))?;
    s.set_read_timeout(Some(IO_TIMEOUT))?;
    let head = format!(
        "POST /hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n{TOKEN_HEADER}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        ep.token,
        body.len()
    );
    s.write_all(head.as_bytes())?;
    s.write_all(&body)?;
    let mut resp = [0u8; 64];
    let n = s.read(&mut resp)?;
    let line = String::from_utf8_lossy(&resp[..n]);
    Ok(line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn hook_round_trip_and_token_check() {
        let file = std::env::temp_dir().join(format!("cw-endpoint-{}.json", uuid::Uuid::new_v4()));
        let (tx, rx) = mpsc::channel();
        let ep = hookserver::start(&file, move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(hookserver::read_endpoint(&file), Some(ep.clone()));

        let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "abc"});
        assert_eq!(post(&ep, &payload).unwrap(), 204);
        let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(got["hook_event_name"], "Stop");
        assert_eq!(got["session_id"], "abc");

        let wrong = Endpoint { token: "nope".into(), ..ep.clone() };
        assert_eq!(post(&wrong, &payload).unwrap(), 403);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "unauthenticated event leaked");
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn post_fails_fast_when_app_is_not_running() {
        // grab a free port, then close it so nothing listens there
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let ep = Endpoint { port, token: "t".into(), pid: 0 };
        let t = std::time::Instant::now();
        // another test's server may grab the freed port; it must still refuse us
        assert!(!matches!(post(&ep, &serde_json::json!({})), Ok(204)));
        assert!(t.elapsed() < Duration::from_secs(2));
    }
}
