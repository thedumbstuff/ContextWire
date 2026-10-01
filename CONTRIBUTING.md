# Contributing to ContextWire

Thanks for helping! This guide covers setup, how the project is organised, and what a
good pull request looks like.

## Ground rules

1. **Never block or break Claude.** The hook client (`contextwire.exe --hook`) runs inside
   every Claude Code turn. It must stay fast (short timeouts), print nothing, and always
   exit `0` - even when the app is not running or the payload is malformed.
2. **Never log or export conversation content.** Logs and *Copy diagnostics* may contain
   event names, session ids, folders, tool names, notification types and exit codes -
   never prompts, titles, messages or transcript text.
3. **Leave the user's Claude configuration alone** unless they opt in. Per-session hooks go
   through `claude --settings`; anything touching `~/.claude/settings.json` must be opt-in,
   idempotent, keep the user's own entries and key order, and write a backup first.
4. **The real CLI is the console.** Features should work with `claude` as it ships rather
   than scraping or re-implementing its terminal UI.

## Development setup

Prerequisites: Windows 10/11, Node.js 20+, Rust stable (MSVC) with the Visual Studio C++
build tools ([Tauri prerequisites](https://tauri.app/start/prerequisites/)), the Claude
Code CLI on `PATH`, and Python 3.10+ with PyYAML for the watchtower.

```powershell
npm install
npm run tauri dev
```

Only one ContextWire instance can run at a time; quit an installed copy from its tray
menu first. Debug builds never register autostart.

## Checks to run before a pull request

```powershell
npx tsc --noEmit
npm test
cargo test --manifest-path src-tauri/Cargo.toml
python -m unittest discover -s watchtower/tests -q
```

CI runs the same on `windows-latest`.

## Project layout

| Path | What |
|---|---|
| `src-tauri/src/pty.rs` | ConPTY session manager (spawn, write, resize, kill, exit) |
| `src-tauri/src/hookserver.rs`, `hook.rs` | localhost hook endpoint and the `--hook` client |
| `src-tauri/src/claudecfg.rs` | per-session hooks file, opt-in global hooks |
| `src-tauri/src/workspaces.rs` | past sessions and workspace folders from `~/.claude/projects` |
| `src-tauri/src/applog.rs` | rotating log file |
| `src-tauri/src/lib.rs` | Tauri commands, tray, single instance, autostart |
| `src/status.ts` | pure status machine - unit-tested in `tests/status.test.ts` |
| `src/sidebar.ts`, `terminal.ts`, `main.ts` | UI |
| `roadmap.yaml`, `watchtower/` | build status and its dashboard |
| `PLAN.md`, `docs/changelog.md` | design decisions and history |

Two gotchas worth knowing before touching `pty.rs`:

- ConPTY asks the terminal for the cursor position (`ESC[6n`) and waits for the reply
  before starting the program. xterm.js answers it in the app; tests must answer it too.
- ConPTY keeps the output pipe open after the child exits until the pseudo console is
  closed, so exit is detected by waiting on the process, not by EOF.

## Roadmap and watchtower

`roadmap.yaml` is the single source of truth for what is done, in progress and planned.
When your change completes or adds work:

- update the task `status` (and add `checks` that prove it - a file, a test, a command);
- update the `features` backlog if a user-visible feature ships;
- add a line to `docs/changelog.md`.

`python watchtower/server.py` shows the result at http://127.0.0.1:8766. A task marked
`done` whose check fails is shown as **CLAIMED** - please don't leave those behind.
Quote YAML values that contain commas or `: ` inside `{flow: mappings}`; the watchtower
lints for that mistake.

## Pull requests

- Keep them focused; one feature or fix per PR, with small coherent commits.
- Describe what changed and how you verified it (tests, and for UI changes a screenshot).
- New behaviour in `status.ts`, `claudecfg.rs`, `hook*.rs` or `pty.rs` needs a test.
- Don't commit personal paths, transcripts or screenshots that show them.

## Reporting bugs

Use the bug report template. The fastest route to a fix is **Settings -> Troubleshooting ->
Copy diagnostics** pasted into the issue (it contains no conversation text - but glance
over it before posting, it does include folder paths).
