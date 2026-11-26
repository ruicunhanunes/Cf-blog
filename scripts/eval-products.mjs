#!/usr/bin/env node
// Offline evaluation of the product matcher against the production corpus (read-only D1 queries).
//
//   node scripts/eval-products.mjs --cache /path/posts.json            summary + per-product table
//   node scripts/eval-products.mjs --cache /path/posts.json --sample r2 [--signal body] [--n 20]
//
// --cache stores the downloaded corpus (≈110 MB of Markdown) so reruns don't hit the API.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildMatcher } from "../src/products/match.ts";

const catalog = JSON.parse(readFileSync(new URL("../src/products/catalog.json", import.meta.url), "utf8"));
const ACCOUNT = "2ca4a078fd31558d48de8371b5699c9f";
const DB = "e14ec309-2cff-4d99-9584-aafedf284899";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i === -1 ? d : process.argv[i + 1]; };
const cache = arg("--cache");

async function q(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? "proxy-injected"}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const j = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result[0].results;
}

let posts;
if (cache && existsSync(cache)) posts = JSON.parse(readFileSync(cache, "utf8"));
else {
  posts = [];
  for (let after = 0; ;) {
    const rows = await q(
      `SELECT f.rowid AS rid, f.slug, f.title, f.description, f.body, p.published_at,
              (SELECT group_concat(tag_slug, ' ') FROM post_tags WHERE post_slug = f.slug) AS tags
         FROM posts_fts f JOIN posts p ON p.slug = f.slug AND p.deleted_at IS NULL
        WHERE f.rowid > ? ORDER BY f.rowid LIMIT 150`, [after]);
    posts.push(...rows.map((r) => ({ ...r, tags: r.tags ? r.tags.split(" ") : [] })));
    process.stderr.write(`\r${posts.length} posts`);
    if (rows.length < 150) break;
    after = rows[rows.length - 1].rid;
  }
  process.stderr.write("\n");
  if (cache) writeFileSync(cache, JSON.stringify(posts));
}

const match = buildMatcher(catalog);
const t0 = performance.now();
const results = posts.map((p) => ({ p, m: match(p) }));
const ms = performance.now() - t0;

const sample = arg("--sample");
if (sample) {
  const sig = arg("--signal");
  const n = Number(arg("--n", 20));
  const hits = results.filter((r) => r.m.some((x) => x.product === sample && (!sig || x.signal === sig) && (sig || x.signal !== "body")));
  // deterministic shuffle
  hits.sort((a, b) => (hash(a.p.slug) - hash(b.p.slug)));
  console.log(`${sample}: ${hits.length} ${sig ?? "strong"} matches; ${Math.min(n, hits.length)} sampled`);
  for (const r of hits.slice(0, n)) {
    const x = r.m.find((y) => y.product === sample);
    console.log(`  [${x.signal} ${x.mentions}] ${r.p.published_at.slice(0, 10)} ${r.p.title}`);
  }
  process.exit(0);
}

function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

const per = new Map(catalog.products.map((p) => [p.slug, { tag: 0, title: 0, body: 0 }]));
for (const r of results) for (const x of r.m) per.get(x.product)[x.signal]++;
const strongPosts = results.filter((r) => r.m.some((x) => x.signal !== "body")).length;
const anyPosts = results.filter((r) => r.m.length).length;
const news = results.filter((r) => r.p.tags.includes("product-news"));
const newsOrphans = news.filter((r) => !r.m.some((x) => x.signal !== "body"));

// Recall proxy: a product term appears in the title in any letter case, but the post got no strong match.
const caseMiss = [];
for (const r of results) {
  const tl = r.p.title.toLowerCase();
  for (const p of catalog.products) {
    if (r.m.some((x) => x.product === p.slug && x.signal !== "body")) continue;
    const t = p.terms.find((t) => t.length >= 4 && new RegExp(`(?<![\\p{L}\\p{N}])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(tl));
    if (t) caseMiss.push(`${p.slug} ← "${r.p.title}"`);
  }
}

console.log(`posts ${posts.length} · matched in ${ms.toFixed(0)} ms (${(ms / posts.length).toFixed(2)} ms/post)`);
console.log(`posts with ≥1 strong product match: ${strongPosts} (${((100 * strongPosts) / posts.length).toFixed(1)}%) · with any match: ${anyPosts}`);
console.log(`product-news posts with no strong match: ${newsOrphans.length} / ${news.length}`);
for (const r of newsOrphans.slice(0, 25)) console.log(`  ${r.p.published_at.slice(0, 10)} ${r.p.title}  [${r.p.tags.join(",")}]`);
const rows = [...per.entries()].map(([s, c]) => ({ s, ...c, strong: c.tag + c.title })).sort((a, b) => b.strong - a.strong);
console.log(`\nproduct                              strong  (tag  +title)  body`);
for (const r of rows) console.log(`${r.s.padEnd(36)} ${String(r.strong).padStart(6)}  (${String(r.tag).padStart(4)} +${String(r.title).padStart(5)})  ${String(r.body).padStart(4)}`);
console.log(`\nproducts with 0 strong matches: ${rows.filter((r) => !r.strong).map((r) => r.s).join(", ")}`);
console.log(`\ncase-insensitive title hits not matched (${caseMiss.length}), first 40:`);
for (const l of caseMiss.slice(0, 40)) console.log(`  ${l}`);
