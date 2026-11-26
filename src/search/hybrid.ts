import type { Env } from "../env";
import type { Filters, PostCard } from "./data";
import { keywordSearch } from "./keyword";
import { semanticSearch } from "./semantic";

export type Mode = "keyword" | "semantic" | "hybrid";

export interface SearchResult {
  mode: Mode;
  posts: PostCard[];
  /** Set when semantic search was requested but unavailable, and keyword results were returned instead. */
  degraded?: string;
  /** Set when filters left fewer than 5 semantic results (filters only narrow what the endpoint returned). */
  few?: boolean;
}

export async function semanticStatus(env: Env): Promise<"ok" | "degraded"> {
  try {
    const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'semantic_status'").first<{ value: string }>();
    return r?.value === "degraded" ? "degraded" : "ok";
  } catch {
    return "ok";
  }
}

/** Reciprocal rank fusion on slug, k = 60. */
export function rrf(lists: PostCard[][], k = 60): PostCard[] {
  const score = new Map<string, number>();
  const card = new Map<string, PostCard>();
  for (const list of lists) {
    list.forEach((p, i) => {
      score.set(p.slug, (score.get(p.slug) ?? 0) + 1 / (k + i + 1));
      if (!card.has(p.slug) || (!card.get(p.slug)!.snippet?.includes("<mark>") && p.snippet?.includes("<mark>"))) card.set(p.slug, p);
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([s, sc]) => ({ ...card.get(s)!, score: sc }));
}

export async function search(env: Env, q: string, mode: Mode, f: Filters, limit = 20, ctx?: ExecutionContext): Promise<SearchResult> {
  if (mode === "keyword") return { mode, posts: await keywordSearch(env, q, f, limit) };
  if ((await semanticStatus(env)) === "degraded") {
    return { mode: "keyword", posts: await keywordSearch(env, q, f, limit), degraded: "Search by meaning is unavailable right now; showing keyword results." };
  }
  try {
    if (mode === "semantic") {
      const posts = await semanticSearch(env, q, f, limit, ctx);
      return { mode, posts, few: posts.length < 5 };
    }
    const [kw, sem] = await Promise.all([keywordSearch(env, q, f, 50), semanticSearch(env, q, f, 50, ctx)]);
    return { mode, posts: rrf([kw, sem]).slice(0, limit), few: sem.length < 5 && kw.length < 5 };
  } catch (err) {
    console.log(JSON.stringify({ stage: "semantic", outcome: "error", error: String(err) }));
    return { mode: "keyword", posts: await keywordSearch(env, q, f, limit), degraded: "Search by meaning is unavailable right now; showing keyword results." };
  }
}
