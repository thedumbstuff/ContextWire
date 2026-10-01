// Jobs panel (rail) + the job editor dialog. Jobs run unattended on a schedule;
// nothing is permitted unless the owner ticks it in the editor.

import { invoke } from "@tauri-apps/api/core";

export interface Permissions { read: boolean; web_search: boolean; web_fetch: boolean; edit: boolean; commands: string[]; full_auto: boolean }
export interface RunRecord {
  id: string; job_id: string; job_name: string; trigger: string; started_ms: number; finished_ms: number;
  status: "running" | "ok" | "attention" | "error" | "timeout"; summary: string; report: string;
  session_id: string | null; cost_usd: number | null; turns: number | null; exit_code: number | null; error: string | null;
}
export interface JobView {
  id: string; name: string; folder: string; prompt: string; cron: string; schedule: string; enabled: boolean;
  permissions: Permissions; notify: "always" | "attention" | "never"; timeout_min: number; model: string | null;
  secret_names: string[]; next_ms: number | null; running: boolean; last: RunRecord | null; error: string | null;
}

export interface JobsCtx {
  openReport: (jobId: string) => void;
  log: (level: string, msg: string) => void;
  pickFolder: () => Promise<string | null>;
  defaultFolder: () => string;
  onChanged: () => void;
}

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function relTime(ms: number, now = Date.now()): string {
  const d = Math.round((ms - now) / 60000);
  const abs = Math.abs(d);
  const txt = abs < 1 ? "now" : abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  return abs < 1 ? "now" : d > 0 ? `in ${txt}` : `${txt} ago`;
}

export const STATUS_TEXT: Record<string, string> = { running: "running", ok: "ok", attention: "needs attention", error: "failed", timeout: "timed out" };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------------------------------------------------------------- templates

export const TEMPLATES: Record<string, { name: string; prompt: string; cron: string; perms: Partial<Permissions>; secrets: string[]; notify: JobView["notify"] }> = {
  cloudflare: {
    name: "Website views (Cloudflare)",
    prompt:
      "Report my website's traffic from Cloudflare for the last 7 complete days and compare it with the 7 days before.\n\n" +
      "Use the Cloudflare GraphQL Analytics API with curl:\n" +
      "  POST https://api.cloudflare.com/client/v4/graphql\n" +
      "  headers: Authorization: Bearer $CF_API_TOKEN, Content-Type: application/json\n" +
      "  query httpRequests1dGroups(limit: 31, filter: {date_geq: <start>, date_leq: <end>}, orderBy: [date_ASC]) on zones(filter: {zoneTag: $CF_ZONE_TAG}) " +
      "with dimensions { date } sum { requests pageViews } uniq { uniques }.\n\n" +
      "Show: a table per day (date, page views, unique visitors, requests), totals for both weeks with the % change, " +
      "and a line chart block of daily page views for the 14 days. Mention the busiest day.\n" +
      "Needs attention if page views fell by more than 30% week over week, or if the API call fails (then say what failed - never print the token).",
    cron: "0 9 * * 1",
    perms: { commands: ["curl *"] },
    secrets: ["CF_API_TOKEN", "CF_ZONE_TAG"],
    notify: "always",
  },
};

// ---------------------------------------------------------------- schedule <-> presets

type Preset = "hourly" | "minutes" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

function cronToPreset(cron: string): { p: Preset; time: string; day: number; every: number; dom: number } {
  const f = cron.trim().split(/\s+/);
  const dflt = { p: "custom" as Preset, time: "09:00", day: 1, every: 15, dom: 1 };
  if (f.length !== 5) return dflt;
  const [m, h, dom, mon, dow] = f;
  const isNum = (s: string) => /^\d+$/.test(s);
  const time = isNum(m) && isNum(h) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : "09:00";
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return { ...dflt, p: "hourly" };
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return { ...dflt, p: "minutes", every: Number(m.slice(2)) };
  if (!isNum(m) || !isNum(h) || mon !== "*") return dflt;
  if (dom === "*" && dow === "*") return { ...dflt, p: "daily", time };
  if (dom === "*" && dow === "1-5") return { ...dflt, p: "weekdays", time };
  if (dom === "*" && isNum(dow)) return { ...dflt, p: "weekly", time, day: Number(dow) % 7 };
  if (isNum(dom) && dow === "*") return { ...dflt, p: "monthly", time, dom: Number(dom) };
  return dflt;
}

function presetToCron(p: Preset, time: string, day: number, every: number, dom: number, custom: string): string {
  const [hh, mm] = (time || "09:00").split(":").map((x) => String(Number(x)));
  switch (p) {
    case "hourly": return "0 * * * *";
    case "minutes": return `*/${Math.max(1, Math.min(59, every || 15))} * * * *`;
    case "daily": return `${mm} ${hh} * * *`;
    case "weekdays": return `${mm} ${hh} * * 1-5`;
    case "weekly": return `${mm} ${hh} * * ${day}`;
    case "monthly": return `${mm} ${hh} ${Math.max(1, Math.min(28, dom || 1))} * *`;
    default: return custom.trim();
  }
}

// ---------------------------------------------------------------- panel

export class JobsPanel {
  jobs: JobView[] = [];
  private editing: JobView | null = null;
  private previewTimer: number | undefined;

  constructor(private ctx: JobsCtx) {
    $("jobList").addEventListener("click", (e) => void this.onClick(e));
    this.bindEditor();
  }

  actions(): string {
    return `<button class="mini" data-pa="new" title="Create a scheduled job">＋ New job</button>`;
  }

  onAction(a: string) {
    if (a !== "new") return false;
    this.openEditor(null);
    return true;
  }

  async load() {
    try {
      this.jobs = await invoke("jobs_list");
    } catch (e) {
      this.ctx.log("warn", `jobs: ${e}`);
    }
    this.render();
  }

  /** latest runs that need the owner (badge) */
  attentionCount(): number {
    return this.jobs.filter((j) => j.last && ["attention", "error", "timeout"].includes(j.last.status)).length;
  }

  render() {
    const el = $("jobList");
    if (!this.jobs.length) {
      el.innerHTML = `<div class="none">No scheduled jobs yet.<br><span class="muted small">A job runs a Claude agent on a schedule - e.g. a weekly website-traffic report - and shows you the result.</span>
        <div class="row" style="justify-content:center;margin-top:10px"><button class="mini" data-new>＋ New job</button><button class="mini" data-tpl="cloudflare">Website views (Cloudflare)…</button></div></div>`;
      return;
    }
    const now = Date.now();
    el.innerHTML = this.jobs.map((j) => {
      const last = j.last;
      const st = j.running ? "running" : last?.status ?? "";
      const lastTxt = last ? `${STATUS_TEXT[last.status] ?? last.status} ${relTime(last.started_ms, now)}${last.summary ? " · " + last.summary : ""}` : "never run";
      return `<div class="job${j.enabled ? "" : " off"}" data-job="${esc(j.id)}" title="${esc(j.folder)}">
          <span class="jdot st-${esc(st)}"></span>
          <div class="txt">
            <div class="t">${esc(j.name)}</div>
            <div class="sub">${esc(j.error ? "schedule error: " + j.error : j.enabled ? `${j.schedule}${j.next_ms ? " · next " + relTime(j.next_ms, now) : ""}` : "paused")}</div>
            <div class="sub last">${esc(lastTxt)}</div>
          </div>
          <div class="jact">
            <button class="mini" data-run="${esc(j.id)}" title="Run now"${j.running ? " disabled" : ""}>▶</button>
            <button class="mini" data-edit="${esc(j.id)}" title="Edit">✎</button>
          </div>
        </div>`;
    }).join("");
  }

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    if (t.closest("[data-new]")) return this.openEditor(null);
    const tpl = t.closest<HTMLElement>("[data-tpl]");
    if (tpl) return this.openEditor(null, tpl.dataset.tpl);
    const run = t.closest<HTMLElement>("[data-run]");
    if (run) {
      try {
        await invoke("job_run", { id: run.dataset.run });
      } catch (err) {
        this.ctx.log("warn", `run job: ${err}`);
      }
      await this.load();
      return;
    }
    const edit = t.closest<HTMLElement>("[data-edit]");
    if (edit) return this.openEditor(this.jobs.find((j) => j.id === edit.dataset.edit) ?? null);
    const row = t.closest<HTMLElement>("[data-job]");
    if (row) this.ctx.openReport(row.dataset.job!);
  }

  // ------------------------------------------------------------ editor

  private val(id: string) {
    return ($(id) as HTMLInputElement).value;
  }
  private set(id: string, v: string) {
    ($(id) as HTMLInputElement).value = v;
  }
  private check(id: string, v?: boolean) {
    const el = $(id) as HTMLInputElement;
    if (v !== undefined) el.checked = v;
    return el.checked;
  }

  openEditor(job: JobView | null, template?: string) {
    this.editing = job;
    const tpl = template ? TEMPLATES[template] : undefined;
    $("jobTitle").textContent = job ? `Edit job - ${job.name}` : "New scheduled job";
    this.set("jobName", job?.name ?? tpl?.name ?? "");
    this.set("jobFolder", job?.folder ?? this.ctx.defaultFolder());
    this.set("jobPrompt", job?.prompt ?? tpl?.prompt ?? "");
    const cron = job?.cron ?? tpl?.cron ?? "0 9 * * *";
    const pr = cronToPreset(cron);
    this.set("jobPreset", pr.p);
    this.set("jobTime", pr.time);
    this.set("jobDay", String(pr.day));
    this.set("jobEvery", String(pr.every));
    this.set("jobDom", String(pr.dom));
    this.set("jobCron", cron);
    const p: Permissions = job?.permissions ?? { read: false, web_search: false, web_fetch: false, edit: false, commands: [], full_auto: false, ...(tpl?.perms ?? {}) };
    this.check("permRead", p.read);
    this.check("permSearch", p.web_search);
    this.check("permFetch", p.web_fetch);
    this.check("permEdit", p.edit);
    this.check("permAuto", p.full_auto);
    this.check("permCmd", p.commands.length > 0);
    this.set("permCmds", p.commands.join("\n"));
    this.set("jobNotify", job?.notify ?? tpl?.notify ?? "always");
    this.set("jobTimeout", String(job?.timeout_min ?? 10));
    this.set("jobModel", job?.model ?? "");
    this.check("jobEnabled", job?.enabled ?? true);
    const names = job?.secret_names ?? tpl?.secrets ?? [];
    $("jobSecrets").innerHTML = "";
    names.forEach((n) => this.addSecretRow(n, !!job));
    $("jobDelete").classList.toggle("hidden", !job);
    $("jobErr").textContent = "";
    this.syncScheduleUi();
    this.syncPermUi();
    ($("dlgJob") as HTMLDialogElement).showModal();
    ($(job ? "jobPrompt" : "jobName") as HTMLInputElement).focus();
  }

  private addSecretRow(name = "", stored = false) {
    const row = document.createElement("div");
    row.className = "secrow";
    row.innerHTML = `<input class="sname" placeholder="NAME (e.g. CF_API_TOKEN)" value="${esc(name)}" autocomplete="off" spellcheck="false" />
      <input class="sval" type="password" placeholder="${stored ? "stored - leave empty to keep" : "value"}" autocomplete="off" />
      <button type="button" class="mini" data-rmsec title="Remove">✕</button>`;
    $("jobSecrets").appendChild(row);
  }

  private syncScheduleUi() {
    const p = this.val("jobPreset") as Preset;
    $("jobTimeWrap").classList.toggle("hidden", ["hourly", "minutes", "custom"].includes(p));
    $("jobDayWrap").classList.toggle("hidden", p !== "weekly");
    $("jobEveryWrap").classList.toggle("hidden", p !== "minutes");
    $("jobDomWrap").classList.toggle("hidden", p !== "monthly");
    ($("jobCron") as HTMLInputElement).readOnly = p !== "custom";
    if (p !== "custom") {
      this.set("jobCron", presetToCron(p, this.val("jobTime"), Number(this.val("jobDay")), Number(this.val("jobEvery")), Number(this.val("jobDom")), this.val("jobCron")));
    }
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => void this.preview(), 150);
  }

  private async preview() {
    const r: { description: string; next: number[]; error: string | null } = await invoke("cron_preview", { expr: this.val("jobCron") });
    $("jobPreview").innerHTML = r.error
      ? `<span class="err">${esc(r.error)}</span>`
      : `${esc(r.description)} · next: ${r.next.map((ms) => esc(new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))).join(", ")}`;
  }

  private syncPermUi() {
    const auto = this.check("permAuto");
    document.querySelectorAll<HTMLInputElement>(".perm-granular input").forEach((i) => (i.disabled = auto));
    ($("permCmds") as HTMLTextAreaElement).disabled = auto || !this.check("permCmd");
    $("permAutoWarn").classList.toggle("hidden", !auto);
    const granted = [
      this.check("permRead") && "read files", this.check("permSearch") && "web search", this.check("permFetch") && "fetch web pages",
      this.check("permCmd") && "run the listed commands", this.check("permEdit") && "edit files",
    ].filter(Boolean);
    $("permSummary").textContent = auto ? "The agent may do anything a normal session in auto mode can." :
      granted.length ? `The agent may only: ${granted.join(", ")}. Everything else is denied.` : "No tools allowed - the agent can only think and write the report.";
  }

  private bindEditor() {
    ["jobPreset", "jobTime", "jobDay", "jobEvery", "jobDom"].forEach((id) => $(id).addEventListener("input", () => this.syncScheduleUi()));
    $("jobCron").addEventListener("input", () => {
      clearTimeout(this.previewTimer);
      this.previewTimer = window.setTimeout(() => void this.preview(), 250);
    });
    document.querySelectorAll("#dlgJob .perm input").forEach((i) => i.addEventListener("change", () => this.syncPermUi()));
    $("jobAddSecret").addEventListener("click", () => this.addSecretRow());
    $("jobSecrets").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-rmsec]");
      if (b) b.parentElement!.remove();
    });
    $("jobBrowse").addEventListener("click", async () => {
      const f = await this.ctx.pickFolder();
      if (f) this.set("jobFolder", f);
    });
    $("jobSave").addEventListener("click", () => void this.save(false));
    $("jobSaveRun").addEventListener("click", () => void this.save(true));
    $("jobDelete").addEventListener("click", async () => {
      if (!this.editing) return;
      if (($("jobDelete") as HTMLButtonElement).dataset.armed !== "1") {
        ($("jobDelete") as HTMLButtonElement).dataset.armed = "1";
        $("jobDelete").textContent = "Click again to delete";
        return;
      }
      await invoke("job_delete", { id: this.editing.id });
      ($("dlgJob") as HTMLDialogElement).close();
      await this.load();
      this.ctx.onChanged();
    });
    ($("dlgJob") as HTMLDialogElement).addEventListener("close", () => {
      ($("jobDelete") as HTMLButtonElement).dataset.armed = "";
      $("jobDelete").textContent = "Delete job";
    });
  }

  private async save(runAfter: boolean) {
    const commands = this.check("permCmd") ? this.val("permCmds").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    const secrets = [...document.querySelectorAll<HTMLElement>("#jobSecrets .secrow")]
      .map((r) => ({ name: (r.querySelector(".sname") as HTMLInputElement).value.trim(), value: (r.querySelector(".sval") as HTMLInputElement).value }))
      .filter((s) => s.name);
    const input = {
      id: this.editing?.id ?? null,
      name: this.val("jobName"),
      folder: this.val("jobFolder").trim(),
      prompt: this.val("jobPrompt"),
      cron: this.val("jobCron"),
      enabled: this.check("jobEnabled"),
      permissions: {
        read: this.check("permRead"), web_search: this.check("permSearch"), web_fetch: this.check("permFetch"),
        edit: this.check("permEdit"), commands, full_auto: this.check("permAuto"),
      },
      notify: this.val("jobNotify"),
      timeout_min: Number(this.val("jobTimeout")) || 10,
      model: this.val("jobModel").trim() || null,
      secrets,
    };
    const missing = secrets.find((s) => !s.value && !this.editing?.secret_names.includes(s.name));
    if (missing) {
      $("jobErr").textContent = `Enter a value for ${missing.name} (or remove that row).`;
      return;
    }
    try {
      const id: string = await invoke("job_save", { input });
      ($("dlgJob") as HTMLDialogElement).close();
      if (runAfter) await invoke("job_run", { id });
      await this.load();
      this.ctx.onChanged();
      if (runAfter) this.ctx.openReport(id);
    } catch (e) {
      $("jobErr").textContent = String(e);
    }
  }
}

export { DAYS };
