// Evaluates test/known-items.json against production data without going through Access:
//  - keyword: runs the Worker's exact FTS5 query (same toFtsQuery + bm25 weights) on remote D1 via wrangler
//  - semantic: the blog's public AI Search endpoint (same call as the Worker), merged by RRF (k=60) = hybrid mode
// Requires CLOUDFLARE_API_TOKEN (wrangler D1 access). Run: NODE_USE_ENV_PROXY=1 node scripts/eval.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "eval-"));
buildSync({ entryPoints: ["src/search/keyword.ts"], bundle: true, format: "esm", platform: "neutral", outfile: join(dir, "kw.mjs"), logLevel: "error" });
const { toFtsQuery } = await import(join(dir, "kw.mjs"));
const set = JSON.parse(readFileSync("test/known-items.json", "utf8"));

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "blog-library", "--remote", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out)[0].results;
}
const q = (s) => `'${s.replace(/'/g, "''")}'`;
async function keyword(query) {
  for (const joiner of [" ", " OR "]) {
    const fts = toFtsQuery(query, joiner);
    const rows = d1(`SELECT p.slug FROM posts_fts JOIN posts p ON p.slug = posts_fts.slug WHERE posts_fts MATCH ${q(fts)} AND p.deleted_at IS NULL ORDER BY bm25(posts_fts, 0, 10.0, 4.0, 3.0, 2.0, 1.0) LIMIT 5`);
    if (rows.length) return rows.map((r) => r.slug);
  }
  return [];
}
const ep = JSON.parse(await (await fetch("https://blog.cloudflare.com/.well-known/api-catalog")).text()).linkset.map((l) => l.anchor).find((a) => a.includes(".search.ai.cloudflare.com")).replace(/\/$/, "");
async function semantic(query) {
  // Same call as src/search/semantic.ts primarySearch: English only, 50 results, best chunk per slug.
  const r = await fetch(`${ep}/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, ai_search_options: { retrieval: { max_num_results: 50, filters: { language: "en-us" } } } }) });
  const j = await r.json();
  const seen = [];
  for (const c of j.result?.chunks ?? []) { const s = new URL(c.item.key).pathname.split("/").filter(Boolean).pop(); if (s && !seen.includes(s)) seen.push(s); }
  return seen;
}
async function keyword50(query) {
  for (const joiner of [" ", " OR "]) {
    const fts = toFtsQuery(query, joiner);
    const rows = d1(`SELECT p.slug FROM posts_fts JOIN posts p ON p.slug = posts_fts.slug WHERE posts_fts MATCH ${q(fts)} AND p.deleted_at IS NULL ORDER BY bm25(posts_fts, 0, 10.0, 4.0, 3.0, 2.0, 1.0) LIMIT 50`);
    if (rows.length) return rows.map((r) => r.slug);
  }
  return [];
}
function rrf(lists, k = 60) {
  const sc = new Map();
  for (const l of lists) l.forEach((s, i) => sc.set(s, (sc.get(s) ?? 0) + 1 / (k + i + 1)));
  return [...sc.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}
async function hybrid(query) {
  return rrf([await keyword50(query), await semantic(query)]).slice(0, 5);
}

let hits = 0;
const report = { known_items: [], questions: [] };
const regex = await hybrid("regex outage 2019");
console.log(`Hybrid "regex outage 2019": July 2, 2019 post at #${regex.indexOf("details-of-the-cloudflare-outage-on-july-2-2019") + 1 || "MISS"}\n`);
for (const k of set.known_items) {
  const top = await keyword(k.query);
  const rank = top.indexOf(k.slug) + 1;
  if (rank) hits++;
  report.known_items.push({ ...k, rank: rank || null });
  console.log(`${rank ? `#${rank}` : "MISS"}\t${k.query}`);
}
console.log(`\nKnown-item: ${hits}/${set.known_items.length} in top 5 (target >= 18)\n`);
for (const question of set.questions) {
  const top = await hybrid(question);
  report.questions.push({ question, top5: top });
  console.log(`${question}\n   → ${top.slice(0, 3).join("\n   → ") || "(none)"}`);
}
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nreport: ${join(dir, "report.json")}`);
