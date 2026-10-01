// Search panel: full-text search across every Claude transcript.

import { invoke } from "@tauri-apps/api/core";
import { ago, basename, rootFor } from "../status";
import { esc } from "../sidebar";

interface Hit { role: string; snippet: string }
export interface SessionHits {
  id: string;
  cwd: string;
  title: string;
  modified_ms: number;
  hits: Hit[];
  total: number;
}

const $ = (id: string) => document.getElementById(id)!;

export class SearchPanel {
  private timer: number | undefined;
  private seq = 0;
  private results: SessionHits[] = [];
  private query = "";

  constructor(private roots: () => string[], private onOpen: (r: SessionHits) => void) {
    const inp = $("tsearch") as HTMLInputElement;
    inp.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(inp.value), 350);
    });
    $("searchList").addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (row) this.onOpen(this.results[Number(row.dataset.i)]);
    });
  }

  focus() {
    ($("tsearch") as HTMLInputElement).focus();
  }

  private async run(q: string) {
    this.query = q.trim();
    const my = ++this.seq;
    if (this.query.length < 2) {
      this.results = [];
      return this.render();
    }
    $("searchList").innerHTML = `<div class="none">Searching…</div>`;
    const res: SessionHits[] = await invoke("transcript_search", { query: this.query, limit: 60 });
    if (my !== this.seq) return; // a newer query is running
    this.results = res;
    this.render();
  }

  private mark(snippet: string): string {
    const e = esc(snippet);
    const q = esc(this.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return q ? e.replace(new RegExp(q, "gi"), (m) => `<mark>${m}</mark>`) : e;
  }

  render() {
    const el = $("searchList");
    if (this.query.length < 2) {
      el.innerHTML = `<div class="none">Search every conversation in every workspace.<br><span class="muted small">Click a result to resume that session.</span></div>`;
      return;
    }
    if (!this.results.length) {
      el.innerHTML = `<div class="none">No conversation mentions “${esc(this.query)}”.</div>`;
      return;
    }
    const now = Date.now();
    const roots = this.roots();
    el.innerHTML = this.results.map((r, i) => `<div class="hitcard" data-i="${i}" title="${esc(r.cwd)}">
        <div class="t">${esc(r.title || "(untitled)")}</div>
        <div class="sub">${esc(basename(rootFor(r.cwd, roots)))} · ${ago(r.modified_ms, now)} · ${r.total} match${r.total > 1 ? "es" : ""}</div>
        ${r.hits.map((h) => `<div class="snip"><span class="role">${h.role === "user" ? "you" : "claude"}</span>${this.mark(h.snippet)}</div>`).join("")}
      </div>`).join("");
  }
}
