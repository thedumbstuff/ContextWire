# Privacy and security

Everything stays on your machine: ContextWire makes no network calls of its own (apart
from the git fetch, pull and push you click) and adds no remote access. The `claude` CLI
talks to Anthropic exactly as it does in a terminal.

| Surface | Protection |
| --- | --- |
| Hook endpoint | Listens on `127.0.0.1` only, on a random port. Every request must carry the per-install random token from `endpoint.json`. Events only change sidebar status; they cannot run commands or type into consoles |
| Hook client (`contextwire.exe --hook`) | Reads the hook JSON from stdin and posts it; no output, short timeouts, always exits 0 - it can never block Claude, even when the app is closed |
| `~/.claude/settings.json` | Untouched unless you turn on *Track sessions started in plain terminals*. Then a one-time backup is written (`settings.json.contextwire-backup`), other hooks and key order are kept, and invalid JSON is refused |
| Spawned processes | Only the `claude` CLI found on `PATH`, in a folder you chose. Environment markers of a parent Claude session are stripped |
| Scheduled jobs | Nothing allowed unless granted per job; full auto is a separate, warned choice. Secrets are DPAPI-encrypted at rest, passed as environment variables, and blanked out of reports |
| Logs and diagnostics | Event names, session ids, folders, tool names, exit codes - never prompts, conversation text or secret values |

Out of scope: what the `claude` CLI itself does inside a session (report that to
Anthropic), and attacks that already need code execution as the same Windows user.

To report a vulnerability, use the repository's private **Security -> Report a
vulnerability** form rather than a public issue; see [SECURITY.md](../SECURITY.md).
