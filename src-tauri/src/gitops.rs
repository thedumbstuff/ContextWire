//! Git panel backend: find repos under the workspace roots, read their state,
//! and run the few actions the panel offers (fetch, pull, push, reword).
//!
//! Everything goes through the `git` CLI so it honours the user's config,
//! credentials and hooks. Destructive history edits are refused: only commits
//! that are on no remote branch can be reworded.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use serde::Serialize;

const SKIP_DIRS: &[&str] = &["node_modules", "target", "venv", ".venv", "__pycache__", "dist", "build", ".git"];
const MAX_DEPTH: usize = 3;
const MAX_MTIME_FILES: usize = 400;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub time_ms: u64,
    pub pushed: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: u32,
    pub last_commit: Option<Commit>,
    /// newest of the last commit time and the mtime of any changed file
    pub last_change_ms: u64,
    pub has_remote: bool,
    pub error: Option<String>,
}

fn git_cmd(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.current_dir(dir);
    c.env("GIT_TERMINAL_PROMPT", "0"); // never hang waiting for a password prompt
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the GUI app
    }
    c
}

/// Run git and return stdout, or stderr (trimmed) as the error.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(dir).args(args).output().map_err(|e| format!("git not found: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("git {} failed ({})", args.join(" "), out.status) } else { err })
    }
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// Repos at or below each root (depth-limited; does not descend into a repo).
pub fn find_repos(roots: &[String]) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if is_repo(dir) {
            out.push(dir.to_path_buf());
            return;
        }
        if depth == 0 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if e.file_type().map_or(false, |t| t.is_dir()) {
                walk(&e.path(), depth - 1, out);
            }
        }
    }
    let mut out = Vec::new();
    for r in roots {
        walk(Path::new(r), MAX_DEPTH, &mut out);
    }
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.display().to_string().to_lowercase()));
    out
}

const LOG_FMT: &str = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%b%x1e";

fn parse_log(raw: &str, unpushed: &HashSet<String>) -> Vec<Commit> {
    raw.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = rec.splitn(6, '\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            Some(Commit {
                hash: f[0].into(),
                short: f[1].into(),
                subject: f[2].into(),
                author: f[3].into(),
                time_ms: f[4].trim().parse::<u64>().unwrap_or(0) * 1000,
                body: f.get(5).map_or("", |b| b.trim()).into(),
                pushed: !unpushed.contains(f[0]),
            })
        })
        .collect()
}

/// Commits reachable from HEAD that are on no remote-tracking branch.
fn unpushed(dir: &Path) -> HashSet<String> {
    git(dir, &["rev-list", "HEAD", "--not", "--remotes"])
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn status(dir: &Path) -> RepoInfo {
    let mut r = RepoInfo {
        path: dir.display().to_string(),
        name: dir.file_name().map_or_else(|| dir.display().to_string(), |n| n.to_string_lossy().into_owned()),
        ..Default::default()
    };
    let raw = match git(dir, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]) {
        Ok(s) => s,
        Err(e) => {
            r.error = Some(e);
            return r;
        }
    };
    let mut newest_change = 0u64;
    let mut stat_budget = MAX_MTIME_FILES;
    for line in raw.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            r.detached = h == "(detached)";
            r.branch = h.to_string();
        } else if let Some(u) = line.strip_prefix("# branch.upstream ") {
            r.upstream = Some(u.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut it = ab.split_whitespace();
            r.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            r.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if !line.starts_with('#') && !line.is_empty() {
            r.changes += 1;
            if stat_budget > 0 {
                stat_budget -= 1;
                let path = match line.as_bytes()[0] {
                    b'1' => line.splitn(9, ' ').nth(8),
                    b'2' => line.splitn(10, ' ').nth(9).map(|p| p.split('\t').next().unwrap_or(p)),
                    b'u' => line.splitn(11, ' ').nth(10),
                    b'?' => line.get(2..),
                    _ => None,
                };
                if let Some(p) = path {
                    newest_change = newest_change.max(mtime_ms(&dir.join(p)));
                }
            }
        }
    }
    r.has_remote = git(dir, &["remote"]).map_or(false, |s| !s.trim().is_empty());
    if let Ok(raw) = git(dir, &["log", "-1", LOG_FMT]) {
        r.last_commit = parse_log(&raw, &unpushed(dir)).into_iter().next();
    }
    let commit_ms = r.last_commit.as_ref().map_or(0, |c| c.time_ms);
    r.last_change_ms = commit_ms.max(newest_change);
    r
}

pub fn log(dir: &Path, n: usize) -> Result<Vec<Commit>, String> {
    let raw = git(dir, &["log", &format!("-n{n}"), LOG_FMT])?;
    Ok(parse_log(&raw, &unpushed(dir)))
}

pub fn fetch(dir: &Path) -> Result<String, String> {
    git(dir, &["fetch", "--prune"]).map(|s| if s.trim().is_empty() { "fetched".into() } else { s })
}

/// Fast-forward only: never creates a merge commit or rewrites anything.
pub fn pull(dir: &Path) -> Result<String, String> {
    git(dir, &["pull", "--ff-only"])
}

pub fn push(dir: &Path) -> Result<String, String> {
    let st = status(dir);
    if st.detached {
        return Err("HEAD is detached - check out a branch before pushing".into());
    }
    let out = if st.upstream.is_some() {
        git_cmd(dir).args(["push"]).output()
    } else if git(dir, &["remote"]).map_or(false, |s| s.lines().any(|l| l == "origin")) {
        git_cmd(dir).args(["push", "-u", "origin", "HEAD"]).output()
    } else {
        return Err("no remote to push to".into());
    };
    // git push reports progress on stderr even on success
    let out = out.map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
    if out.status.success() {
        Ok(if text.is_empty() { "pushed".into() } else { text })
    } else {
        Err(text)
    }
}

/// Run git with extra environment and stdin; stdout on success, stderr as the error.
fn git_with(dir: &Path, args: &[&str], env: &[(&str, &str)], stdin: &str) -> Result<String, String> {
    let mut cmd = git_cmd(dir);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("git not found: {e}"))?;
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Change the message of any commit on the current branch that has not been
/// pushed yet.
///
/// The commit and everything after it are re-created with `git commit-tree`
/// from their *existing trees*, so file contents, the index and the working
/// tree are untouched and no conflict is possible; authors and author dates
/// are preserved. The branch is then moved with `update-ref` (the old history
/// stays in the reflog). Refused for pushed commits (would need a force-push)
/// and when the range contains merges.
pub fn reword(dir: &Path, hash: &str, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("the commit message is empty".into());
    }
    let target = git(dir, &["rev-parse", "--verify", &format!("{hash}^{{commit}}")])
        .map_err(|_| "that commit no longer exists - refresh".to_string())?
        .trim()
        .to_string();
    let head = git(dir, &["rev-parse", "HEAD"])?.trim().to_string();
    if git(dir, &["merge-base", "--is-ancestor", &target, "HEAD"]).is_err() {
        return Err("that commit is not on the current branch".into());
    }
    if !unpushed(dir).contains(&target) {
        return Err("this commit is already on a remote; rewording it would need a force-push, so it is not allowed here".into());
    }
    // commits to rebuild, oldest first: the target and everything after it
    let mut chain: Vec<String> = git(dir, &["rev-list", "--reverse", "--topo-order", &format!("{target}..HEAD")])?
        .lines()
        .map(str::to_string)
        .collect();
    chain.insert(0, target.clone());
    let merges = git(dir, &["rev-list", "--min-parents=2", &format!("{target}..HEAD")])?;
    let target_parents = git(dir, &["rev-list", "--parents", "-n1", &target])?;
    if !merges.trim().is_empty() || target_parents.split_whitespace().count() > 2 {
        return Err("there is a merge between this commit and HEAD; edit it with an interactive rebase instead".into());
    }
    let mut parent: Option<String> = target_parents.split_whitespace().nth(1).map(str::to_string);

    for c in &chain {
        let meta = git(dir, &["log", "-1", "--format=%an%x1f%ae%x1f%ad", "--date=raw", c])?;
        let f: Vec<&str> = meta.trim_end().splitn(3, '\x1f').collect();
        let (name, email, date) = (f.first().copied().unwrap_or(""), f.get(1).copied().unwrap_or(""), f.get(2).copied().unwrap_or(""));
        let msg = if *c == target { message.to_string() } else { git(dir, &["log", "-1", "--format=%B", c])?.trim_end().to_string() };
        let tree = format!("{c}^{{tree}}");
        let mut args = vec!["commit-tree", tree.as_str()];
        if let Some(p) = &parent {
            args.push("-p");
            args.push(p.as_str());
        }
        let env = [("GIT_AUTHOR_NAME", name), ("GIT_AUTHOR_EMAIL", email), ("GIT_AUTHOR_DATE", date)];
        let new = git_with(dir, &args, &env, &(msg + "\n"))?.trim().to_string();
        parent = Some(new);
    }
    let new_head = parent.ok_or("nothing to rewrite")?;
    // compare-and-swap: fails if HEAD moved while we were working
    git(dir, &["update-ref", "-m", "contextwire: reword commit message", "HEAD", &new_head, &head])?;
    Ok(git(dir, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("cw-git-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    fn commit(dir: &Path, file: &str, msg: &str) {
        std::fs::write(dir.join(file), msg).unwrap();
        run(dir, &["add", "."]);
        run(dir, &["commit", "-q", "-m", msg]);
    }

    /// bare remote + two clones, identities configured locally
    fn setup() -> (PathBuf, PathBuf, PathBuf) {
        let base = tmp();
        let remote = base.join("remote.git");
        run(&base, &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        let a = base.join("a");
        let b = base.join("b");
        for c in [&a, &b] {
            run(&base, &["clone", "-q", remote.to_str().unwrap(), c.to_str().unwrap()]);
            run(c, &["config", "user.name", "Test"]);
            run(c, &["config", "user.email", "test@example.com"]);
            run(c, &["checkout", "-q", "-b", "main"]);
        }
        commit(&a, "one.txt", "first");
        assert!(push(&a).is_ok(), "initial push sets upstream");
        run(&b, &["pull", "-q", "origin", "main"]);
        run(&b, &["branch", "-q", "--set-upstream-to=origin/main"]);
        (base, a, b)
    }

    #[test]
    fn finds_repos_without_descending_into_them() {
        let base = tmp();
        for p in ["ws/r1", "ws/group/r2", "ws/r1/nested", "ws/node_modules/x"] {
            std::fs::create_dir_all(base.join(p)).unwrap();
        }
        for p in ["ws/r1", "ws/group/r2", "ws/r1/nested", "ws/node_modules/x"] {
            run(&base.join(p), &["init", "-q"]);
        }
        let mut got: Vec<String> = find_repos(&[base.join("ws").display().to_string()])
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        got.sort();
        assert_eq!(got, ["r1", "r2"]);
    }

    #[test]
    fn status_log_pull_push_and_reword() {
        let (_base, a, b) = setup();

        // a: one local commit + one dirty file
        commit(&a, "two.txt", "second");
        std::fs::write(a.join("dirty.txt"), "x").unwrap();
        let st = status(&a);
        assert_eq!(st.branch, "main");
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind, st.changes), (1, 0, 1));
        assert_eq!(st.last_commit.as_ref().unwrap().subject, "second");
        assert!(!st.last_commit.as_ref().unwrap().pushed);
        assert!(st.last_change_ms >= st.last_commit.as_ref().unwrap().time_ms);

        let lg = log(&a, 10).unwrap();
        assert_eq!(lg.iter().map(|c| (c.subject.as_str(), c.pushed)).collect::<Vec<_>>(), [("second", false), ("first", true)]);

        // reword: refused for a pushed commit, allowed for the unpushed HEAD, staged work untouched
        run(&a, &["add", "dirty.txt"]);
        assert!(reword(&a, &lg[1].hash, "nope").unwrap_err().contains("force-push"));
        reword(&a, &lg[0].hash, "second, reworded\n\nwith a body").unwrap();
        let lg2 = log(&a, 1).unwrap();
        assert_eq!(lg2[0].subject, "second, reworded");
        assert_eq!(lg2[0].body, "with a body");
        assert_eq!(status(&a).changes, 1, "staged file was not swallowed into the amend");
        run(&a, &["reset", "-q"]);
        std::fs::remove_file(a.join("dirty.txt")).unwrap();

        // push, then the pushed HEAD can no longer be reworded
        push(&a).unwrap();
        let head = log(&a, 1).unwrap().remove(0);
        assert!(head.pushed);
        assert!(reword(&a, &head.hash, "x").unwrap_err().contains("force-push"));

        // b: fetch shows behind, pull fast-forwards
        fetch(&b).unwrap();
        assert_eq!(status(&b).behind, 1);
        pull(&b).unwrap();
        let sb = status(&b);
        assert_eq!((sb.ahead, sb.behind), (0, 0));
        assert_eq!(sb.last_commit.unwrap().subject, "second, reworded");
    }

    #[test]
    fn reword_an_older_unpushed_commit_keeps_files_authors_and_later_commits() {
        let (_base, a, _b) = setup();
        commit(&a, "c1.txt", "c1");
        commit(&a, "c2.txt", "c2 typo");
        commit(&a, "c3.txt", "c3");
        std::fs::write(a.join("staged.txt"), "s").unwrap();
        run(&a, &["add", "staged.txt"]);
        let before = log(&a, 4).unwrap();
        let trees_before: Vec<String> = before.iter().take(3).map(|c| run(&a, &["rev-parse", &format!("{}^{{tree}}", c.hash)])).collect();
        let author_date = run(&a, &["log", "-1", "--format=%ad", "--date=raw", &before[1].hash]);

        let short = reword(&a, &before[1].hash, "c2 fixed\n\nwith body").unwrap();
        let after = log(&a, 4).unwrap();
        assert_eq!(after[0].short, short);
        assert_eq!(after.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["c3", "c2 fixed", "c1", "first"]);
        assert_eq!(after[1].body, "with body");
        assert_eq!(after[3].hash, before[3].hash, "commits before the target are untouched");
        let trees_after: Vec<String> = after.iter().take(3).map(|c| run(&a, &["rev-parse", &format!("{}^{{tree}}", c.hash)])).collect();
        assert_eq!(trees_before, trees_after, "file contents identical");
        assert_eq!(run(&a, &["log", "-1", "--format=%ad", "--date=raw", &after[1].hash]), author_date, "author date kept");
        assert_eq!(status(&a).changes, 1, "staged file still staged, not committed");
        assert!(run(&a, &["reflog", "-1"]).contains("contextwire: reword"));
        assert_eq!(status(&a).ahead, 3);
    }

    #[test]
    fn reword_refuses_across_a_merge_and_unknown_commits() {
        let (_base, a, _b) = setup();
        commit(&a, "x.txt", "base unpushed");
        let target = log(&a, 1).unwrap().remove(0);
        run(&a, &["checkout", "-q", "-b", "side"]);
        commit(&a, "side.txt", "side");
        run(&a, &["checkout", "-q", "main"]);
        commit(&a, "main.txt", "main");
        run(&a, &["merge", "-q", "--no-edit", "side"]);
        assert!(reword(&a, &target.hash, "x").unwrap_err().contains("merge"));
        assert!(reword(&a, "deadbeef", "x").unwrap_err().contains("no longer exists"));
        assert!(reword(&a, &target.hash, "   ").unwrap_err().contains("empty"));
    }

    #[test]
    fn pull_refuses_to_merge_diverged_history() {
        let (_base, a, b) = setup();
        commit(&a, "a.txt", "from a");
        push(&a).unwrap();
        commit(&b, "b.txt", "from b");
        let err = pull(&b).unwrap_err();
        assert!(err.to_lowercase().contains("fast-forward") || err.to_lowercase().contains("diverg"), "{err}");
        assert_eq!(log(&b, 1).unwrap()[0].subject, "from b", "nothing was merged");
    }

    #[test]
    fn push_without_remote_is_a_clear_error() {
        let d = tmp();
        run(&d, &["init", "-q", "-b", "main"]);
        run(&d, &["config", "user.name", "T"]);
        run(&d, &["config", "user.email", "t@e.com"]);
        commit(&d, "f", "only");
        assert_eq!(push(&d).unwrap_err(), "no remote to push to");
        let st = status(&d);
        assert!(!st.has_remote && st.upstream.is_none());
    }
}
