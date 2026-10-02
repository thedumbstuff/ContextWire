# Troubleshooting

Start with **Settings -> Troubleshooting -> Copy diagnostics**. It copies the version, the
`claude` path found, the hook endpoint, whether global hooks are installed, any startup
error, the running consoles and the last 200 log lines - no conversation text. It does
include folder paths, so glance over it before posting it anywhere.

1. **Read the log:** `%APPDATA%\ContextWire\logs\contextwire.log` (Open logs folder in
   Settings). One line per hook event, status change, spawn, exit, job run and UI error,
   in UTC.
2. **Compare belief with reality:** `state.json` is what the sidebar believes;
   `~/.claude/projects/*/<session id>.jsonl` is what Claude actually did.
3. **Check the installed build is current** (developers):
   `python watchtower/checks/installed_current.py`.

## Common problems

| Symptom | Likely cause and fix |
| --- | --- |
| `claude: NOT FOUND` in diagnostics | The CLI is not on `PATH` for the app. Install Claude Code or fix `PATH`, then restart ContextWire from the tray |
| A session's status never changes | Hook endpoint not running (see diagnostics) or the session was started outside the app. Plain-terminal sessions are tracked only with the opt-in global hooks |
| A past session opens paused with *Adopt here* | It was active in a terminal in the last few minutes. Close it there first, then adopt it |
| Installer finishes but the old version still runs | The old process was still alive (setup exit code 2). Quit from the tray, wait until `contextwire.exe` is gone, run setup again |
| Clicking a toast does nothing | Toast clicks work in the installed build only, not in a dev build |
| A job shows Failed or Timed out | Open its report for the error. Usually a permission it was not granted, a missing secret, or a timeout set too short |
| A job did not run at its time | The app was not running. It catches up once, for the latest missed time, on next start |
