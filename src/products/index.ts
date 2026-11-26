import type { Env } from "../env";
import catalogJson from "./catalog.json";
import { buildMatcher, MATCHER_VERSION, type Catalog, type CatalogProduct, type MatchInput, type ProductMatch } from "./match";
import { fetchDirectory } from "./directory";

export const CATALOG = catalogJson as unknown as Catalog;
/** Stored in settings.products_version; a mismatch makes the sync workflow re-match every post. */
export const PRODUCTS_VERSION = `${CATALOG.version}.m${MATCHER_VERSION}`;

export const PRODUCT = new Map<string, CatalogProduct>(CATALOG.products.map((p) => [p.slug, p]));
const CHILDREN = new Map<string, CatalogProduct[]>();
for (const p of CATALOG.products) if (p.parent) CHILDREN.set(p.parent, [...(CHILDREN.get(p.parent) ?? []), p]);

export function children(slug: string): CatalogProduct[] {
  return CHILDREN.get(slug) ?? [];
}

export function descendants(slug: string): string[] {
  const out: string[] = [];
  const walk = (s: string) => { for (const c of children(s)) { out.push(c.slug); walk(c.slug); } };
  walk(slug);
  return out;
}

export function ancestors(slug: string): CatalogProduct[] {
  const out: CatalogProduct[] = [];
  for (let p = PRODUCT.get(slug)?.parent; p && PRODUCT.has(p) && out.length < 10; p = PRODUCT.get(p)!.parent) out.unshift(PRODUCT.get(p)!);
  return out;
}

export function categorySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

let matcher: ((p: MatchInput) => ProductMatch[]) | null = null;
export function matchProducts(post: MatchInput): ProductMatch[] {
  matcher ??= buildMatcher(CATALOG);
  return matcher(post);
}

/** Replace a post's product links. 4 params per row, 25 rows per statement (D1 allows 100 bound params). */
export function productStatements(env: Env, postSlug: string, matches: ProductMatch[]): D1PreparedStatement[] {
  const out = [env.DB.prepare("DELETE FROM product_posts WHERE post_slug = ?").bind(postSlug)];
  for (let i = 0; i < matches.length; i += 25) {
    const chunk = matches.slice(i, i + 25);
    out.push(
      env.DB.prepare(`INSERT INTO product_posts (product_slug, post_slug, signal, mentions) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`)
        .bind(...chunk.flatMap((m) => [m.product, postSlug, m.signal, m.mentions])),
    );
  }
  return out;
}

/** Re-match one page of posts (by posts_fts rowid) from what D1 already holds: no blog fetches. */
export async function rematchBatch(env: Env, afterRowid: number, limit = 100): Promise<{ n: number; last: number; links: number }> {
  const rows = await env.DB.prepare(
    `SELECT f.rowid AS rid, f.slug, f.title, f.description, f.body,
            (SELECT group_concat(tag_slug, ' ') FROM post_tags WHERE post_slug = f.slug) AS tags
       FROM posts_fts f JOIN posts p ON p.slug = f.slug AND p.deleted_at IS NULL
      WHERE f.rowid > ? ORDER BY f.rowid LIMIT ?`,
  ).bind(afterRowid, limit).all<{ rid: number; slug: string; title: string; description: string; body: string; tags: string | null }>();
  const stmts: D1PreparedStatement[] = [];
  let links = 0;
  for (const r of rows.results) {
    const m = matchProducts({ title: r.title, description: r.description, body: r.body, tags: r.tags ? r.tags.split(" ") : [] });
    links += m.length;
    stmts.push(...productStatements(env, r.slug, m));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { n: rows.results.length, last: rows.results.at(-1)?.rid ?? afterRowid, links };
}

export interface CatalogHealth {
  checked_at: string;
  catalog_version: string;
  /** In the docs directory but not in the deployed catalog: rebuild the catalog. */
  docs_added: string[];
  /** In the catalog (from the directory) but gone from it: renamed or retired. */
  docs_removed: string[];
  /** Tags first used in the last 45 days that map to no product. */
  new_unmapped_tags: { slug: string; name: string; count: number }[];
  error?: string;
}

/** Daily drift check: docs directory vs. bundled catalog, and new blog tags no product claims. */
export async function catalogHealth(env: Env): Promise<CatalogHealth> {
  const out: CatalogHealth = { checked_at: new Date().toISOString(), catalog_version: CATALOG.version, docs_added: [], docs_removed: [], new_unmapped_tags: [] };
  try {
    const entries = await fetchDirectory(`blog-library/1.0 (private personal index; contact ${env.CONTACT})`);
    const known = new Set([...CATALOG.products.map((p) => p.docs_path).filter(Boolean), ...CATALOG.excluded_paths]);
    const live = new Set(entries.map((e) => e.path));
    out.docs_added = entries.filter((e) => !known.has(e.path)).map((e) => `${e.name} (${e.path})`);
    out.docs_removed = CATALOG.products.filter((p) => p.docs_path && !live.has(p.docs_path)).map((p) => `${p.name} (${p.docs_path})`);
  } catch (err) {
    out.error = String(err);
  }
  const mapped = new Set(CATALOG.products.flatMap((p) => p.tags));
  const rows = await env.DB.prepare(
    `SELECT t.slug, t.name, COUNT(*) AS count FROM tags t JOIN post_tags pt ON pt.tag_slug = t.slug
       JOIN posts p ON p.slug = pt.post_slug AND p.deleted_at IS NULL
      GROUP BY t.slug HAVING MIN(p.published_at) >= ? ORDER BY count DESC`,
  ).bind(new Date(Date.now() - 45 * 86400_000).toISOString()).all<{ slug: string; name: string; count: number }>();
  out.new_unmapped_tags = rows.results.filter((t) => !mapped.has(t.slug));
  return out;
}
