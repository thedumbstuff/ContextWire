//! One pseudo-console (Windows ConPTY via portable-pty) per Claude session.
//!
//! Output is delivered through a callback in raw byte chunks; the Tauri layer
//! forwards them to the web UI as base64 so multi-byte UTF-8 sequences split
//! across reads survive intact (xterm.js reassembles them).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Per-session markers that make a nested `claude` think it is a child of
/// another Claude Code session (e.g. when ContextWire itself was launched
/// from one - then the child even stops saving its transcript). They must
/// not leak into the consoles we host. User config such as
/// CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is deliberately kept.
const STRIP_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

pub type OutputFn = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;
pub type ExitFn = Arc<dyn Fn(&str, Option<u32>) + Send + Sync>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

pub struct SpawnSpec<'a> {
    pub id: &'a str,
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    pub cols: u16,
    pub rows: u16,
}

impl PtyManager {
    pub fn spawn(&self, spec: SpawnSpec, on_output: OutputFn, on_exit: ExitFn) -> Result<(), String> {
        if self.sessions.lock().unwrap().contains_key(spec.id) {
            return Err(format!("session {} is already running", spec.id));
        }
        if !spec.cwd.is_dir() {
            return Err(format!("folder does not exist: {}", spec.cwd.display()));
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows: spec.rows.max(2), cols: spec.cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {e}"))?;

        let mut cmd = CommandBuilder::new(spec.program);
        cmd.args(spec.args);
        cmd.cwd(spec.cwd);
        for k in STRIP_ENV {
            cmd.env_remove(k);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in spec.env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn {}: {e}", spec.program.display()))?;
        drop(pair.slave); // the child owns the slave end now
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;
        let killer = child.clone_killer();

        let id = spec.id.to_string();
        self.sessions.lock().unwrap().insert(id.clone(), Session { master: pair.master, writer, killer });

        // reader: forward output until the pseudo console closes
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let rid = id.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => on_output(&rid, &buf[..n]),
                    }
                }
                let _ = done_tx.send(());
            })
            .map_err(|e| format!("thread: {e}"))?;

        // waiter: ConPTY keeps the output pipe open after the process exits
        // until the pseudo console itself is closed, so wait on the process,
        // then drop the master (closing the console), let the reader drain,
        // and only then report the exit.
        let sessions = self.sessions.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|st| st.exit_code());
                drop(sessions.lock().unwrap().remove(&id));
                let _ = done_rx.recv_timeout(std::time::Duration::from_secs(3));
                on_exit(&id, code);
            })
            .map_err(|e| format!("thread: {e}"))?;
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or_else(|| format!("no session {id}"))?;
        s.writer.write_all(data).and_then(|_| s.writer.flush()).map_err(|e| format!("write: {e}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id).ok_or_else(|| format!("no session {id}"))?;
        s.master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize: {e}"))
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        match map.get_mut(id) {
            Some(s) => s.killer.kill().map_err(|e| format!("kill: {e}")),
            None => Ok(()),
        }
    }

    pub fn kill_all(&self) {
        for s in self.sessions.lock().unwrap().values_mut() {
            let _ = s.killer.kill();
        }
    }

    pub fn running(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_echo_and_exit() {
        let mgr = PtyManager::default();
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let (tx, rx) = mpsc::channel();
        let o = out.clone();
        let cmd = which::which("cmd").expect("cmd.exe");
        let args = vec!["/c".to_string(), "echo contextwire-pty-ok".to_string()];
        let cwd = std::env::temp_dir();
        mgr.spawn(
            SpawnSpec { id: "t1", program: &cmd, args: &args, cwd: &cwd, env: &[], cols: 80, rows: 24 },
            Arc::new(move |_, b| o.lock().unwrap().extend_from_slice(b)),
            Arc::new(move |id, code| tx.send((id.to_string(), code)).unwrap()),
        )
        .unwrap();
        // ConPTY asks the terminal for the cursor position (ESC[6n) and waits
        // for the reply before running the program; xterm.js answers this in
        // the app, so the test plays terminal here.
        let t = std::time::Instant::now();
        while !String::from_utf8_lossy(&out.lock().unwrap()).contains("[6n") {
            assert!(t.elapsed() < Duration::from_secs(10), "no cursor query");
            std::thread::sleep(Duration::from_millis(20));
        }
        mgr.write("t1", b"[1;1R").unwrap();
        let (id, code) = rx.recv_timeout(Duration::from_secs(20)).expect("exit event");
        assert_eq!(id, "t1");
        assert_eq!(code, Some(0));
        let text = String::from_utf8_lossy(&out.lock().unwrap()).to_string();
        assert!(text.contains("contextwire-pty-ok"), "output was {text:?}");
        assert!(mgr.running().is_empty());
    }

    #[test]
    fn spawn_rejects_missing_folder() {
        let mgr = PtyManager::default();
        let cmd = which::which("cmd").unwrap();
        let err = mgr
            .spawn(
                SpawnSpec { id: "t2", program: &cmd, args: &[], cwd: Path::new("Z:/definitely/not/here"), env: &[], cols: 80, rows: 24 },
                Arc::new(|_, _| {}),
                Arc::new(|_, _| {}),
            )
            .unwrap_err();
        assert!(err.contains("does not exist"));
    }
}
