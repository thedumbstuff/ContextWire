# Git

Git support has two parts: the **Git panel** on the rail for quick actions across every
repo, and the **Git view**, a read-only PyCharm-style log that opens in the main area.
Everything goes through your own `git` CLI, so your config, credentials and hooks apply.

## Git panel (Alt+3)

Lists every repo found under the workspace roots, newest change first, with its branch,
ahead/behind counts and recent commits.

| Action | What it does |
| --- | --- |
| Fetch | `git fetch` |
| Pull | Fast-forward only - never creates a merge commit or rewrites anything |
| Push | `git push` of the current branch |
| Edit (hover over a commit) | Rewords the message of a commit that is not pushed yet |
| Log | Opens the Git view for that repo |

### Rewording is safe by design

The commit and the ones after it are re-created from their existing file trees, so files,
the index and your working tree are untouched and no conflict is possible. Authors and
author dates are kept, and the old history stays in the reflog. Pushed commits (which
would need a force-push) and ranges containing merges are refused.

## Git view

Opened with **Log** in the panel, or by clicking a commit. Three columns, with a diff above
when you pick a file:

- **Branches** - local and remote, with ahead/behind counts.
- **Log** - commit graph lanes beside each commit, and a filter bar: text or hash, branch,
  user, date, paths. Scrolling loads more.
- **Changes and details** - a changed-files tree with folder counts and status colours,
  then the message, hash, author and email, dates, refs and how many branches contain it.
- **Diff** - side by side with line numbers, word-level highlights, previous/next change,
  and an ignore-whitespace toggle.

While the Git view is open the side panel folds away; it comes back on close. Esc closes
the view.
