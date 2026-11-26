#!/usr/bin/env node
// Builds src/products/catalog.json from the developer docs directory plus data/product-overrides.json.
//
//   node scripts/build-products.mjs            fetch the directory and the blog's tags from D1, write the catalog
//   node scripts/build-products.mjs --check    exit 1 if the written catalog would change (CI / before deploy)
//
// Tags come from the production D1 through the Cloudflare API (CLOUDFLARE_API_TOKEN).
// The report printed at the end lists the curation work left: products with no tag, frequent unmapped tags.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fetchDirectory, parentPaths, slugify, DOCS_ORIGIN } from "../src/products/directory.ts";

const ROOT = new URL("..", import.meta.url);
const ACCOUNT = "2ca4a078fd31558d48de8371b5699c9f";
const DB = "e14ec309-2cff-4d99-9584-aafedf284899";
const check = process.argv.includes("--check");

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function blogTags() {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? "proxy-injected"}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: "SELECT t.slug, t.name, COUNT(*) AS count FROM tags t JOIN post_tags pt ON pt.tag_slug = t.slug JOIN posts p ON p.slug = pt.post_slug AND p.deleted_at IS NULL GROUP BY t.slug" }),
  });
  const j = await res.json();
  if (!j.success) throw new Error(`D1 query failed: ${JSON.stringify(j.errors)}`);
  return j.result[0].results;
}

const overrides = JSON.parse(readFileSync(new URL("data/product-overrides.json", ROOT), "utf8"));
const [entries, tags] = await Promise.all([fetchDirectory("blog-library catalog builder"), blogTags()]);
const tagBySlug = new Map(tags.map((t) => [t.slug, t]));
const parents = parentPaths(entries);
const slugByPath = new Map(entries.map((e) => [e.path, slugify(e.name)]));
const exclude = new Set(overrides.exclude ?? []);
const excludedPaths = entries.filter((e) => exclude.has(slugify(e.name))).map((e) => e.path).sort();

/** @type {Map<string, any>} */
const products = new Map();
for (const e of entries) {
  const slug = slugify(e.name);
  if (exclude.has(slug)) continue;
  if (products.has(slug)) throw new Error(`duplicate product slug ${slug}`);
  products.set(slug, {
    slug,
    name: e.name,
    description: e.description,
    categories: e.groups.filter((g) => g !== "Docs collections"),
    parent: parents.get(e.path) ? slugByPath.get(parents.get(e.path)) : null,
    docs_url: DOCS_ORIGIN + e.path,
    docs_path: e.path,
    status: "current",
  });
}
for (const x of overrides.extra ?? []) {
  if (products.has(x.slug)) throw new Error(`extra product ${x.slug} already in the directory`);
  products.set(x.slug, { description: "", categories: [], parent: null, docs_url: null, docs_path: null, status: "retired", ...x });
}
// Parents that were excluded (docs-only entries): drop the link.
for (const p of products.values()) while (p.parent && !products.has(p.parent)) p.parent = null;

const unknownOverride = Object.keys(overrides.products ?? {}).filter((s) => !products.has(s));
if (unknownOverride.length) throw new Error(`overrides for unknown products: ${unknownOverride.join(", ")}`);

for (const p of products.values()) {
  // Extra (retired) products carry their aliases/terms/tags inline; directory products take them from overrides.products.
  const o = overrides.products?.[p.slug] ?? (overrides.extra ?? []).find((x) => x.slug === p.slug) ?? {};
  if (o.parent !== undefined) p.parent = o.parent;
  if (o.categories) p.categories = o.categories;
  if (o.status) p.status = o.status;
  p.aliases = o.aliases ?? [];
  // Terms are matched case-sensitively in titles, descriptions and bodies. `terms` replaces the defaults
  // (used for names that are ordinary words, e.g. "Access", "Pages", "DNS"); `add_terms` extends them.
  p.terms = [...new Set([...(o.terms ?? [p.name]), ...p.aliases, ...(o.add_terms ?? [])])];

  // Tags: automatic name match (name, aliases, with/without "Cloudflare "), plus listed, minus not_tags.
  const names = new Set();
  for (const n of [p.name, ...p.aliases]) {
    names.add(norm(n));
    names.add(norm(n.replace(/^Cloudflare /, "")));
    names.add(norm(`Cloudflare ${n}`));
  }
  const auto = o.auto_tags === false ? [] : tags.filter((t) => names.has(norm(t.name)) || t.slug === p.slug).map((t) => t.slug);
  const not = new Set(o.not_tags ?? []);
  p.tags = [...new Set([...auto, ...(o.tags ?? [])])].filter((t) => !not.has(t)).sort();
  for (const t of o.tags ?? []) if (!tagBySlug.has(t)) console.warn(`warn: ${p.slug}: tag "${t}" has no posts`);
}

for (const p of products.values()) if (p.parent && !products.has(p.parent)) throw new Error(`${p.slug}: unknown parent ${p.parent}`);

const list = [...products.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
  slug: p.slug, name: p.name, description: p.description, categories: p.categories, parent: p.parent,
  status: p.status, docs_url: p.docs_url, docs_path: p.docs_path, aliases: p.aliases, terms: p.terms, tags: p.tags,
}));
// Primary groups (the first group of some directory product) first, then cross-cutting ones (AI, Storage, ...).
const primary = new Set(entries.map((e) => e.groups[0]));
const cats = [...new Set(list.flatMap((p) => p.categories))].sort((a, b) => Number(primary.has(b)) - Number(primary.has(a)) || a.localeCompare(b));
const body = { excluded_paths: excludedPaths, categories: cats, primary_categories: cats.filter((c) => primary.has(c)), stop_terms: overrides.stop_terms ?? [], products: list };
const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
const out = JSON.stringify({ version, source: `${DOCS_ORIGIN}/directory/`, ...body }, null, 1) + "\n";

const file = new URL("src/products/catalog.json", ROOT);
let prev = "";
try { prev = readFileSync(file, "utf8"); } catch { /* first build */ }
if (check) {
  if (prev !== out) { console.error("catalog.json is out of date: run node scripts/build-products.mjs"); process.exit(1); }
  console.log(`catalog up to date (${version})`);
  process.exit(0);
}
writeFileSync(file, out);

// ---- Curation report ----
const mapped = new Set(list.flatMap((p) => p.tags));
console.log(`wrote src/products/catalog.json: ${list.length} products (${list.filter((p) => p.status === "retired").length} retired), ${body.categories.length} categories, version ${version}`);
console.log(`\nProducts with no blog tag (${list.filter((p) => !p.tags.length).length}): ${list.filter((p) => !p.tags.length).map((p) => p.slug).join(", ")}`);
const ignored = new Set(overrides.ignored_tags ?? []);
const unmapped = tags.filter((t) => !mapped.has(t.slug) && !ignored.has(t.slug) && t.count >= 5).sort((a, b) => b.count - a.count);
console.log(`\nUnmapped tags with ≥5 posts (${unmapped.length}), not in ignored_tags:\n${unmapped.map((t) => `${t.slug}:${t.count}`).join(" ")}`);
