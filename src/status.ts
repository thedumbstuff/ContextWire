// Pure status machine: Claude Code hook event -> session status change.
// No DOM / Tauri imports so it can be unit-tested with plain node
// (tests/status.test.ts).

import type { HookEvent, Session, Status } from "./types";

export interface Transition {
  status?: Status;
  unread: boolean; // bump the unread counter
  notify: "needs" | "done" | null;
  msg?: string; // last activity line for the sidebar ("" clears it)
  prompt?: string; // the user's prompt (for the auto title)
  hasTranscript?: boolean;
}

const IDLE_RE = /waiting for your input/i;

export function firstLine(s: unknown, max = 140): string {
  const t = String(s ?? "").trim().split(/\r?\n/)[0] ?? "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * @param visible true when this session is on screen AND the window has focus;
 *                visible sessions never get unread bumps or notifications.
 */
export function applyHook(s: Pick<Session, "status">, ev: HookEvent, visible: boolean): Transition {
  const none: Transition = { unread: false, notify: null };
  switch (ev.hook_event_name) {
    case "SessionStart":
      return ["starting", "exited", "suspended"].includes(s.status) ? { ...none, status: "idle", msg: "" } : none;

    case "UserPromptSubmit":
      return { ...none, status: "working", prompt: firstLine(ev.prompt), msg: "you: " + firstLine(ev.prompt), hasTranscript: true };

    case "PreToolUse":
    case "PostToolUse":
      return { ...none, status: "working", msg: ev.tool_name ? `running ${ev.tool_name}` : undefined };

    case "Notification": {
      const idle = ev.notification_type === "idle_prompt" || IDLE_RE.test(String(ev.message ?? ""));
      if (idle) {
        // the 60s "still waiting for input" nudge after a finished turn - not new news
        return s.status === "working" ? { ...none, status: "done" } : none;
      }
      return {
        status: "needs",
        unread: !visible,
        notify: visible ? null : "needs",
        msg: firstLine(ev.message) || "needs your input",
      };
    }

    case "Stop":
      return visible
        ? { ...none, status: "idle", msg: "finished" }
        : { status: "done", unread: true, notify: "done", msg: "finished" };

    case "SessionEnd":
      return { ...none, status: "exited", msg: "session ended" };

    default:
      return none;
  }
}

/** Sidebar order inside a group: needs you, then unread, then most recent. */
export function sessionRank(a: Session, b: Session): number {
  const w = (s: Session) => (s.status === "needs" ? 2 : 0) + (s.unread > 0 ? 1 : 0);
  return w(b) - w(a) || b.lastEvent - a.lastEvent;
}

/** Comparable form of a Windows path: backslashes, no trailing slash, lower case. */
export const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** The registered root that contains `cwd` (longest match), else `cwd` itself. */
export function rootFor(cwd: string, roots: string[]): string {
  const c = norm(cwd);
  let best = "";
  for (const r of roots) {
    const n = norm(r);
    if ((c === n || c.startsWith(n + "\\")) && n.length > norm(best).length) best = r;
  }
  return best || cwd;
}

/** Collapse a set of folders to top-level ones (drop folders inside another). */
export function topLevel(paths: string[]): string[] {
  const uniq = [...new Map(paths.map((p) => [norm(p), p])).values()];
  return uniq.filter((p) => !uniq.some((q) => q !== p && norm(p).startsWith(norm(q) + "\\")));
}

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** cwd relative to its root ("" when equal). */
export function relativeTo(cwd: string, root: string): string {
  const c = cwd.replace(/[\\/]+$/, "");
  return norm(c) === norm(root) ? "" : c.slice(root.replace(/[\\/]+$/, "").length + 1);
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
