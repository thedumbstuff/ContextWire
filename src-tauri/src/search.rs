//! Full-text search across Claude transcripts (`~/.claude/projects/*/*.jsonl`).
//!
//! Lines are filtered with a cheap lowercase `contains` before any JSON is
//! parsed, so even large transcript folders search in a second or two.
//! Results are shown in the UI only - never logged.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::workspaces;

const HITS_PER_SESSION: usize = 3;
const SNIPPET: usize = 70; // chars of context on each side

#[derive(Serialize, Clone, Debug)]
pub struct Hit {
    pub role: String,
    pub snippet: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionHits {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub modified_ms: u64,
    pub hits: Vec<Hit>,
    pub total: usize,
}

fn text_of(rec: &Value) -> Option<(String, String)> {
    let role = rec["type"].as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let text = match &rec["message"]["content"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let t = text.trim();
    // skip tool results and injected system text
    if t.is_empty() || t.starts_with('<') {
        return None;
    }
    Some((role.to_string(), t.to_string()))
}

/// Snippet around the first match; `q` is already lowercase.
pub fn snippet(text: &str, q: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    let qc: Vec<char> = q.chars().collect();
    if qc.is_empty() || lower.len() != chars.len() {
        // lowercasing changed the length (rare scripts): fall back to a plain find
        return text.to_lowercase().contains(q).then(|| text.chars().take(2 * SNIPPET).collect());
    }
    let pos = lower.windows(qc.len()).position(|w| w == qc.as_slice())?;
    let start = pos.saturating_sub(SNIPPET);
    let end = (pos + qc.len() + SNIPPET).min(chars.len());
    let mut s: String = chars[start..end].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    Some(s)
}

fn search_file(path: &Path, q: &str) -> Option<SessionHits> {
    let f = File::open(path).ok()?;
    let mut hits = Vec::new();
    let mut total = 0;
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if !line.to_lowercase().contains(q) {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(&line) else { continue };
        let Some((role, text)) = text_of(&rec) else { continue };
        if let Some(sn) = snippet(&text, q) {
            total += 1;
            if hits.len() < HITS_PER_SESSION {
                hits.push(Hit { role, snippet: sn });
            }
        }
    }
    if total == 0 {
        return None;
    }
    let meta = workspaces::read_session(path);
    let modified_ms = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(SessionHits {
        id: path.file_stem()?.to_string_lossy().into_owned(),
        cwd: meta.as_ref().map_or_else(String::new, |m| m.cwd.clone()),
        title: meta.map_or_else(String::new, |m| m.title),
        modified_ms,
        hits,
        total,
    })
}

/// Sessions whose transcript mentions `query`, newest first.
pub fn search(root: &Path, query: &str, limit: usize) -> Vec<SessionHits> {
    let q = query.trim().to_lowercase();
    if q.chars().count() < 2 {
        return vec![];
    }
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for e in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().map_or(false, |x| x == "jsonl") {
                let m = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok());
                files.push((m.map_or(0, |d| d.as_millis() as u64), p));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.iter().filter_map(|(_, p)| search_file(p, &q)).take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_matches_with_snippets_and_skips_tool_noise() {
        let root = std::env::temp_dir().join(format!("cw-search-{}", uuid::Uuid::new_v4().simple()));
        let proj = root.join("C--demo");
        std::fs::create_dir_all(&proj).unwrap();
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"How do I set up the Cloudflare redirect rule?"},"cwd":"C:\\demo"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Add a cloudflare Redirect Rule from www to the apex."}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"cloudflare in tool output"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Cloudflare setup"}"#,
        ];
        std::fs::write(proj.join("aaaa.jsonl"), lines.join("\n")).unwrap();
        std::fs::write(proj.join("bbbb.jsonl"), r#"{"type":"user","message":{"content":"nothing here"},"cwd":"C:\\x"}"#).unwrap();

        let r = search(&root, "CloudFlare", 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "aaaa");
        assert_eq!(r[0].total, 2, "tool output and titles are not counted");
        assert_eq!(r[0].title, "Cloudflare setup");
        assert_eq!(r[0].cwd, r"C:\demo");
        assert_eq!(r[0].hits[1].role, "assistant");
        assert!(search(&root, "x", 10).is_empty(), "one-char queries are ignored");
    }

    #[test]
    fn snippet_window() {
        let long = format!("{}needle{}", "a ".repeat(100), " b".repeat(100));
        let s = snippet(&long, "needle").unwrap();
        assert!(s.starts_with('…') && s.ends_with('…') && s.contains("needle"));
        assert!(s.chars().count() < 2 * SNIPPET + 20);
        assert_eq!(snippet("short Needle", "needle").unwrap(), "short Needle");
    }
}
