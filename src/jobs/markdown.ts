// Minimal, safe markdown for job reports: headings, paragraphs, lists, tables,
// code fences, inline code/bold/italic/links - and ```chart blocks rendered as
// SVG bar/line charts. All text is escaped first; no raw HTML passes through.
// Pure (no DOM) so it is unit-tested in tests/jobs.test.ts.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  // links: only http(s), opened by the app's link handler
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext="1">$1</a>');
  return t;
}

export interface ChartSpec {
  type: "bar" | "line";
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}

const PALETTE = ["#4c9aff", "#3fb95f", "#e3a526", "#a974f0", "#f0524f"];

export function parseChart(json: string): ChartSpec | null {
  try {
    const c = JSON.parse(json);
    if (!c || !Array.isArray(c.labels) || !Array.isArray(c.series) || !c.series.length) return null;
    const series = c.series
      .filter((s: { values?: unknown }) => Array.isArray(s?.values))
      .map((s: { name?: unknown; values: unknown[] }) => ({ name: String(s.name ?? ""), values: s.values.map((v) => Number(v) || 0) }));
    if (!series.length) return null;
    return { type: c.type === "line" ? "line" : "bar", title: c.title ? String(c.title) : undefined, labels: c.labels.map(String), series };
  } catch {
    return null;
  }
}

export function chartSvg(c: ChartSpec): string {
  const W = 640, H = 220, L = 46, R = 12, T = 26, B = 34;
  const n = c.labels.length || 1;
  const max = Math.max(1, ...c.series.flatMap((s) => s.values));
  const nice = (() => {
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    return Math.ceil(max / p) * p;
  })();
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / n;
  const y = (v: number) => H - B - ((H - T - B) * v) / nice;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = nice * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="cg"/><text x="${L - 6}" y="${y(v) + 4}" class="cy">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : v}</text>`;
  }).join("");
  const step = Math.ceil(n / 12);
  const labels = c.labels.map((l, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - B + 16}" class="cx">${esc(l)}</text>` : "")).join("");
  let marks = "";
  const k = c.series.length;
  c.series.forEach((s, si) => {
    const col = PALETTE[si % PALETTE.length];
    if (c.type === "line") {
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      marks += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/>` +
        s.values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${col}"><title>${esc(c.labels[i] ?? "")}: ${v}</title></circle>`).join("");
    } else {
      const bw = ((W - L - R) / n) * 0.7 / k;
      marks += s.values.map((v, i) => {
        const bx = x(i) - (bw * k) / 2 + si * bw;
        return `<rect x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${(H - B - y(v)).toFixed(1)}" fill="${col}" rx="2"><title>${esc(c.labels[i] ?? "")}: ${v}</title></rect>`;
      }).join("");
    }
  });
  const legend = k > 1 ? c.series.map((s, si) => `<tspan fill="${PALETTE[si % PALETTE.length]}">■</tspan> ${esc(s.name)}  `).join("") : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title ?? "chart")}">
    <text x="${L}" y="16" class="ct">${esc(c.title ?? "")}</text><text x="${W - R}" y="16" class="cl" text-anchor="end">${legend}</text>
    ${grid}${marks}${labels}</svg>`;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```\s*(\w*)/);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      const chart = lang === "chart" ? parseChart(body.join("\n")) : null;
      out.push(chart ? `<figure class="mdchart">${chartSvg(chart)}</figure>` : `<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      i++;
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const num = (s: string) => /^[-+]?[\d,.]+%?$/.test(s);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td${num(c) ? ' class="n"' : ""}>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
