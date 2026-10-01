# Changelog

## 2026-10-01

- Project started. Researched the official Claude desktop app; it cannot link to
  running terminal consoles, so ContextWire is built (decisions D1-D4 in roadmap.yaml).
- Installed Rust (rustup stable, cargo 1.98.1); scaffolded Tauri 2 + vanilla-ts.
- Watchtower adapted from statarb: Build tab + new Features tab (feature backlog
  incl. 23 features captured from code.claude.com/docs/en/desktop). Lints
  unknown feature keys (unquoted commas in YAML flow maps) and flags features
  declared shipped whose task is not verified.
- Rust core: ConPTY session manager (handles the ConPTY cursor-query handshake
  and the "pipe stays open after exit" quirk), localhost hook server with token,
  `contextwire.exe --hook` client (51 ms round trip, always exit 0), per-session
  `--settings` hooks, opt-in global hooks with backup, transcript scanner,
  project-folder name decoder, tray, single instance, autostart (release only).
- UI: chat-style sidebar grouped by workspace, live xterm consoles, status
  machine (ready/working/needs you/done/ended), unread badges, red needs-you
  rows, toasts + taskbar flash, History (resume any past session), Settings.
- Verified live with claude 2.1.286: new session, folder-trust prompt, real
  turn -> done + unread while unfocused, needs-you, focus clears unread,
  restart -> `--resume` restores the conversation, toasts in the Windows
  notification DB.
- Fixes found while testing: Enter in dialogs hit Cancel; nested-session env
  markers (CLAUDE_CODE_CHILD_SESSION etc.) disabled transcript saving; UI reload
  orphaned live consoles; stale activity line after restart; settings overflow.
- Watchtower: adds ~/.cargo/bin to PATH for checks (it reported cargo checks as
  CLAIMED when started from a pre-rustup shell).
