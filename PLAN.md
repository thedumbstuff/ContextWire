# ContextWire - plan

**One Windows app for every Claude Code console.** A chat-app style sidebar lists
every Claude session across all workspace roots; each "chat" is a real, live
`claude` CLI console; sessions that finish or need you get highlighted, badged
and announced with a Windows toast + taskbar flash - like an unread chat.

Started 2026-10-01. Build status lives in `roadmap.yaml` (single source of
truth) and is shown by the watchtower dashboard: `python watchtower/server.py`
-> http://127.0.0.1:8766 (Build tab = tasks; Features tab = feature backlog,
including features noted from the official Claude desktop app for later).

## Why not the official Claude desktop app?

Researched 2026-10-01 (code.claude.com/docs/en/desktop). It has a multi-session
sidebar and finish notifications, but it does **not** link to a running
terminal console: `/desktop` hands a session over and exits the CLI, the two
keep separate session lists, and its terminal pane is a plain shell. Its
features are recorded in roadmap.yaml `features` (source: official) as an
upgrade backlog.

## Architecture

```
 ContextWire.exe (Tauri 2)
 ├─ Rust core (src-tauri/src)
 │   ├─ pty.rs         one ConPTY per session (portable-pty), runs `claude`
 │   │                 output -> "pty-output" events (base64), exit -> "pty-exit"
 │   ├─ hookserver.rs  127.0.0.1:<port> POST /hook (token) -> "hook-event"
 │   ├─ hook.rs        `ContextWire.exe --hook`: Claude hook client (stdin JSON -> POST)
 │   ├─ claudecfg.rs   per-session --settings JSON, opt-in global hooks install
 │   ├─ workspaces.rs  roots + past sessions from ~/.claude/projects/*/*.jsonl
 │   └─ lib.rs         tray, single instance, autostart, notifications, commands
 └─ Web UI (src, vanilla TS + xterm.js)
     ├─ sidebar.ts     workspaces -> sessions, status dots, unread, highlight
     ├─ terminal.ts    one xterm per session, fit-to-pane, kept alive when hidden
     └─ main.ts        state store, status machine, notifications
```

### How status works (decision D3)

* The app starts each session as
  `claude --session-id <uuid> --settings <hooks json>` in the chosen folder.
  The hooks JSON registers `ContextWire.exe --hook` for SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SessionEnd.
  Nothing in `~/.claude/settings.json` changes.
* The hook client reads the hook payload from stdin, adds the event name, and
  POSTs it to the app (endpoint + token in `%APPDATA%\ContextWire\endpoint.json`).
  It always exits 0 within ~0.5 s, so it can never block or break Claude,
  even when the app is closed.
* Status machine per session: UserPromptSubmit / PreToolUse / PostToolUse ->
  **working**; Notification -> **needs you** (permission prompt / waiting
  input); Stop -> **done**; SessionEnd or process exit -> **exited**.
* Optional (Settings): install the same hooks globally so sessions started in
  plain terminals also appear (as "external"); Adopt = close there, resume here.

## Not possible / known limits

* A Claude session can be attached to only one console at a time. ContextWire
  replaces terminal windows, it does not mirror them.
* If the app quits, its sessions end; they are restored with
  `claude --resume <id>` in the same folder on next start.
* Toast click-to-open needs a WinRT activation handler (roadmap P3.5).
