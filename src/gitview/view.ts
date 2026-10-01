// The Git view: a PyCharm-style Git tool window shown in the main area.
// Branches tree | commit log (graph + filters) | changed files + commit details,
// with a side-by-side diff on top when a file is picked. Read-only.

import { invoke } from "@tauri-apps/api/core";
import { buildTree, computeGraph, fileName, wordDiff, type ChangedFile, type GraphRow, type TreeNode } from "./model";

interface Branch { name: string; remote: boolean; head: boolean; hash: string; upstream: string | null; ahead: number; behind: number; gone: boolean }
interface LogEntry { hash: string; short: string; parents: string[]; author: string; email: string; time_ms: number; refs: string[]; subject: string }
interface Detail { hash: string; author: string; email: string; author_ms: number; committer: string; committer_email: string; commit_ms: number; refs: string[]; message: string; branches: string[] }
interface Side { no: number; text: string }
interface Row { kind: "same" | "change" | "add" | "del" | "gap"; left: Side | null; right: Side | null }
interface FileDiff { old_path: string; new_path: string; base: string; binary: boolean; rows: Row[]; note: string | null }

const PAGE = 300;
const LANE_W = 14;
const ROW_H = 26;
const COLORS = ["#4c9aff", "#3fb95f", "#e3a526", "#a974f0", "#f0524f", "#39c5cf", "#e26fb2", "#9bc53d"];

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function when(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return `Today ${time}`;
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}
const fullDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function refBadge(r: string): string {
  if (r.startsWith("HEAD|")) return `<span class="ref head" title="HEAD → ${esc(r.slice(5))}">⌂ ${esc(r.slice(5))}</span>`;
  if (r === "HEAD") return `<span class="ref head">HEAD</span>`;
  if (r.startsWith("tag: ")) return `<span class="ref tag">◇ ${esc(r.slice(5))}</span>`;
  return r.includes("/") ? `<span class="ref remote">${esc(r)}</span>` : `<span class="ref local">${esc(r)}</span>`;
}

function graphSvg(g: GraphRow, width: number): string {
  const x = (i: number) => 8 + i * LANE_W;
  const y = (v: number) => v * ROW_H;
  const lines = g.segs.map((s) => {
    const c = COLORS[s.color % COLORS.length];
    if (s.x1 === s.x2) return `<line x1="${x(s.x1)}" y1="${y(s.y1)}" x2="${x(s.x2)}" y2="${y(s.y2)}" stroke="${c}" stroke-width="2"/>`;
    const ym = (y(s.y1) + y(s.y2)) / 2;
    return `<path d="M${x(s.x1)} ${y(s.y1)} C${x(s.x1)} ${ym} ${x(s.x2)} ${ym} ${x(s.x2)} ${y(s.y2)}" stroke="${c}" stroke-width="2" fill="none"/>`;
  }).join("");
  const c = COLORS[g.color % COLORS.length];
  return `<svg class="graph" width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">${lines}<circle cx="${x(g.col)}" cy="${ROW_H / 2}" r="4" fill="${c}" stroke="var(--bg)" stroke-width="1.5"/></svg>`;
}

export interface GitViewCtx {
  onClose: () => void;
  log: (level: string, msg: string) => void;
}

export class GitView {
  private repo = "";
  private branches: Branch[] = [];
  private authors: string[] = [];
  private entries: LogEntry[] = [];
  private more = true;
  private loading = false;
  private selected: string | null = null;
  private files = new Map<string, ChangedFile[]>();
  private details = new Map<string, Detail>();
  private diffFile: ChangedFile | null = null;
  private diff: FileDiff | null = null;
  private ignoreWs = false;
  private branchFilter = "";
  private branchSearch = "";
  private timer: number | undefined;
  private seq = 0;
  private el: HTMLElement;

  constructor(private ctx: GitViewCtx) {
    this.el = document.getElementById("gitview")!;
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("input", (e) => this.onInput(e));
    this.el.addEventListener("change", (e) => this.onInput(e));
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  async open(repo: string, hash?: string) {
    const fresh = repo !== this.repo;
    this.repo = repo;
    this.el.classList.remove("hidden");
    if (fresh) {
      this.entries = [];
      this.files.clear();
      this.details.clear();
      this.selected = null;
      this.diff = this.diffFile = null;
      this.branchFilter = "";
      this.skeleton();
    }
    await Promise.all([this.loadBranches(), this.loadAuthors()]);
    await this.reload();
    if (hash) await this.select(this.entries.find((e) => e.hash === hash || e.short === hash)?.hash ?? this.entries[0]?.hash);
    else if (!this.selected && this.entries[0]) await this.select(this.entries[0].hash);
  }

  hide() {
    this.el.classList.add("hidden");
  }

  // ------------------------------------------------------------ layout

  private q<T extends HTMLElement = HTMLElement>(sel: string) {
    return this.el.querySelector(sel) as T;
  }

  private skeleton() {
    const name = this.repo.split(/[\\/]/).pop();
    this.el.innerHTML = `
      <div class="gv-head">
        <span class="gv-title">⎇ ${esc(name)}</span><span class="gv-path">${esc(this.repo)}</span>
        <span class="spacer"></span>
        <button class="mini" data-gv="refresh" title="Reload branches and log">⟳ Refresh</button>
        <button class="mini" data-gv="close" title="Back to the session (Esc)">✕ Close</button>
      </div>
      <div class="gv-diff hidden"></div>
      <div class="gv-bottom">
        <div class="gv-branches">
          <input type="search" class="gv-bsearch" placeholder="Branch or tag" autocomplete="off" />
          <div class="gv-btree"></div>
        </div>
        <div class="gv-logcol">
          <div class="gv-filters">
            <input type="search" class="gv-text" placeholder="Text or hash" autocomplete="off" />
            <select class="gv-branch" title="Branch"></select>
            <select class="gv-user" title="User"></select>
            <select class="gv-date" title="Date">
              <option value="">Date: any</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option>
            </select>
            <input type="search" class="gv-path-f" placeholder="Paths" autocomplete="off" />
          </div>
          <div class="gv-log" tabindex="0"></div>
        </div>
        <div class="gv-details"><div class="gv-files"></div><div class="gv-info"></div></div>
      </div>`;
    this.q(".gv-log").addEventListener("scroll", () => this.maybeMore());
  }

  // ------------------------------------------------------------ data

  private async loadBranches() {
    try {
      this.branches = await invoke("gv_branches", { path: this.repo });
    } catch (e) {
      this.branches = [];
      this.ctx.log("warn", `git view branches: ${e}`);
    }
    this.renderBranches();
  }

  private async loadAuthors() {
    try {
      this.authors = await invoke("gv_authors", { path: this.repo });
    } catch {
      this.authors = [];
    }
    const sel = this.q<HTMLSelectElement>(".gv-user");
    const cur = sel.value;
    sel.innerHTML = `<option value="">User: all</option>` + this.authors.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
    sel.value = cur;
  }

  private query(skip: number) {
    const val = (c: string) => this.q<HTMLInputElement>(c).value.trim();
    return {
      branch: this.branchFilter || null,
      text: val(".gv-text") || null,
      author: val(".gv-user") || null,
      since_days: val(".gv-date") ? Number(val(".gv-date")) : null,
      path: val(".gv-path-f") || null,
      skip,
      limit: PAGE,
    };
  }

  private async reload() {
    const my = ++this.seq;
    this.loading = true;
    this.q(".gv-log").innerHTML = `<div class="none">Loading…</div>`;
    try {
      const page: LogEntry[] = await invoke("gv_log", { path: this.repo, query: this.query(0) });
      if (my !== this.seq) return;
      this.entries = page;
      this.more = page.length >= PAGE;
    } catch (e) {
      if (my !== this.seq) return;
      this.entries = [];
      this.more = false;
      this.q(".gv-log").innerHTML = `<div class="none err">${esc(e)}</div>`;
      return;
    } finally {
      if (my === this.seq) this.loading = false;
    }
    this.renderLog();
  }

  private async maybeMore() {
    const el = this.q(".gv-log");
    if (this.loading || !this.more || el.scrollTop + el.clientHeight < el.scrollHeight - 400) return;
    this.loading = true;
    const my = this.seq;
    try {
      const page: LogEntry[] = await invoke("gv_log", { path: this.repo, query: this.query(this.entries.length) });
      if (my !== this.seq) return;
      this.entries.push(...page);
      this.more = page.length >= PAGE;
      this.renderLog();
    } finally {
      this.loading = false;
    }
  }

  private async select(hash: string | undefined) {
    if (!hash) return;
    this.selected = hash;
    this.el.querySelectorAll(".gv-row.sel").forEach((r) => r.classList.remove("sel"));
    const row = this.el.querySelector(`.gv-row[data-h="${hash}"]`);
    row?.classList.add("sel");
    row?.scrollIntoView({ block: "nearest" });
    this.q(".gv-files").innerHTML = `<div class="none">Loading…</div>`;
    try {
      if (!this.files.has(hash)) this.files.set(hash, await invoke("gv_files", { path: this.repo, hash }));
      if (!this.details.has(hash)) this.details.set(hash, await invoke("gv_detail", { path: this.repo, hash }));
    } catch (e) {
      this.q(".gv-files").innerHTML = `<div class="none err">${esc(e)}</div>`;
      return;
    }
    if (this.selected !== hash) return;
    this.renderDetails();
    // keep the diff on the same file when moving between commits, if it changed there too
    const same = this.diffFile && this.files.get(hash)!.find((f) => f.path === this.diffFile!.path);
    if (same) void this.openDiff(same);
    else if (this.diffFile) this.closeDiff();
  }

  private async openDiff(f: ChangedFile) {
    if (!this.selected) return;
    this.diffFile = f;
    const pane = this.q(".gv-diff");
    pane.classList.remove("hidden");
    this.el.classList.add("with-diff");
    pane.innerHTML = this.diffToolbar() + `<div class="gv-diffbody"><div class="none">Loading…</div></div>`;
    this.el.querySelectorAll(".gv-file.sel").forEach((r) => r.classList.remove("sel"));
    this.el.querySelector(`.gv-file[data-path="${CSS.escape(f.path)}"]`)?.classList.add("sel");
    try {
      this.diff = await invoke("gv_diff", { path: this.repo, hash: this.selected, file: f.path, oldFile: f.old_path, ignoreWs: this.ignoreWs });
    } catch (e) {
      this.q(".gv-diffbody").innerHTML = `<div class="none err">${esc(e)}</div>`;
      return;
    }
    this.renderDiff();
  }

  private closeDiff() {
    this.diffFile = this.diff = null;
    this.q(".gv-diff").classList.add("hidden");
    this.el.classList.remove("with-diff");
    this.el.querySelectorAll(".gv-file.sel").forEach((r) => r.classList.remove("sel"));
  }

  // ------------------------------------------------------------ render

  private renderBranches() {
    const f = this.branchSearch.toLowerCase();
    const match = (b: Branch) => !f || b.name.toLowerCase().includes(f);
    const head = this.branches.find((b) => b.head);
    const row = (b: Branch, label = b.name) => {
      const track = [b.ahead ? `<span class="ahead" title="${b.ahead} to push">↑${b.ahead}</span>` : "", b.behind ? `<span class="behind" title="${b.behind} to pull">↓${b.behind}</span>` : "", b.gone ? `<span class="muted small">gone</span>` : ""].join("");
      return `<div class="gv-br${this.branchFilter === b.name ? " sel" : ""}" data-branch="${esc(b.name)}" title="${esc(b.name)} · ${esc(b.hash)}${b.upstream ? " · tracks " + esc(b.upstream) : ""}">
        <span class="bico${b.head ? " head" : ""}">${b.head ? "◆" : b.remote ? "◇" : "⎇"}</span>${esc(label)}${track}</div>`;
    };
    const locals = this.branches.filter((b) => !b.remote && match(b));
    const remotes = this.branches.filter((b) => b.remote && match(b));
    const byRemote = new Map<string, Branch[]>();
    for (const b of remotes) {
      const r = b.name.split("/")[0];
      byRemote.set(r, [...(byRemote.get(r) ?? []), b]);
    }
    this.q(".gv-btree").innerHTML =
      `<div class="gv-br${this.branchFilter === "" ? " sel" : ""}" data-branch="">All branches</div>` +
      (head ? `<div class="gv-br${this.branchFilter === "HEAD" ? " sel" : ""}" data-branch="HEAD">HEAD (Current Branch)</div>` : "") +
      `<div class="gv-bgroup">Local</div>${locals.map((b) => row(b)).join("") || `<div class="none small">none</div>`}` +
      (byRemote.size ? `<div class="gv-bgroup">Remote</div>` + [...byRemote.entries()].map(([r, bs]) =>
        `<div class="gv-bsub">${esc(r)}</div>` + bs.map((b) => row(b, b.name.slice(r.length + 1))).join("")).join("") : "");
    const sel = this.q<HTMLSelectElement>(".gv-branch");
    sel.innerHTML = `<option value="">Branch: all</option><option value="HEAD">HEAD</option>` +
      this.branches.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join("");
    sel.value = this.branchFilter;
  }

  private filtered() {
    const val = (c: string) => this.q<HTMLInputElement>(c).value.trim();
    return !!(val(".gv-text") || val(".gv-user") || val(".gv-path-f"));
  }

  private renderLog() {
    const el = this.q(".gv-log");
    if (!this.entries.length) {
      el.innerHTML = `<div class="none">No commits${this.filtered() || this.branchFilter ? " match the filters" : ""}.</div>`;
      return;
    }
    // the graph only makes sense on unfiltered history (filters drop parents)
    const graph = this.filtered() ? null : computeGraph(this.entries);
    const lanes = graph ? Math.min(12, Math.max(1, ...graph.map((g) => g.width))) : 0;
    const gw = lanes ? 10 + lanes * LANE_W : 0;
    const now = Date.now();
    el.innerHTML = this.entries.map((e, i) => `<div class="gv-row${e.hash === this.selected ? " sel" : ""}" data-h="${e.hash}" title="${esc(e.subject)}">
        ${graph ? graphSvg(graph[i], gw) : ""}
        <span class="subj">${esc(e.subject)}</span>
        <span class="refs">${e.refs.map(refBadge).join("")}</span>
        <span class="auth" title="${esc(e.email)}">${esc(e.author)}</span>
        <span class="hash">${esc(e.short)}</span>
        <span class="date" title="${esc(fullDate(e.time_ms))}">${esc(when(e.time_ms, now))}</span>
      </div>`).join("") + (this.more ? `<div class="none small">scroll for more…</div>` : "");
  }

  private renderDetails() {
    const hash = this.selected!;
    const files = this.files.get(hash) ?? [];
    const d = this.details.get(hash);
    const tree = buildTree(files);
    const status = (s: string) => ({ A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" })[s] ?? s;
    const node = (n: TreeNode, depth: number): string =>
      n.dirs.map((c) => `<div class="gv-dir" style="padding-left:${8 + depth * 14}px"><span class="fold"></span>📁 ${esc(c.name)} <span class="muted small">${c.count} file${c.count > 1 ? "s" : ""}</span></div>` + node(c, depth + 1)).join("") +
      n.files.map((f) => `<div class="gv-file st-${esc(f.status)}${this.diffFile?.path === f.path ? " sel" : ""}" data-path="${esc(f.path)}" style="padding-left:${22 + depth * 14}px" title="${esc(status(f.status))}: ${esc(f.path)}${f.old_path ? " (from " + esc(f.old_path) + ")" : ""}">
          ${esc(fileName(f.path))}${f.old_path ? ` <span class="muted small">← ${esc(fileName(f.old_path))}</span>` : ""}</div>`).join("");
    this.q(".gv-files").innerHTML = files.length
      ? `<div class="gv-dir root">📁 ${files.length} file${files.length > 1 ? "s" : ""}</div>` + node(tree, 1)
      : `<div class="none small">No file changes (merge or empty commit).</div>`;
    this.q(".gv-info").innerHTML = d ? `
      <div class="msg">${esc(d.message)}</div>
      <div class="meta"><span class="hash">${esc(d.hash.slice(0, 8))}</span> ${esc(d.author)} <span class="muted">&lt;${esc(d.email)}&gt;</span> on ${esc(fullDate(d.author_ms))}</div>
      ${d.commit_ms !== d.author_ms || d.committer !== d.author ? `<div class="meta muted">committed${d.committer !== d.author ? ` by ${esc(d.committer)}` : ""} on ${esc(fullDate(d.commit_ms))}</div>` : ""}
      ${d.refs.length ? `<div class="meta">${d.refs.map(refBadge).join(" ")}</div>` : ""}
      ${d.branches.length ? `<div class="meta muted">In ${d.branches.length} branch${d.branches.length > 1 ? "es" : ""}: ${esc(d.branches.slice(0, 12).join(", "))}${d.branches.length > 12 ? "…" : ""}</div>` : ""}` : "";
  }

  private diffToolbar(): string {
    const f = this.diffFile!;
    return `<div class="gv-dtool">
      <button class="mini" data-gv="prev" title="Previous change (Shift+F7)">↑</button>
      <button class="mini" data-gv="next" title="Next change (F7)">↓</button>
      <span class="dfile">${esc(f.old_path ? `${f.old_path} → ${f.path}` : f.path)}</span>
      <span class="dcount"></span>
      <span class="spacer"></span>
      <label class="dws"><input type="checkbox" data-gv="ws"${this.ignoreWs ? " checked" : ""}/> Ignore whitespace</label>
      <button class="mini" data-gv="closediff" title="Close the diff">✕</button>
    </div>`;
  }

  private renderDiff() {
    const d = this.diff!;
    const body = this.q(".gv-diffbody");
    const hash = this.selected!.slice(0, 8);
    const head = `<div class="dhead"><span>${esc(d.base || "(new file)")} ${esc(d.old_path)}</span><span>${esc(hash)} ${esc(d.new_path)}</span></div>`;
    if (d.note) {
      body.innerHTML = head + `<div class="none">${esc(d.note)}</div>`;
      return;
    }
    const cell = (s: Side | null, other: Side | null, side: "a" | "b", kind: string) => {
      if (!s) return `<span class="ln"></span><span class="code empty"></span>`;
      let html = esc(s.text);
      if (kind === "change" && other) {
        const w = wordDiff(side === "a" ? s.text : other.text, side === "a" ? other.text : s.text);
        if (w) {
          const [pre, mid, post] = side === "a" ? w.a : w.b;
          html = `${esc(pre)}<mark>${esc(mid)}</mark>${esc(post)}`;
        }
      }
      return `<span class="ln">${s.no}</span><span class="code">${html || " "}</span>`;
    };
    let changes = 0;
    const rows = d.rows.map((r, i) => {
      if (r.kind === "gap") return `<div class="drow gap"><span></span><span>⋯</span><span></span><span>⋯</span></div>`;
      const first = r.kind !== "same" && (i === 0 || d.rows[i - 1].kind === "same" || d.rows[i - 1].kind === "gap");
      if (first) changes++;
      return `<div class="drow ${r.kind}"${first ? ` data-chg="${changes}"` : ""}>${cell(r.left, r.right, "a", r.kind)}${cell(r.right, r.left, "b", r.kind)}</div>`;
    }).join("");
    body.innerHTML = head + `<div class="dgrid">${rows}</div>`;
    this.q(".dcount").textContent = `${changes} change${changes === 1 ? "" : "s"}`;
    this.jumpChange(1, true);
  }

  private chgIndex = 0;
  private jumpChange(dir: 1 | -1, reset = false) {
    const marks = [...this.el.querySelectorAll<HTMLElement>(".drow[data-chg]")];
    if (!marks.length) return;
    this.chgIndex = reset ? 0 : Math.max(0, Math.min(marks.length - 1, this.chgIndex + dir));
    marks[this.chgIndex].scrollIntoView({ block: "center" });
    marks.forEach((m, i) => m.classList.toggle("cur", i === this.chgIndex));
  }

  // ------------------------------------------------------------ events

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-gv]")?.dataset.gv;
    if (act === "close") return this.ctx.onClose();
    if (act === "refresh") {
      this.files.clear();
      this.details.clear();
      await Promise.all([this.loadBranches(), this.loadAuthors()]);
      await this.reload();
      return;
    }
    if (act === "prev") return this.jumpChange(-1);
    if (act === "next") return this.jumpChange(1);
    if (act === "closediff") return this.closeDiff();
    if (act === "ws") return;
    const row = t.closest<HTMLElement>(".gv-row");
    if (row) return this.select(row.dataset.h);
    const file = t.closest<HTMLElement>(".gv-file");
    if (file) {
      const f = this.files.get(this.selected ?? "")?.find((x) => x.path === file.dataset.path);
      if (f) await this.openDiff(f);
      return;
    }
    const br = t.closest<HTMLElement>(".gv-br");
    if (br) {
      this.branchFilter = br.dataset.branch ?? "";
      this.renderBranches();
      await this.reload();
    }
  }

  private onInput(e: Event) {
    const t = e.target as HTMLElement;
    if (t.matches("[data-gv='ws']")) {
      this.ignoreWs = (t as HTMLInputElement).checked;
      if (this.diffFile) void this.openDiff(this.diffFile);
      return;
    }
    if (t.matches(".gv-bsearch")) {
      this.branchSearch = (t as HTMLInputElement).value;
      this.renderBranches();
      return;
    }
    if (t.matches(".gv-branch")) {
      this.branchFilter = (t as HTMLSelectElement).value;
      this.renderBranches();
      void this.reload();
      return;
    }
    if (t.matches(".gv-text, .gv-path-f, .gv-user, .gv-date")) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.reload(), e.type === "change" ? 0 : 350);
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && !(e.target as HTMLElement).matches("input, select")) {
      e.preventDefault();
      if (this.diffFile) this.closeDiff();
      else this.ctx.onClose();
      return;
    }
    if (e.key === "F7") {
      e.preventDefault();
      this.jumpChange(e.shiftKey ? -1 : 1);
      return;
    }
    if (!(e.target as HTMLElement).closest(".gv-log")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = this.entries.findIndex((x) => x.hash === this.selected);
      const next = this.entries[Math.max(0, Math.min(this.entries.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) void this.select(next.hash);
    }
  }
}
