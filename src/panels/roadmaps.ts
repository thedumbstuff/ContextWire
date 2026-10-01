// Roadmaps panel: a roll-up of every roadmap.yaml (watchtower pattern) under
// the workspaces. Progress is from declared statuses; the watchtower runs the checks.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { esc } from "../sidebar";

interface Item { id: string; title: string }
export interface Roadmap {
  repo: string;
  project: string;
  tagline: string;
  updated: string;
  tasks: number;
  effort_total: number;
  effort_done: number;
  effort_in_progress: number;
  pct_done: number;
  in_progress: Item[];
  blocked: number;
  next_up: Item[];
  open_decisions: Item[];
  watchtower_port: number | null;
  error: string | null;
}

export interface RoadmapCtx {
  roots: () => string[];
  newSessionIn: (cwd: string) => void;
  log: (level: string, msg: string) => void;
}

const $ = (id: string) => document.getElementById(id)!;

export class RoadmapsPanel {
  private items: Roadmap[] = [];
  private loadedAt = 0;
  private loading = false;
  private notes = new Map<string, string>();

  constructor(private ctx: RoadmapCtx) {
    $("roadmapList").addEventListener("click", (e) => void this.onClick(e));
  }

  actions(): string {
    return `<button class="mini" data-pa="refresh" title="Re-read roadmaps">⟳</button>`;
  }

  onAction(a: string) {
    if (a !== "refresh") return false;
    void this.load(true);
    return true;
  }

  async load(force = false) {
    if (this.loading || (!force && Date.now() - this.loadedAt < 30_000)) return this.render();
    this.loading = true;
    if (!this.items.length) $("roadmapList").innerHTML = `<div class="none">Reading roadmaps…</div>`;
    try {
      this.items = await invoke("roadmaps", { roots: this.ctx.roots() });
      this.loadedAt = Date.now();
    } catch (e) {
      this.ctx.log("warn", `roadmaps: ${e}`);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  render() {
    const el = $("roadmapList");
    if (!this.items.length) {
      el.innerHTML = this.loading
        ? `<div class="none">Reading roadmaps…</div>`
        : `<div class="none">No <code>roadmap.yaml</code> found in your workspaces.<br><span class="muted small">Projects that use the watchtower pattern show up here.</span></div>`;
      return;
    }
    const list = [...this.items].sort((a, b) => (b.updated || "").localeCompare(a.updated || "") || a.project.localeCompare(b.project));
    el.innerHTML = list.map((r) => {
      if (r.error) return `<div class="rm"><div class="rmhead"><b>${esc(r.project)}</b></div><div class="err small">${esc(r.error)}</div></div>`;
      const wip = r.effort_total ? (100 * r.effort_in_progress) / r.effort_total : 0;
      const li = (xs: Item[]) => xs.map((x) => `<li><span class="rid">${esc(x.id)}</span> ${esc(x.title)}</li>`).join("");
      const note = this.notes.get(r.repo);
      return `<div class="rm" title="${esc(r.repo)}">
          <div class="rmhead"><b>${esc(r.project)}</b><span class="spacer"></span><span class="pct">${r.pct_done.toFixed(0)}%</span></div>
          ${r.tagline ? `<div class="sub">${esc(r.tagline)}</div>` : ""}
          <div class="pbar" title="${r.pct_done}% done (declared), ${wip.toFixed(0)}% in progress"><span class="done" style="width:${r.pct_done}%"></span><span class="wip" style="width:${wip}%"></span></div>
          <div class="rmstats">${r.tasks} tasks · ${r.in_progress.length} in progress · ${r.blocked} blocked${r.open_decisions.length ? ` · <span class="dec">${r.open_decisions.length} open decision${r.open_decisions.length > 1 ? "s" : ""}</span>` : ""}${r.updated ? ` · updated ${esc(r.updated)}` : ""}</div>
          ${r.in_progress.length ? `<div class="rmsec">In progress</div><ul>${li(r.in_progress.slice(0, 3))}</ul>` : ""}
          ${r.next_up.length ? `<div class="rmsec">Next up</div><ul>${li(r.next_up)}</ul>` : ""}
          ${r.open_decisions.length ? `<div class="rmsec">Needs a decision</div><ul>${li(r.open_decisions)}</ul>` : ""}
          <div class="gitbar">
            ${r.watchtower_port ? `<button class="mini" data-wt="${esc(r.repo)}" data-port="${r.watchtower_port}">Open dashboard</button>` : ""}
            <button class="mini" data-rsess="${esc(r.repo)}">＋ Session</button>
            ${note ? `<span class="muted small">${esc(note)}</span>` : ""}
          </div>
        </div>`;
    }).join("") + `<div class="none small">Progress counts declared statuses; open a dashboard to run the checks.</div>`;
  }

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    const s = t.closest<HTMLElement>("[data-rsess]");
    if (s) return this.ctx.newSessionIn(s.dataset.rsess!);
    const w = t.closest<HTMLElement>("[data-wt]");
    if (!w) return;
    const repo = w.dataset.wt!;
    const port = Number(w.dataset.port);
    this.notes.set(repo, "starting dashboard…");
    this.render();
    try {
      await invoke("watchtower_ensure", { repo, port });
      await openUrl(`http://127.0.0.1:${port}`);
      this.notes.set(repo, `http://127.0.0.1:${port}`);
    } catch (err) {
      this.notes.set(repo, String(err));
    }
    this.render();
  }
}
