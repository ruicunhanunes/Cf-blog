import type { Env } from "../env";
import { filterSql, hydrate, type Filters, type PostCard } from "./data";

interface Chunk {
  filename: string;
  score: number;
  content: { type: string; text: string }[];
}

function aiSearch(env: Env) {
  // AI Search (formerly AutoRAG) is reached through the Workers AI binding.
  return (env.AI as unknown as { autorag(name: string): { search(o: unknown): Promise<{ data: Chunk[] }>; aiSearch(o: unknown): Promise<{ response: string; data: Chunk[] }> } }).autorag(env.AI_SEARCH_NAME);
}

function slugFromFilename(f: string): string | null {
  const m = f.match(/(?:^|\/)posts\/([^/]+)\.md$/) ?? f.match(/([^/]+)\.md$/);
  return m ? m[1] : null;
}

function stripFrontmatter(t: string): string {
  return t.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^# .*\n+/, "");
}

export async function semanticSearch(env: Env, q: string, f: Filters, limit = 20): Promise<PostCard[]> {
  const res = await aiSearch(env).search({ query: q, max_num_results: 50, rewrite_query: false, ranking_options: { score_threshold: 0 } });
  const best = new Map<string, { score: number; text: string }>();
  for (const c of res.data ?? []) {
    const slug = slugFromFilename(c.filename);
    if (!slug) continue;
    if (!best.has(slug) || best.get(slug)!.score < c.score) best.set(slug, { score: c.score, text: c.content?.map((x) => x.text).join(" ") ?? "" });
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
  const res = await aiSearch(env).aiSearch({ query: question, max_num_results: 15, rewrite_query: true });
  const slugs = [...new Set((res.data ?? []).map((c) => slugFromFilename(c.filename)).filter((s): s is string => !!s))];
  let sources: { title: string; url: string; published_at: string }[] = [];
  if (slugs.length) {
    const where = filterSql(f);
    const rows = await env.DB.prepare(
      `SELECT p.title, p.url, p.published_at FROM posts p WHERE p.slug IN (${slugs.map(() => "?").join(",")}) AND ${where.sql} ORDER BY p.published_at DESC`,
    ).bind(...slugs, ...where.params).all<{ title: string; url: string; published_at: string }>();
    sources = rows.results;
  }
  return { answer: res.response, sources };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
