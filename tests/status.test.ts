// node --experimental-strip-types --test tests/   (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHook, rootFor, topLevel, relativeTo, sessionRank, dropText } from "../src/status.ts";

const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name, ...extra });

test("a full turn in a background session: working -> needs -> working -> done", () => {
  let st: any = { status: "starting" };
  let t = applyHook(st, ev("SessionStart"), false);
  assert.equal(t.status, "idle");
  st.status = t.status;

  t = applyHook(st, ev("UserPromptSubmit", { prompt: "fix the bug\nplease" }), false);
  assert.deepEqual([t.status, t.prompt, t.hasTranscript, t.notify], ["working", "fix the bug", true, null]);
  st.status = t.status;

  t = applyHook(st, ev("Notification", { message: "Claude needs your permission to use Bash" }), false);
  assert.deepEqual([t.status, t.unread, t.notify], ["needs", true, "needs"]);
  st.status = t.status;

  t = applyHook(st, ev("PostToolUse", { tool_name: "Bash" }), false);
  assert.equal(t.status, "working");
  st.status = t.status;

  t = applyHook(st, ev("Stop"), false);
  assert.deepEqual([t.status, t.unread, t.notify], ["done", true, "done"]);
});

test("visible session never notifies or counts unread", () => {
  const t = applyHook({ status: "working" }, ev("Stop"), true);
  assert.deepEqual([t.status, t.unread, t.notify], ["idle", false, null]);
  const n = applyHook({ status: "working" }, ev("Notification", { message: "permission" }), true);
  assert.deepEqual([n.status, n.unread, n.notify], ["needs", false, null]);
});

test("idle 'waiting for your input' nudge after a finished turn is not news", () => {
  const t = applyHook({ status: "done" }, ev("Notification", { message: "Claude is waiting for your input" }), false);
  assert.deepEqual([t.status, t.unread, t.notify], [undefined, false, null]);
  const t2 = applyHook({ status: "idle" }, ev("Notification", { notification_type: "idle_prompt", message: "x" }), false);
  assert.equal(t2.notify, null);
});

test("SessionStart does not reset a busy session (e.g. after /clear)", () => {
  assert.equal(applyHook({ status: "working" }, ev("SessionStart"), false).status, undefined);
  const r = applyHook({ status: "suspended" }, ev("SessionStart"), false);
  assert.deepEqual([r.status, r.msg], ["idle", ""], "a fresh start clears the stale activity line");
});

test("rootFor picks the longest containing root, case/slash-insensitive", () => {
  const roots = ["C:\\Work\\Python\\opensource", "C:\\Work\\Python\\opensource\\statarb", "C:\\Work\\JS\\mysite"];
  assert.equal(rootFor("c:/work/python/opensource/statarb/src", roots), roots[1]);
  assert.equal(rootFor("C:\\Work\\Python\\opensource\\cskr", roots), roots[0]);
  assert.equal(rootFor("C:\\Work\\Python\\opensourcex", roots), "C:\\Work\\Python\\opensourcex");
  assert.equal(relativeTo("C:\\Work\\JS\\mysite\\web", roots[2]), "web");
  assert.equal(relativeTo("C:\\Work\\JS\\mysite\\", roots[2]), "");
});

test("topLevel drops nested folders and duplicates", () => {
  const got = topLevel(["C:\\a", "C:\\a\\b", "c:\\A", "C:\\c"]);
  assert.deepEqual(got.map((s) => s.toLowerCase()).sort(), ["c:\\a", "c:\\c"]);
});

test("needs-you sorts first, then unread, then recency", () => {
  const mk = (id: string, status: string, unread: number, lastEvent: number): any => ({ id, status, unread, lastEvent });
  const list = [mk("old", "idle", 0, 1), mk("new", "idle", 0, 5), mk("unread", "done", 1, 2), mk("needs", "needs", 0, 0)];
  assert.deepEqual(list.sort(sessionRank).map((s) => s.id), ["needs", "unread", "new", "old"]);
});

test("dropped files paste like Windows Terminal: quoted only with spaces, space separated", () => {
  assert.equal(dropText([String.raw`C:\a\b.txt`]), String.raw`C:\a\b.txt`);
  assert.equal(dropText([String.raw`C:\My Docs\shot 1.png`, String.raw`D:\x.md`]), String.raw`"C:\My Docs\shot 1.png" D:\x.md`);
  assert.equal(dropText([]), "");
});
