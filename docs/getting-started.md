# Getting started

There is no signed release yet, so ContextWire is built from source; the first build
takes about 5 minutes. The installer is per-user and needs no admin rights.

## Prerequisites

- Windows 10 or 11 (x64) with the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (preinstalled on Windows 11).
- [Claude Code](https://code.claude.com) CLI on `PATH` - check with `claude --version`.
- [Node.js](https://nodejs.org) 20 or later.
- [Rust](https://rustup.rs) stable (MSVC toolchain) and the Visual Studio C++ build tools -
  see the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Build and install

```powershell
git clone <repo> ContextWire
cd ContextWire
npm install
npm run tauri build
.\src-tauri\target\release\bundle\nsis\ContextWire_0.4.0_x64-setup.exe
```

The app installs to `%LOCALAPPDATA%\ContextWire`. Windows SmartScreen may warn on first
launch because the build is unsigned.

## First run

1. The release build registers itself to start with Windows, minimized to the tray.
   Turn this off in **Settings**.
2. Closing the window hides it to the tray; quit from the tray menu. Only one instance
   runs at a time.
3. Workspace roots are found from `~/.claude/projects`. Add or remove roots in Settings.

## Upgrading

Quit the installed app from the tray first and wait until `contextwire.exe` has fully
exited, then run the new installer. A setup started while the old process is alive exits
with code 2 and the old version keeps running.

Quitting ends any open consoles; they come back with `claude --resume` on the next start.

## Where data lives

| Path | Holds |
| --- | --- |
| `%LOCALAPPDATA%\ContextWire` | The installed program |
| `%APPDATA%\ContextWire\state.json` | Open sessions, names, unread state - what the sidebar believes |
| `%APPDATA%\ContextWire\endpoint.json` | Hook server port and per-install token |
| `%APPDATA%\ContextWire\session-hooks.json` | The hooks file passed to each `claude` with `--settings` |
| `%APPDATA%\ContextWire\activity.json` | The Activity feed |
| `%APPDATA%\ContextWire\jobs.json`, `job-runs\` | Scheduled jobs and their last 50 runs each |
| `%APPDATA%\ContextWire\logs\contextwire.log` | Rotating log, UTC, one line per event |

A debug build (`npm run dev:app`) uses `%APPDATA%\ContextWire-dev` and its own app
identifier, so it can run beside the installed app without touching its data. Setting
`CONTEXTWIRE_DATA_DIR` overrides the folder (used by tests).
