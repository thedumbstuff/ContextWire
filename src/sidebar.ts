// Chat-style session list: workspaces -> sessions, with status dots, unread
// badges and "needs you" floating to the top.

import type { PastSession, Session } from "./types";
import { ago, basename, norm, relativeTo, rootFor, sessionRank } from "./status";

export const STATUS_LABEL: Record<Session["status"], string> = {
  starting: "starting",
  idle: "ready",
  working: "working",
  needs: "needs you",
  done: "done",
  exited: "ended",
  suspended: "not running",
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function displayName(s: Session): string {
  return s.name || s.autoTitle || basename(s.cwd);
}

interface Group {
  root: string;
  sessions: Session[];
  past: PastSession[];
  needs: number;
  unread: number;
  last: number;
}

export interface SidebarModel {
  sessions: Session[];
  past: PastSession[]; // transcripts on disk (newest first), like `claude --resume`
  roots: string[];
  activeId: string | null;
  filter: string;
  collapsed: Set<string>;
  pastExpanded: Set<string>;
}

const PAST_SHOWN = 3;

export function renderSidebar(el: HTMLElement, m: SidebarModel): void {
  const f = m.filter.trim().toLowerCase();
  const groups = new Map<string, Group>();
  const group = (root: string) => {
    const key = norm(root);
    let g = groups.get(key);
    if (!g) {
      g = { root, sessions: [], past: [], needs: 0, unread: 0, last: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of m.roots) group(r); // every workspace shows, even with nothing open

  const open = new Set(m.sessions.map((s) => s.id));
  for (const s of m.sessions) {
    if (f && !`${displayName(s)} ${s.cwd} ${s.lastMsg}`.toLowerCase().includes(f)) continue;
    const g = group(rootFor(s.cwd, m.roots));
    g.sessions.push(s);
    g.needs += s.status === "needs" ? 1 : 0;
    g.unread += s.unread;
    g.last = Math.max(g.last, s.lastEvent);
  }
  for (const p of m.past) {
    if (open.has(p.id)) continue;
    if (f && !`${p.title} ${p.first_prompt} ${p.cwd}`.toLowerCase().includes(f)) continue;
    const root = rootFor(p.cwd, m.roots);
    const g = groups.get(norm(root));
    if (!g) continue; // folders outside every workspace stay in History only
    g.past.push(p);
    g.last = Math.max(g.last, p.modified_ms);
  }

  const ordered = [...groups.values()]
    .filter((g) => !f || g.sessions.length || g.past.length)
    .sort((a, b) => (b.needs > 0 ? 1 : 0) - (a.needs > 0 ? 1 : 0) || b.last - a.last);
  if (!ordered.length) {
    el.innerHTML = `<div class="none">${f ? "No session matches." : "No workspaces yet - add one in Settings."}</div>`;
    return;
  }
  const now = Date.now();
  el.innerHTML = ordered
    .map((g) => {
      const closed = m.collapsed.has(g.root) && !g.needs;
      const rows = g.sessions
        .sort(sessionRank)
        .map((s) => {
          const rel = relativeTo(s.cwd, g.root);
          const cls = ["sess", `st-${s.status}`, s.id === m.activeId ? "active" : "", s.unread ? "unread" : ""].join(" ");
          const badge = s.unread ? `<span class="badge">${s.unread}</span>` : `<span class="when">${ago(s.lastEvent, now)}</span>`;
          const sub = [s.external ? "terminal" : "", STATUS_LABEL[s.status], rel, s.lastMsg].filter(Boolean).join(" · ");
          return `<div class="${cls}" data-id="${esc(s.id)}" title="${esc(s.cwd)}">
              <span class="dot"></span>
              <div class="txt"><div class="t">${esc(displayName(s))}</div><div class="sub">${esc(sub)}</div></div>
              ${badge}
            </div>`;
        })
        .join("");
      const expanded = m.pastExpanded.has(g.root) || !!f;
      const shown = expanded ? g.past : g.past.slice(0, PAST_SHOWN);
      const pastRows = shown
        .map((p) => {
          const sub = [relativeTo(p.cwd, g.root), p.first_prompt && p.first_prompt !== p.title ? p.first_prompt : ""].filter(Boolean).join(" · ");
          return `<div class="sess past" data-pid="${esc(p.id)}" title="Resume - ${esc(p.cwd)}">
              <span class="resume">⟲</span>
              <div class="txt"><div class="t">${esc(p.title || "(untitled)")}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
              <span class="when">${ago(p.modified_ms, now)}</span>
            </div>`;
        })
        .join("");
      const more = g.past.length > PAST_SHOWN && !f
        ? `<button class="pastmore" data-pastroot="${esc(g.root)}">${expanded ? "Show fewer" : `Show ${g.past.length - PAST_SHOWN} more`}</button>`
        : "";
      const past = g.past.length
        ? `<div class="pasthead">Earlier sessions · click to resume</div>${pastRows}${more}`
        : g.sessions.length ? "" : `<div class="pasthead">No sessions yet</div>`;
      const counts = (g.needs ? `<span class="gneeds">${g.needs}</span>` : "") + (g.unread ? `<span class="gunread">${g.unread}</span>` : "");
      return `<section class="group${closed ? " closed" : ""}">
          <div class="ghead" data-root="${esc(g.root)}" title="${esc(g.root)}">
            <span class="caret">${closed ? "▸" : "▾"}</span><span class="gname">${esc(basename(g.root))}</span>${counts}
            <button class="gnew" data-newroot="${esc(g.root)}" title="New session in ${esc(basename(g.root))}">＋</button>
          </div>
          <div class="gbody">${rows}${past}</div>
        </section>`;
    })
    .join("");
}
