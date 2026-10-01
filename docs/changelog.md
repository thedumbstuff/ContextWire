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
- P6.2 worktree option verified live. Fixes found on the way: `claude
  --worktree` exits at once in a folder Claude has not been trusted in - the
  dialog now checks git + trust (~/.claude.json) first and explains; the app
  follows the session into its .claude/worktrees/<name> folder so resume finds
  the transcript; the worktree choice is remembered for Start; exit notice says
  Start/Resume to match the button; closing a session no longer auto-starts the
  next one; WebView autofill ("Saved info") disabled on text inputs.
- P3.5 toast click opens the session (verified on the installed build). Own
  WinRT toasts: the notification plugin cannot report clicks and the helper
  crate dropped the toast object, so the Activated event never fired; the app
  now keeps the last 20 toasts alive and declares its AppUserModelID at start.
  Toasts show as "ContextWire" with the app icon. Dev builds borrow
  PowerShell's identity (no Start-menu shortcut), so their clicks do nothing.
- Fixed: a panel open at startup never loaded (Git said "No git repos found");
  an unreadable hook payload created a blank session.
- v0.2.2 installed: shortcuts, Claude's reply in rows/toasts, worktree fixes, toast click opens the session, startup panel load fix.
- Watchtower: phase cards collapse/expand (click the header; fully verified
  phases start folded and show status counts when folded; Expand all /
  Collapse all; search opens phases with matches; jumping to a task unfolds
  its phase); cards no longer stretch to their neighbour's height; the venv
  line only shows for projects that declare one. Roadmap: P8 Git view phase;
  P6.1/6.3/6.4/6.5 blocked by decision D6 (deferred - owner on hold), so Next
  up only lists work that is actually wanted.
- P8 Git view (PyCharm-style, read-only): Log button in the Git panel (or click
  a commit) opens a main-area tool window - branches tree (HEAD, Local with
  ahead/behind, Remote by remote), log with commit graph, ref badges, author,
  hash, relative dates and filters (text or hash, branch, user, date, paths,
  infinite scroll), changed-files tree (folders with counts, status colours,
  single-folder chains collapsed like PyCharm), commit details (message, author
  <email>, dates, refs, "In N branches"), side-by-side diff (line numbers,
  colours, word highlights, next/previous change, F7, ignore whitespace).
  The side panel folds while the view is open and comes back on close.
- Fixed while testing: added-line diff rows broke the grid (CSS class clash),
  the log had zero height while the diff was hidden (grid rows), the fold for
  the Git view was saved as a preference, and restarting an unprompted
  worktree session created yet another worktree.
- v0.3.0 installed: Git view (P8) + collapsible watchtower phases.
- P9 scheduled agent jobs (in progress): Jobs tab (Alt+6) with a job editor -
  name, folder, instruction, schedule presets or cron with a next-3-runs
  preview, explicit permissions (nothing allowed unless ticked; full auto is a
  separate, warned option), secrets sealed with Windows DPAPI and passed as
  environment variables, notify rule, timeout, model. Jobs run in the app
  (catch up once after downtime, never overlap, whole process tree killed on
  timeout) as `claude -p` with only the granted tools; the agent ends with a
  STATUS line, the run (report, status, cost, session) is kept (last 50).
  Report view renders markdown tables and chart blocks; Continue in a session
  resumes the run's conversation. Verified with the real CLI: a read-only
  "Docs digest" job ran unattended in 24 s and produced a correct report.
  Template: Website views (Cloudflare GraphQL Analytics, curl only).
