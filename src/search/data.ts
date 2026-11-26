import type { Env } from "../env";
import { descendants, PRODUCT } from "../products";

export interface PostCard {
  slug: string;
  url: string;
  title: string;
  description: string | null;
  published_at: string;
  authors: { slug: string; name: string }[];
  tags: { slug: string; name: string }[];
  /** Products the post is strongly about (tag or title signal). */
  products?: { slug: string; name: string }[];
  snippet?: string;
  score?: number;
}

export interface Filters {
  tag?: string;
  author?: string;
  from?: string; // ISO date
  to?: string; // ISO date
  year?: number;
  since?: string;
  /** Product slug: posts strongly related to it (tag or title signal). */
  product?: string;
  /** With product: also its sub-products (the parent page's toggle). */
  sub?: boolean;
  /** With product: also posts that only mention it in the body. */
  mentions?: boolean;
}

/** The product slugs a filter covers (itself, plus descendants when sub is set). */
export function productScope(f: Filters): string[] {
  if (!f.product || !PRODUCT.has(f.product)) return f.product ? [f.product] : [];
  return f.sub ? [f.product, ...descendants(f.product)] : [f.product];
}

/** Builds SQL WHERE fragments against alias p. */
export function filterSql(f: Filters): { sql: string; params: unknown[] } {
  const parts = ["p.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (f.tag) { parts.push("EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_slug = p.slug AND pt.tag_slug = ?)"); params.push(f.tag); }
  if (f.author) { parts.push("EXISTS (SELECT 1 FROM post_authors pa WHERE pa.post_slug = p.slug AND pa.author_slug = ?)"); params.push(f.author); }
  if (f.from) { parts.push("p.published_at >= ?"); params.push(normDate(f.from)); }
  if (f.to) { parts.push("p.published_at < ?"); params.push(endDate(f.to)); }
  if (f.year) { parts.push("p.year = ?"); params.push(f.year); }
  if (f.since) { parts.push("p.published_at >= ?"); params.push(normDate(f.since)); }
  if (f.product) {
    const scope = productScope(f);
    parts.push(`EXISTS (SELECT 1 FROM product_posts pp WHERE pp.post_slug = p.slug AND pp.product_slug IN (${scope.map(() => "?").join(",")})${f.mentions ? "" : " AND pp.signal != 'body'"})`);
    params.push(...scope);
  }
  return { sql: parts.join(" AND "), params };
}

function normDate(d: string): string {
  return /^\d{4}$/.test(d) ? `${d}-01-01` : d;
}
function endDate(d: string): string {
  if (/^\d{4}$/.test(d)) return `${Number(d) + 1}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T23:59:59.999Z`;
  return d;
}

/** Attach authors and tags to a list of post rows, preserving order. */
export async function hydrate(env: Env, rows: Omit<PostCard, "authors" | "tags" | "products">[]): Promise<PostCard[]> {
  if (!rows.length) return [];
  const slugs = rows.map((r) => r.slug);
  const ph = slugs.map(() => "?").join(",");
  const [a, t, pr] = await env.DB.batch([
    env.DB.prepare(`SELECT pa.post_slug, au.slug, au.name FROM post_authors pa JOIN authors au ON au.slug = pa.author_slug WHERE pa.post_slug IN (${ph})`).bind(...slugs),
    env.DB.prepare(`SELECT pt.post_slug, tg.slug, tg.name FROM post_tags pt JOIN tags tg ON tg.slug = pt.tag_slug WHERE pt.post_slug IN (${ph})`).bind(...slugs),
    env.DB.prepare(`SELECT post_slug, product_slug AS slug, '' AS name FROM product_posts WHERE signal != 'body' AND post_slug IN (${ph}) ORDER BY mentions DESC`).bind(...slugs),
  ]);
  const by = (res: D1Result) => {
    const m = new Map<string, { slug: string; name: string }[]>();
    for (const r of res.results as { post_slug: string; slug: string; name: string }[]) {
      if (!m.has(r.post_slug)) m.set(r.post_slug, []);
      m.get(r.post_slug)!.push({ slug: r.slug, name: r.name });
    }
    return m;
  };
  const am = by(a);
  const tm = by(t);
  const pm = by(pr);
  const products = (s: string) => (pm.get(s) ?? []).filter((x) => PRODUCT.has(x.slug)).map((x) => ({ slug: x.slug, name: PRODUCT.get(x.slug)!.name }));
  return rows.map((r) => ({ ...r, authors: am.get(r.slug) ?? [], tags: tm.get(r.slug) ?? [], products: products(r.slug) }));
}

export interface ListOpts extends Filters {
  sort?: "newest" | "oldest";
  limit?: number;
  cursor?: string;
}

/** Keyset pagination on (published_at, slug). Cursor is base64 of "published_at|slug". */
export async function listPosts(env: Env, o: ListOpts): Promise<{ posts: PostCard[]; next_cursor: string | null }> {
  const limit = clamp(o.limit ?? 50, 1, 100);
  const asc = o.sort === "oldest";
  const f = filterSql(o);
  let where = f.sql;
  const params = [...f.params];
  if (o.cursor) {
    const [pa, s] = atob(o.cursor).split("|");
    where += asc ? " AND (p.published_at, p.slug) > (?, ?)" : " AND (p.published_at, p.slug) < (?, ?)";
    params.push(pa, s);
  }
  const dir = asc ? "ASC" : "DESC";
  const rows = await env.DB.prepare(
    `SELECT p.slug, p.url, p.title, p.description, p.published_at FROM posts p WHERE ${where} ORDER BY p.published_at ${dir}, p.slug ${dir} LIMIT ?`,
  ).bind(...params, limit + 1).all<Omit<PostCard, "authors" | "tags">>();
  const list = rows.results.slice(0, limit);
  const next = rows.results.length > limit ? btoa(`${list[list.length - 1].published_at}|${list[list.length - 1].slug}`) : null;
  return { posts: await hydrate(env, list), next_cursor: next };
}

export async function getPost(env: Env, slug: string, includeBody: boolean, maxChars = 20000) {
  const row = await env.DB.prepare(
    "SELECT slug, url, title, description, image_url, published_at, updated_at, word_count, reading_minutes, body_source, r2_key FROM posts WHERE slug = ? AND deleted_at IS NULL",
  ).bind(slug).first<Record<string, unknown> & { slug: string; url: string; title: string; description: string | null; published_at: string; r2_key: string }>();
  if (!row) return null;
  const [card] = await hydrate(env, [row]);
  const out: Record<string, unknown> = { ...row, authors: card.authors, tags: card.tags };
  delete out.r2_key;
  if (includeBody) {
    const obj = await env.POSTS.get(row.r2_key);
    let body = obj ? await obj.text() : "";
    body = body.replace(/^---\n[\s\S]*?\n---\n/, "");
    const truncated = body.length > maxChars;
    out.body = truncated ? body.slice(0, maxChars) : body;
    out.truncated = truncated;
    out.approx_tokens = Math.ceil(body.length / 4);
  }
  return out;
}

export async function listFacet(env: Env, kind: "tags" | "authors", prefix?: string, limit = 1000) {
  const table = kind === "tags" ? "tags" : "authors";
  const join = kind === "tags" ? "post_tags j ON j.tag_slug = x.slug" : "post_authors j ON j.author_slug = x.slug";
  const where = prefix ? "WHERE x.slug LIKE ?1 OR x.name LIKE ?1" : "";
  const stmt = env.DB.prepare(
    `SELECT x.slug, x.name, COUNT(p.slug) AS count FROM ${table} x JOIN ${join} JOIN posts p ON p.slug = j.post_slug AND p.deleted_at IS NULL ${where} GROUP BY x.slug ORDER BY count DESC, x.name LIMIT ${limit}`,
  );
  const res = await (prefix ? stmt.bind(`${prefix.toLowerCase()}%`) : stmt).all<{ slug: string; name: string; count: number }>();
  return res.results;
}

export async function stats(env: Env) {
  const [p, r] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS posts, MIN(published_at) AS oldest, MAX(published_at) AS newest FROM posts WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1"),
  ]);
  const ps = p.results[0] as { posts: number; oldest: string | null; newest: string | null };
  const run = (r.results[0] as Record<string, unknown> | undefined) ?? null;
  if (run && typeof run.dropped_locales === "string") {
    try { run.dropped_locales = JSON.parse(run.dropped_locales); } catch { /* keep string */ }
  }
  return { posts: ps.posts, oldest: ps.oldest, newest: ps.newest, last_sync: run };
}

export async function yearCounts(env: Env, f: Filters = {}) {
  const w = filterSql({ ...f, year: undefined });
  const r = await env.DB.prepare(`SELECT p.year, COUNT(*) AS count FROM posts p WHERE ${w.sql} GROUP BY p.year ORDER BY p.year DESC`).bind(...w.params).all<{ year: number; count: number }>();
  return r.results;
}

/** Post counts per product: strong (tag/title) and body-only mentions. */
export async function productCounts(env: Env): Promise<Map<string, { strong: number; body: number }>> {
  const r = await env.DB.prepare(
    `SELECT pp.product_slug AS slug, SUM(pp.signal != 'body') AS strong, SUM(pp.signal = 'body') AS body
       FROM product_posts pp JOIN posts p ON p.slug = pp.post_slug AND p.deleted_at IS NULL GROUP BY pp.product_slug`,
  ).all<{ slug: string; strong: number; body: number }>();
  return new Map(r.results.map((x) => [x.slug, { strong: x.strong, body: x.body }]));
}

/** "Also mentioned in": posts that mention the product(s) in the body but are not strongly about any of them. */
export async function productMentions(env: Env, f: Filters, limit = 50): Promise<{ posts: (PostCard & { mentions: number })[]; total: number }> {
  const scope = productScope(f);
  if (!scope.length) return { posts: [], total: 0 };
  const ph = scope.map(() => "?").join(",");
  const base = `FROM product_posts pp JOIN posts p ON p.slug = pp.post_slug AND p.deleted_at IS NULL
     WHERE pp.product_slug IN (${ph}) AND pp.signal = 'body'
       AND NOT EXISTS (SELECT 1 FROM product_posts s WHERE s.post_slug = pp.post_slug AND s.product_slug IN (${ph}) AND s.signal != 'body')`;
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`SELECT p.slug, p.url, p.title, p.description, p.published_at, MAX(pp.mentions) AS mentions ${base} GROUP BY p.slug ORDER BY mentions DESC, p.published_at DESC LIMIT ?`).bind(...scope, ...scope, clamp(limit, 1, 100)),
    env.DB.prepare(`SELECT COUNT(DISTINCT p.slug) AS n ${base}`).bind(...scope, ...scope),
  ]);
  const list = rows.results as (Omit<PostCard, "authors" | "tags"> & { mentions: number })[];
  const cards = await hydrate(env, list);
  return { posts: cards.map((c, i) => ({ ...c, mentions: list[i].mentions })), total: (count.results[0] as { n: number }).n };
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}
