// Evaluates test/known-items.json against production data without going through Access:
//  - keyword: runs the Worker's exact FTS5 query (same toFtsQuery + bm25 weights) on remote D1 via wrangler
//  - semantic: queries the AI Search instance via the REST API
// Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
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
async function semantic(query) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai-search/namespaces/default/instances/blog-library/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    body: JSON.stringify({ query, ai_search_options: { retrieval: { max_num_results: 25, match_threshold: 0.2 } } }),
  });
  const j = await r.json();
  const seen = [];
  for (const c of j.result?.chunks ?? []) { const s = c.item.key.replace(/\.md$/, ""); if (!seen.includes(s)) seen.push(s); }
  return seen.slice(0, 5);
}

let hits = 0;
const report = { known_items: [], questions: [] };
for (const k of set.known_items) {
  const top = await keyword(k.query);
  const rank = top.indexOf(k.slug) + 1;
  if (rank) hits++;
  report.known_items.push({ ...k, rank: rank || null });
  console.log(`${rank ? `#${rank}` : "MISS"}\t${k.query}`);
}
console.log(`\nKnown-item: ${hits}/${set.known_items.length} in top 5 (target >= 18)\n`);
for (const question of set.questions) {
  const top = await semantic(question);
  report.questions.push({ question, top5: top });
  console.log(`${question}\n   → ${top.slice(0, 3).join("\n   → ") || "(none)"}`);
}
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nreport: ${join(dir, "report.json")}`);
