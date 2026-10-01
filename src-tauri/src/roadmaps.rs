//! Roadmaps panel: a roll-up of every `roadmap.yaml` (watchtower pattern) found
//! in the repos under the workspaces.
//!
//! Progress here is computed from the *declared* task statuses only - the
//! automated checks are the watchtower's job; the panel offers to open it.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_yaml::Value;

#[derive(Serialize, Clone, Debug, Default)]
pub struct NextTask {
    pub id: String,
    pub title: String,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Roadmap {
    pub repo: String,
    pub project: String,
    pub tagline: String,
    pub updated: String,
    pub tasks: u32,
    pub effort_total: u32,
    pub effort_done: u32,
    pub effort_in_progress: u32,
    pub pct_done: f32,
    pub in_progress: Vec<NextTask>,
    pub blocked: u32,
    pub next_up: Vec<NextTask>,
    pub open_decisions: Vec<NextTask>,
    pub watchtower_port: Option<u16>,
    pub error: Option<String>,
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `--port` default declared in watchtower/server.py, if the repo has one.
fn watchtower_port(repo: &Path) -> Option<u16> {
    let src = std::fs::read_to_string(repo.join("watchtower").join("server.py")).ok()?;
    let line = src.lines().find(|l| l.contains("\"--port\"") && l.contains("default="))?;
    let rest = &line[line.find("default=")? + 8..];
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

pub fn read(repo: &Path) -> Option<Roadmap> {
    let path = repo.join("roadmap.yaml");
    let text = std::fs::read_to_string(&path).ok()?;
    let mut r = Roadmap {
        repo: repo.display().to_string(),
        project: repo.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        watchtower_port: watchtower_port(repo),
        ..Default::default()
    };
    let doc: Value = match serde_yaml::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            r.error = Some(format!("roadmap.yaml does not parse: {e}"));
            return Some(r);
        }
    };
    if !s(&doc, "project").is_empty() {
        r.project = s(&doc, "project");
    }
    r.tagline = s(&doc, "tagline");
    r.updated = s(&doc, "updated");

    let tasks: Vec<&Value> = doc["phases"]
        .as_sequence()
        .map(|ps| ps.iter().flat_map(|p| p["tasks"].as_sequence().into_iter().flatten()).collect())
        .unwrap_or_default();
    let status_of = |id: &str| tasks.iter().find(|t| s(t, "id") == id).map(|t| s(t, "status"));
    for t in &tasks {
        let effort = t["effort"].as_u64().unwrap_or(1) as u32;
        r.tasks += 1;
        r.effort_total += effort;
        let item = NextTask { id: s(t, "id"), title: s(t, "title") };
        match s(t, "status").as_str() {
            "done" => r.effort_done += effort,
            "in_progress" => {
                r.effort_in_progress += effort;
                r.in_progress.push(item);
            }
            "blocked" => r.blocked += 1,
            _ => {
                let deps_done = t["depends_on"].as_sequence().map_or(true, |ds| {
                    ds.iter().all(|d| {
                        let id = match d {
                            Value::String(x) => x.clone(),
                            other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
                        };
                        status_of(&id).as_deref() == Some("done")
                    })
                });
                if deps_done {
                    r.next_up.push(item);
                } else {
                    r.blocked += 1;
                }
            }
        }
    }
    r.pct_done = if r.effort_total > 0 { (1000.0 * r.effort_done as f32 / r.effort_total as f32).round() / 10.0 } else { 0.0 };
    r.next_up.truncate(3);
    for d in doc["open_decisions"].as_sequence().into_iter().flatten() {
        let st = s(d, "status");
        if st.is_empty() || st == "open" {
            r.open_decisions.push(NextTask { id: s(d, "id"), title: s(d, "title") });
        }
    }
    Some(r)
}

pub fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(250)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolls_up_declared_progress() {
        let d = std::env::temp_dir().join(format!("cw-rm-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(d.join("watchtower")).unwrap();
        std::fs::write(d.join("watchtower/server.py"), "    ap.add_argument(\"--port\", type=int, default=8799)\n").unwrap();
        std::fs::write(
            d.join("roadmap.yaml"),
            r#"
project: demo
tagline: a demo
open_decisions:
  - {id: D1, title: pick a broker, status: open}
  - {id: D2, title: done deal, status: resolved}
phases:
  - id: P1
    tasks:
      - {id: P1.1, title: base, status: done, effort: 3}
      - {id: P1.2, title: wip, status: in_progress, effort: 2}
      - {id: P1.3, title: ready one, status: pending, effort: 1, depends_on: [P1.1]}
      - {id: P1.4, title: waits, status: pending, effort: 2, depends_on: [P1.2]}
      - {id: P1.5, title: human, status: blocked, effort: 2}
"#,
        )
        .unwrap();
        let r = read(&d).unwrap();
        assert_eq!(r.project, "demo");
        assert_eq!((r.tasks, r.effort_total, r.effort_done, r.effort_in_progress), (5, 10, 3, 2));
        assert_eq!(r.pct_done, 30.0);
        assert_eq!(r.next_up.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["P1.3"]);
        assert_eq!(r.blocked, 2);
        assert_eq!(r.open_decisions.len(), 1);
        assert_eq!(r.watchtower_port, Some(8799));
    }

    #[test]
    fn bad_yaml_is_reported_not_fatal() {
        let d = std::env::temp_dir().join(format!("cw-rm-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("roadmap.yaml"), "phases: [unclosed").unwrap();
        assert!(read(&d).unwrap().error.unwrap().contains("does not parse"));
        assert!(read(&d.join("missing")).is_none());
    }
}
