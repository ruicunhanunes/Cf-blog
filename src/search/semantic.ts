import type { Env } from "../env";
import { filterSql, hydrate, type Filters, type PostCard } from "./data";
// AI Search instance binding (built-in storage): env.AI_SEARCH

type Chunk = AiSearchSearchResponse["chunks"][number];

function slugFromFilename(f: string): string | null {
  const m = f.match(/([^/]+)\.md$/);
  return m ? m[1] : null;
}

function stripFrontmatter(t: string): string {
  return t.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^# .*\n+/, "");
}

export async function semanticSearch(env: Env, q: string, f: Filters, limit = 20): Promise<PostCard[]> {
  const res = await env.AI_SEARCH.search({
    query: q,
    ai_search_options: { retrieval: { max_num_results: 50, match_threshold: 0.2, return_on_failure: false }, query_rewrite: { enabled: false } },
  });
  const best = new Map<string, { score: number; text: string }>();
  for (const c of (res.chunks ?? []) as Chunk[]) {
    const slug = slugFromFilename(c.item?.key ?? "");
    if (!slug) continue;
    if (!best.has(slug) || best.get(slug)!.score < c.score) best.set(slug, { score: c.score, text: c.text ?? "" });
  }
  if (!best.size) return [];
  const slugs = [...best.keys()];
  const where = filterSql(f);
  const rows = await env.DB.prepare(
    `SELECT p.slug, p.url, p.title, p.description, p.published_at FROM posts p WHERE p.slug IN (${slugs.map(() => "?").join(",")}) AND ${where.sql}`,
  ).bind(...slugs, ...where.params).all<Omit<PostCard, "authors" | "tags">>();
  const ordered = rows.results
    .map((r) => ({ ...r, score: best.get(r.slug)!.score, snippet: escapeHtml(stripFrontmatter(best.get(r.slug)!.text).slice(0, 240)) + "…" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return hydrate(env, ordered);
}

export async function askBlog(env: Env, question: string, f: Filters) {
  const res = await env.AI_SEARCH.chatCompletions({
    messages: [
      { role: "system", content: "Answer using only the provided Cloudflare blog excerpts. Cite post titles and dates. If the excerpts do not answer the question, say so." },
      { role: "user", content: question },
    ],
    ai_search_options: { retrieval: { max_num_results: 15 }, query_rewrite: { enabled: true } },
  });
  const slugs = [...new Set(((res.chunks ?? []) as Chunk[]).map((c) => slugFromFilename(c.item?.key ?? "")).filter((s): s is string => !!s))];
  let sources: { title: string; url: string; published_at: string }[] = [];
  if (slugs.length) {
    const where = filterSql(f);
    const rows = await env.DB.prepare(
      `SELECT p.title, p.url, p.published_at FROM posts p WHERE p.slug IN (${slugs.map(() => "?").join(",")}) AND ${where.sql} ORDER BY p.published_at DESC`,
    ).bind(...slugs, ...where.params).all<{ title: string; url: string; published_at: string }>();
    sources = rows.results;
  }
  return { answer: res.choices?.[0]?.message?.content ?? "", sources };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
