//! Backend for the Git view (PyCharm-style log): branches, a filtered commit
//! log with parents for the graph, the files a commit changed, commit details
//! and a side-by-side diff of one file. Read-only - nothing here changes a repo.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::gitops::git;

/// git's well-known empty tree, used as the "parent" of a root commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_DIFF_BYTES: usize = 3 * 1024 * 1024;

// ---------------------------------------------------------------- branches

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub head: bool,
    pub hash: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
}

fn parse_track(track: &str) -> (u32, u32, bool) {
    let (mut a, mut b) = (0, 0);
    for part in track.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            a = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            b = n.parse().unwrap_or(0);
        }
    }
    (a, b, track.contains("gone"))
}

pub fn branches(dir: &Path) -> Result<Vec<Branch>, String> {
    let raw = git(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 6 || f[0].ends_with("/HEAD") {
            continue; // skip origin/HEAD symbolic refs
        }
        let (ahead, behind, gone) = parse_track(f[4]);
        out.push(Branch {
            name: f[1].to_string(),
            remote: f[0].starts_with("refs/remotes/"),
            head: f[5].trim() == "*",
            hash: f[2].to_string(),
            upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
            ahead,
            behind,
            gone,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- log

#[derive(Serialize, Clone, Debug)]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time_ms: u64,
    pub refs: Vec<String>,
    pub subject: String,
}

#[derive(Deserialize, Default, Debug)]
pub struct LogQuery {
    /// a branch/ref to show; None = every local and remote branch
    pub branch: Option<String>,
    /// message text, or a commit hash (4+ hex chars)
    pub text: Option<String>,
    pub author: Option<String>,
    pub since_days: Option<u32>,
    pub path: Option<String>,
    pub skip: Option<usize>,
    pub limit: Option<usize>,
}

const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

fn parse_refs(d: &str) -> Vec<String> {
    d.split(", ")
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| r.strip_prefix("HEAD -> ").map(|b| format!("HEAD|{b}")).unwrap_or_else(|| r.to_string()))
        .collect()
}

fn parse_entries(raw: &str) -> Vec<LogEntry> {
    raw.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = rec.splitn(8, '\x1f').collect();
            if f.len() < 8 {
                return None;
            }
            Some(LogEntry {
                hash: f[0].into(),
                short: f[1].into(),
                parents: f[2].split_whitespace().map(str::to_string).collect(),
                author: f[3].into(),
                email: f[4].into(),
                time_ms: f[5].trim().parse::<u64>().unwrap_or(0) * 1000,
                refs: parse_refs(f[6]),
                subject: f[7].trim_end().into(),
            })
        })
        .collect()
}

fn is_hexish(s: &str) -> bool {
    s.len() >= 4 && s.len() <= 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn log(dir: &Path, q: &LogQuery) -> Result<Vec<LogEntry>, String> {
    if git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(vec![]); // repository without any commit yet
    }
    let limit = q.limit.unwrap_or(300).min(2000);
    let skip = q.skip.unwrap_or(0);
    let mut args: Vec<String> = vec!["log".into(), "--date-order".into(), LOG_FORMAT.into(), format!("-n{limit}")];
    if skip > 0 {
        args.push(format!("--skip={skip}"));
    }
    let text = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if let Some(t) = text {
        args.push("--regexp-ignore-case".into());
        args.push("--fixed-strings".into());
        args.push(format!("--grep={t}"));
    }
    if let Some(a) = q.author.as_deref().filter(|a| !a.is_empty()) {
        args.push(format!("--author={a}"));
    }
    if let Some(d) = q.since_days {
        args.push(format!("--since={d} days ago"));
    }
    match q.branch.as_deref().filter(|b| !b.is_empty()) {
        Some(b) => args.push(b.to_string()),
        None => {
            args.push("--branches".into());
            args.push("--remotes".into());
            args.push("HEAD".into());
        }
    }
    if let Some(p) = q.path.as_deref().filter(|p| !p.is_empty()) {
        args.push("--".into());
        args.push(p.to_string());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = git(dir, &argv)?;
    let mut entries = parse_entries(&raw);
    // "Text or hash": a hash-looking query also finds that commit directly
    if let Some(t) = text.filter(|t| is_hexish(t)) {
        if skip == 0 {
            if let Ok(one) = git(dir, &["log", "-1", LOG_FORMAT, t, "--"]) {
                for e in parse_entries(&one) {
                    if !entries.iter().any(|x| x.hash == e.hash) {
                        entries.insert(0, e);
                    }
                }
            }
        }
    }
    Ok(entries)
}

/// Authors seen in the repo (for the User filter), most active first.
pub fn authors(dir: &Path) -> Result<Vec<String>, String> {
    let raw = git(dir, &["shortlog", "-sn", "--all", "--no-merges", "HEAD"])?;
    Ok(raw.lines().filter_map(|l| l.split_once('\t').map(|(_, n)| n.trim().to_string())).collect())
}

// ---------------------------------------------------------------- one commit

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ChangedFile {
    /// A added, M modified, D deleted, R renamed, C copied, T type change
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

/// What the commit's diff is taken against: first parent, or the empty tree.
fn base_of(dir: &Path, hash: &str) -> Result<String, String> {
    let parents = git(dir, &["rev-list", "--parents", "-n1", hash])?;
    Ok(parents.split_whitespace().nth(1).map(str::to_string).unwrap_or_else(|| EMPTY_TREE.to_string()))
}

pub fn commit_files(dir: &Path, hash: &str) -> Result<Vec<ChangedFile>, String> {
    let base = base_of(dir, hash)?;
    let raw = git(dir, &["diff-tree", "-r", "-M", "--name-status", "-z", "--no-commit-id", &base, hash])?;
    let mut parts = raw.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(st) = parts.next() {
        let code = st.chars().next().unwrap_or('M').to_string();
        if code == "R" || code == "C" {
            let old = parts.next().unwrap_or_default().to_string();
            let new = parts.next().unwrap_or_default().to_string();
            out.push(ChangedFile { status: code, path: new, old_path: Some(old) });
        } else if let Some(p) = parts.next() {
            out.push(ChangedFile { status: code, path: p.to_string(), old_path: None });
        }
    }
    Ok(out)
}

#[derive(Serialize, Clone, Debug)]
pub struct CommitDetail {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub author_ms: u64,
    pub committer: String,
    pub committer_email: String,
    pub commit_ms: u64,
    pub refs: Vec<String>,
    pub message: String,
    pub branches: Vec<String>,
}

pub fn commit_detail(dir: &Path, hash: &str) -> Result<CommitDetail, String> {
    let raw = git(dir, &["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B", hash])?;
    let f: Vec<&str> = raw.splitn(9, '\x1f').collect();
    if f.len() < 9 {
        return Err("could not read that commit".into());
    }
    let branches = git(dir, &["branch", "-a", "--contains", hash, "--format=%(refname:short)"])
        .map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty() && !l.ends_with("/HEAD")).map(str::to_string).collect())
        .unwrap_or_default();
    Ok(CommitDetail {
        hash: f[0].into(),
        author: f[1].into(),
        email: f[2].into(),
        author_ms: f[3].parse::<u64>().unwrap_or(0) * 1000,
        committer: f[4].into(),
        committer_email: f[5].into(),
        commit_ms: f[6].parse::<u64>().unwrap_or(0) * 1000,
        refs: parse_refs(f[7]),
        message: f[8].trim_end().into(),
        branches,
    })
}

// ---------------------------------------------------------------- diff

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Side {
    pub no: u32,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiffRow {
    /// same | change | add | del
    pub kind: &'static str,
    pub left: Option<Side>,
    pub right: Option<Side>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileDiff {
    pub old_path: String,
    pub new_path: String,
    pub base: String,
    pub binary: bool,
    pub rows: Vec<DiffRow>,
    pub note: Option<String>,
}

/// Turn a unified diff (generated with whole-file context) into side-by-side
/// rows: runs of deletions followed by additions are paired line by line as
/// "change", the remainder become "del"/"add" with an empty opposite side.
pub fn side_by_side(unified: &str) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let (mut ln, mut rn) = (0u32, 0u32);
    let mut dels: Vec<Side> = Vec::new();
    let mut adds: Vec<Side> = Vec::new();
    let flush = |rows: &mut Vec<DiffRow>, dels: &mut Vec<Side>, adds: &mut Vec<Side>| {
        let n = dels.len().max(adds.len());
        let mut d = dels.drain(..);
        let mut a = adds.drain(..);
        for _ in 0..n {
            let (l, r) = (d.next(), a.next());
            let kind = match (&l, &r) {
                (Some(_), Some(_)) => "change",
                (Some(_), None) => "del",
                _ => "add",
            };
            rows.push(DiffRow { kind, left: l, right: r });
        }
    };
    let mut in_hunk = false;
    for line in unified.lines() {
        if let Some(h) = line.strip_prefix("@@ ") {
            flush(&mut rows, &mut dels, &mut adds);
            // @@ -l,s +r,s @@
            let mut it = h.split_whitespace();
            let l = it.next().unwrap_or("-1").trim_start_matches('-');
            let r = it.next().unwrap_or("+1").trim_start_matches('+');
            ln = l.split(',').next().unwrap_or("1").parse::<u32>().unwrap_or(1).saturating_sub(1);
            rn = r.split(',').next().unwrap_or("1").parse::<u32>().unwrap_or(1).saturating_sub(1);
            if !rows.is_empty() {
                rows.push(DiffRow { kind: "gap", left: None, right: None });
            }
            in_hunk = true;
            continue;
        }
        if !in_hunk || line.starts_with('\\') {
            continue; // headers, "\ No newline at end of file"
        }
        match line.as_bytes().first() {
            Some(b'-') => {
                ln += 1;
                dels.push(Side { no: ln, text: line[1..].to_string() });
            }
            Some(b'+') => {
                rn += 1;
                adds.push(Side { no: rn, text: line[1..].to_string() });
            }
            _ => {
                flush(&mut rows, &mut dels, &mut adds);
                ln += 1;
                rn += 1;
                let text = line.get(1..).unwrap_or("").to_string();
                rows.push(DiffRow { kind: "same", left: Some(Side { no: ln, text: text.clone() }), right: Some(Side { no: rn, text }) });
            }
        }
    }
    flush(&mut rows, &mut dels, &mut adds);
    rows
}

pub fn file_diff(dir: &Path, hash: &str, path: &str, old_path: Option<&str>, ignore_ws: bool) -> Result<FileDiff, String> {
    let base = base_of(dir, hash)?;
    let old = old_path.unwrap_or(path);
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", "--unified=1000000"];
    if ignore_ws {
        args.push("-w");
    }
    args.extend([base.as_str(), hash, "--", old, path]);
    let raw = git(dir, &args)?;
    let mut d = FileDiff {
        old_path: old.to_string(),
        new_path: path.to_string(),
        base: if base == EMPTY_TREE { String::new() } else { base.chars().take(8).collect() },
        binary: false,
        rows: vec![],
        note: None,
    };
    if raw.len() > MAX_DIFF_BYTES {
        d.note = Some(format!("diff too large to show ({} KB)", raw.len() / 1024));
    } else if raw.lines().any(|l| l.starts_with("Binary files ")) {
        d.binary = true;
        d.note = Some("binary file".into());
    } else {
        d.rows = side_by_side(&raw);
        if d.rows.is_empty() {
            d.note = Some(if old != path { "renamed - content unchanged".into() } else { "no content change".into() });
        }
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn run(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    fn repo() -> PathBuf {
        let d = std::env::temp_dir().join(format!("cw-log-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        run(&d, &["init", "-q", "-b", "main"]);
        run(&d, &["config", "user.name", "Ann"]);
        run(&d, &["config", "user.email", "ann@example.com"]);
        d
    }

    fn commit(d: &Path, file: &str, body: &str, msg: &str) {
        std::fs::create_dir_all(d.join(file).parent().unwrap()).unwrap();
        std::fs::write(d.join(file), body).unwrap();
        run(d, &["add", "-A"]);
        run(d, &["commit", "-q", "-m", msg]);
    }

    #[test]
    fn side_by_side_pairs_changes_and_keeps_line_numbers() {
        let u = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n-b\n-c\n+B\n d\n+e\n";
        let rows = side_by_side(u);
        let k: Vec<&str> = rows.iter().map(|r| r.kind).collect();
        assert_eq!(k, ["same", "change", "del", "same", "add"]);
        assert_eq!(rows[1].left.as_ref().unwrap(), &Side { no: 2, text: "b".into() });
        assert_eq!(rows[1].right.as_ref().unwrap(), &Side { no: 2, text: "B".into() });
        assert_eq!(rows[3].left.as_ref().unwrap().no, 4);
        assert_eq!(rows[3].right.as_ref().unwrap().no, 3);
        assert_eq!(rows[4].right.as_ref().unwrap(), &Side { no: 4, text: "e".into() });
    }

    #[test]
    fn log_branches_files_detail_and_diff() {
        let d = repo();
        commit(&d, "src/a.txt", "one\ntwo\nthree\n", "first: add a");
        commit(&d, "src/a.txt", "one\nTWO\nthree\nfour\n", "second: edit a");
        run(&d, &["checkout", "-q", "-b", "feature"]);
        commit(&d, "docs/b.md", "# b\n", "third: docs on feature");
        run(&d, &["mv", "src/a.txt", "src/renamed.txt"]);
        run(&d, &["commit", "-q", "-m", "fourth: rename"]);
        run(&d, &["checkout", "-q", "main"]);

        let br = branches(&d).unwrap();
        let main = br.iter().find(|b| b.name == "main").unwrap();
        assert!(main.head && !main.remote);
        assert!(br.iter().any(|b| b.name == "feature" && !b.head));

        // all branches by default, newest first, refs decorated
        let all = log(&d, &LogQuery::default()).unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(all[0].subject, "fourth: rename");
        assert!(all[0].refs.contains(&"feature".to_string()));
        let second = all.iter().find(|e| e.subject == "second: edit a").unwrap();
        assert!(second.refs.iter().any(|r| r == "HEAD|main"), "{:?}", second.refs);
        assert_eq!(second.parents.len(), 1);
        assert_eq!(second.email, "ann@example.com");

        // filters
        let only_main = log(&d, &LogQuery { branch: Some("main".into()), ..Default::default() }).unwrap();
        assert_eq!(only_main.len(), 2);
        let by_text = log(&d, &LogQuery { text: Some("DOCS".into()), ..Default::default() }).unwrap();
        assert_eq!(by_text.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["third: docs on feature"]);
        let by_hash = log(&d, &LogQuery { text: Some(second.short.clone()), ..Default::default() }).unwrap();
        assert_eq!(by_hash[0].hash, second.hash);
        let by_path = log(&d, &LogQuery { path: Some("docs".into()), ..Default::default() }).unwrap();
        assert_eq!(by_path.len(), 1);
        assert_eq!(log(&d, &LogQuery { author: Some("nobody".into()), ..Default::default() }).unwrap().len(), 0);
        assert_eq!(log(&d, &LogQuery { limit: Some(1), skip: Some(1), ..Default::default() }).unwrap()[0].subject, "third: docs on feature");
        assert_eq!(authors(&d).unwrap(), ["Ann"]);

        // files of a root commit, an edit and a rename
        let first = all.iter().find(|e| e.subject == "first: add a").unwrap();
        assert_eq!(commit_files(&d, &first.hash).unwrap(), [ChangedFile { status: "A".into(), path: "src/a.txt".into(), old_path: None }]);
        assert_eq!(commit_files(&d, &second.hash).unwrap()[0].status, "M");
        let ren = commit_files(&d, &all[0].hash).unwrap();
        assert_eq!(ren[0].status, "R");
        assert_eq!(ren[0].old_path.as_deref(), Some("src/a.txt"));

        // detail
        let det = commit_detail(&d, &second.hash).unwrap();
        assert_eq!(det.message, "second: edit a");
        assert_eq!(det.author, "Ann");
        let mut b = det.branches.clone();
        b.sort();
        assert_eq!(b, ["feature", "main"]);

        // diff: whole file, changed + added lines, root commit diffs against nothing
        let fd = file_diff(&d, &second.hash, "src/a.txt", None, false).unwrap();
        let kinds: Vec<&str> = fd.rows.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, ["same", "change", "same", "add"]);
        let root = file_diff(&d, &first.hash, "src/a.txt", None, false).unwrap();
        assert!(root.base.is_empty() && root.rows.iter().all(|r| r.kind == "add"));
        let rn = file_diff(&d, &all[0].hash, "src/renamed.txt", Some("src/a.txt"), false).unwrap();
        assert_eq!(rn.note.as_deref(), Some("renamed - content unchanged"));
    }

    #[test]
    fn empty_repo_has_an_empty_log() {
        let d = repo();
        assert!(log(&d, &LogQuery::default()).unwrap().is_empty());
    }
}
