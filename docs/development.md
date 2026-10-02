# Development

Contributions follow four ground rules (details in [CONTRIBUTING.md](../CONTRIBUTING.md)):

1. Never block or break Claude - the hook client is fast, silent and always exits 0.
2. Never log or export conversation content.
3. Leave the user's Claude configuration alone unless they opt in.
4. The real CLI is the console - no scraping or re-implementing its UI.

Prerequisites are those in [Getting started](getting-started.md), plus Python 3.10+ with
PyYAML for the watchtower.

## Run and test

```powershell
npm install
npm run dev:app            # isolated debug build, data in %APPDATA%\ContextWire-dev
npm run tauri build        # release exe + NSIS installer

npx tsc --noEmit                                       # type check
npm test                                               # UI tests (status machine, git view, job reports)
cargo test --manifest-path src-tauri/Cargo.toml        # Rust tests (ConPTY, hooks, cron, secrets, jobs, git)
python -m unittest discover -s watchtower/tests -q     # watchtower tests
```

CI runs the same checks on `windows-latest`. An opt-in Rust test,
`cargo test real_claude_job -- --ignored`, runs a real unattended Claude job end to end
(the last run cost $0.29 of API usage).

## Roadmap and watchtower

[`roadmap.yaml`](../roadmap.yaml) is the single source of truth for what is done, in
progress and planned, plus a `features` backlog that includes official-desktop-app
features worth adopting. Every task carries checks (a file, a test, a command).

```powershell
python watchtower/server.py          # http://127.0.0.1:8766  (Build + Features tabs)
python watchtower/server.py --once   # terminal summary
```

A task marked done whose check fails shows as **CLAIMED**. Each change updates its task
status and adds a line to [changelog.md](changelog.md).

## Pull requests

- One feature or fix each, in small coherent commits, saying how you verified it (a
  screenshot for UI changes).
- New behaviour in `status.ts`, `claudecfg.rs`, `hook*.rs` or `pty.rs` needs a test.
- Don't commit personal paths, transcripts or screenshots that show them.

## Two ConPTY gotchas

- ConPTY asks the terminal for the cursor position (`ESC[6n`) and waits for the reply
  before starting the program. xterm.js answers it in the app; tests must answer it too.
- ConPTY keeps the output pipe open after the child exits, so exit is detected by waiting
  on the process, not by end of file.
