import type { Env } from "../env";
import { clamp, listFacet, listPosts } from "../search/data";
import { keywordSearch } from "../search/keyword";

/**
 * Remote MCP server over Streamable HTTP (stateless, JSON responses).
 * The PRD's M4 add-on: three read-only tools filling the official Blog MCP server's gaps
 * (exact keyword search, filters, full history), calling the same functions as the web UI.
 */

const SERVER_INFO = { name: "blog-library", title: "Cloudflare Blog Library (keyword + filters)", version: "1.1.0" };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Add-on to the official Cloudflare Blog MCP server (https://blog.mcp.cloudflare.com/mcp). " +
  "Use THIS server for exact terms, date/tag/author filters and full-history listing of English posts. " +
  "Use the official server for search by meaning and for full post content (get_post). " +
  "Content is Cloudflare's public blog; always cite post URLs and publication dates.";

const RO = { readOnlyHint: true, openWorldHint: false };
const iso = { type: "string", description: "ISO date (YYYY, YYYY-MM-DD or full timestamp)" };

const TOOLS = [
  {
    name: "keyword_search_posts",
    title: "Keyword search posts",
    description: "Exact keyword search (SQLite FTS5, bm25; title hits outweigh body hits) over every English Cloudflare blog post, with optional tag, author and date filters. Use for half-remembered titles, product names, CVEs, dates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string", description: "Tag slug, e.g. zero-trust (the official server's list_tags lists them)" },
        author: { type: "string", description: "Author slug, see list_authors" },
        from: iso, to: iso,
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
      required: ["query"],
    },
    annotations: RO,
  },
  {
    name: "list_posts",
    title: "List posts",
    description: "List English posts (no body) filtered by tag, author, year or since date; newest or oldest first; paginated with cursor. Covers the full history.",
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
    name: "list_authors",
    title: "List authors",
    description: "List blog authors with post counts; use the slug with keyword_search_posts or list_posts.",
    inputSchema: { type: "object", properties: { prefix: { type: "string" } } },
    annotations: RO,
  },
];

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : undefined);
const brief = (p: { slug: string; title: string; url: string; published_at: string; authors: { name: string }[]; tags: { slug: string }[] }) => ({
  slug: p.slug, title: p.title, url: p.url, published_at: p.published_at, authors: p.authors.map((x) => x.name), tags: p.tags.map((x) => x.slug),
});

async function callTool(env: Env, _user: string, name: string, a: Args): Promise<unknown> {
  switch (name) {
    case "keyword_search_posts": {
      const q = s(a.query);
      if (!q) throw new Error("query is required");
      const posts = await keywordSearch(env, q, { tag: s(a.tag), author: s(a.author), from: s(a.from), to: s(a.to) }, clamp(n(a.limit) ?? 10, 1, 25));
      return { posts: posts.map((p) => ({ ...brief(p), snippet: p.snippet?.replace(/<\/?mark>/g, "") })) };
    }
    case "list_posts": {
      const sort = a.sort === "oldest" ? "oldest" : "newest";
      const r = await listPosts(env, { tag: s(a.tag), author: s(a.author), year: n(a.year), since: s(a.since), sort, limit: clamp(n(a.limit) ?? 25, 1, 100), cursor: s(a.cursor) });
      return { posts: r.posts.map(brief), next_cursor: r.next_cursor };
    }
    case "list_authors":
      return { authors: await listFacet(env, "authors", s(a.prefix), 2000) };
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
