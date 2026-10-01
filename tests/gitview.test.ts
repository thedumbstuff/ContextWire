// node --experimental-strip-types --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, computeGraph, wordDiff } from "../src/gitview/model.ts";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

test("linear history stays in one lane", () => {
  const rows = computeGraph([c("c", "b"), c("b", "a"), c("a")]);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.ok(rows.every((r) => r.width === 1));
  // root commit has no line below it
  assert.ok(!rows[2].segs.some((s) => s.y2 === 1));
});

test("a merge opens a second lane that joins back at the fork point", () => {
  //   m      (merge of b and f)
  //   |\
  //   b f
  //   |/
  //   a
  const rows = computeGraph([c("m", "b", "f"), c("b", "a"), c("f", "a"), c("a")]);
  assert.equal(rows[0].col, 0);
  assert.equal(rows[1].col, 0);
  assert.equal(rows[2].col, 1, "the merged branch gets its own lane");
  assert.ok(rows[0].segs.some((s) => s.x1 === 0 && s.x2 === 1 && s.y2 === 1), "merge line to lane 1");
  assert.ok(rows[1].segs.some((s) => s.x1 === 1 && s.x2 === 1 && s.y1 === 0 && s.y2 === 1), "lane 1 passes b");
  assert.ok(rows[2].segs.some((s) => s.x1 === 1 && s.x2 === 0 && s.y2 === 1), "f joins lane 0 at a");
  assert.equal(rows[3].col, 0);
  assert.equal(rows[3].width, 1);
});

test("two branch tips share history", () => {
  const rows = computeGraph([c("x", "a"), c("y", "a"), c("a")]);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0]);
  assert.notEqual(rows[0].color, rows[1].color);
});

test("files tree groups folders, counts files and collapses single-folder chains", () => {
  const t = buildTree([
    { status: "M", path: "src/panels/git.ts", old_path: null },
    { status: "M", path: "src/styles.css", old_path: null },
    { status: "M", path: "src-tauri/src/gitops.rs", old_path: null },
    { status: "M", path: "src-tauri/src/lib.rs", old_path: null },
    { status: "A", path: "index.html", old_path: null },
  ]);
  assert.equal(t.count, 5);
  assert.deepEqual(t.dirs.map((d) => [d.name, d.count]), [["src", 2], ["src-tauri\\src", 2]]);
  assert.deepEqual(t.dirs[0].dirs.map((d) => d.name), ["panels"]);
  assert.deepEqual(t.files.map((f) => f.path), ["index.html"]);
});

test("word diff isolates the changed part", () => {
  const w = wordDiff("const headHash = r.last;", "const bar = r.last;")!;
  assert.deepEqual(w.a, ["const ", "headHash", " = r.last;"]);
  assert.deepEqual(w.b, ["const ", "bar", " = r.last;"]);
  assert.equal(wordDiff("same", "same"), null);
  const add = wordDiff("abc", "abcdef")!;
  assert.deepEqual(add.b, ["", "abcdef", ""], "inside one word the whole word is marked");
});
