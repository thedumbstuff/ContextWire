//! Claude Code configuration that ContextWire generates or edits.
//!
//! * Per-session hooks file passed with `claude --settings <file>` (default;
//!   touches nothing global).
//! * Opt-in global hooks in `~/.claude/settings.json` so sessions started in
//!   plain terminals report too. Our entries are recognised by their command
//!   (`contextwire... --hook`) and removed cleanly; the rest of the file is
//!   preserved key-for-key (serde_json preserve_order).

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Hook events ContextWire listens to, and whether they take a tool matcher.
pub const EVENTS: &[(&str, bool)] = &[
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("Notification", false),
    ("Stop", false),
    ("SessionEnd", false),
];
const HOOK_TIMEOUT_S: u64 = 5;
const MARKER: &str = "contextwire";

/// The command Claude runs for each hook: this very executable in hook mode.
/// Forward slashes + quotes work in both Git Bash and cmd.exe.
pub fn hook_command(exe: &Path) -> String {
    format!("\"{}\" --hook", exe.display().to_string().replace('\\', "/"))
}

fn is_ours(entry: &Value) -> bool {
    entry["hooks"].as_array().map_or(false, |hs| {
        hs.iter().any(|h| {
            let c = h["command"].as_str().unwrap_or("").to_lowercase();
            c.contains(MARKER) && c.contains("--hook")
        })
    })
}

fn our_entry(command: &str, matcher: bool) -> Value {
    let mut e = json!({"hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT_S}]});
    if matcher {
        e["matcher"] = json!("*");
    }
    e
}

pub fn hooks_settings(command: &str) -> Value {
    let mut hooks = Map::new();
    for (ev, m) in EVENTS {
        hooks.insert((*ev).into(), json!([our_entry(command, *m)]));
    }
    json!({ "hooks": hooks })
}

/// Write the per-session settings file and return its path.
pub fn write_session_settings(dir: &Path, exe: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let p = dir.join("session-hooks.json");
    let body = serde_json::to_string_pretty(&hooks_settings(&hook_command(exe))).unwrap();
    std::fs::write(&p, body).map_err(|e| format!("write {}: {e}", p.display()))?;
    Ok(p)
}

pub fn user_settings_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude").join("settings.json")
}

fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(json!({})),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("{} is not valid JSON ({e}); not touching it", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// True when every ContextWire event has our hook in the given settings file.
pub fn global_installed(path: &Path) -> bool {
    let Ok(v) = read_settings(path) else { return false };
    EVENTS.iter().all(|(ev, _)| v["hooks"][*ev].as_array().map_or(false, |a| a.iter().any(is_ours)))
}

/// Add (enable=true) or remove (enable=false) our hooks in a settings file.
/// Writes `<file>.contextwire-backup` once, before the first change.
pub fn set_global(path: &Path, command: &str, enable: bool) -> Result<(), String> {
    let mut v = read_settings(path)?;
    if !v.is_object() {
        return Err(format!("{} is not a JSON object; not touching it", path.display()));
    }
    let root = v.as_object_mut().unwrap();
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err("\"hooks\" in settings.json is not an object; not touching it".into());
    }
    let hooks = hooks.as_object_mut().unwrap();
    for (ev, m) in EVENTS {
        let list = hooks.entry((*ev).to_string()).or_insert_with(|| json!([]));
        let Some(arr) = list.as_array_mut() else { continue };
        arr.retain(|e| !is_ours(e));
        if enable {
            arr.push(our_entry(command, *m));
        }
    }
    hooks.retain(|_, l| l.as_array().map_or(true, |a| !a.is_empty()));
    if hooks.is_empty() {
        root.remove("hooks");
    }

    if path.exists() {
        let backup = PathBuf::from(format!("{}.contextwire-backup", path.display()));
        if !backup.exists() {
            std::fs::copy(path, &backup).map_err(|e| format!("backup: {e}"))?;
        }
    } else if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.contextwire-tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap() + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str, body: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cw-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn install_and_remove_preserve_user_settings() {
        let original = r#"{
  "model": "opus",
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "my-own-script.sh" } ] } ]
  },
  "effortLevel": "xhigh"
}"#;
        let p = tmp_file("settings.json", original);
        let cmd = hook_command(Path::new(r"C:\Apps\ContextWire\contextwire.exe"));
        assert_eq!(cmd, "\"C:/Apps/ContextWire/contextwire.exe\" --hook");
        assert!(!global_installed(&p));

        set_global(&p, &cmd, true).unwrap();
        assert!(global_installed(&p));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2, "user's own Stop hook kept");
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], "*");
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["model", "hooks", "effortLevel"], "key order preserved");

        set_global(&p, &cmd, true).unwrap(); // idempotent
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);

        set_global(&p, &cmd, false).unwrap();
        assert!(!global_installed(&p));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["hooks"].as_object().unwrap().len(), 1, "only the user's Stop remains");
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "my-own-script.sh");
        let backup = std::fs::read_to_string(format!("{}.contextwire-backup", p.display())).unwrap();
        assert_eq!(backup, original);
    }

    #[test]
    fn refuses_invalid_json() {
        let p = tmp_file("settings.json", "{ not json");
        assert!(set_global(&p, "x --hook", true).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ not json");
    }

    #[test]
    fn session_settings_cover_all_events() {
        let v = hooks_settings("\"c:/x/contextwire.exe\" --hook");
        for (ev, _) in EVENTS {
            assert!(is_ours(&v["hooks"][*ev][0]), "{ev}");
        }
    }
}
