// LOCAL TEST HARNESS ONLY — never deployed. Exposes internals without Access for `wrangler dev`.
import type { Env } from "../src/env";
import { processPost } from "../src/sync/consumer";
import { search, type Mode } from "../src/search/hybrid";
import { handleMcp } from "../src/mcp/server";
import { listPosts, stats } from "../src/search/data";
import { blogFetch, localeOf, parseSitemapIndex, parseUrlset, slugOf } from "../src/sync/parse";
export { SyncWorkflow } from "../src/sync/workflow";

// Route outbound https through the local forwarder (scripts/fwd.mjs). Test-only.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as RequestInfo, init);
  if (req.url.startsWith("https://")) return realFetch(new Request("http://127.0.0.1:9000/?u=" + encodeURIComponent(req.url), req));
  return realFetch(req);
}) as typeof fetch;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    const p = u.searchParams;
    try {
      if (u.pathname === "/consume") {
        const out: Record<string, string> = {};
        for (const slug of p.getAll("slug")) {
          try { out[slug] = await processPost({ slug, url: `https://blog.cloudflare.com/${slug}/`, lastmod: null, run_id: "test" }, env); }
          catch (e) { out[slug] = "ERR " + String(e); }
        }
        return Response.json(out);
      }
      if (u.pathname === "/sitemaps") {
        const idx = parseSitemapIndex(await (await blogFetch("https://blog.cloudflare.com/sitemap.xml", "test", "application/xml")).text());
        let total = 0, en = 0; const sample: string[] = [];
        for (const c of idx) {
          const entries = parseUrlset(await (await blogFetch(c, "test", "application/xml")).text());
          total += entries.length;
          for (const e of entries) if (!localeOf(e.loc)) { en++; if (sample.length < 5 || Math.random() < 0.002) sample.push(slugOf(e.loc)); }
        }
        return Response.json({ children: idx, total, en, sample });
      }
      if (u.pathname === "/search") return Response.json(await search(env, p.get("q") ?? "", (p.get("mode") ?? "keyword") as Mode, { tag: p.get("tag") ?? undefined, from: p.get("from") ?? undefined, to: p.get("to") ?? undefined }, 10));
      if (u.pathname === "/list") return Response.json(await listPosts(env, { tag: p.get("tag") ?? undefined, year: p.get("year") ? Number(p.get("year")) : undefined, limit: 5 }));
      if (u.pathname === "/stats") return Response.json(await stats(env));
      if (u.pathname === "/mcp") return handleMcp(req, env, "test@example.com");
      if (u.pathname === "/workflow") { const i = await env.SYNC.create({ params: {} }); return Response.json({ id: i.id }); }
      if (u.pathname === "/workflow-status") { const i = await env.SYNC.get(p.get("id")!); return Response.json(await i.status()); }
      return new Response("harness", { status: 404 });
    } catch (e) {
      return new Response(String((e as Error).stack ?? e), { status: 500 });
    }
  },
};
