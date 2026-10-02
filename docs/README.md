# ContextWire documentation

ContextWire is a Windows app that puts every Claude Code console in one chat-style
window, so you can see which session is working, which one needs you and which one
has finished without switching between terminals. These pages cover v0.4.0.

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, build and install, first run, upgrading, where data lives |
| [Using the app](using-the-app.md) | The window, tool windows on the rail, session status, shortcuts, settings |
| [Scheduled agent jobs](scheduled-jobs.md) | Configure a job once; Claude runs it unattended and reports back |
| [Git](git.md) | Git panel actions, safe rewording, the PyCharm-style Git view |
| [Architecture](architecture.md) | Components, how a session starts, how status flows through hooks |
| [Privacy and security](privacy-and-security.md) | What stays local, what is logged, secrets, permissions |
| [Troubleshooting](troubleshooting.md) | Diagnostics, logs, common problems |
| [Development](development.md) | Build, test, roadmap and watchtower, pull requests |

History of changes: [changelog.md](changelog.md). Design decisions: [PLAN.md](../PLAN.md).

## What ContextWire adds on top of the CLI

Each chat is the real `claude` CLI running in a Windows pseudo-console (ConPTY), not a
re-implementation. Slash commands, permission prompts, skills, your settings and
`CLAUDE.md` all behave as they do in a terminal. Status comes from Claude Code hooks,
not from reading the screen.

- **One sidebar for every workspace**, grouped by root folder and discovered from
  `~/.claude/projects`.
- **Status per session**: starting, ready, working, needs you, done, ended. A session
  waiting on a permission prompt turns red and moves to the top.
- **Unread badges, Windows toasts and a taskbar flash** when a turn finishes in the
  background.
- **Earlier sessions in every workspace**, one click to resume - like `claude --resume`,
  for all workspaces at once.
- **Tool windows** on a left rail: Git, a PyCharm-style Git log, project roadmaps, an
  activity feed, transcript search.
- **Scheduled agent jobs**: a task configured once runs unattended on a schedule and
  reports back.

## Compared with the official Claude desktop app

Its Code tab also runs parallel sessions, but in its own chat UI. It cannot attach to a
session running in a terminal - `/desktop` hands the session over and exits the CLI.
ContextWire keeps the CLI as the console. Features of the official app worth adopting are
tracked as an upgrade backlog in [`roadmap.yaml`](../roadmap.yaml) (`features`, `source: official`).
