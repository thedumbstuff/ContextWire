# Security Policy

## Supported versions

ContextWire is pre-1.0; only the latest release on the default branch gets fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use the repository's private
**Security -> Report a vulnerability** form (GitHub private vulnerability reporting).
Include the version (Settings shows it), steps to reproduce, and impact. You should get
an acknowledgement within a week.

## Security model

ContextWire runs Claude Code consoles locally; it does not add network services or
remote access. The parts worth scrutiny:

| Surface | Protection |
|---|---|
| Hook endpoint (status events from `contextwire.exe --hook`) | Binds `127.0.0.1` on a random port; every request must carry a per-install random token stored in `%APPDATA%\ContextWire\endpoint.json`. Events only change sidebar status; they cannot run commands or write to consoles. |
| Hook client | Reads the hook JSON from stdin and POSTs it to the endpoint; no output, short timeouts, always exits `0`. |
| `~/.claude/settings.json` | Only modified when the user enables *Track sessions started in plain terminals*; writes a one-time backup (`settings.json.contextwire-backup`), keeps other hooks and key order, refuses to touch invalid JSON. |
| Spawned processes | Only the `claude` CLI found on `PATH`, in a folder the user chose. Environment markers of a parent Claude session are stripped. |
| Logs / diagnostics | Event names, session ids, folders, tool names, exit codes - no prompts or conversation text. |

Out of scope: anything the `claude` CLI itself does inside a session (report those to
Anthropic), and attacks that already require code execution as the same Windows user.
