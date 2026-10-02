# Architecture

ContextWire is a Tauri 2 app: a Rust backend that owns processes, files and the hook
server, and a vanilla TypeScript UI with xterm.js. It never scrapes the terminal - status
arrives through Claude Code hooks.

```mermaid
flowchart LR
  subgraph app["ContextWire.exe (Tauri 2)"]
    direction LR
    subgraph ui["UI - TypeScript"]
      U1["Console (xterm.js)<br/>one per session"]
      U2["Sidebar + status<br/>status.ts state machine"]
      U3["Jobs + report view<br/>markdown tables, charts"]
      U4["Git panel + Git view<br/>log graph, diff, actions"]
      U5["All Sessions + Search<br/>past sessions, full text"]
    end
    subgraph rs["Rust backend"]
      R1["pty.rs<br/>one ConPTY per session"]
      R2["hookserver.rs<br/>127.0.0.1 + per-install token"]
      R3["jobs.rs + cron.rs<br/>cron, DPAPI secrets, run log"]
      R4["gitops.rs + gitlog.rs<br/>fetch, pull (ff), push, reword"]
      R5["workspaces.rs, search.rs<br/>sessions + transcript search"]
    end
  end
  subgraph ext["Outside the app"]
    E1["claude CLI<br/>real CLI in a ConPTY"]
    E2["Hook client<br/>contextwire.exe --hook"]
    E3["claude -p (job run)<br/>only the granted tools"]
    E4["git CLI<br/>your config, credentials"]
    E5["~/.claude/projects<br/>session transcripts"]
  end
  U1 <--> R1 --> E1
  E1 -- fires hooks --> E2 --> R2 --> U2
  U3 <--> R3 --> E3
  U4 <--> R4 --> E4
  U5 <--> R5
  E5 --> R5
```

Double arrows are Tauri commands and events between the UI and the backend. The status
path: `claude` fires a hook, the hook client posts it to the local hook server, and the
UI's status machine updates the row.

## How a session starts

Each console runs `claude --session-id <uuid> --settings session-hooks.json` (or
`--resume <uuid>`) in the chosen folder. The hooks file registers
`contextwire.exe --hook` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Notification`, `Stop` and `SessionEnd`, so nothing in your global Claude
settings changes.

The hook client forwards the event to the app over localhost and always exits `0` within
about half a second, so it can never block or break Claude - even when ContextWire is not
running.

## Modules

| Path | What |
| --- | --- |
| `src-tauri/src/pty.rs` | ConPTY session manager (spawn, write, resize, kill, exit) |
| `src-tauri/src/hookserver.rs`, `hook.rs` | Localhost hook endpoint and the `--hook` client |
| `src-tauri/src/claudecfg.rs` | Per-session hooks file; opt-in global hooks with backup |
| `src-tauri/src/workspaces.rs`, `search.rs` | Past sessions and workspace folders from `~/.claude/projects`; transcript search |
| `src-tauri/src/jobs.rs`, `cron.rs`, `secrets.rs` | Scheduled jobs: store, scheduler, runner; cron parser; DPAPI seal/open |
| `src-tauri/src/gitops.rs`, `gitlog.rs` | Git panel actions; Git view log, branches, files, diffs |
| `src-tauri/src/roadmaps.rs` | Finds and summarises `roadmap.yaml` files |
| `src-tauri/src/toast.rs` | Windows toasts that open the session on click |
| `src-tauri/src/applog.rs` | Rotating log file |
| `src-tauri/src/lib.rs` | Tauri commands, tray, single instance, autostart |
| `src/status.ts` | Pure status machine (hook event -> status / unread / notify) |
| `src/sidebar.ts`, `terminal.ts`, `rail.ts`, `main.ts` | Sidebar, xterm per session, tool-window rail, app state |
| `src/panels/` | Activity, Git, Roadmaps, Search panels |
| `src/gitview/` | The PyCharm-style Git view |
| `src/jobs/` | Jobs panel + editor, report view, markdown/chart renderer |
