# Scheduled agent jobs

A job is a task you configure once - a folder, an instruction, a schedule and the
permissions it may use. When its time comes, ContextWire runs Claude unattended with only
those permissions and shows the result as a report, an Activity entry and a toast.
Example: every Monday at 09:00, fetch last week's website views from Cloudflare and flag
a drop.

## Create a job

Open **Jobs** (Alt+6), click **New job** or start from a template, fill in the editor,
then **Save** or **Save & run now**.

| Field | What to set |
| --- | --- |
| Name | Shown in the list, toasts and reports |
| Folder | Where the agent runs - its working directory and `CLAUDE.md` |
| Instruction | What to do, in plain English. Say what counts as needing attention |
| Schedule | A preset or a cron expression; the editor shows the next 3 run times |
| Permissions | Tools the agent may use - nothing is allowed unless ticked |
| Secrets | Name and value pairs given to the agent as environment variables |
| Notify | Always, only when it needs attention, or never |
| Timeout | Minutes before the run is stopped (default 10) |
| Model | Optional; blank uses your Claude Code default |

## Schedules

Presets cover every N minutes, hourly, daily, weekdays, weekly and monthly (day 1 to 28)
at a chosen time. Anything else is a 5-field cron expression in local time, for example
`30 9 * * 1-5` = weekdays at 09:30.

## Permissions

An unattended run cannot answer a permission prompt, so anything not granted is denied.

| Choice | Grants the agent |
| --- | --- |
| Read files | `Read`, `Glob`, `Grep` |
| Web search | `WebSearch` |
| Fetch web pages | `WebFetch` |
| Edit files | `Edit`, `Write` |
| Run these commands | `Bash(<pattern>)` per line, e.g. `curl *` |
| Full auto | `--permission-mode auto` - everything; shown with a warning |

## Secrets

Secrets such as API tokens are encrypted with Windows DPAPI (tied to your Windows
account) before they are saved. At run time they become environment variables, the agent
is told to use them by name, and their values are blanked out of reports. Leaving a value
empty when editing keeps the stored one.

## When a run happens

- The app checks schedules while it is running, in the tray too.
- If the PC was off or the app closed, a missed run happens once, for the latest missed
  time, when the app starts again (marked *catch-up*).
- The same job never runs twice at once, and at most 2 jobs run in parallel.
- A run that hits its timeout is stopped with its whole process tree.

Under the hood a run is `claude -p <instruction> --output-format json
--append-system-prompt <unattended instructions> [--model] --allowedTools <granted tools>`
in the job's folder.

## Reports

The agent ends with a markdown report and a status line: **OK**, or **Needs attention**
with a reason. Failures and timeouts are marked as such.

Click a job to open its report view: run history on the left, the selected report on the
right, with tables and simple bar or line charts. **Continue in a session** resumes that
run's conversation as a normal chat to ask follow-ups. The last 50 runs per job are kept.

## Example - website views from Cloudflare

1. In Cloudflare, create an API token: My Profile, API Tokens, Create Token, Custom, with
   permission **Zone - Analytics - Read**, limited to your site.
2. Copy the **Zone ID** from your site's Overview page.
3. In Jobs, pick the **Website views (Cloudflare)** template and paste the two values into
   `CF_API_TOKEN` and `CF_ZONE_TAG`.
4. Click **Save & run now**. It runs Mondays at 09:00 with only `curl` allowed, reports
   page views and unique visitors per day with a chart, and needs attention on a drop over
   30% or an API failure.
