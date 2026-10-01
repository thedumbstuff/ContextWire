# ContextWire

Windows desktop app (Tauri 2 + Rust + vanilla TS + xterm.js) that hosts every
Claude Code console in one chat-style window with status highlights and
notifications. Read `PLAN.md` first.

## Rules

- `roadmap.yaml` is the single source of truth for build status. Update task
  statuses (and the `features` backlog) with every change, and add an entry to
  `docs/changelog.md`. Never mark a task done without a passing check.
- Watchtower: `python watchtower/server.py` -> http://127.0.0.1:8766
  (`--once` terminal summary, `--once --features` feature backlog).
  Tests: `python -m unittest discover -s watchtower/tests -q`.
- Quote YAML values containing commas or ": " inside `{flow: mappings}`
  (the watchtower lints unknown keys for exactly this mistake).
- Features seen in the official Claude desktop app go in `features` with
  `source: official` - that list is the upgrade backlog.

## Build / run

```powershell
npm install
npm run tauri dev          # dev app with hot reload
npm run tauri build        # release exe + NSIS installer
cargo test --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
```

Rust is installed per-user via rustup (`%USERPROFILE%\.cargo\bin`); open a new
shell if `cargo` is not on PATH.

## Troubleshooting a reported issue

1. Ask the owner for Settings > Troubleshooting > Copy diagnostics, or read
   `%APPDATA%\ContextWire\logs\contextwire.log` directly (hook events, status
   changes, spawn/exit, UI errors - one line each, UTC).
2. `%APPDATA%\ContextWire\state.json` = what the sidebar believes;
   `~/.claude/projects/*/<id>.jsonl` = what Claude actually did.
3. `python watchtower/checks/installed_current.py` - is the installed app the
   latest source? Never rebuild/reinstall while the owner has consoles open
   (reinstall kills them); check for child processes of contextwire.exe first.

## Gotchas

- Reinstalling: stop the installed contextwire.exe and wait until the process is
  really gone before running the NSIS setup with /S - otherwise it exits 2
  (file in use) and the old version keeps running.

- The hook client must never block Claude: short connect/read timeouts and
  always exit 0.
- Global hooks are opt-in only; they edit `~/.claude/settings.json` (backup
  written next to it as `settings.json.contextwire-backup`).
