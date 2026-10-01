// Activity panel: a persisted timeline of what happened across all sessions
// (finished, needs you, started, ended, git actions). Kept to the last 500.

import { invoke } from "@tauri-apps/api/core";
import { basename } from "../status";
import { esc } from "../sidebar";

export interface ActivityItem {
  t: number;
  kind: string; // done | needs | start | end | exit | git | git-error
  text: string;
  cwd: string;
  sid?: string;
}

const MAX = 500;
const GIT_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11.2 6.6"/></svg>`;
const ICON: Record<string, string> = {
  done: "✓", needs: "!", start: "▶", end: "■", exit: "■", git: GIT_ICON, "git-error": "✕",
};

const $ = (id: string) => document.getElementById(id)!;

export class ActivityPanel {
  private items: ActivityItem[] = [];
  private seenAt = Date.now();
  private saveTimer: number | undefined;

  constructor(private onOpen: (item: ActivityItem) => void, private onUnseen: (n: number) => void) {
    $("activityList").addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (row) this.onOpen(this.items[Number(row.dataset.i)]);
    });
  }

  async load() {
    try {
      const v = (await invoke("kv_load", { name: "activity" })) as { items?: ActivityItem[]; seenAt?: number } | null;
      this.items = v?.items ?? [];
      this.seenAt = v?.seenAt ?? Date.now();
    } catch {
      this.items = [];
    }
    this.badge();
  }

  add(kind: string, text: string, cwd: string, sid?: string) {
    this.items.unshift({ t: Date.now(), kind, text, cwd, sid });
    if (this.items.length > MAX) this.items.length = MAX;
    this.persist();
    this.badge();
  }

  actions(): string {
    return `<button class="mini" data-pa="clear" title="Clear the timeline">Clear</button>`;
  }

  onAction(a: string) {
    if (a !== "clear") return false;
    this.items = [];
    this.persist();
    this.render();
    return true;
  }

  /** Panel opened: everything so far counts as seen. */
  markSeen() {
    this.seenAt = Date.now();
    this.persist();
    this.badge();
  }

  private badge() {
    this.onUnseen(this.items.filter((i) => i.t > this.seenAt && (i.kind === "needs" || i.kind === "done" || i.kind === "git-error")).length);
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      invoke("kv_save", { name: "activity", value: { items: this.items, seenAt: this.seenAt } }).catch(() => {});
    }, 500);
  }

  render() {
    const el = $("activityList");
    if (!this.items.length) {
      el.innerHTML = `<div class="none">Nothing yet.<br><span class="muted small">Finished turns, permission requests, started/ended sessions and git actions appear here.</span></div>`;
      return;
    }
    let day = "";
    el.innerHTML = this.items.map((it, i) => {
      const d = new Date(it.t);
      const dayLabel = d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      const head = dayLabel !== day ? `<div class="subhead"><span>${esc(dayLabel)}</span></div>` : "";
      day = dayLabel;
      const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      return `${head}<div class="act k-${esc(it.kind)}${it.t > this.seenAt ? " new" : ""}" data-i="${i}" title="${esc(it.cwd)}">
          <span class="ico">${ICON[it.kind] ?? "·"}</span>
          <div class="txt"><div class="t">${esc(it.text)}</div>${it.text.includes(basename(it.cwd)) ? "" : `<div class="sub">${esc(basename(it.cwd))}</div>`}</div>
          <span class="when">${esc(time)}</span>
        </div>`;
    }).join("");
  }
}
