// Chat-style session list: workspaces -> sessions, with status dots, unread
// badges and "needs you" floating to the top.

import type { Session } from "./types";
import { ago, basename, relativeTo, rootFor, sessionRank } from "./status";

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
  needs: number;
  unread: number;
  last: number;
}

export function renderSidebar(el: HTMLElement, sessions: Session[], roots: string[], activeId: string | null,
                              filter: string, collapsed: Set<string>): void {
  const f = filter.trim().toLowerCase();
  const groups = new Map<string, Group>();
  for (const s of sessions) {
    if (f && !`${displayName(s)} ${s.cwd} ${s.lastMsg}`.toLowerCase().includes(f)) continue;
    const root = rootFor(s.cwd, roots);
    const g = groups.get(root) ?? { root, sessions: [], needs: 0, unread: 0, last: 0 };
    g.sessions.push(s);
    g.needs += s.status === "needs" ? 1 : 0;
    g.unread += s.unread;
    g.last = Math.max(g.last, s.lastEvent);
    groups.set(root, g);
  }
  const ordered = [...groups.values()].sort((a, b) => (b.needs > 0 ? 1 : 0) - (a.needs > 0 ? 1 : 0) || b.last - a.last);
  if (!ordered.length) {
    el.innerHTML = `<div class="none">${f ? "No session matches." : "No sessions yet."}</div>`;
    return;
  }
  const now = Date.now();
  el.innerHTML = ordered
    .map((g) => {
      const closed = collapsed.has(g.root) && !g.needs;
      const rows = g.sessions
        .sort(sessionRank)
        .map((s) => {
          const rel = relativeTo(s.cwd, g.root);
          const cls = ["sess", `st-${s.status}`, s.id === activeId ? "active" : "", s.unread ? "unread" : ""].join(" ");
          const badge = s.unread ? `<span class="badge">${s.unread}</span>` : `<span class="when">${ago(s.lastEvent, now)}</span>`;
          const sub = [s.external ? "terminal" : "", STATUS_LABEL[s.status], rel, s.lastMsg].filter(Boolean).join(" · ");
          return `<div class="${cls}" data-id="${esc(s.id)}" title="${esc(s.cwd)}">
              <span class="dot"></span>
              <div class="txt"><div class="t">${esc(displayName(s))}</div><div class="sub">${esc(sub)}</div></div>
              ${badge}
            </div>`;
        })
        .join("");
      const counts = (g.needs ? `<span class="gneeds">${g.needs}</span>` : "") + (g.unread ? `<span class="gunread">${g.unread}</span>` : "");
      return `<section class="group${closed ? " closed" : ""}">
          <div class="ghead" data-root="${esc(g.root)}" title="${esc(g.root)}">
            <span class="caret">${closed ? "▸" : "▾"}</span><span class="gname">${esc(basename(g.root))}</span>${counts}
          </div>
          <div class="gbody">${rows}</div>
        </section>`;
    })
    .join("");
}
