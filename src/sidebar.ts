// Session lists for the Active and All Sessions panels.

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

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function displayName(s: Session): string {
  return s.name || s.autoTitle || basename(s.cwd);
}

/** One open-session row. `where` replaces the folder part of the subtitle. */
export function sessionRow(s: Session, root: string, activeId: string | null, now: number, where?: string): string {
  // a Claude worktree shows as "worktree <name>" rather than its .claude\worktrees\<name> path
  const rel = (where ?? relativeTo(s.cwd, root)).replace(/(^|[\\/])\.claude[\\/]worktrees[\\/][^\\/]+$/, "");
  const where2 = s.worktree ? [rel, `worktree ${s.worktree}`].filter(Boolean).join(" · ") : rel;
  const cls = ["sess", `st-${s.status}`, s.id === activeId ? "active" : "", s.unread ? "unread" : ""].join(" ");
  const badge = s.unread ? `<span class="badge">${s.unread}</span>` : `<span class="when">${ago(s.lastEvent, now)}</span>`;
  const sub = [s.external ? "terminal" : "", STATUS_LABEL[s.status], where2, s.lastMsg].filter(Boolean).join(" · ");
  return `<div class="${cls}" data-id="${esc(s.id)}" title="${esc(s.cwd)}">
      <span class="dot"></span>
      <div class="txt"><div class="t">${esc(displayName(s))}</div><div class="sub">${esc(sub)}</div></div>
      ${badge}
    </div>`;
}

function pastRow(p: PastSession, root: string, now: number): string {
  const live = now - p.modified_ms < 5 * 60 * 1000;
  const sub = [relativeTo(p.cwd, root), p.first_prompt && p.first_prompt !== p.title ? p.first_prompt : ""].filter(Boolean).join(" · ");
  return `<div class="sess past${live ? " recent" : ""}" data-pid="${esc(p.id)}" title="${live ? "Active in the last few minutes - may be open in a terminal" : "Resume"} - ${esc(p.cwd)}">
      <span class="resume">⟲</span>
      <div class="txt"><div class="t">${esc(p.title || "(untitled)")}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
      <span class="when">${live ? "active" : ago(p.modified_ms, now)}</span>
    </div>`;
}

// ---------------------------------------------------------------- Active

/** Sessions that are running or still unread, across every workspace. */
export function isActive(s: Session): boolean {
  return s.running || s.unread > 0 || s.status === "needs" || s.status === "done" || s.status === "working" || s.status === "starting";
}

export function renderActive(el: HTMLElement, sessions: Session[], roots: string[], activeId: string | null): void {
  const now = Date.now();
  const list = sessions.filter(isActive).sort(sessionRank);
  el.innerHTML = list.length
    ? list.map((s) => {
        const root = rootFor(s.cwd, roots);
        const rel = relativeTo(s.cwd, root);
        return sessionRow(s, root, activeId, now, basename(root) + (rel ? "/" + rel.replace(/\\/g, "/") : ""));
      }).join("")
    : `<div class="none">Nothing running.<br><span class="muted small">Start a session, or resume one from All Sessions.</span></div>`;
}

// ---------------------------------------------------------------- All Sessions

export interface SidebarModel {
  sessions: Session[];
  past: PastSession[]; // transcripts on disk (newest first), like `claude --resume`
  roots: string[];
  activeId: string | null;
  filter: string;
  collapsed: Set<string>;
  pastExpanded: Set<string>;
}

interface Bucket {
  key: string; // first folder below the workspace root ("" = the root itself)
  sessions: Session[];
  past: PastSession[];
  last: number;
}

interface Group {
  root: string;
  buckets: Map<string, Bucket>;
  needs: number;
  unread: number;
  last: number;
}

const PAST_SHOWN = 3;

/** Sub-heading for a session: the first folder below the workspace root.
 *  Claude worktrees (<repo>\.claude\worktrees\x) belong to their repo. */
const firstSegment = (cwd: string, root: string) => {
  const seg = relativeTo(cwd, root).split(/[\\/]/)[0] ?? "";
  return seg === ".claude" ? "" : seg;
};

export function renderSidebar(el: HTMLElement, m: SidebarModel): void {
  const f = m.filter.trim().toLowerCase();
  const groups = new Map<string, Group>();
  const group = (root: string) => {
    const key = norm(root);
    let g = groups.get(key);
    if (!g) {
      g = { root, buckets: new Map(), needs: 0, unread: 0, last: 0 };
      groups.set(key, g);
    }
    return g;
  };
  const bucket = (g: Group, cwd: string) => {
    const k = firstSegment(cwd, g.root);
    let b = g.buckets.get(k.toLowerCase());
    if (!b) {
      b = { key: k, sessions: [], past: [], last: 0 };
      g.buckets.set(k.toLowerCase(), b);
    }
    return b;
  };
  for (const r of m.roots) group(r); // every workspace shows, even with nothing in it

  const open = new Set(m.sessions.map((s) => s.id));
  for (const s of m.sessions) {
    if (f && !`${displayName(s)} ${s.cwd} ${s.lastMsg}`.toLowerCase().includes(f)) continue;
    const g = group(rootFor(s.cwd, m.roots));
    const b = bucket(g, s.cwd);
    b.sessions.push(s);
    b.last = Math.max(b.last, s.lastEvent);
    g.needs += s.status === "needs" ? 1 : 0;
    g.unread += s.unread;
    g.last = Math.max(g.last, s.lastEvent);
  }
  for (const p of m.past) {
    if (open.has(p.id)) continue;
    if (f && !`${p.title} ${p.first_prompt} ${p.cwd}`.toLowerCase().includes(f)) continue;
    const g = groups.get(norm(rootFor(p.cwd, m.roots)));
    if (!g) continue; // folders outside every workspace stay in History only
    const b = bucket(g, p.cwd);
    b.past.push(p);
    b.last = Math.max(b.last, p.modified_ms);
    g.last = Math.max(g.last, p.modified_ms);
  }

  const ordered = [...groups.values()]
    .filter((g) => !f || [...g.buckets.values()].some((b) => b.sessions.length || b.past.length))
    .sort((a, b) => (b.needs > 0 ? 1 : 0) - (a.needs > 0 ? 1 : 0) || b.last - a.last);
  if (!ordered.length) {
    el.innerHTML = `<div class="none">${f ? "No session matches." : "No workspaces yet - add one in Settings."}</div>`;
    return;
  }
  const now = Date.now();
  el.innerHTML = ordered
    .map((g) => {
      const closed = m.collapsed.has(g.root) && !g.needs;
      const buckets = [...g.buckets.values()].sort((a, b) => (a.key === "" ? -1 : b.key === "" ? 1 : b.last - a.last));
      const showHeads = buckets.length > 1 || (buckets[0] && buckets[0].key !== "");
      const body = buckets.length
        ? buckets.map((b) => {
            const key = `${g.root}|${b.key}`;
            const expanded = m.pastExpanded.has(key) || !!f;
            const rows = b.sessions.sort(sessionRank).map((s) => sessionRow(s, g.root, m.activeId, now)).join("");
            const shown = expanded ? b.past : b.past.slice(0, PAST_SHOWN);
            const more = b.past.length > PAST_SHOWN && !f
              ? `<button class="pastmore" data-pastroot="${esc(key)}">${expanded ? "Show fewer" : `Show ${b.past.length - PAST_SHOWN} more`}</button>`
              : "";
            const head = showHeads
              ? `<div class="subhead" title="${esc(b.key ? g.root + "\\" + b.key : g.root)}"><span>${esc(b.key || basename(g.root) + " (root)")}</span>
                   <button class="gnew" data-newroot="${esc(b.key ? g.root.replace(/[\\/]+$/, "") + "\\" + b.key : g.root)}" title="New session here">＋</button></div>`
              : "";
            const pastHead = b.past.length && !showHeads ? `<div class="pasthead">Earlier sessions · click to resume</div>` : "";
            return head + rows + pastHead + shown.map((p) => pastRow(p, g.root, now)).join("") + more;
          }).join("")
        : `<div class="pasthead">No sessions yet</div>`;
      const counts = (g.needs ? `<span class="gneeds">${g.needs}</span>` : "") + (g.unread ? `<span class="gunread">${g.unread}</span>` : "");
      return `<section class="group${closed ? " closed" : ""}">
          <div class="ghead" data-root="${esc(g.root)}" title="${esc(g.root)}">
            <span class="caret"></span><span class="gname">${esc(basename(g.root))}</span>${counts}
            <button class="gnew" data-newroot="${esc(g.root)}" title="New session in ${esc(basename(g.root))}">＋</button>
          </div>
          <div class="gbody">${body}</div>
        </section>`;
    })
    .join("");
}
