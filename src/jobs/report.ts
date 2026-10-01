// Job report view (main area): run history on the left, the selected run's
// rendered report (markdown + charts) on the right.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "./markdown";
import { relTime, STATUS_TEXT, type JobView, type RunRecord } from "./panel";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface ReportCtx {
  onClose: () => void;
  edit: (job: JobView) => void;
  continueSession: (run: RunRecord, folder: string) => void;
  jobs: () => JobView[];
  log: (level: string, msg: string) => void;
}

export class JobReport {
  private el: HTMLElement;
  private jobId: string | null = null;
  private runs: RunRecord[] = [];
  private sel: string | null = null;

  constructor(private ctx: ReportCtx) {
    this.el = document.getElementById("jobview")!;
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.ctx.onClose();
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  get currentJob() {
    return this.jobId;
  }

  async open(jobId: string, runId?: string) {
    this.jobId = jobId;
    this.el.classList.remove("hidden");
    await this.refresh(runId);
  }

  hide() {
    this.el.classList.add("hidden");
  }

  async refresh(runId?: string) {
    if (!this.jobId) return;
    try {
      this.runs = await invoke("job_runs", { id: this.jobId });
    } catch (e) {
      this.runs = [];
      this.ctx.log("warn", `job runs: ${e}`);
    }
    if (runId) this.sel = runId;
    if (!this.sel || !this.runs.some((r) => r.id === this.sel)) this.sel = this.runs[0]?.id ?? null;
    this.render();
  }

  private render() {
    const job = this.ctx.jobs().find((j) => j.id === this.jobId);
    if (!job) {
      this.el.innerHTML = `<div class="none">This job no longer exists.</div>`;
      return;
    }
    const now = Date.now();
    const run = this.runs.find((r) => r.id === this.sel) ?? null;
    const dur = (r: RunRecord) => (r.finished_ms ? `${Math.max(1, Math.round((r.finished_ms - r.started_ms) / 1000))}s` : "");
    const history = this.runs.length
      ? this.runs.map((r) => `<div class="jrun${r.id === this.sel ? " sel" : ""}" data-run="${esc(r.id)}">
          <span class="jdot st-${esc(r.status)}"></span>
          <div class="txt"><div class="t">${esc(new Date(r.started_ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</div>
          <div class="sub">${esc(STATUS_TEXT[r.status] ?? r.status)} · ${esc(r.trigger)}${dur(r) ? " · " + dur(r) : ""}</div></div></div>`).join("")
      : `<div class="none small">No runs yet - click Run now.</div>`;
    const body = !run
      ? `<div class="none">No run selected.</div>`
      : run.status === "running"
        ? `<div class="none">Running since ${esc(new Date(run.started_ms).toLocaleTimeString())}… the report appears here when it finishes.</div>`
        : `<div class="jsum st-${esc(run.status)}"><b>${esc(STATUS_TEXT[run.status] ?? run.status)}</b>${run.summary ? " - " + esc(run.summary) : ""}</div>
           ${run.error ? `<pre class="jerr">${esc(run.error)}</pre>` : ""}
           <div class="md">${run.report ? renderMarkdown(run.report) : `<p class="muted">The agent returned no report.</p>`}</div>
           <div class="jmeta muted small">${esc(run.trigger)} run · ${esc(new Date(run.started_ms).toLocaleString())} · ${dur(run)}${run.turns ? ` · ${run.turns} turns` : ""}${run.cost_usd != null ? ` · $${run.cost_usd.toFixed(3)}` : ""}</div>`;
    this.el.innerHTML = `
      <div class="gv-head">
        <span class="gv-title">⏱ ${esc(job.name)}</span>
        <span class="gv-path">${esc(job.enabled ? job.schedule + (job.next_ms ? " · next " + relTime(job.next_ms, now) : "") : "paused")} · ${esc(job.folder)}</span>
        <span class="spacer"></span>
        <button class="mini" data-jr="run"${job.running ? " disabled" : ""}>▶ Run now</button>
        <button class="mini" data-jr="edit">✎ Edit</button>
        ${run?.session_id ? `<button class="mini" data-jr="session" title="Resume this run's conversation as a normal session to dig deeper">Continue in a session</button>` : ""}
        <button class="mini" data-jr="close">✕ Close</button>
      </div>
      <div class="jr-body">
        <div class="jr-runs">${history}</div>
        <div class="jr-report">${body}</div>
      </div>`;
  }

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    const link = t.closest<HTMLAnchorElement>("a[data-ext]");
    if (link) {
      e.preventDefault();
      void openUrl(link.href);
      return;
    }
    const act = t.closest<HTMLElement>("[data-jr]")?.dataset.jr;
    const job = this.ctx.jobs().find((j) => j.id === this.jobId);
    if (act === "close") return this.ctx.onClose();
    if (act === "edit" && job) return this.ctx.edit(job);
    if (act === "run" && job) {
      try {
        await invoke("job_run", { id: job.id });
      } catch (err) {
        this.ctx.log("warn", `run job: ${err}`);
      }
      return;
    }
    if (act === "session" && job) {
      const run = this.runs.find((r) => r.id === this.sel);
      if (run) this.ctx.continueSession(run, job.folder);
      return;
    }
    const r = t.closest<HTMLElement>("[data-run]");
    if (r) {
      this.sel = r.dataset.run!;
      this.render();
    }
  }
}
