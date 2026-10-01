// node --experimental-strip-types --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChart, renderMarkdown } from "../src/jobs/markdown.ts";

test("headings, lists, tables with numeric cells, inline formatting", () => {
  const html = renderMarkdown("## Weekly views\n\n- up **12%**\n- see `log`\n\n| day | views |\n|---|---:|\n| Mon | 1,204 |\n| Tue | 98 |\n\nDone.");
  assert.match(html, /<h3>Weekly views<\/h3>/);
  assert.match(html, /<li>up <b>12%<\/b><\/li>/);
  assert.match(html, /<li>see <code>log<\/code><\/li>/);
  assert.match(html, /<th>day<\/th><th>views<\/th>/);
  assert.match(html, /<td class="n">1,204<\/td>/);
  assert.match(html, /<p>Done\.<\/p>/);
});

test("raw HTML and script never pass through", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](https://example.com)');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('href="https://example.com"'));
});

test("chart blocks become SVG, bad charts fall back to code", () => {
  const md = '```chart\n{"type":"line","title":"Views","labels":["Mon","Tue"],"series":[{"name":"views","values":[120,98]}]}\n```';
  const html = renderMarkdown(md);
  assert.match(html, /<svg class="chart"/);
  assert.match(html, /<polyline/);
  assert.match(renderMarkdown('```chart\n{"oops": 1}\n```'), /<pre><code>/);
  assert.equal(parseChart('{"labels":["a"],"series":[{"name":"x","values":["5"]}]}')!.series[0].values[0], 5);
});
