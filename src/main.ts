import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { enable as autostartOn, disable as autostartOff, isEnabled as autostartIsOn } from "@tauri-apps/plugin-autostart";

import type { AppInfo, HookEvent, PastSession, Persisted, Session, Settings } from "./types";
import { TermHost } from "./terminal";
import { displayName, renderSidebar, STATUS_LABEL } from "./sidebar";
import { ago, applyHook, basename, firstLine, relativeTo, rootFor, topLevel } from "./status";

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
    const data: Persisted = { version: 1, roots, sessions: [...sessions.values()], activeId, settings };
    invoke("store_save", { value: data }).catch((e) => console.error("save", e));
  }, 400);
}

async function load() {
  const data = (await invoke("store_load")) as Persisted | null;
  if (data && data.version === 1) {
    roots = data.roots ?? [];
    settings = { ...settings, ...(data.settings ?? {}) };
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
  renderSidebar($("groups"), {
    sessions: [...sessions.values()], past, roots, activeId,
    filter: ($("search") as HTMLInputElement).value, collapsed, pastExpanded,
  });
  renderSummary();
  renderBar();
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
  $("bar").classList.toggle("hidden", !s);
  $("empty").classList.toggle("hidden", !!s);
  if (!s) return;
  $("barDot").className = `dot st-${s.status}`;
  $("barTitle").textContent = displayName(s);
  $("barSub").textContent = s.cwd + (s.external ? "  ·  running in a plain terminal" : "");
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

function select(id: string | null) {
  if (activeId && hosts.has(activeId) && activeId !== id) hosts.get(activeId)!.hide();
  activeId = id;
  const s = id ? sessions.get(id) : undefined;
  if (s) {
    s.unread = 0;
    if (s.status === "done") s.status = "idle";
    const h = host(s.id);
    h.show();
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
  const args = resume ? ["--resume", s.id] : ["--session-id", s.id, ...(s.name ? ["--name", s.name] : []), ...extra];
  s.status = "starting";
  s.external = false;
  s.lastEvent = Date.now();
  try {
    await invoke("session_spawn", { id: s.id, cwd: s.cwd, args, cols, rows });
    s.running = true;
    if (resume) h.notice(`resumed ${s.id.slice(0, 8)} in ${s.cwd}`);
  } catch (e) {
    s.status = "exited";
    h.notice(`could not start claude: ${e}`);
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
    const next = [...sessions.values()].sort((a, b) => b.lastEvent - a.lastEvent)[0];
    activeId = null;
    if (next) select(next.id);
  }
  render();
  save();
}

function nextAttention(): Session | undefined {
  const all = [...sessions.values()].filter((s) => s.id !== activeId);
  return all.find((s) => s.status === "needs") ?? all.filter((s) => s.unread).sort((a, b) => b.lastEvent - a.lastEvent)[0];
}

// ---------------------------------------------------------------- events

function onHook(ev: HookEvent) {
  const id = ev.cw_tab ?? ev.session_id;
  if (!id) return;
  let s = sessions.get(id);
  if (!s) {
    if (ev.hook_event_name === "SessionEnd") return;
    // a session we did not start: reported by the opt-in global hooks
    s = newSession(id, String(ev.cwd ?? ""), { external: true, status: "idle", hasTranscript: true });
    sessions.set(id, s);
  }
  const t = applyHook(s, ev, isVisible(s.id));
  if (t.status) s.status = t.status;
  if (t.msg !== undefined) s.lastMsg = t.msg;
  if (t.prompt && !s.autoTitle) s.autoTitle = t.prompt;
  if (t.hasTranscript) s.hasTranscript = true;
  if (t.unread) s.unread += 1;
  s.lastEvent = Date.now();
  if (t.notify) notify(s, t.notify);
  if (ev.hook_event_name === "Stop" || ev.hook_event_name === "SessionEnd") refreshPastSoon();
  render();
  save();
}

function notify(s: Session, kind: "needs" | "done") {
  if (kind === "needs" && !settings.notifyNeeds) return;
  if (kind === "done" && !settings.notifyDone) return;
  invoke("attention", { critical: kind === "needs" }).catch(() => {});
  if (!notifyOk) return;
  const where = basename(rootFor(s.cwd, roots));
  sendNotification({
    title: kind === "needs" ? `⚠ ${displayName(s)} needs you` : `✓ ${displayName(s)} is done`,
    body: `${where}${s.lastMsg ? " · " + s.lastMsg : ""}`,
  });
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
    s.lastEvent = Date.now();
    hosts.get(s.id)?.notice(`claude exited${e.payload.code ? ` (code ${e.payload.code})` : ""} · click Resume to continue`);
    render();
    save();
  });
  await listen<HookEvent>("hook-event", (e) => onHook(e.payload));

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
}

// ---------------------------------------------------------------- dialogs

async function listDirs(path: string): Promise<{ name: string; git: boolean }[]> {
  try {
    return await invoke("list_dirs", { path });
  } catch {
    return [];
  }
}

function openNew(prefillCwd?: string, root?: string) {
  const dlg = $("dlgNew") as HTMLDialogElement;
  const sel = $("newRoot") as HTMLSelectElement;
  const cwd = $("newCwd") as HTMLInputElement;
  const lastRoot = root ?? (activeId && sessions.get(activeId) ? rootFor(sessions.get(activeId)!.cwd, roots) : roots[0]);
  sel.innerHTML = roots.map((r) => `<option value="${esc(r)}"${r === lastRoot ? " selected" : ""}>${esc(basename(r))} — ${esc(r)}</option>`).join("")
    + `<option value="">Other folder…</option>`;
  cwd.value = prefillCwd ?? root ?? sel.value;
  ($("newName") as HTMLInputElement).value = "";
  ($("newWorktree") as HTMLInputElement).checked = false;
  $("newErr").textContent = "";
  void fillRepos(sel.value);
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
  if (!roots.some((r) => rootFor(cwd, [r]) === r)) roots.push(cwd); // new workspace root
  ($("dlgNew") as HTMLDialogElement).close();
  await createSession(cwd, ($("newName") as HTMLInputElement).value.trim(), ($("newWorktree") as HTMLInputElement).checked);
}

const LIVE_ELSEWHERE_MS = 5 * 60 * 1000;
let pastBusy = false;
let pastTimer: number | undefined;
/** Re-read past sessions from ~/.claude/projects (what `claude --resume` lists). */
async function refreshPast() {
  if (pastBusy) return;
  pastBusy = true;
  try {
    past = await invoke("past_sessions", { limit: 400 });
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
  $("setInfo").innerHTML = `v${esc(info.version)} · claude: ${esc(info.claude ?? "NOT FOUND")} · hook port ${esc(info.hook_port ?? "-")}<br>data: ${esc(info.data_dir)}`;
  ($("dlgSettings") as HTMLDialogElement).showModal();
}

function renderRoots() {
  $("setRoots").innerHTML = roots.length
    ? roots.map((r, i) => `<div class="rootrow"><span title="${esc(r)}">${esc(r)}</span><button type="button" data-rmroot="${i}">Remove</button></div>`).join("")
    : `<div class="muted small">No workspaces yet.</div>`;
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
  $("setRoots").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rmroot]");
    if (b) { roots.splice(Number(b.dataset.rmroot), 1); renderRoots(); render(); save(); }
  };
  ($("dlgSettings") as HTMLDialogElement).addEventListener("close", () => { if (activeId) hosts.get(activeId)?.focus(); });
  ($("dlgNew") as HTMLDialogElement).addEventListener("close", () => { if (activeId) hosts.get(activeId)?.focus(); });

  // shortcuts use Ctrl+Shift so plain Ctrl keys keep working inside Claude
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.shiftKey)) return;
    const k = e.key.toLowerCase();
    const act: Record<string, () => void> = {
      n: () => openNew(),
      h: () => void openHistory(),
      u: () => { const s = nextAttention(); if (s) select(s.id); },
    };
    if (act[k]) { e.preventDefault(); e.stopPropagation(); act[k](); }
  }, true);

  setInterval(() => render(), 30000); // keep "5m ago" labels fresh
  setInterval(() => void refreshPast(), 60000); // sessions started elsewhere show up too
}

async function main() {
  uiLog("info", "ui starting");
  bindUi();
  info = await invoke("app_info");
  await load();
  await seedRoots();
  void refreshPast();
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
