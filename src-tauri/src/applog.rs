//! Small rotating log file: `%APPDATA%\ContextWire\logs\contextwire.log`.
//!
//! Records what is needed to trace a problem after the fact - hook events
//! received, consoles started/exited, spawn failures, UI errors and status
//! changes - never conversation text. Rotates at 1 MB, keeping one old file.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 1024 * 1024;

static LOG: Mutex<Option<Logger>> = Mutex::new(None);

struct Logger {
    path: PathBuf,
    file: File,
    size: u64,
}

pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("contextwire.log")
}

pub fn init(data_dir: &Path) -> Result<PathBuf, String> {
    let path = log_path(data_dir);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    *LOG.lock().unwrap() = Some(Logger { path: path.clone(), file, size });
    Ok(path)
}

/// UTC timestamp `YYYY-MM-DD HH:MM:SS.mmm` without pulling in a date crate.
fn timestamp() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs(), d.subsec_millis());
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // civil-from-days (Howard Hinnant)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn write(level: &str, msg: &str) {
    let line = format!("{} {:<5} {}\n", timestamp(), level, msg.replace('\n', " | "));
    if cfg!(debug_assertions) {
        eprint!("{line}");
    }
    let mut guard = LOG.lock().unwrap();
    let Some(l) = guard.as_mut() else { return };
    if l.size + line.len() as u64 > MAX_BYTES {
        let old = l.path.with_extension("log.1");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(&l.path, &old);
        if let Ok(f) = OpenOptions::new().create(true).append(true).open(&l.path) {
            l.file = f;
            l.size = 0;
        }
    }
    if l.file.write_all(line.as_bytes()).is_ok() {
        l.size += line.len() as u64;
    }
}

/// Last `n` lines (old file first if the current one is short).
pub fn tail(n: usize) -> Vec<String> {
    let path = match LOG.lock().unwrap().as_ref() {
        Some(l) => l.path.clone(),
        None => return vec![],
    };
    let read = |p: &Path| -> Vec<String> {
        File::open(p).map(|f| BufReader::new(f).lines().map_while(Result::ok).collect()).unwrap_or_default()
    };
    let mut lines = read(&path);
    if lines.len() < n {
        let mut old = read(&path.with_extension("log.1"));
        old.extend(lines);
        lines = old;
    }
    let skip = lines.len().saturating_sub(n);
    lines.split_off(skip)
}

#[macro_export]
macro_rules! info {
    ($($t:tt)*) => { $crate::applog::write("INFO", &format!($($t)*)) };
}
#[macro_export]
macro_rules! warn {
    ($($t:tt)*) => { $crate::applog::write("WARN", &format!($($t)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_rotates_and_tails() {
        let dir = std::env::temp_dir().join(format!("cw-log-{}", uuid::Uuid::new_v4().simple()));
        let p = init(&dir).unwrap();
        write("INFO", "first line\nwith newline");
        let t = tail(5);
        assert_eq!(t.len(), 1);
        assert!(t[0].contains("INFO  first line | with newline"), "{t:?}");
        assert_eq!(&t[0][4..5], "-"); // YYYY-...
        let big = "x".repeat(4096);
        for _ in 0..300 {
            write("INFO", &big); // > 1 MB in total
        }
        assert!(p.with_extension("log.1").exists(), "rotated");
        assert!(std::fs::metadata(&p).unwrap().len() <= MAX_BYTES);
        assert_eq!(tail(50).len(), 50);
    }

    #[test]
    fn timestamp_shape() {
        let t = timestamp();
        assert_eq!(t.len(), 24, "{t}");
        assert!(t.starts_with("20") && t.ends_with('Z'));
    }
}
