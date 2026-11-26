import { BLOG_ORIGIN, type Env } from "../env";
import { slugOf } from "../sync/parse";
import { clamp, getPost, listFacet, listPosts, stats } from "../search/data";
import { search, type Mode } from "../search/hybrid";
import { askBlog } from "../search/semantic";

/**
 * Remote MCP server over Streamable HTTP (stateless, JSON responses).
 * Every tool is read-only and calls the same functions as the web UI.
 */

const SERVER_INFO = { name: "blog-library", title: "Cloudflare Blog Library", version: "1.0.0" };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Private library of every English post on blog.cloudflare.com (Cloudflare's public blog). " +
  "Call search_posts before get_post. When the user names a Cloudflare product, call list_tags to find its tag slug, then filter by it. " +
  "Always cite post URLs and publication dates in answers. Call library_stats to say how fresh the index is.";

const RO = { readOnlyHint: true, openWorldHint: false };
const iso = { type: "string", description: "ISO date (YYYY, YYYY-MM-DD or full timestamp)" };

const TOOLS = [
  {
    name: "search_posts",
    title: "Search posts",
    description: "Search Cloudflare blog posts by keyword, by meaning, or both (hybrid, default). Content is Cloudflare's public blog; cite post URLs and dates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["keyword", "semantic", "hybrid"], default: "hybrid" },
        tag: { type: "string", description: "Tag slug, see list_tags" },
        author: { type: "string", description: "Author slug, see list_authors" },
        from: iso, to: iso,
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
      required: ["query"],
    },
    annotations: RO,
  },
  {
    name: "get_post",
    title: "Get post",
    description: "Get one post's metadata and Markdown body by slug or by any blog URL (localized URLs resolve to the English post).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" }, url: { type: "string" },
        include_body: { type: "boolean", default: true },
        max_chars: { type: "integer", minimum: 500, maximum: 100000, default: 20000 },
      },
    },
    annotations: RO,
  },
  {
    name: "list_posts",
    title: "List posts",
    description: "List posts (no body) filtered by tag, author, year or since date; newest or oldest first; paginated with cursor.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string" }, author: { type: "string" }, year: { type: "integer" }, since: iso,
        sort: { type: "string", enum: ["newest", "oldest"], default: "newest" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        cursor: { type: "string" },
      },
    },
    annotations: RO,
  },
  {
    name: "list_tags",
    title: "List tags",
    description: "List tags with post counts; use to find the right tag slug before filtering.",
    inputSchema: { type: "object", properties: { prefix: { type: "string" } } },
    annotations: RO,
  },
  {
    name: "list_authors",
    title: "List authors",
    description: "List authors with post counts.",
    inputSchema: { type: "object", properties: { prefix: { type: "string" } } },
    annotations: RO,
  },
  {
    name: "ask_blog",
    title: "Ask the blog",
    description: "Answer a natural-language question from the blog with a generated answer plus source posts. Costs model tokens; limited to 30 calls a day.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, from: iso, to: iso }, required: ["question"] },
    annotations: RO,
  },
  {
    name: "library_stats",
    title: "Library stats",
    description: "Post count, date range, last sync time and status.",
    inputSchema: { type: "object", properties: {} },
    annotations: RO,
  },
];

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : undefined);

async function callTool(env: Env, user: string, name: string, a: Args): Promise<unknown> {
  switch (name) {
    case "search_posts": {
      const q = s(a.query);
      if (!q) throw new Error("query is required");
      const mode = (["keyword", "semantic", "hybrid"].includes(String(a.mode)) ? a.mode : "hybrid") as Mode;
      const r = await search(env, q, mode, { tag: s(a.tag), author: s(a.author), from: s(a.from), to: s(a.to) }, clamp(n(a.limit) ?? 10, 1, 25));
      return {
        mode: r.mode, degraded: r.degraded,
        posts: r.posts.map((p) => ({ slug: p.slug, title: p.title, url: p.url, published_at: p.published_at, authors: p.authors.map((x) => x.name), tags: p.tags.map((x) => x.slug), snippet: p.snippet?.replace(/<\/?mark>/g, "") })),
      };
    }
    case "get_post": {
      let slug = s(a.slug);
      const url = s(a.url);
      if (!slug && url) {
        const u = new URL(url, BLOG_ORIGIN);
        if (u.host !== new URL(BLOG_ORIGIN).host) throw new Error("url must be on blog.cloudflare.com");
        slug = slugOf(u.toString());
      }
      if (!slug) throw new Error("slug or url is required");
      const post = await getPost(env, slug.toLowerCase(), a.include_body !== false, clamp(n(a.max_chars) ?? 20000, 500, 100000));
      if (!post) throw new Error(`no post with slug ${slug}`);
      return post;
    }
    case "list_posts": {
      const sort = a.sort === "oldest" ? "oldest" : "newest";
      const r = await listPosts(env, { tag: s(a.tag), author: s(a.author), year: n(a.year), since: s(a.since), sort, limit: clamp(n(a.limit) ?? 25, 1, 100), cursor: s(a.cursor) });
      return { posts: r.posts.map((p) => ({ slug: p.slug, title: p.title, url: p.url, published_at: p.published_at, authors: p.authors.map((x) => x.name), tags: p.tags.map((x) => x.slug) })), next_cursor: r.next_cursor };
    }
    case "list_tags":
      return { tags: await listFacet(env, "tags", s(a.prefix), 2000) };
    case "list_authors":
      return { authors: await listFacet(env, "authors", s(a.prefix), 2000) };
    case "ask_blog": {
      const q = s(a.question);
      if (!q) throw new Error("question is required");
      const key = `rl:ask:${user}:${new Date().toISOString().slice(0, 10)}`;
      const used = Number((await env.OAUTH_KV.get(key)) ?? 0);
      if (used >= 30) throw new Error("ask_blog daily limit (30) reached; use search_posts instead");
      await env.OAUTH_KV.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
      return askBlog(env, q, { from: s(a.from), to: s(a.to) });
    }
    case "library_stats":
      return stats(env);
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

interface RpcMsg { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> }

async function handleOne(env: Env, user: string, m: RpcMsg): Promise<unknown | null> {
  const isNotification = m.id === undefined || m.id === null;
  try {
    let result: unknown;
    switch (m.method) {
      case "initialize": {
        const requested = String(m.params?.protocolVersion ?? "");
        result = {
          protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = (m.params?.arguments ?? {}) as Args;
        try {
          const out = await callTool(env, user, name, args);
          result = { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          result = { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
        }
        break;
      }
      case "resources/list": result = { resources: [] }; break;
      case "prompts/list": result = { prompts: [] }; break;
      default:
        if (m.method?.startsWith("notifications/")) return null;
        throw new RpcError(-32601, `Method not found: ${m.method}`);
    }
    return isNotification ? null : { jsonrpc: "2.0", id: m.id, result };
  } catch (e) {
    if (isNotification) return null;
    const code = e instanceof RpcError ? e.code : -32603;
    return { jsonrpc: "2.0", id: m.id, error: { code, message: (e as Error).message } };
  }
}

export async function handleMcp(req: Request, env: Env, user: string): Promise<Response> {
  if (req.method === "GET") return new Response("SSE stream not offered; use POST", { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body: RpcMsg | RpcMsg[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handleOne(env, user, m)))).filter((x) => x !== null);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: { "Cache-Control": "no-store" } });
}
