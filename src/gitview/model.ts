// Pure helpers for the Git view (no DOM, unit-tested in tests/gitview.test.ts):
// commit-graph lanes, the changed-files tree and word-level diff highlights.

export interface GraphInput {
  hash: string;
  parents: string[];
}

/** A line in one row of the graph. Lanes are columns; y is 0 (top), 0.5 (dot) or 1 (bottom). */
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}

export interface GraphRow {
  col: number; // lane of this commit's dot
  color: number;
  width: number; // lanes used in this row
  segs: Seg[];
}

/**
 * Classic lane assignment: walk commits newest-first; every lane remembers the
 * commit it is waiting for. A commit takes the lane waiting for it (or a new
 * one), other lanes waiting for it merge into it, its first parent continues
 * the lane and further parents open (or join) other lanes.
 */
export function computeGraph(entries: GraphInput[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  const rows: GraphRow[] = [];
  for (const e of entries) {
    let col = lanes.indexOf(e.hash);
    if (col === -1) {
      col = free();
      lanes[col] = e.hash;
      colors[col] = nextColor++;
    }
    const before = lanes.slice();
    const segs: Seg[] = [];
    // lines coming into this commit (its own lane and any lanes merging into it)
    before.forEach((h, i) => {
      if (h === e.hash) segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: colors[i] });
    });
    before.forEach((h, i) => {
      if (h === e.hash && i !== col) lanes[i] = null;
    });
    // parents
    const myColor = colors[col];
    const [first, ...rest] = e.parents;
    if (first === undefined) {
      lanes[col] = null;
    } else {
      const k = lanes.indexOf(first);
      if (k !== -1 && k !== col) lanes[col] = null; // first parent already has a lane: join it
      else lanes[col] = first;
    }
    for (const p of rest) {
      if (lanes.indexOf(p) === -1) {
        const j = free();
        lanes[j] = p;
        colors[j] = nextColor++;
      }
    }
    for (const p of e.parents) {
      const j = lanes.indexOf(p);
      if (j !== -1) segs.push({ x1: col, y1: 0.5, x2: j, y2: 1, color: j === col ? myColor : colors[j] });
    }
    // lanes just passing through this row
    before.forEach((h, i) => {
      if (h !== null && h !== e.hash && lanes[i] === h) segs.push({ x1: i, y1: 0, x2: i, y2: 1, color: colors[i] });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ col, color: myColor, width: Math.max(before.length, lanes.length, col + 1), segs });
  }
  return rows;
}

// ---------------------------------------------------------------- files tree

export interface ChangedFile {
  status: string;
  path: string;
  old_path: string | null;
}

export interface TreeNode {
  name: string; // may be "a\b" after collapsing single-folder chains
  path: string;
  dirs: TreeNode[];
  files: ChangedFile[];
  count: number; // files below this folder
}

export function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split(/[\\/]/);
    let node = root;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.find((d) => d.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: [], files: [], count: 0 };
        node.dirs.push(next);
      }
      next.count++;
      node = next;
    }
    node.files.push(f);
  }
  const tidy = (n: TreeNode): TreeNode => {
    n.dirs = n.dirs.map(tidy).sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => a.path.localeCompare(b.path));
    // a folder whose only content is one folder is shown as "a\b" (like PyCharm)
    while (n.path && n.files.length === 0 && n.dirs.length === 1) {
      const c = n.dirs[0];
      n = { ...c, name: `${n.name}\\${c.name}` };
    }
    return n;
  };
  return tidy(root);
}

export const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

// ---------------------------------------------------------------- word diff

/** Split two changed lines into [same prefix, changed middle, same suffix]. */
export function wordDiff(a: string, b: string): { a: [string, string, string]; b: [string, string, string] } | null {
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // widen to word boundaries so highlights cover whole tokens
  const isWord = (c: string | undefined) => !!c && /\w/.test(c);
  while (p > 0 && isWord(a[p - 1]) && (isWord(a[p]) || isWord(b[p]))) p--;
  while (s > 0 && isWord(a[a.length - s]) && (isWord(a[a.length - s - 1]) || isWord(b[b.length - s - 1]))) s--;
  return {
    a: [a.slice(0, p), a.slice(p, a.length - s), a.slice(a.length - s)],
    b: [b.slice(0, p), b.slice(p, b.length - s), b.slice(b.length - s)],
  };
}
