//! Scheduled agent jobs: configure once, and when the schedule comes due an
//! unattended `claude -p` runs the job's instruction in its folder with only
//! the permissions the owner granted. The result (a short markdown report
//! ending in a STATUS line) is stored as a run record and announced to the UI.
//!
//! Runs only while ContextWire is running; a run missed while the app or PC
//! was off is caught up once at the next start (never once per missed slot).

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cron::{self, Cron};
use crate::{pty, secrets};

const TICK: Duration = Duration::from_secs(20);
const KEEP_RUNS: usize = 50;
const MAX_PARALLEL: usize = 2;
/// A due time older than this when noticed counts as a catch-up run.
const LATE_MS: u64 = 2 * 60 * 1000;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---------------------------------------------------------------- model

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Permissions {
    /// Read, Glob, Grep
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub web_fetch: bool,
    /// Edit, Write
    #[serde(default)]
    pub edit: bool,
    /// Bash patterns such as "curl *" (become Bash(curl *))
    #[serde(default)]
    pub commands: Vec<String>,
    /// everything, like an interactive session in auto mode
    #[serde(default)]
    pub full_auto: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SecretEntry {
    pub name: String,
    pub sealed: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub prompt: String,
    pub cron: String,
    pub enabled: bool,
    pub permissions: Permissions,
    /// always | attention | never
    pub notify: String,
    pub timeout_min: u32,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub secrets: Vec<SecretEntry>,
    pub created_ms: u64,
    /// the latest scheduled time already handled (run or skipped as a duplicate)
    pub last_handled_ms: u64,
}

/// What the UI sends to create or update a job. Secret values are plain text
/// here; an empty value keeps the stored one, a missing name deletes it.
#[derive(Deserialize, Debug)]
pub struct JobInput {
    pub id: Option<String>,
    pub name: String,
    pub folder: String,
    pub prompt: String,
    pub cron: String,
    pub enabled: bool,
    pub permissions: Permissions,
    pub notify: String,
    pub timeout_min: u32,
    pub model: Option<String>,
    pub secrets: Vec<SecretInput>,
}

#[derive(Deserialize, Debug)]
pub struct SecretInput {
    pub name: String,
    pub value: String,
}

/// Job as shown to the UI: secret names only, plus schedule facts.
#[derive(Serialize, Clone, Debug)]
pub struct JobView {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub prompt: String,
    pub cron: String,
    pub schedule: String,
    pub enabled: bool,
    pub permissions: Permissions,
    pub notify: String,
    pub timeout_min: u32,
    pub model: Option<String>,
    pub secret_names: Vec<String>,
    pub next_ms: Option<u64>,
    pub running: bool,
    pub last: Option<RunRecord>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct RunRecord {
    pub id: String,
    pub job_id: String,
    pub job_name: String,
    /// schedule | catch-up | manual
    pub trigger: String,
    pub started_ms: u64,
    pub finished_ms: u64,
    /// running | ok | attention | error | timeout
    pub status: String,
    pub summary: String,
    pub report: String,
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub turns: Option<u64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- runner pieces (pure / testable)

pub fn system_prompt(job_name: &str) -> String {
    format!(
        "You are running UNATTENDED as the scheduled job \"{job_name}\" for ContextWire. Nobody is watching and you \
         cannot ask questions - make reasonable choices and finish. When done, reply with a concise markdown report \
         for the owner (lead with what changed or matters; use a table for numbers). If a numeric series is worth \
         charting, add a fenced block marked chart containing JSON like \
         {{\"type\":\"bar\",\"title\":\"Views per day\",\"labels\":[\"Mon\",\"Tue\"],\"series\":[{{\"name\":\"views\",\"values\":[120,98]}}]}} \
         (type bar or line). Environment variables may hold credentials: use them by name (e.g. $CF_API_TOKEN) and \
         never print their values. End with exactly one final line: \"STATUS: ok - <one-line summary>\" or \
         \"STATUS: attention - <what needs the owner's attention>\"."
    )
}

pub fn build_args(job: &Job) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-p".into(),
        job.prompt.clone(),
        "--output-format".into(),
        "json".into(),
        "--append-system-prompt".into(),
        system_prompt(&job.name),
    ];
    if let Some(m) = job.model.as_deref().filter(|m| !m.is_empty()) {
        a.push("--model".into());
        a.push(m.to_string());
    }
    let p = &job.permissions;
    if p.full_auto {
        a.push("--permission-mode".into());
        a.push("auto".into());
    } else {
        let mut tools: Vec<String> = Vec::new();
        if p.read {
            tools.extend(["Read", "Glob", "Grep"].map(String::from));
        }
        if p.web_search {
            tools.push("WebSearch".into());
        }
        if p.web_fetch {
            tools.push("WebFetch".into());
        }
        if p.edit {
            tools.extend(["Edit", "Write"].map(String::from));
        }
        for c in p.commands.iter().map(|c| c.trim()).filter(|c| !c.is_empty()) {
            tools.push(format!("Bash({c})"));
        }
        if !tools.is_empty() {
            // anything not listed is denied: in print mode nobody can approve it
            a.push("--allowedTools".into());
            a.push(tools.join(","));
        }
    }
    a
}

#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub status: String,
    pub summary: String,
    pub report: String,
    pub session_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub turns: Option<u64>,
    pub error: Option<String>,
}

/// Interpret `claude -p --output-format json` output plus the exit code.
pub fn parse_result(stdout: &str, exit_code: Option<i32>) -> Parsed {
    let v: Value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
    let text = v["result"].as_str().unwrap_or("").trim().to_string();
    let mut lines: Vec<&str> = text.lines().collect();
    while lines.last().map_or(false, |l| l.trim().is_empty()) {
        lines.pop();
    }
    let mut status = String::from("ok");
    let mut summary = String::new();
    if let Some(last) = lines.last() {
        let t = last.trim().trim_start_matches(['*', '_']).trim_end_matches(['*', '_']);
        let upper = t.to_ascii_uppercase();
        if let Some(rest) = upper.strip_prefix("STATUS:") {
            let rest_orig = t[t.len() - rest.len()..].trim();
            let (word, tail) = rest_orig.split_once(|c: char| !c.is_alphanumeric()).unwrap_or((rest_orig, ""));
            status = if word.eq_ignore_ascii_case("attention") { "attention".into() } else { "ok".into() };
            summary = tail.trim_start_matches(|c: char| c == '-' || c == '–' || c == ':' || c.is_whitespace()).trim().to_string();
            lines.pop();
        }
    }
    let report = lines.join("\n").trim().to_string();
    if summary.is_empty() {
        summary = report.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches('#').trim().chars().take(140).collect();
    }
    let is_error = v["is_error"].as_bool().unwrap_or(false) || v.is_null() || exit_code.map_or(false, |c| c != 0);
    let error = if is_error {
        Some(if v.is_null() {
            let s = stdout.trim();
            if s.is_empty() { format!("claude exited with code {exit_code:?} and no output") } else { s.chars().take(400).collect() }
        } else {
            text.chars().take(400).collect::<String>().trim().to_string()
        })
    } else {
        None
    };
    Parsed {
        status: if is_error { "error".into() } else { status },
        summary,
        report,
        session_id: v["session_id"].as_str().map(str::to_string),
        cost_usd: v["total_cost_usd"].as_f64(),
        turns: v["num_turns"].as_u64(),
        error,
    }
}

pub struct Exec {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Kill a process and everything it started (agents spawn shells and tools).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).output();
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// Run a program without a console window, with a hard timeout.
pub fn execute(program: &Path, args: &[String], cwd: &Path, env: &[(String, String)], timeout: Duration) -> Result<Exec, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for k in pty::STRIP_ENV {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("start {}: {e}", program.display()))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let (tx_out, rx_out) = std::sync::mpsc::channel();
    let (tx_err, rx_err) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx_out.send(s);
    });
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        let _ = tx_err.send(s);
    });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(st);
        }
        if start.elapsed() > timeout {
            timed_out = true;
            kill_tree(child.id());
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    // grandchildren (tools the agent started) can keep the pipes open - don't wait on them forever
    let grace = Duration::from_secs(if timed_out { 3 } else { 15 });
    let stdout = rx_out.recv_timeout(grace).unwrap_or_default();
    let stderr = rx_err.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok(Exec { exit_code: status.and_then(|s| s.code()), stdout, stderr, timed_out })
}

/// Latest scheduled time <= now that comes after `handled`, if any.
pub fn due(cron: &Cron, handled_ms: u64, now_ms: u64) -> Option<u64> {
    let from = Local.timestamp_millis_opt(handled_ms as i64).single()?;
    let mut next = cron.next_after(from)?;
    if next.timestamp_millis() as u64 > now_ms {
        return None;
    }
    // several slots may have passed while we were off: run once, for the latest
    for _ in 0..100_000 {
        match cron.next_after(next) {
            Some(n) if (n.timestamp_millis() as u64) <= now_ms => next = n,
            _ => break,
        }
    }
    Some(next.timestamp_millis() as u64)
}

// ---------------------------------------------------------------- manager

pub type OnRun = Arc<dyn Fn(&RunRecord) + Send + Sync>;

pub struct JobManager {
    dir: PathBuf,
    jobs: Mutex<Vec<Job>>,
    running: Mutex<HashSet<String>>,
    claude: Box<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    on_run: OnRun,
}

impl JobManager {
    pub fn new(data_dir: &Path, claude: impl Fn() -> Option<PathBuf> + Send + Sync + 'static, on_run: OnRun) -> Arc<JobManager> {
        let dir = data_dir.to_path_buf();
        let jobs = std::fs::read_to_string(dir.join("jobs.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Job>>(s.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_default();
        Arc::new(JobManager { dir, jobs: Mutex::new(jobs), running: Mutex::new(HashSet::new()), claude: Box::new(claude), on_run })
    }

    fn save(&self, jobs: &[Job]) -> Result<(), String> {
        let p = self.dir.join("jobs.json");
        let tmp = self.dir.join("jobs.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(jobs).unwrap()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }

    fn runs_dir(&self, job_id: &str) -> PathBuf {
        self.dir.join("job-runs").join(job_id)
    }

    pub fn start_scheduler(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::Builder::new()
            .name("job-scheduler".into())
            .spawn(move || loop {
                me.tick(now_ms());
                std::thread::sleep(TICK);
            })
            .expect("scheduler thread");
    }

    /// Start every job that is due. Returns the ids started (for tests).
    pub fn tick(self: &Arc<Self>, now: u64) -> Vec<String> {
        let mut started = Vec::new();
        let mut jobs = self.jobs.lock().unwrap();
        let mut changed = false;
        for job in jobs.iter_mut().filter(|j| j.enabled) {
            let Ok(cron) = Cron::parse(&job.cron) else { continue };
            let Some(slot) = due(&cron, job.last_handled_ms, now) else { continue };
            job.last_handled_ms = slot;
            changed = true;
            if self.running.lock().unwrap().contains(&job.id) || self.running.lock().unwrap().len() >= MAX_PARALLEL {
                info!("job   {} due but skipped (already running or {MAX_PARALLEL} jobs busy)", job.name);
                continue;
            }
            let trigger = if now.saturating_sub(slot) > LATE_MS { "catch-up" } else { "schedule" };
            self.spawn_run(job.clone(), trigger);
            started.push(job.id.clone());
        }
        if changed {
            let _ = self.save(&jobs);
        }
        started
    }

    pub fn run_now(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let job = self.jobs.lock().unwrap().iter().find(|j| j.id == id).cloned().ok_or("no such job")?;
        if self.running.lock().unwrap().contains(id) {
            return Err("this job is already running".into());
        }
        self.spawn_run(job, "manual");
        Ok(())
    }

    fn spawn_run(self: &Arc<Self>, job: Job, trigger: &str) {
        self.running.lock().unwrap().insert(job.id.clone());
        let me = Arc::clone(self);
        let trigger = trigger.to_string();
        std::thread::spawn(move || {
            let rec = me.run_job(&job, &trigger);
            me.running.lock().unwrap().remove(&job.id);
            (me.on_run)(&rec);
        });
    }

    fn run_job(&self, job: &Job, trigger: &str) -> RunRecord {
        let started = now_ms();
        let mut rec = RunRecord {
            id: format!("{started}"),
            job_id: job.id.clone(),
            job_name: job.name.clone(),
            trigger: trigger.into(),
            started_ms: started,
            status: "running".into(),
            ..Default::default()
        };
        (self.on_run)(&rec);
        info!("job   {} started ({trigger})", job.name);
        let result = (|| -> Result<(Exec, Vec<(String, String)>), String> {
            let claude = (self.claude)().ok_or("claude CLI not found on PATH")?;
            let folder = Path::new(&job.folder);
            if !folder.is_dir() {
                return Err(format!("folder does not exist: {}", job.folder));
            }
            let mut env = Vec::new();
            for s in &job.secrets {
                env.push((s.name.clone(), secrets::open(&s.sealed).map_err(|e| format!("secret {}: {e}", s.name))?));
            }
            let exec = execute(&claude, &build_args(job), folder, &env, Duration::from_secs(job.timeout_min.max(1) as u64 * 60))?;
            Ok((exec, env))
        })();
        rec.finished_ms = now_ms();
        match result {
            Err(e) => {
                rec.status = "error".into();
                rec.summary = e.clone();
                rec.error = Some(e);
            }
            Ok((exec, env)) => {
                let mut p = parse_result(&exec.stdout, exec.exit_code);
                // defence in depth: never store a secret value even if the agent printed it
                for (_, v) in env.iter().filter(|(_, v)| v.len() >= 6) {
                    p.report = p.report.replace(v.as_str(), "[secret]");
                    p.summary = p.summary.replace(v.as_str(), "[secret]");
                }
                rec.status = if exec.timed_out { "timeout".into() } else { p.status };
                rec.summary = if exec.timed_out { format!("stopped after {} min (timeout)", job.timeout_min) } else { p.summary };
                rec.report = p.report;
                rec.session_id = p.session_id;
                rec.cost_usd = p.cost_usd;
                rec.turns = p.turns;
                rec.exit_code = exec.exit_code;
                rec.error = p.error.or_else(|| (!exec.stderr.trim().is_empty() && exec.exit_code != Some(0)).then(|| exec.stderr.chars().take(400).collect()));
            }
        }
        info!("job   {} finished: {} ({} s)", job.name, rec.status, (rec.finished_ms - rec.started_ms) / 1000);
        let _ = self.store_run(&rec);
        rec
    }

    fn store_run(&self, rec: &RunRecord) -> Result<(), String> {
        let dir = self.runs_dir(&rec.job_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{}.json", rec.id)), serde_json::to_vec_pretty(rec).unwrap()).map_err(|e| e.to_string())?;
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).collect();
        files.sort();
        while files.len() > KEEP_RUNS {
            let _ = std::fs::remove_file(files.remove(0));
        }
        Ok(())
    }

    pub fn runs(&self, job_id: &str, limit: usize) -> Vec<RunRecord> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.runs_dir(job_id)).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        files.sort();
        files.iter().rev().take(limit).filter_map(|p| serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()).collect()
    }

    /// Session ids of all stored runs (so the sidebar can hide job transcripts).
    pub fn session_ids(&self) -> Vec<String> {
        let ids: Vec<String> = self.jobs.lock().unwrap().iter().map(|j| j.id.clone()).collect();
        ids.iter().flat_map(|id| self.runs(id, KEEP_RUNS)).filter_map(|r| r.session_id).collect()
    }

    pub fn list(&self) -> Vec<JobView> {
        let jobs = self.jobs.lock().unwrap().clone();
        let running = self.running.lock().unwrap().clone();
        jobs.into_iter()
            .map(|j| {
                let parsed = Cron::parse(&j.cron);
                let next_ms = parsed.as_ref().ok().filter(|_| j.enabled).and_then(|c| {
                    let from = Local.timestamp_millis_opt(j.last_handled_ms.max(now_ms()) as i64).single()?;
                    c.next_after(from).map(|t| t.timestamp_millis() as u64)
                });
                JobView {
                    schedule: cron::describe(&j.cron),
                    next_ms,
                    running: running.contains(&j.id),
                    last: self.runs(&j.id, 1).into_iter().next(),
                    error: parsed.err(),
                    secret_names: j.secrets.iter().map(|s| s.name.clone()).collect(),
                    id: j.id,
                    name: j.name,
                    folder: j.folder,
                    prompt: j.prompt,
                    cron: j.cron,
                    enabled: j.enabled,
                    permissions: j.permissions,
                    notify: j.notify,
                    timeout_min: j.timeout_min,
                    model: j.model,
                }
            })
            .collect()
    }

    pub fn upsert(&self, input: JobInput) -> Result<String, String> {
        Cron::parse(&input.cron)?;
        if input.name.trim().is_empty() || input.prompt.trim().is_empty() {
            return Err("a job needs a name and an instruction".into());
        }
        if !Path::new(&input.folder).is_dir() {
            return Err(format!("folder does not exist: {}", input.folder));
        }
        let mut jobs = self.jobs.lock().unwrap();
        let existing = input.id.as_ref().and_then(|id| jobs.iter().position(|j| &j.id == id));
        let old_secrets: Vec<SecretEntry> = existing.map(|i| jobs[i].secrets.clone()).unwrap_or_default();
        let mut sealed = Vec::new();
        for s in input.secrets.iter().filter(|s| !s.name.trim().is_empty()) {
            let name = s.name.trim().to_string();
            if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(format!("secret name {name:?} must be letters, digits or _ (it becomes an environment variable)"));
            }
            if s.value.is_empty() {
                if let Some(old) = old_secrets.iter().find(|o| o.name == name) {
                    sealed.push(old.clone());
                }
            } else {
                sealed.push(SecretEntry { name, sealed: secrets::seal(&s.value)? });
            }
        }
        let now = now_ms();
        let job = Job {
            id: input.id.clone().filter(|_| existing.is_some()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: input.name.trim().into(),
            folder: input.folder,
            prompt: input.prompt,
            cron: input.cron.trim().into(),
            enabled: input.enabled,
            permissions: input.permissions,
            notify: input.notify,
            timeout_min: input.timeout_min.clamp(1, 240),
            model: input.model,
            secrets: sealed,
            created_ms: existing.map_or(now, |i| jobs[i].created_ms),
            // a new or re-scheduled job starts counting from now (no instant catch-up)
            last_handled_ms: now,
        };
        let id = job.id.clone();
        match existing {
            Some(i) => jobs[i] = job,
            None => jobs.push(job),
        }
        self.save(&jobs)?;
        info!("job   saved {id}");
        Ok(id)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        let j = jobs.iter_mut().find(|j| j.id == id).ok_or("no such job")?;
        j.enabled = enabled;
        if enabled {
            j.last_handled_ms = now_ms(); // re-enabling does not replay the off period
        }
        self.save(&jobs)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.retain(|j| j.id != id);
        self.save(&jobs)?;
        let _ = std::fs::remove_dir_all(self.runs_dir(id));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(perm: Permissions) -> Job {
        Job {
            id: "j1".into(),
            name: "Site stats".into(),
            folder: std::env::temp_dir().display().to_string(),
            prompt: "Report views".into(),
            cron: "0 9 * * *".into(),
            enabled: true,
            permissions: perm,
            notify: "always".into(),
            timeout_min: 10,
            model: None,
            secrets: vec![],
            created_ms: 0,
            last_handled_ms: 0,
        }
    }

    #[test]
    fn permissions_become_allowed_tools_and_nothing_else() {
        let a = build_args(&job(Permissions { read: true, web_fetch: true, commands: vec!["curl *".into(), " ".into()], ..Default::default() }));
        let i = a.iter().position(|x| x == "--allowedTools").unwrap();
        assert_eq!(a[i + 1], "Read,Glob,Grep,WebFetch,Bash(curl *)");
        assert!(!a.contains(&"--permission-mode".to_string()));
        assert_eq!(&a[..2], &["-p".to_string(), "Report views".to_string()]);
        let none = build_args(&job(Permissions::default()));
        assert!(!none.contains(&"--allowedTools".to_string()), "no permissions = no tools");
        let auto = build_args(&job(Permissions { full_auto: true, read: true, ..Default::default() }));
        assert!(auto.windows(2).any(|w| w == ["--permission-mode", "auto"]));
        assert!(!auto.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn parses_report_status_and_errors() {
        let out = r###"{"type":"result","is_error":false,"result":"## Views\n| day | n |\n|---|---|\n| Mon | 120 |\n\nSTATUS: attention - views dropped 40% on Monday","session_id":"s-1","total_cost_usd":0.12,"num_turns":4}"###;
        let p = parse_result(out, Some(0));
        assert_eq!(p.status, "attention");
        assert_eq!(p.summary, "views dropped 40% on Monday");
        assert!(p.report.starts_with("## Views") && !p.report.contains("STATUS"));
        assert_eq!(p.session_id.as_deref(), Some("s-1"));
        assert_eq!(p.cost_usd, Some(0.12));

        let ok = parse_result(r#"{"result":"All good.\n**STATUS: ok - nothing unusual**"}"#, Some(0));
        assert_eq!((ok.status.as_str(), ok.summary.as_str()), ("ok", "nothing unusual"));

        let nostatus = parse_result(r##"{"result":"# Weekly views\nUp 5%."}"##, Some(0));
        assert_eq!((nostatus.status.as_str(), nostatus.summary.as_str()), ("ok", "Weekly views"));

        let err = parse_result("Error: not logged in", Some(1));
        assert_eq!(err.status, "error");
        assert!(err.error.unwrap().contains("not logged in"));
        let api_err = parse_result(r#"{"is_error":true,"result":"Credit balance too low"}"#, Some(1));
        assert_eq!(api_err.status, "error");
    }

    #[test]
    fn due_runs_once_for_the_latest_missed_slot() {
        let cron = Cron::parse("0 * * * *").unwrap(); // hourly
        let t = |h: u32, m: u32| Local.with_ymd_and_hms(2026, 10, 1, h, m, 0).earliest().unwrap().timestamp_millis() as u64;
        assert_eq!(due(&cron, t(9, 0), t(9, 30)), None, "next slot 10:00 not reached");
        assert_eq!(due(&cron, t(9, 0), t(10, 0)), Some(t(10, 0)));
        assert_eq!(due(&cron, t(9, 0), t(13, 20)), Some(t(13, 0)), "off for 4 hours -> one catch-up run");
        assert_eq!(due(&cron, t(13, 0), t(13, 20)), None, "already handled");
    }

    #[test]
    fn executes_with_timeout_and_no_window() {
        let cmd = which::which("cmd").unwrap();
        let tmp = std::env::temp_dir();
        let ok = execute(&cmd, &["/c".into(), "echo %CW_TEST%".into()], &tmp, &[("CW_TEST".into(), "hello".into())], Duration::from_secs(20)).unwrap();
        assert_eq!(ok.exit_code, Some(0));
        assert!(ok.stdout.contains("hello"));
        let slow = execute(&cmd, &["/c".into(), "ping -n 30 127.0.0.1 >nul".into()], &tmp, &[], Duration::from_secs(1)).unwrap();
        assert!(slow.timed_out);
        let t = Instant::now();
        let _ = execute(&cmd, &["/c".into(), "ping -n 30 127.0.0.1 >nul".into()], &tmp, &[], Duration::from_secs(1)).unwrap();
        assert!(t.elapsed() < Duration::from_secs(10), "timeout kills the whole tree, took {:?}", t.elapsed());
    }

    #[test]
    fn manager_saves_jobs_seals_secrets_and_records_runs() {
        let dir = std::env::temp_dir().join(format!("cw-jobs-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<RunRecord>();
        let tx = Mutex::new(tx);
        // a fake "claude": cmd that prints a canned JSON result
        let m = JobManager::new(&dir, || which::which("cmd").ok(), Arc::new(move |r: &RunRecord| { let _ = tx.lock().unwrap().send(r.clone()); }));
        let id = m
            .upsert(JobInput {
                id: None,
                name: "Stats".into(),
                folder: dir.display().to_string(),
                prompt: "x".into(),
                cron: "0 9 * * *".into(),
                enabled: true,
                permissions: Permissions::default(),
                notify: "always".into(),
                timeout_min: 5,
                model: None,
                secrets: vec![SecretInput { name: "CF_API_TOKEN".into(), value: "super-secret-token".into() }],
            })
            .unwrap();
        let on_disk = std::fs::read_to_string(dir.join("jobs.json")).unwrap();
        assert!(!on_disk.contains("super-secret-token"), "secret sealed at rest");
        let view = m.list();
        assert_eq!(view[0].secret_names, ["CF_API_TOKEN"]);
        assert_eq!(view[0].schedule, "daily at 09:00");
        assert!(view[0].next_ms.is_some());

        // editing without a value keeps the sealed secret
        m.upsert(JobInput {
            id: Some(id.clone()),
            name: "Stats".into(),
            folder: dir.display().to_string(),
            prompt: "x".into(),
            cron: "30 9 * * *".into(),
            enabled: true,
            permissions: Permissions::default(),
            notify: "attention".into(),
            timeout_min: 5,
            model: None,
            secrets: vec![SecretInput { name: "CF_API_TOKEN".into(), value: String::new() }],
        })
        .unwrap();
        assert_eq!(m.list()[0].secret_names, ["CF_API_TOKEN"]);
        assert_eq!(m.list()[0].notify, "attention");

        assert!(m.upsert(JobInput { id: None, name: "bad".into(), folder: dir.display().to_string(), prompt: "x".into(), cron: "nope".into(), enabled: true, permissions: Permissions::default(), notify: "always".into(), timeout_min: 5, model: None, secrets: vec![] }).is_err());

        // a manual run: cmd receives claude's args and fails (exit != 0) -> recorded as an error run
        m.run_now(&id).unwrap();
        let first = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(first.status, "running");
        let done = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(done.trigger, "manual");
        assert_ne!(done.status, "running");
        assert_eq!(m.runs(&id, 10).len(), 1);
        m.delete(&id).unwrap();
        assert!(m.list().is_empty());
    }
}
