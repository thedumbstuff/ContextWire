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
- Sidebar now lists every workspace (even empty ones) with its earlier
  sessions from ~/.claude/projects - like `claude --resume` for all workspaces
  at once: 3 newest shown, "Show N more", one click resumes in the right folder,
  "+" on a workspace header starts a new session there. Sessions whose
  transcript changed in the last 5 minutes are tagged "active" and open paused
  with "Adopt here" so a session still running in a terminal is never resumed
  twice. Verified in the installed build.
- v0.1.1 - troubleshooting: rotating log at %APPDATA%\ContextWire\logs\contextwire.log
  (1 MB, one old file kept) records app start, hook endpoint, every hook event
  (event, session, folder, tool/notification - never prompts), status changes,
  console spawn args/exit codes and UI errors. Settings > Troubleshooting has
  Copy diagnostics (facts + last 200 log lines + status/folder-only session
  summary) and Open logs folder. Watchtower check `installed_current.py`
  flags an installed app older than the source.
- Fixed: the "may be open in a terminal" pause stuck to a session forever; it
  is now re-checked on every open (5-minute rule, or SessionEnd when global
  hooks are on).
- Open-source readiness: README rewritten (why, features, install from source,
  usage, architecture, privacy, limitations, development), MIT LICENSE,
  CONTRIBUTING (ground rules: never block Claude, never log conversation text,
  opt-in only for global config), CODE_OF_CONDUCT (Contributor Covenant 2.1),
  SECURITY (threat model of the hook endpoint), GitHub CI on windows-latest,
  issue/PR templates, .gitattributes/.editorconfig, scrubbed screenshots.
  Publishing (repo, CI run, release) waits on decision D5.
- PyCharm-style tool windows (P7, in testing): icon rail with Active, All
  Sessions (workspace -> repo -> sessions), Git (repos newest-first with toggle,
  commits, fetch / ff-only pull / push with confirm / edit an unpushed HEAD
  message), Roadmaps (roll-up of every roadmap.yaml, opens its watchtower),
  Activity (persisted timeline) and Search (full text across transcripts).
  Collapsible + resizable panel, Alt+1..6, Ctrl+Shift+F. Dev builds now use
  %APPDATA%\ContextWire-dev and their own identity (`npm run dev:app`).
- Fixed: with the panel hidden the console slid into the empty panel column.
- v0.2.0 installed (2026-10-01): tool-window rail + six panels, Edit on every
  unpushed commit. Before this the installed app was still 0.1.1, so after a
  reboot it showed the old single sidebar.
- UI audit fixes (2026-10-01, every panel + dialog at 1320x840 and 900x600):
  "active" earlier-session rows were squashed into a green blob (CSS class
  clash with the git panel's live dot); the panel kept its width on small
  windows and starved the console (now capped at 45% of the window); the
  session title vanished from a narrow header; empty-screen buttons wrapped;
  text arrows rendered as specks (CSS chevrons now); Roadmaps cut "in
  progress" to 3 silently ("+ N more"); Activity git icon unclear and second
  line duplicated the name; New session defaulted to the alphabetically first
  workspace (now the most recently used).
- v0.2.1 installed with the UI audit fixes.
- P5.2 shortcuts: Ctrl+1..9 / Ctrl+Tab move between sessions in Active-panel
  order; shortcut list in Settings. Repo chips use a drawn branch icon.
- P5.4 last-activity line: rows, toasts and Activity show the first line of
  Claude's reply when a turn finishes ("claude: ..."). The reply lands in the
  transcript a moment after the Stop hook, so the app polls for up to ~3 s.
  Hook-event handler errors are now logged instead of silently swallowed.
- P6.1 / P6.3 / P6.4 / P6.5 on hold at the owner's request.
