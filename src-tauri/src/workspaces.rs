//! Past Claude sessions, read from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
//!
//! Each transcript line is a JSON record; the first user record carries `cwd`
//! and the first prompt, and `ai-title` / `custom-title` records carry the
//! title. Transcripts can be tens of MB, so only the head and tail are read.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

const HEAD_BYTES: u64 = 128 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;

#[derive(Serialize, Clone, Debug, Default)]
pub struct PastSession {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub first_prompt: String,
    pub modified_ms: u64,
    pub size: u64,
}

pub fn projects_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude").join("projects")
}

fn read_range(f: &mut File, start: u64, len: u64) -> String {
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_ok() {
        let _ = f.take(len).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn prompt_text(rec: &Value) -> Option<String> {
    let c = &rec["message"]["content"];
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().find_map(|b| (b["type"] == "text").then(|| b["text"].as_str().unwrap_or("").to_string()))?,
        _ => return None,
    };
    let t = text.trim();
    // skip command wrappers / system reminders
    if t.is_empty() || t.starts_with('<') {
        return None;
    }
    Some(t.chars().take(160).collect())
}

/// First line of the last assistant text in a transcript (reads only the tail).
/// Used for the "claude: ..." activity line when a turn finishes.
pub fn last_reply(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let tail = read_range(&mut f, size.saturating_sub(TAIL_BYTES), TAIL_BYTES);
    tail.lines().rev().find_map(|line| {
        let rec: Value = serde_json::from_str(line).ok()?;
        if rec["type"] != "assistant" {
            return None;
        }
        let text = rec["message"]["content"].as_array()?.iter().rev().find_map(|b| (b["type"] == "text").then(|| b["text"].as_str().unwrap_or("")))?;
        let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
        let clean: String = first.trim_start_matches(['#', '*', '-', '>', ' ']).replace("**", "").replace('`', "");
        Some(clean.chars().take(160).collect())
    })
}

/// True when `path` is a transcript inside `root` (canonicalised; no traversal).
pub fn is_transcript_in(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(r) && p.extension().map_or(false, |x| x == "jsonl"),
        _ => false,
    }
}

pub fn read_session(path: &Path) -> Option<PastSession> {
    let meta = std::fs::metadata(path).ok()?;
    let id = path.file_stem()?.to_string_lossy().to_string();
    let mut f = File::open(path).ok()?;
    let size = meta.len();
    let head = read_range(&mut f, 0, HEAD_BYTES);
    let tail = if size > HEAD_BYTES { read_range(&mut f, size.saturating_sub(TAIL_BYTES), TAIL_BYTES) } else { String::new() };

    let mut s = PastSession {
        id,
        size,
        modified_ms: meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64,
        ..Default::default()
    };
    let mut ai_title = String::new();
    let mut custom_title = String::new();
    for chunk in [&head, &tail] {
        for line in chunk.lines() {
            let Ok(rec) = serde_json::from_str::<Value>(line) else { continue }; // partial first/last line
            if s.cwd.is_empty() {
                if let Some(c) = rec["cwd"].as_str() {
                    s.cwd = c.to_string();
                }
            }
            match rec["type"].as_str() {
                Some("user") if s.first_prompt.is_empty() && rec["isMeta"] != true => {
                    if let Some(p) = prompt_text(&rec) {
                        s.first_prompt = p;
                    }
                }
                Some("ai-title") => ai_title = rec["aiTitle"].as_str().unwrap_or("").to_string(),
                Some("custom-title") => custom_title = rec["customTitle"].as_str().unwrap_or("").to_string(),
                _ => {}
            }
        }
    }
    s.title = [custom_title, ai_title, s.first_prompt.clone()].into_iter().find(|t| !t.is_empty()).unwrap_or_default();
    (!s.cwd.is_empty()).then_some(s)
}

/// Turn a project folder name back into the path it encodes. Claude replaces
/// the drive colon and path separators with dashes, so "C--Work-my-app" may be
/// C:/Work/my-app or C:/Work/my/app; resolve the ambiguity by walking the real
/// filesystem. Returns None when no existing folder matches.
pub fn decode_project_dir(name: &str) -> Option<PathBuf> {
    let (drive, rest) = name.split_once("--")?;
    if drive.len() != 1 || !drive.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let tokens: Vec<&str> = rest.split('-').collect();
    fn walk(dir: &Path, tokens: &[&str]) -> Option<PathBuf> {
        if tokens.is_empty() {
            return Some(dir.to_path_buf());
        }
        // longest component first: "playpaltoons-ABCVideo" before "playpaltoons"
        for take in (1..=tokens.len().min(6)).rev() {
            for sep in ["-", " ", "_", "."] {
                let comp = tokens[..take].join(sep);
                if comp.is_empty() {
                    continue;
                }
                let p = dir.join(&comp);
                if p.is_dir() {
                    if let Some(found) = walk(&p, &tokens[take..]) {
                        return Some(found);
                    }
                }
                if take == 1 {
                    break; // separators make no difference for one token
                }
            }
        }
        None
    }
    walk(&PathBuf::from(format!("{drive}:\\")), &tokens)
}

/// Folders Claude has been started in, from the project directory names.
pub fn project_folders(root: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    rd.flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| decode_project_dir(&e.file_name().to_string_lossy()))
        .map(|p| p.display().to_string())
        .collect()
}

/// All past sessions under `root` (normally `projects_dir()`), newest first.
pub fn scan(root: &Path, limit: usize) -> Vec<PastSession> {
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    let Ok(dirs) = std::fs::read_dir(root) else { return vec![] };
    for d in dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(d.path()) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map_or(false, |x| x == "jsonl") {
                let m = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok());
                files.push((m.map_or(0, |d| d.as_millis() as u64), p));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(limit).filter_map(|(_, p)| read_session(&p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_dash_ambiguous_folder_names() {
        let base = std::env::temp_dir().join(format!("cwdec{}", uuid::Uuid::new_v4().simple()));
        let target = base.join("Work").join("play-toons-ABC").join("src");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(base.join("Work").join("play")).unwrap(); // decoy
        let enc = target.display().to_string().replace(':', "-").replace('\\', "-");
        assert_eq!(decode_project_dir(&enc), Some(target.clone()));
        assert_eq!(decode_project_dir("C--definitely-not-a-real-folder-xyz"), None);
        assert_eq!(decode_project_dir("no-drive"), None);
    }

    #[test]
    fn last_reply_takes_the_final_assistant_text() {
        let root = std::env::temp_dir().join(format!("cw-reply-{}", uuid::Uuid::new_v4()));
        let dir = root.join("C--x");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("s.jsonl");
        let lines = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"old answer"}]}}"#,
            r#"{"type":"user","message":{"content":"next question"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"\n## **Fixed** the `login` bug\nmore detail"}]}}"#,
            r#"{"type":"system","subtype":"turn_duration"}"#,
        ];
        std::fs::write(&p, lines.join("\n")).unwrap();
        assert_eq!(last_reply(&p).as_deref(), Some("Fixed the login bug"));
        assert!(is_transcript_in(&p, &root));
        assert!(!is_transcript_in(&root.join("..").join("x.jsonl"), &root));
        assert!(!is_transcript_in(Path::new("C:/Windows/win.ini"), &root));
    }

    #[test]
    fn parses_cwd_prompt_and_title() {
        let dir = std::env::temp_dir().join(format!("cw-proj-{}", uuid::Uuid::new_v4())).join("C--x");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("11111111-2222-3333-4444-555555555555.jsonl");
        let lines = [
            r#"{"type":"mode","mode":"normal"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/model</command-name>"},"cwd":"C:\\work\\repo"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the login bug"}]},"cwd":"C:\\work\\repo"}"#,
            r#"{"type":"ai-title","aiTitle":"Login bug fix"}"#,
        ];
        std::fs::write(&p, lines.join("\n")).unwrap();
        let all = scan(dir.parent().unwrap(), 10);
        assert_eq!(all.len(), 1);
        let s = &all[0];
        assert_eq!(s.id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(s.cwd, r"C:\work\repo");
        assert_eq!(s.first_prompt, "Fix the login bug");
        assert_eq!(s.title, "Login bug fix");
    }
}
