import { BLOG_ORIGIN, type Env } from "../env";
import { decodeEntities, localeOf, slugOf } from "../sync/parse";
import { filterSql, hydrate, type Filters, type PostCard } from "./data";

/**
 * Search by meaning via the blog's own published services (PRD section 8):
 *  primary  — the public AI Search endpoint listed in /.well-known/api-catalog (POST /search)
 *  fallback — GET /.well-known/search?q= (undocumented Markdown format, tolerant parser)
 * Nothing is indexed by the library for this; results are joined to D1 for authors, tags and filters.
 */

export interface SemanticHit {
  slug: string;
  url: string;
  score: number;
  title?: string;
  description?: string;
  published_at?: string;
  snippet?: string;
}

const CATALOG_URL = `${BLOG_ORIGIN}/.well-known/api-catalog`;
const FALLBACK_URL = `${BLOG_ORIGIN}/.well-known/search`;
const UA = "blog-library/1.0 (private personal index)";
const TIMEOUT_MS = 3000;

function cacheKey(kind: string, q: string): Request {
  return new Request(`https://blog-library.cache/${kind}?q=${encodeURIComponent(q.trim().toLowerCase().replace(/\s+/g, " "))}`);
}

/** The public AI Search hostname from the api-catalog, cached for a day (never hardcoded). */
export async function discoverEndpoint(): Promise<string | null> {
  const cache = caches.default;
  const key = new Request("https://blog-library.cache/api-catalog");
  const hit = await cache.match(key);
  let text: string | null = hit ? await hit.text() : null;
  if (!text) {
    const res = await fetch(CATALOG_URL, { headers: { "User-Agent": UA, Accept: "application/linkset+json, application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    text = await res.text();
    await cache.put(key, new Response(text, { headers: { "Cache-Control": "max-age=86400" } }));
  }
  try {
    const anchors: string[] = (JSON.parse(text).linkset ?? []).map((l: { anchor: string }) => l.anchor);
    const ep = anchors.find((a) => /^https:\/\/[a-z0-9-]+\.search\.ai\.cloudflare\.com\/?$/.test(a));
    return ep ? ep.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function toHit(url: string, score: number, extra: Partial<SemanticHit> = {}): SemanticHit | null {
  try {
    const u = new URL(url, BLOG_ORIGIN);
    if (u.host !== new URL(BLOG_ORIGIN).host) return null;
    const slug = slugOf(u.toString());
    if (!slug) return null;
    // Localized copies map to the English slug (the locale prefix is stripped by slugOf's last-segment rule).
    return { slug, url: `${BLOG_ORIGIN}/${slug}/`, score, ...extra, ...(localeOf(u.toString()) ? { title: undefined, description: undefined, snippet: undefined } : {}) };
  } catch {
    return null;
  }
}

/** Primary: POST {endpoint}/search, English only (the index carries a `language` attribute). */
export async function primarySearch(endpoint: string, q: string): Promise<{ hits: SemanticHit[]; raw: string }> {
  const res = await fetch(`${endpoint}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query: q, ai_search_options: { retrieval: { max_num_results: 50, filters: { language: "en-us" } } } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`primary ${res.status}`);
  return { hits: parsePrimary(raw), raw };
}

export function parsePrimary(raw: string): SemanticHit[] {
  const j = JSON.parse(raw);
  const out: SemanticHit[] = [];
  for (const c of j?.result?.chunks ?? []) {
    const md = c?.item?.metadata ?? {};
    const pt = md["article:published_time"];
    const h = toHit(String(c?.item?.key ?? ""), Number(c?.score ?? 0), {
      title: typeof md.title === "string" ? decodeEntities(md.title) : undefined,
      description: typeof md.description === "string" ? decodeEntities(md.description) : undefined,
      published_at: typeof pt === "number" ? new Date(pt).toISOString() : typeof pt === "string" ? pt : undefined,
      snippet: typeof c?.text === "string" ? c.text : undefined,
    });
    if (h) out.push(h);
  }
  return out;
}

/** Fallback: GET /.well-known/search?q= — "## <url> (score: x)" sections with a YAML-ish block and JSON-LD. */
export async function fallbackSearch(q: string): Promise<{ hits: SemanticHit[]; raw: string }> {
  const res = await fetch(`${FALLBACK_URL}?q=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`fallback ${res.status}`);
  return { hits: parseFallback(raw), raw };
}

export function parseFallback(raw: string): SemanticHit[] {
  const out: SemanticHit[] = [];
  const sections = raw.split(/^## /m).slice(1);
  for (const sec of sections) {
    const head = sec.match(/^(https?:\/\/\S+)\s*(?:\(score:\s*([\d.]+)\))?/);
    if (!head) continue;
    const field = (k: string) => sec.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim();
    let published: string | undefined;
    const ld = sec.match(/```json\s*([\s\S]*?)```/);
    if (ld) {
      try { published = JSON.parse(ld[1]).datePublished; } catch { /* tolerate */ }
    }
    const h = toHit(head[1], head[2] ? Number(head[2]) : 0, {
      title: field("title") ? decodeEntities(field("title")!) : undefined,
      description: field("description") ? decodeEntities(field("description")!) : undefined,
      published_at: published,
    });
    if (h) out.push(h);
  }
  return out;
}

/** Primary, then fallback; raw responses cached 1 h by normalised query. Best score per slug. */
export async function blogSemantic(env: Env, q: string): Promise<SemanticHit[]> {
  const cache = caches.default;
  const key = cacheKey("semantic", q);
  const cached = await cache.match(key);
  if (cached) return (await cached.json()) as SemanticHit[];

  const rl = await env.SEMANTIC_RL?.limit({ key: "global" });
  if (rl && !rl.success) throw new Error("semantic rate limit (30/min) reached");

  let hits: SemanticHit[] = [];
  try {
    const ep = await discoverEndpoint();
    if (!ep) throw new Error("no endpoint in api-catalog");
    hits = (await primarySearch(ep, q)).hits;
  } catch (err) {
    console.log(JSON.stringify({ stage: "semantic", source: "primary", outcome: "error", error: String(err) }));
  }
  if (!hits.length) hits = (await fallbackSearch(q)).hits;

  const best = new Map<string, SemanticHit>();
  for (const h of hits) {
    const cur = best.get(h.slug);
    if (!cur || cur.score < h.score) best.set(h.slug, { ...cur, ...h, title: h.title ?? cur?.title, description: h.description ?? cur?.description, published_at: h.published_at ?? cur?.published_at });
  }
  const list = [...best.values()].sort((a, b) => b.score - a.score);
  await cache.put(key, new Response(JSON.stringify(list), { headers: { "Cache-Control": "max-age=3600", "Content-Type": "application/json" } }));
  return list;
}

export async function semanticSearch(env: Env, q: string, f: Filters, limit = 20, ctx?: ExecutionContext): Promise<PostCard[]> {
  const hits = await blogSemantic(env, q);
  if (!hits.length) return [];
  const where = filterSql(f);
  const slugs = hits.map((h) => h.slug);
  const known = new Map<string, Omit<PostCard, "authors" | "tags">>();
  const size = Math.max(10, 90 - where.params.length); // D1: at most 100 bound parameters per statement
  for (let i = 0; i < slugs.length; i += size) {
    const chunk = slugs.slice(i, i + size);
    const rows = await env.DB.prepare(`SELECT p.slug, p.url, p.title, p.description, p.published_at FROM posts p WHERE p.slug IN (${chunk.map(() => "?").join(",")}) AND ${where.sql}`)
      .bind(...chunk, ...where.params).all<Omit<PostCard, "authors" | "tags">>();
    for (const r of rows.results) known.set(r.slug, r);
  }
  // Slugs the library hasn't synced yet: keep them (only when no filters apply) and enqueue a fetch.
  const unfiltered = !f.tag && !f.author && !f.from && !f.to && !f.year && !f.since && !f.product;
  const missing: SemanticHit[] = [];
  if (unfiltered) {
    const exist = new Set<string>();
    const all = slugs.filter((s) => !known.has(s));
    for (let i = 0; i < all.length; i += 90) {
      const chunk = all.slice(i, i + 90);
      if (!chunk.length) break;
      const r = await env.DB.prepare(`SELECT slug FROM posts WHERE slug IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ slug: string }>();
      r.results.forEach((x) => exist.add(x.slug));
    }
    for (const h of hits) if (!known.has(h.slug) && !exist.has(h.slug) && h.title) missing.push(h);
    if (missing.length) {
      const send = env.FETCH_QUEUE.sendBatch(missing.slice(0, 20).map((h) => ({ body: { slug: h.slug, url: h.url, lastmod: null, run_id: "semantic-discovery" } })));
      ctx ? ctx.waitUntil(send) : await send;
    }
  }
  const ordered: (Omit<PostCard, "authors" | "tags"> & { score: number })[] = [];
  for (const h of hits) {
    const k = known.get(h.slug);
    const snippet = escapeHtml(cleanSnippet(h.snippet ?? "") || h.description || k?.description || "").slice(0, 260);
    if (k) ordered.push({ ...k, score: h.score, snippet });
    else if (missing.includes(h)) ordered.push({ slug: h.slug, url: h.url, title: h.title!, description: h.description ?? null, published_at: h.published_at ?? "", score: h.score, snippet });
    if (ordered.length >= limit) break;
  }
  return hydrate(env, ordered);
}

function cleanSnippet(t: string): string {
  return t
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^#{1,6} .*$/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*`>_|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
