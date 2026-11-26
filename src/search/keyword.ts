import type { Env } from "../env";
import { escapeHtml } from "./semantic";
import { clamp, filterSql, hydrate, type Filters, type PostCard } from "./data";

/** Turn free text into a safe FTS5 query: quoted terms, implicit AND, prefix match on the last term. */
const STOP = new Set("a an and are as at be by did do does for from has have how i in is it its of on or that the this to was were what when where which who why will with write wrote about cloudflare cloudflare's explain explained".split(" "));

export function toFtsQuery(q: string, joiner: " " | " OR " = " "): string {
  const terms = q
    .toLowerCase()
    // Keep dotted/punctuated tokens (1.1.1.1, 17.2m, http/2) together: they become FTS phrases below.
    .replace(/[^\p{L}\p{N}\s'.\/:-]/gu, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['.\/:-]+|['.\/:-]+$/g, ""))
    .filter(Boolean)
    .slice(0, 16);
  const content = terms.filter((t) => !STOP.has(t));
  const use = (content.length ? content : terms).slice(0, 12);
  if (!use.length) return "";
  return use
    .map((t, i) => {
      const phrase = t.replace(/["'.\/:-]+/g, " ").trim(); // unicode61 splits on these too, so a phrase matches adjacency
      const prefix = joiner === " " && i === use.length - 1 && t.length >= 3 && !/[.\/:-]/.test(t) ? "*" : "";
      return `"${phrase}"${prefix}`;
    })
    .join(joiner);
}

export async function keywordSearch(env: Env, q: string, f: Filters, limit = 20, offset = 0): Promise<PostCard[]> {
  const strict = toFtsQuery(q);
  if (!strict) return [];
  const first = await runFts(env, strict, f, limit, offset);
  if (first.length || !strict.includes(" ")) return first;
  // No document has every term: fall back to any-term matching, still ranked by bm25.
  return runFts(env, toFtsQuery(q, " OR "), f, limit, offset);
}

async function runFts(env: Env, fts: string, f: Filters, limit: number, offset: number): Promise<PostCard[]> {
  const where = filterSql(f);
  const rows = await env.DB.prepare(
    `SELECT p.slug, p.url, p.title, p.description, p.published_at,
            snippet(posts_fts, 5, char(1), char(2), '…', 24) AS snippet,
            bm25(posts_fts, 0, 10.0, 4.0, 3.0, 2.0, 1.0) AS score
       FROM posts_fts JOIN posts p ON p.slug = posts_fts.slug
      WHERE posts_fts MATCH ? AND ${where.sql}
      ORDER BY score LIMIT ? OFFSET ?`,
  ).bind(fts, ...where.params, clamp(limit, 1, 50), Math.max(0, offset)).all<Omit<PostCard, "authors" | "tags">>();
  return hydrate(env, rows.results.map((r) => ({ ...r, snippet: safeSnippet(r.snippet ?? "") })));
}

/** Escape everything, then let only the FTS5 highlight markers through as <mark>. */
export function safeSnippet(raw: string): string {
  const plain = raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/!\[[^\]]*\]?/g, "").replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim();
  return escapeHtml(plain).replaceAll("\u0001", "<mark>").replaceAll("\u0002", "</mark>");
}
