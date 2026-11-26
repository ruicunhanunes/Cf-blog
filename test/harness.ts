// LOCAL TEST HARNESS ONLY — never deployed. Exposes internals without Access for `wrangler dev`.
import type { Env } from "../src/env";
import { processPost } from "../src/sync/consumer";
import { search, type Mode } from "../src/search/hybrid";
import { handleMcp } from "../src/mcp/server";
import { appFetch } from "../src/app";
import { listPosts, stats } from "../src/search/data";
import { blogFetch, localeOf, parseSitemapIndex, parseUrlset, slugOf } from "../src/sync/parse";
export { SyncWorkflow } from "../src/sync/workflow";

// Route outbound https through the local forwarder (scripts/fwd.mjs). Test-only.
const realFetch = globalThis.fetch;
let testKey: CryptoKeyPair | null = null;
async function key() {
  testKey ??= (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return testKey;
}
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function signJwt(email: string, aud = "test-aud") {
  const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const h = enc({ alg: "RS256", kid: "k1" });
  const p = enc({ email, sub: "u1", aud: [aud], iss: "https://test.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await key()).privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input as RequestInfo, init);
  if (req.url === "https://test.cloudflareaccess.com/cdn-cgi/access/certs") {
    const jwk = (await crypto.subtle.exportKey("jwk", (await key()).publicKey)) as JsonWebKey;
    return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] });
  }
  if (req.url.startsWith("https://")) return realFetch(new Request("http://127.0.0.1:9000/?u=" + encodeURIComponent(req.url), req));
  return realFetch(req);
}) as typeof fetch;

export default {
  async fetch(req: Request, realEnv: Env): Promise<Response> {
    // AI Search isn't available locally: stub uploads; search calls throw → hybrid degrades to keyword.
    const env = { ...realEnv, AI_SEARCH: { items: { upload: async () => ({}) }, search: async () => { throw new Error("no AI Search locally"); } } } as unknown as Env;
    const u = new URL(req.url);
    const p = u.searchParams;
    try {
      if (u.pathname.startsWith("/ui/")) {
        // Real app handler + real JWT verification against a test JWKS.
        const as = p.get("as") ?? "owner@example.com";
        const target = new URL(u.pathname.slice(3) + "?" + [...p].filter(([k]) => k !== "as").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"), "http://localhost:8799");
        const headers = new Headers(req.headers);
        if (as !== "none") headers.set("Cf-Access-Jwt-Assertion", await signJwt(as, p.get("aud") ?? "test-aud"));
        const env2 = { ...env, ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com", ACCESS_AUD: "test-aud", ALLOWED_EMAILS: "owner@example.com" } as Env;
        return appFetch(new Request(target, { method: req.method, headers, body: req.method === "GET" ? undefined : req.body }), env2, {} as ExecutionContext);
      }
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
