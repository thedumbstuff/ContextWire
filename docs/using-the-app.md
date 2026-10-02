# Using the app

The window has three parts: an icon rail on the far left, the panel it opens, and the
main area that shows the selected console or view. Clicking the open rail icon again
hides the panel, as in PyCharm; drag the splitter to resize it, double-click it to reset.

## Start a session

Click **New session** (or `+` on a workspace header). Pick a workspace, optionally a repo
inside it, a name, and whether to isolate the work in a git worktree. Then work in the
console exactly as in a terminal.

## Tool windows on the rail

| Rail tab | Shortcut | What it shows |
| --- | --- | --- |
| Active | Alt+1 | Open sessions with live status; needs-you rows float to the top |
| All Sessions | Alt+2 | Every workspace with its earlier sessions, newest first; one click resumes |
| Git | Alt+3 | Every repo under the workspaces with its commits; fetch, pull, push, reword ([Git](git.md)) |
| Roadmaps | Alt+4 | A roll-up of every `roadmap.yaml` found under the workspaces |
| Activity | Alt+5 | Timeline of what happened: finished, needs you, started, ended, git actions, job runs (last 500) |
| Jobs | Alt+6 | Scheduled agent jobs, their next run and last result ([Scheduled agent jobs](scheduled-jobs.md)) |
| Search | Alt+7 | Full-text search across every Claude transcript |

## Session status

| Status | Meaning | What you see |
| --- | --- | --- |
| Starting | The console is launching | Pulsing blue dot |
| Ready | Waiting for your first prompt | Grey dot |
| Working | Claude is running a turn | Pulsing amber dot |
| Needs you | Waiting on a permission prompt or a question | Red row, moved to the top, toast and taskbar flash |
| Done | A turn finished | Green dot; bold row with an unread badge and a toast if you were elsewhere |
| Ended | The `claude` process exited | Dark grey dot |

Opening a session clears its unread badge. Sessions active in a terminal during the last
few minutes are tagged *active* and open paused with an **Adopt here** button, so one
conversation is never resumed twice. Open sessions are restored with `claude --resume`
after a restart.

## Keyboard shortcuts

Plain `Ctrl` keys are left to Claude, so app shortcuts use `Ctrl+Shift` or `Alt`.

| Keys | Action |
| --- | --- |
| Ctrl+Shift+N | New session |
| Ctrl+Shift+U | Jump to the session that needs you |
| Ctrl+Shift+H | History - resume a past session |
| Ctrl+Shift+F | Search conversations |
| Ctrl+1 to Ctrl+9 | Open the Nth active session |
| Ctrl+Tab, Ctrl+Shift+Tab | Next or previous active session |
| Alt+1 to Alt+7 | Switch panel; again hides it |
| Ctrl+C with a selection, Ctrl+V | Copy, paste in the console |

## Settings

The gear at the bottom of the rail: notifications, autostart, tracking sessions started
in plain terminals (opt-in global hooks), workspace roots, and Troubleshooting (Copy
diagnostics, Open logs folder).
