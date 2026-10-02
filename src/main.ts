import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { enable as autostartOn, disable as autostartOff, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";

import type { AppInfo, HookEvent, PastSession, Persisted, Session, Settings } from "./types";
import { TermHost } from "./terminal";
import { displayName, isActive, renderActive, renderSidebar, STATUS_LABEL } from "./sidebar";
import { Rail, type PanelId, type RailState } from "./rail";
import { GitPanel } from "./panels/git";
import { RoadmapsPanel } from "./panels/roadmaps";
import { ActivityPanel } from "./panels/activity";
import { SearchPanel, type SessionHits } from "./panels/search";
import { GitView } from "./gitview/view";
import { JobsPanel, STATUS_TEXT, type RunRecord } from "./jobs/panel";
import { JobReport } from "./jobs/report";
import { ago, applyHook, basename, dropText, firstLine, relativeTo, rootFor, sessionRank, topLevel } from "./status";

// ---------------------------------------------------------------- state

// surface frontend errors in the `tauri dev` terminal
const uiLog = (level: string, msg: unknown) => { invoke("ui_log", { level, msg: String(msg) }).catch(() => {}); };
window.addEventListener("error", (e) => uiLog("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => uiLog("error", `unhandled: ${e.reason}`));

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let info: AppInfo;
let roots: string[] = [];
let settings: Settings = { notifyDone: true, notifyNeeds: true };
const sessions = new Map<string, Session>();
const hosts = new Map<string, TermHost>();
let activeId: string | null = null;
const collapsed = new Set<string>();
const pastExpanded = new Set<string>();
let past: PastSession[] = []; // transcripts on disk, newest first (refreshed in the background)
let notifyOk = false;
let ui: RailState & { gitNewestFirst?: boolean } = { panel: "active", collapsed: false, width: 300, gitNewestFirst: true };
let rail: Rail;
let git: GitPanel;
let roadmapsPanel: RoadmapsPanel;
let activity: ActivityPanel;
let searchPanel: SearchPanel;
let gitView: GitView;
let jobsPanel: JobsPanel;
let jobReport: JobReport;
let jobSessionIds = new Set<string>(); // transcripts of job runs - not shown as sessions

function newSession(id: string, cwd: string, patch: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id, cwd, name: "", autoTitle: "", createdAt: now, lastEvent: now, lastMsg: "",
    status: "starting", unread: 0, hasTranscript: false, external: false, running: false, ...patch,
  };
}

// ---------------------------------------------------------------- persistence

let saveTimer: number | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const data: Persisted = {
      version: 1, roots, sessions: [...sessions.values()], activeId, settings,
      // folding the panel for the Git view is temporary - save the user's own choice
      ui: { ...ui, ...(rail ? rail.state : {}), ...(panelBeforeLog !== null ? { collapsed: panelBeforeLog } : {}),
            gitNewestFirst: git ? git.prefs.newestFirst : ui.gitNewestFirst },
    };
    invoke("store_save", { value: data }).catch((e) => console.error("save", e));
  }, 400);
}

async function load() {
  const data = (await invoke("store_load")) as Persisted | null;
  if (data && data.version === 1) {
    roots = data.roots ?? [];
    settings = { ...settings, ...(data.settings ?? {}) };
    ui = { ...ui, ...(data.ui ?? {}) };
    // after an app restart nothing runs (every session is resumable); after a
    // UI reload the Rust side may still own live consoles - re-attach to those
    const alive = new Set<string>(await invoke("sessions_running"));
    for (const s of data.sessions ?? []) {
      const live = alive.has(s.id);
      sessions.set(s.id, { ...s, running: live, status: live ? (s.status === "suspended" || s.status === "exited" ? "idle" : s.status) : "suspended" });
      if (live) host(s.id).notice("reconnected (earlier output is not shown)");
    }
    activeId = data.activeId && sessions.has(data.activeId) ? data.activeId : null;
  }
}

// ---------------------------------------------------------------- rendering

function isVisible(id: string): boolean {
  return id === activeId && document.hasFocus() && document.visibilityState === "visible";
}

function render() {
  const all = [...sessions.values()];
  renderActive($("activeList"), all, roots, activeId);
  renderSidebar($("groups"), {
    sessions: all, past, roots, activeId,
    filter: ($("search") as HTMLInputElement).value, collapsed, pastExpanded,
  });
  if (rail && rail.state.panel === "git" && !rail.state.collapsed) git.render(); // live "session here" dots
  renderSummary();
  renderBar();
  if (rail) {
    const c = counts();
    if (c.needs) rail.badge("active", String(c.needs), "needs");
    else rail.badge("active", c.unread ? String(c.unread) : "", "unread");
  }
}

// ---------------------------------------------------------------- tool windows

function panelOf(id: PanelId): { actions(): string; onAction(a: string): boolean } | null {
  return id === "git" ? git : id === "roadmaps" ? roadmapsPanel : id === "activity" ? activity : id === "jobs" ? jobsPanel : null;
}

// ---------------------------------------------------------------- scheduled jobs

function openJobReport(jobId: string, runId?: string) {
  if (gitView.isOpen) gitView.hide();
  void jobReport.open(jobId, runId);
  renderBar();
  ($("jobview") as HTMLElement).focus();
}

function closeJobReport() {
  jobReport.hide();
  renderBar();
  if (activeId) hosts.get(activeId)?.show();
}

function jobBadge() {
  const n = jobsPanel.attentionCount();
  const running = jobsPanel.jobs.filter((j) => j.running).length;
  if (n) rail.badge("jobs", String(n), "needs");
  else rail.badge("jobs", running ? String(running) : "", "info");
}

async function refreshJobSessions() {
  try {
    jobSessionIds = new Set(await invoke<string[]>("job_session_ids"));
  } catch {
    /* jobs not available */
  }
}

function onJobRun(r: RunRecord) {
  void jobsPanel.load().then(() => {
    jobBadge();
    if (jobReport.isOpen && jobReport.currentJob === r.job_id) void jobReport.refresh(r.status === "running" ? undefined : r.id);
  });
  if (r.status === "running") return;
  const job = jobsPanel.jobs.find((j) => j.id === r.job_id);
  const bad = r.status !== "ok";
  activity.add(bad ? (r.status === "attention" ? "job-attention" : "job-error") : "job-ok",
    `${r.job_name}: ${STATUS_TEXT[r.status] ?? r.status}${r.summary ? " - " + r.summary : ""}`, job?.folder ?? "", undefined);
  if (r.session_id) {
    jobSessionIds.add(r.session_id);
    refreshPastSoon();
  }
  const notifyRule = job?.notify ?? "always";
  if (notifyRule === "never" || (notifyRule === "attention" && !bad)) return;
  const title = `${bad ? "⚠" : "⏱"} ${r.job_name}: ${STATUS_TEXT[r.status] ?? r.status}`;
  invoke("toast", { title, body: r.summary || "Open the report in ContextWire", session: `job:${r.job_id}` }).catch(() => {
    if (notifyOk) sendNotification({ title, body: r.summary });
  });
  if (bad) invoke("attention", { critical: true }).catch(() => {});
}

/** Resume a job run's conversation as a normal session to dig deeper. */
function continueJobSession(run: RunRecord, folder: string) {
  if (!run.session_id) return;
  jobSessionIds.delete(run.session_id); // it becomes a normal session now
  if (!sessions.has(run.session_id)) {
    sessions.set(run.session_id, newSession(run.session_id, folder, {
      name: `${run.job_name} (job run)`, status: "suspended", hasTranscript: true, lastEvent: Date.now(),
    }));
  }
  select(run.session_id);
}

function onPanelChange(st: RailState, opened: PanelId | null) {
  ui = { ...ui, ...st };
  $("panelActions").innerHTML = panelOf(st.panel)?.actions() ?? "";
  if (opened === "git") void git.load();
  if (opened === "roadmaps") void roadmapsPanel.load();
  if (opened === "activity") { activity.markSeen(); activity.render(); }
  if (opened === "search") { searchPanel.render(); searchPanel.focus(); }
  if (opened === "jobs") void jobsPanel.load().then(jobBadge);
  if (opened === "active" || opened === "all") render();
  save();
}

/** OK/Cancel in the app's own dialog (browser confirm() would block the webview). */
function confirmDialog(title: string, text: string): Promise<boolean> {
  const dlg = $("dlgConfirm") as HTMLDialogElement;
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
}

function openSearchHit(r: SessionHits) {
  if (sessions.has(r.id)) return select(r.id);
  if (!past.some((p) => p.id === r.id)) {
    past.push({ id: r.id, cwd: r.cwd, title: r.title, first_prompt: "", modified_ms: r.modified_ms, size: 0 });
  }
  resumePast(r.id);
}

function setupPanels() {
  rail = new Rail({ panel: ui.panel, collapsed: ui.collapsed, width: ui.width }, (st, opened) => {
    if (git) onPanelChange(st, opened);
  });
  gitView = new GitView({ onClose: closeLog, log: uiLog });
  jobsPanel = new JobsPanel({
    openReport: (id) => openJobReport(id),
    log: uiLog,
    pickFolder: async () => {
      const f = await openDialog({ directory: true, title: "Folder the agent works in" });
      return typeof f === "string" ? f : null;
    },
    defaultFolder: () => recentRoot() ?? roots[0] ?? "",
    onChanged: () => {
      jobBadge();
      if (jobReport.isOpen) void jobReport.refresh();
    },
  });
  jobReport = new JobReport({
    onClose: closeJobReport,
    edit: (job) => jobsPanel.openEditor(job),
    continueSession: continueJobSession,
    jobs: () => jobsPanel.jobs,
    log: uiLog,
  });
  git = new GitPanel({
    openLog,
    roots: () => roots,
    sessions: () => [...sessions.values()],
    select: (id) => select(id),
    newSessionIn: (cwd) => openNew(undefined, cwd),
    confirm: confirmDialog,
    log: uiLog,
    activity: (kind, text, cwd) => activity.add(kind, text, cwd),
  }, { newestFirst: ui.gitNewestFirst });
  roadmapsPanel = new RoadmapsPanel({ roots: () => roots, newSessionIn: (cwd) => openNew(undefined, cwd), log: uiLog });
  activity = new ActivityPanel(
    (it) => {
      if (it.sid && sessions.has(it.sid)) select(it.sid);
      else if (it.sid && past.some((p) => p.id === it.sid)) resumePast(it.sid);
    },
    (n) => rail.badge("activity", n ? String(n) : "", "info"),
  );
  searchPanel = new SearchPanel(() => roots, openSearchHit);
  $("panelActions").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pa]");
    const p = panelOf(rail.state.panel);
    if (b && p && p.onAction(b.dataset.pa!)) { $("panelActions").innerHTML = p.actions(); save(); }
  };
  $("activeList").onclick = (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".sess");
    if (row?.dataset.id) select(row.dataset.id);
  };
}

function counts() {
  const all = [...sessions.values()];
  return {
    needs: all.filter((s) => s.status === "needs").length,
    working: all.filter((s) => s.status === "working").length,
    unread: all.reduce((n, s) => n + s.unread, 0),
    done: all.filter((s) => s.status === "done").length,
  };
}

function renderSummary() {
  const c = counts();
  const parts = [
    c.needs ? `<span class="c-needs">${c.needs} need you</span>` : "",
    c.working ? `<span class="c-working">${c.working} working</span>` : "",
    c.done ? `<span class="c-done">${c.done} done</span>` : "",
  ].filter(Boolean);
  $("summary").innerHTML = parts.join(" · ") || `<span class="muted">all quiet</span>`;
  const tip = ["ContextWire", c.needs && `${c.needs} need you`, c.working && `${c.working} working`, c.done && `${c.done} done`]
    .filter(Boolean).join(" · ");
  invoke("tray_status", { tooltip: tip }).catch(() => {});
  document.title = c.needs + c.unread ? `(${c.needs + c.unread}) ContextWire` : "ContextWire";
}

function renderBar() {
  const s = activeId ? sessions.get(activeId) : undefined;
  const gv = !!gitView?.isOpen || !!jobReport?.isOpen;
  $("terms").classList.toggle("hidden", gv);
  $("bar").classList.toggle("hidden", !s || gv);
  $("empty").classList.toggle("hidden", !!s);
  if (!s) return;
  $("barDot").className = `dot st-${s.status}`;
  $("barTitle").textContent = displayName(s);
  $("barSub").textContent = (s.worktree ? `worktree ${s.worktree}  ·  ` : "") + s.cwd + (s.external ? "  ·  running in a plain terminal" : "");
  $("barState").textContent = STATUS_LABEL[s.status];
  $("barState").className = `state st-${s.status}`;
  const canResume = !s.running && (s.status === "exited" || s.status === "suspended" || s.external);
  $("btnResume").classList.toggle("hidden", !canResume);
  $("btnResume").textContent = s.external ? "Adopt here" : s.hasTranscript ? "Resume" : "Start";
  $("btnClose").textContent = s.running ? "Close" : "Remove";
}

function banner(html: string | null, kind: "warn" | "err" = "warn") {
  const b = $("banner");
  b.className = `banner ${kind}${html ? "" : " hidden"}`;
  b.innerHTML = html ?? "";
}

// ---------------------------------------------------------------- sessions

function host(id: string): TermHost {
  let h = hosts.get(id);
  if (!h) {
    h = new TermHost(id, $("terms"));
    hosts.set(id, h);
  }
  return h;
}

/** Is a session we parked as "maybe open in a terminal" safe to resume now?
 *  With global hooks on, the terminal session reports SessionEnd, so trust that.
 *  Without them, fall back to the transcript having been quiet for 5 minutes. */
function externalReleased(s: Session): boolean {
  if (info?.global_hooks) return s.status === "exited";
  const p = past.find((x) => x.id === s.id);
  return !!p && Date.now() - p.modified_ms >= LIVE_ELSEWHERE_MS;
}

/** Show the Git view for a repo in the main area (optionally at a commit). */
let panelBeforeLog: boolean | null = null;
function openLog(repo: string, hash?: string) {
  // like PyCharm's Git window the log wants the full width: fold the side panel
  // while it is open and put it back on close
  if (panelBeforeLog === null) panelBeforeLog = rail.state.collapsed;
  if (!rail.state.collapsed) rail.toggle(rail.state.panel);
  void gitView.open(repo, hash);
  renderBar();
  ($("gitview") as HTMLElement).focus();
}

function closeLog() {
  gitView.hide();
  if (panelBeforeLog === false && rail.state.collapsed) rail.toggle(rail.state.panel);
  panelBeforeLog = null;
  renderBar();
  if (activeId) hosts.get(activeId)?.show();
}

function select(id: string | null) {
  if (jobReport?.isOpen) jobReport.hide();
  if (gitView?.isOpen) {
    gitView.hide();
    panelBeforeLog = null;
  }
  if (activeId && hosts.has(activeId) && activeId !== id) hosts.get(activeId)!.hide();
  activeId = id;
  const s = id ? sessions.get(id) : undefined;
  if (s) {
    s.unread = 0;
    if (s.status === "done") s.status = "idle";
    const h = host(s.id);
    h.show();
    if (s.external && !s.running && externalReleased(s)) {
      // the "may be open in a terminal" pause is re-checked on every open, not kept forever
      uiLog("info", `release ${s.id.slice(0, 8)}: no longer looks open elsewhere`);
      s.external = false;
      s.status = "suspended";
      s.lastMsg = "";
    }
    if (!s.external && !s.running && s.status === "suspended") void start(s, "resume");
    else if (s.external && !s.running) {
      h.notice("This session may still be running in a terminal (it was active in the last few minutes). Close it there first, then click \"Adopt here\" to continue it in ContextWire.");
    }
  }
  render();
  save();
}

async function start(s: Session, mode: "new" | "resume", extra: string[] = []) {
  const h = host(s.id);
  if (activeId === s.id) h.show();
  const { cols, rows } = h.size();
  const resume = mode === "resume" && s.hasTranscript;
  if (extra.length) s.extraArgs = extra;
  const args = resume ? ["--resume", s.id] : ["--session-id", s.id, ...(s.name ? ["--name", s.name] : []), ...(s.extraArgs ?? [])];
  s.status = "starting";
  s.external = false;
  s.lastEvent = Date.now();
  try {
    await invoke("session_spawn", { id: s.id, cwd: s.cwd, args, cols, rows });
    s.running = true;
    if (resume) h.notice(`resumed ${s.id.slice(0, 8)} in ${s.cwd}`);
    activity.add("start", `${displayName(s)} ${resume ? "resumed" : "started"}`, s.cwd, s.id);
  } catch (e) {
    s.status = "exited";
    h.notice(`could not start claude: ${e}`);
    uiLog("warn", `start ${s.id.slice(0, 8)} failed: ${e}`);
  }
  render();
  save();
}

async function createSession(cwd: string, name: string, worktree: boolean) {
  const s = newSession(crypto.randomUUID(), cwd, { name });
  sessions.set(s.id, s);
  select(s.id);
  await start(s, "new", worktree ? ["--worktree"] : []);
}

async function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.running) await invoke("session_kill", { id }).catch(() => {});
  hosts.get(id)?.dispose();
  hosts.delete(id);
  sessions.delete(id);
  refreshPastSoon(); // it moves to "Earlier sessions"
  if (activeId === id) {
    // move to another session that is already running - never start one just
    // because it happens to be next in the list
    const next = [...sessions.values()].filter((x) => x.running).sort((a, b) => b.lastEvent - a.lastEvent)[0];
    activeId = null;
    if (next) select(next.id);
    else hosts.forEach((h) => h.hide());
  }
  render();
  save();
}

/** Sessions in Active-panel order: needs you, unread, most recent. */
function activeOrder(): Session[] {
  return [...sessions.values()].filter(isActive).sort(sessionRank);
}

function nextAttention(): Session | undefined {
  const all = [...sessions.values()].filter((s) => s.id !== activeId);
  return all.find((s) => s.status === "needs") ?? all.filter((s) => s.unread).sort((a, b) => b.lastEvent - a.lastEvent)[0];
}

// ---------------------------------------------------------------- events

function onHook(ev: HookEvent) {
  const id = ev.cw_tab ?? ev.session_id;
  // an event without a name (unreadable hook payload) must not create a blank session
  if (!id || !ev.hook_event_name) return;
  let s = sessions.get(id);
  if (!s) {
    if (ev.hook_event_name === "SessionEnd") return;
    // a session we did not start: reported by the opt-in global hooks
    s = newSession(id, String(ev.cwd ?? ""), { external: true, status: "idle", hasTranscript: true });
    sessions.set(id, s);
  }
  // with --worktree Claude runs (and keeps its transcript) in a new folder
  // inside the repo; follow it so resume and grouping use the real location
  if (ev.hook_event_name === "SessionStart" && typeof ev.cwd === "string" && ev.cwd && ev.cwd !== s.cwd
      && rootFor(ev.cwd, [s.cwd]) === s.cwd && /[\\/]\.claude[\\/]worktrees[\\/]/i.test(ev.cwd)) {
    s.worktree = basename(ev.cwd);
    // it now lives in the worktree: starting it again must not create another one
    s.extraArgs = s.extraArgs?.filter((a) => a !== "--worktree");
    uiLog("info", `session ${s.id.slice(0, 8)} runs in worktree ${s.worktree}`);
    s.cwd = ev.cwd;
  }
  const t = applyHook(s, ev, isVisible(s.id));
  if (t.status && t.status !== s.status) uiLog("info", `status ${s.id.slice(0, 8)} ${s.status} -> ${t.status} (${ev.hook_event_name})${t.notify ? ` notify=${t.notify}` : ""}`);
  if (t.status) s.status = t.status;
  if (t.msg !== undefined) s.lastMsg = t.msg;
  if (t.prompt && !s.autoTitle) s.autoTitle = t.prompt;
  if (t.hasTranscript) s.hasTranscript = true;
  if (t.unread) s.unread += 1;
  s.lastEvent = Date.now();
  const name = displayName(s);
  if (ev.hook_event_name === "Stop" && typeof ev.transcript_path === "string") {
    // show what Claude actually said; the toast waits for it (max ~1 s)
    const sess = s;
    const kind = t.notify;
    void freshReply(sess.id, ev.transcript_path).then((reply) => {
      if (reply) sess.lastMsg = "claude: " + reply;
      activity.add("done", `${name} finished${reply ? ": " + reply : ""}`, sess.cwd, sess.id);
      if (kind) notify(sess, kind);
      render();
      save();
    });
  } else if (t.notify) notify(s, t.notify);
  if (ev.hook_event_name === "Stop" && typeof ev.transcript_path !== "string") activity.add("done", `${name} finished`, s.cwd, s.id);
  else if (t.status === "needs") activity.add("needs", `${name} needs you${t.msg ? ": " + t.msg : ""}`, s.cwd, s.id);
  else if (ev.hook_event_name === "SessionEnd") activity.add("end", `${name} ended`, s.cwd, s.id);
  if (ev.hook_event_name === "Stop" || ev.hook_event_name === "SessionEnd") refreshPastSoon();
  render();
  save();
}

function notify(s: Session, kind: "needs" | "done") {
  if (kind === "needs" && !settings.notifyNeeds) return;
  if (kind === "done" && !settings.notifyDone) return;
  invoke("attention", { critical: kind === "needs" }).catch(() => {});
  const where = basename(rootFor(s.cwd, roots));
  const title = kind === "needs" ? `⚠ ${displayName(s)} needs you` : `✓ ${displayName(s)} is done`;
  const body = `${where}${s.lastMsg ? " · " + s.lastMsg : ""}`;
  // our own toast opens the session when clicked; fall back to the plugin
  invoke("toast", { title, body, session: s.id }).catch((e) => {
    uiLog("warn", `toast: ${e}`);
    if (notifyOk) sendNotification({ title, body });
  });
}

/** Last reply seen per session, to tell a fresh reply from the previous turn's. */
const lastReplies = new Map<string, string>();

/** Claude writes the final reply to the transcript a moment *after* the Stop
 *  hook fires, so poll briefly until a reply different from the last one shows
 *  up (about 3 s at most). Returns null if nothing new appeared. */
async function freshReply(id: string, path: string): Promise<string | null> {
  const before = lastReplies.get(id);
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 300 : 400));
    const reply = await withTimeout(invoke<string | null>("last_reply", { path }), 1000);
    if (reply && reply !== before) {
      lastReplies.set(id, reply);
      return reply;
    }
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function wireEvents() {
  await listen<{ id: string; data: string }>("pty-output", (e) => {
    hosts.get(e.payload.id)?.write(decode(e.payload.data));
  });
  await listen<{ id: string; code: number | null }>("pty-exit", (e) => {
    const s = sessions.get(e.payload.id);
    if (!s) return;
    s.running = false;
    s.status = "exited";
    s.lastMsg = e.payload.code ? `exited with code ${e.payload.code}` : "session ended";
    if (e.payload.code) activity.add("exit", `${displayName(s)} exited with code ${e.payload.code}`, s.cwd, s.id);
    s.lastEvent = Date.now();
    hosts.get(s.id)?.notice(`claude exited${e.payload.code ? ` (code ${e.payload.code})` : ""} · click ${s.hasTranscript ? "Resume" : "Start"} to continue`);
    render();
    save();
  });
  // errors inside event callbacks are swallowed by the event system - log them
  await listen<{ id: string | null }>("toast-clicked", (e) => {
    const id = e.payload.id;
    if (id?.startsWith("job:")) openJobReport(id.slice(4));
    else if (id && sessions.has(id)) select(id);
  });
  await listen<RunRecord>("job-run", (e) => onJobRun(e.payload));
  await listen<HookEvent>("hook-event", (e) => {
    try {
      onHook(e.payload);
    } catch (err) {
      uiLog("error", `hook handler (${e.payload.hook_event_name}): ${err instanceof Error ? err.stack ?? err.message : err}`);
    }
  });

  // looking at the window = reading the active chat
  window.addEventListener("focus", () => {
    const s = activeId ? sessions.get(activeId) : undefined;
    if (s && (s.unread || s.status === "done")) {
      s.unread = 0;
      if (s.status === "done") s.status = "idle";
      render();
      save();
    }
    if (activeId) hosts.get(activeId)?.focus();
  });
  new ResizeObserver(() => { if (activeId) hosts.get(activeId)?.refit(); }).observe($("terms"));
  bindFileDrop();
}

// Files dragged from Explorer onto the console paste their paths, as in a
// terminal. Tauri takes OS drops away from the page (the HTML drop event never
// sees paths), so this listens to the webview's own drag-drop event.
function bindFileDrop() {
  const terms = $("terms");
  const overConsole = (pos: { x: number; y: number }) => {
    const r = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(pos.x / r, pos.y / r);
    return !!el && !!el.closest("#terms") && !!activeId && hosts.has(activeId);
  };
  getCurrentWebview()
    .onDragDropEvent(({ payload: p }) => {
      if (p.type === "over") terms.classList.toggle("dropping", overConsole(p.position));
      else if (p.type === "enter") terms.classList.toggle("dropping", overConsole(p.position));
      else if (p.type === "leave") terms.classList.remove("dropping");
      else if (p.type === "drop") {
        terms.classList.remove("dropping");
        if (!overConsole(p.position) || !p.paths.length) return;
        hosts.get(activeId!)!.paste(dropText(p.paths));
        uiLog("info", `dropped ${p.paths.length} path(s) on ${activeId!.slice(0, 8)}`);
      }
    })
    .catch((e) => uiLog("warn", `drag-drop listener: ${e}`));
}

// ---------------------------------------------------------------- dialogs

async function listDirs(path: string): Promise<{ name: string; git: boolean }[]> {
  try {
    return await invoke("list_dirs", { path });
  } catch {
    return [];
  }
}

/** Workspace of the session in view, else the most recently used one. */
function recentRoot(): string | undefined {
  const s = activeId ? sessions.get(activeId) : undefined;
  if (s) return rootFor(s.cwd, roots);
  const recent = [...sessions.values()].sort((a, b) => b.lastEvent - a.lastEvent)[0]?.cwd ?? past[0]?.cwd;
  const r = recent ? rootFor(recent, roots) : undefined;
  return r && roots.includes(r) ? r : roots[0];
}

function openNew(prefillCwd?: string, root?: string) {
  const dlg = $("dlgNew") as HTMLDialogElement;
  const sel = $("newRoot") as HTMLSelectElement;
  const cwd = $("newCwd") as HTMLInputElement;
  const lastRoot = root ? rootFor(root, roots) : recentRoot();
  sel.innerHTML = roots.map((r) => `<option value="${esc(r)}"${r === lastRoot ? " selected" : ""}>${esc(basename(r))} — ${esc(r)}</option>`).join("")
    + `<option value="">Other folder…</option>`;
  cwd.value = prefillCwd ?? root ?? sel.value;
  ($("newName") as HTMLInputElement).value = "";
  ($("newWorktree") as HTMLInputElement).checked = false;
  $("newErr").textContent = "";
  void fillRepos(lastRoot && roots.includes(lastRoot) ? lastRoot : sel.value);
  dlg.showModal();
  cwd.focus();
}

async function fillRepos(root: string) {
  const el = $("newRepos");
  if (!root) { el.innerHTML = ""; return; }
  const dirs = await listDirs(root);
  el.innerHTML = dirs.length
    ? `<span class="muted small">Repos in ${esc(basename(root))}:</span> ` +
      dirs.map((d) => `<button type="button" class="chip${d.git ? " git" : ""}" data-sub="${esc(d.name)}">${esc(d.name)}</button>`).join("")
    : "";
}

async function submitNew(e: Event) {
  e.preventDefault();
  const cwd = ($("newCwd") as HTMLInputElement).value.trim();
  if (!cwd || !(await invoke("path_is_dir", { path: cwd }))) {
    $("newErr").textContent = "That folder does not exist.";
    return;
  }
  const worktree = ($("newWorktree") as HTMLInputElement).checked;
  if (worktree) {
    // claude --worktree exits at once in a folder that is not a git repo or that
    // Claude has not been trusted in yet - say so here instead of failing later
    const st: { git: boolean; trusted: boolean } = await invoke("folder_status", { path: cwd });
    if (!st.git) {
      $("newErr").textContent = "A worktree needs a git repository - this folder is not inside one.";
      return;
    }
    if (!st.trusted) {
      $("newErr").textContent = "Claude has not been trusted in this folder yet, and --worktree needs that. Untick the worktree option, start once, accept Claude's trust prompt - after that worktree sessions work here.";
      return;
    }
  }
  if (!roots.some((r) => rootFor(cwd, [r]) === r)) roots.push(cwd); // new workspace root
  ($("dlgNew") as HTMLDialogElement).close();
  await createSession(cwd, ($("newName") as HTMLInputElement).value.trim(), worktree);
}

const LIVE_ELSEWHERE_MS = 5 * 60 * 1000;
let pastBusy = false;
let pastTimer: number | undefined;
/** Re-read past sessions from ~/.claude/projects (what `claude --resume` lists). */
async function refreshPast() {
  if (pastBusy) return;
  pastBusy = true;
  try {
    const all: PastSession[] = await invoke("past_sessions", { limit: 400 });
    past = all.filter((p) => !jobSessionIds.has(p.id)); // job runs live in the Jobs panel
    render();
  } catch (e) {
    uiLog("error", `past sessions: ${e}`);
  } finally {
    pastBusy = false;
  }
}
/** A turn finished or a session closed - its transcript changed; refresh soon. */
function refreshPastSoon() {
  clearTimeout(pastTimer);
  pastTimer = window.setTimeout(() => void refreshPast(), 2500);
}

async function openHistory() {
  const dlg = $("dlgHistory") as HTMLDialogElement;
  dlg.showModal();
  ($("histSearch") as HTMLInputElement).focus();
  $("histList").textContent = "loading…";
  await refreshPast();
  renderHistory();
}

function renderHistory() {
  const f = ($("histSearch") as HTMLInputElement).value.trim().toLowerCase();
  const items = past.filter((p) => !f || `${p.title} ${p.first_prompt} ${p.cwd}`.toLowerCase().includes(f));
  const groups = new Map<string, PastSession[]>();
  for (const p of items) {
    const r = rootFor(p.cwd, roots);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  }
  const now = Date.now();
  $("histList").innerHTML = items.length
    ? [...groups.entries()].map(([root, ps]) => `<h4 title="${esc(root)}">${esc(basename(root))} <span class="muted small">${esc(root)}</span></h4>` +
      ps.map((p) => {
        const open = sessions.has(p.id);
        const rel = relativeTo(p.cwd, root);
        return `<div class="hrow" data-hid="${esc(p.id)}">
          <div class="txt"><div class="t">${esc(p.title || "(untitled)")}</div>
          <div class="sub">${esc([rel, p.first_prompt && p.first_prompt !== p.title ? p.first_prompt : ""].filter(Boolean).join(" · "))}</div></div>
          <span class="when">${ago(p.modified_ms, now)}</span>
          <button>${open ? "Open" : "Resume"}</button></div>`;
      }).join("")).join("")
    : `<div class="none">No past sessions${f ? " match" : " found in ~/.claude/projects"}.</div>`;
}

function resumePast(id: string) {
  const p = past.find((x) => x.id === id);
  if (!p) return;
  ($("dlgHistory") as HTMLDialogElement).close();
  if (!sessions.has(id)) {
    // A transcript written in the last few minutes probably belongs to a claude
    // still running in some terminal: resuming it here too would put two
    // processes on one conversation. Open it paused ("Adopt here") instead.
    const maybeLive = Date.now() - p.modified_ms < LIVE_ELSEWHERE_MS;
    sessions.set(id, newSession(id, p.cwd, {
      autoTitle: firstLine(p.title, 80), status: maybeLive ? "idle" : "suspended", hasTranscript: true,
      lastEvent: p.modified_ms, external: maybeLive, lastMsg: maybeLive ? "may be open in a terminal" : "",
    }));
  }
  select(id);
}

async function openSettings() {
  info = await invoke("app_info");
  ($("setNotifyDone") as HTMLInputElement).checked = settings.notifyDone;
  ($("setNotifyNeeds") as HTMLInputElement).checked = settings.notifyNeeds;
  ($("setGlobal") as HTMLInputElement).checked = info.global_hooks;
  $("setUserSettings").textContent = info.user_settings;
  const auto = $("setAutostart") as HTMLInputElement;
  auto.disabled = !info.autostart_managed;
  auto.checked = info.autostart_managed ? await autostartIsOn().catch(() => false) : false;
  if (!info.autostart_managed) auto.parentElement!.title = "Only available in the installed (release) build";
  renderRoots();
  $("setInfo").innerHTML = `v${esc(info.version)} · claude: ${esc(info.claude ?? "NOT FOUND")} · hook port ${esc(info.hook_port ?? "-")}<br>data: ${esc(info.data_dir)}<br>log: ${esc(info.log_file)}`;
  $("setDiag").textContent = "Copy diagnostics";
  ($("dlgSettings") as HTMLDialogElement).showModal();
}

function renderRoots() {
  $("setRoots").innerHTML = roots.length
    ? roots.map((r, i) => `<div class="rootrow"><span title="${esc(r)}">${esc(r)}</span><button type="button" data-rmroot="${i}">Remove</button></div>`).join("")
    : `<div class="muted small">No workspaces yet.</div>`;
}

/** Rust facts + log tail, plus a session summary: status and folder only -
 *  no prompts, titles or messages, so it is safe to paste anywhere. */
async function diagnosticsText(): Promise<string> {
  const base: string = await invoke("diagnostics");
  const rows = [...sessions.values()].map((s) =>
    `${s.id.slice(0, 8)}  ${s.status.padEnd(9)} unread=${s.unread} running=${s.running} external=${s.external} transcript=${s.hasTranscript}  ${s.cwd}`);
  return [
    base,
    "",
    `---- sessions in the sidebar (${rows.length}) ----`,
    ...rows,
    `workspaces: ${roots.length} · past sessions known: ${past.length} · window focused: ${document.hasFocus()}`,
  ].join("\n");
}

// ---------------------------------------------------------------- startup

/** Folders Claude has been used in (transcripts + project dir names), top-level only. */
async function discoverRoots(): Promise<string[]> {
  const ps: PastSession[] = await invoke("past_sessions", { limit: 400 });
  const dirs: string[] = await invoke("project_folders");
  const tmp = (p: string) => /\\appdata\\local\\temp\\/i.test(p);
  return topLevel([...ps.map((p) => p.cwd), ...dirs].filter((p) => !tmp(p))).sort((a, b) => a.localeCompare(b));
}

async function seedRoots() {
  if (roots.length) return;
  try {
    roots = await discoverRoots();
    save();
  } catch (e) {
    console.error("seed roots", e);
  }
}

function bindUi() {
  $("btnNew").onclick = () => openNew();
  $("btnNew2").onclick = () => openNew();
  $("btnHistory").onclick = () => void openHistory();
  $("btnHistory2").onclick = () => void openHistory();
  $("btnSettings").onclick = () => void openSettings();
  $("search").oninput = () => render();

  $("groups").onclick = (e) => {
    const t = e.target as HTMLElement;
    const more = t.closest<HTMLElement>("[data-pastroot]");
    if (more) {
      const r = more.dataset.pastroot!;
      pastExpanded.has(r) ? pastExpanded.delete(r) : pastExpanded.add(r);
      render();
      return;
    }
    const gnew = t.closest<HTMLElement>("[data-newroot]");
    if (gnew) { openNew(undefined, gnew.dataset.newroot!); return; }
    const pastRow = t.closest<HTMLElement>("[data-pid]");
    if (pastRow) { resumePast(pastRow.dataset.pid!); return; }
    const row = t.closest<HTMLElement>(".sess");
    if (row) { select(row.dataset.id!); return; }
    const head = (e.target as HTMLElement).closest<HTMLElement>(".ghead");
    if (head) {
      const r = head.dataset.root!;
      collapsed.has(r) ? collapsed.delete(r) : collapsed.add(r);
      render();
    }
  };

  $("btnResume").onclick = () => {
    const s = activeId ? sessions.get(activeId) : undefined;
    if (s) void start(s, "resume");
  };
  $("btnClose").onclick = () => { if (activeId) void closeSession(activeId); };
  $("btnRename").onclick = () => {
    const s = activeId ? sessions.get(activeId) : undefined;
    if (!s) return;
    const inp = $("renameInput") as HTMLInputElement;
    inp.value = displayName(s);
    ($("dlgRename") as HTMLDialogElement).showModal();
    inp.select();
  };
  ($("dlgRename") as HTMLDialogElement).addEventListener("close", () => {
    const dlg = $("dlgRename") as HTMLDialogElement;
    const s = activeId ? sessions.get(activeId) : undefined;
    if (dlg.returnValue === "ok" && s) {
      s.name = ($("renameInput") as HTMLInputElement).value.trim();
      render();
      save();
    }
    if (activeId) hosts.get(activeId)?.focus();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) => {
    b.onclick = () => b.closest("dialog")?.close("cancel");
  });

  // new-session dialog
  const sel = $("newRoot") as HTMLSelectElement;
  sel.onchange = async () => {
    if (!sel.value) {
      const picked = await openDialog({ directory: true, title: "Choose a folder for the session" });
      if (typeof picked === "string") ($("newCwd") as HTMLInputElement).value = picked;
      $("newRepos").innerHTML = "";
      return;
    }
    ($("newCwd") as HTMLInputElement).value = sel.value;
    void fillRepos(sel.value);
  };
  $("newBrowse").onclick = async () => {
    const picked = await openDialog({ directory: true, defaultPath: ($("newCwd") as HTMLInputElement).value || undefined });
    if (typeof picked === "string") ($("newCwd") as HTMLInputElement).value = picked;
  };
  $("newRepos").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sub]");
    if (b) ($("newCwd") as HTMLInputElement).value = `${sel.value.replace(/[\\/]+$/, "")}\\${b.dataset.sub}`;
  };
  $("newGo").onclick = (e) => void submitNew(e);

  // history dialog
  $("histClose").onclick = () => ($("dlgHistory") as HTMLDialogElement).close();
  $("histSearch").oninput = () => renderHistory();
  $("histList").onclick = (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-hid]");
    if (r) resumePast(r.dataset.hid!);
  };

  // settings dialog
  ($("setNotifyDone") as HTMLInputElement).onchange = (e) => { settings.notifyDone = (e.target as HTMLInputElement).checked; save(); };
  ($("setNotifyNeeds") as HTMLInputElement).onchange = (e) => { settings.notifyNeeds = (e.target as HTMLInputElement).checked; save(); };
  ($("setAutostart") as HTMLInputElement).onchange = async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    try { await (on ? autostartOn() : autostartOff()); } catch (err) { console.error(err); }
    (e.target as HTMLInputElement).checked = await autostartIsOn().catch(() => false);
  };
  ($("setGlobal") as HTMLInputElement).onchange = async (e) => {
    const el = e.target as HTMLInputElement;
    try {
      el.checked = await invoke("global_hooks_set", { enable: el.checked });
      $("setGlobalHelp").classList.remove("err");
    } catch (err) {
      el.checked = !el.checked;
      $("setGlobalHelp").textContent = `Could not change ${info.user_settings}: ${err}`;
      $("setGlobalHelp").classList.add("err");
    }
  };
  $("setAddRoot").onclick = async () => {
    const picked = await openDialog({ directory: true, title: "Add a workspace folder" });
    if (typeof picked === "string" && !roots.includes(picked)) {
      roots.push(picked);
      renderRoots(); render(); save();
    }
  };
  $("setFindRoots").onclick = async () => {
    const found = await discoverRoots().catch(() => [] as string[]);
    const added = found.filter((f) => !roots.some((r) => r.toLowerCase() === f.toLowerCase()));
    roots.push(...added);
    renderRoots(); render(); save();
    $("setFindRoots").textContent = added.length ? `Added ${added.length}` : "Nothing new found";
  };
  $("setDiag").onclick = async () => {
    const btn = $("setDiag");
    try {
      await navigator.clipboard.writeText(await diagnosticsText());
      btn.textContent = "Copied - paste it to Claude";
    } catch (e) {
      btn.textContent = `Copy failed: ${e}`;
    }
  };
  $("setLogs").onclick = () => { invoke("open_logs").catch((e) => uiLog("warn", `open logs: ${e}`)); };
  $("setRoots").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rmroot]");
    if (b) { roots.splice(Number(b.dataset.rmroot), 1); renderRoots(); render(); save(); }
  };
  ($("dlgSettings") as HTMLDialogElement).addEventListener("close", () => { if (activeId) hosts.get(activeId)?.focus(); });
  ($("dlgNew") as HTMLDialogElement).addEventListener("close", () => { if (activeId) hosts.get(activeId)?.focus(); });

  // Ctrl+1..9 / Ctrl+Tab move between sessions (same order as the Active panel);
  // Claude's console does not use these keys
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const list = activeOrder();
    if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
      const s = list[Number(e.key) - 1];
      e.preventDefault(); e.stopPropagation();
      if (s) select(s.id);
      return;
    }
    if (e.key === "Tab" && list.length) {
      e.preventDefault(); e.stopPropagation();
      const i = list.findIndex((s) => s.id === activeId);
      const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      select(next.id);
    }
  }, true);

  // other shortcuts use Ctrl+Shift so plain Ctrl keys keep working inside Claude
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.shiftKey)) return;
    const k = e.key.toLowerCase();
    const act: Record<string, () => void> = {
      n: () => openNew(),
      h: () => void openHistory(),
      u: () => { const s = nextAttention(); if (s) select(s.id); },
      f: () => rail.show("search"),
    };
    if (act[k]) { e.preventDefault(); e.stopPropagation(); act[k](); }
  }, true);

  setInterval(() => render(), 30000); // keep "5m ago" labels fresh
  setInterval(() => void refreshPast(), 60000); // sessions started elsewhere show up too
}

async function main() {
  uiLog("info", "ui starting");
  info = await invoke("app_info");
  await load();
  setupPanels();
  bindUi();
  await activity.load();
  await seedRoots();
  await refreshJobSessions();
  await refreshPast(); // select() below needs transcript times for the open-elsewhere check
  void jobsPanel.load().then(jobBadge);
  // the panel remembered from last time is open but was never "opened" - load it now
  // that the workspaces are known (otherwise Git said "no repos found")
  if (!rail.state.collapsed) onPanelChange(rail.state, rail.state.panel);
  await wireEvents();
  notifyOk = await isPermissionGranted().catch(() => false);
  if (!notifyOk) notifyOk = (await requestPermission().catch(() => "denied")) === "granted";
  const problems = [
    !info.claude && "The <b>claude</b> CLI was not found on PATH - sessions cannot start.",
    info.startup_error && `Startup problem: ${esc(info.startup_error)} - status highlights may not work.`,
  ].filter(Boolean);
  if (problems.length) banner(problems.join("<br>"), "err");
  render();
  if (activeId) select(activeId);
}

void main();
