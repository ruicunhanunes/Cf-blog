import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { verifyAccess, type AccessIdentity } from "./auth/access";
import { clamp, getPost, listFacet, listPosts, stats, yearCounts, type Filters } from "./search/data";
import { search, semanticStatus, type Mode } from "./search/hybrid";
import { escapeHtml as e } from "./search/semantic";
import { filtersForm, ICON_SVG, layout, MANIFEST, resultsBlock } from "./ui/views";
import { APPLE_ICON_B64 } from "./ui/icon-png";


export const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function html(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", ...extra } });
}
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

function filtersFrom(p: URLSearchParams): Filters {
  const g = (k: string) => p.get(k)?.trim() || undefined;
  return { tag: g("tag"), author: g("author"), from: g("from"), to: g("to"), year: g("year") ? Number(g("year")) : undefined, since: g("since") };
}

// ---------- OAuth consent (MCP clients) ----------

async function authorizeGet(req: Request, env: Env, who: AccessIdentity): Promise<Response> {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (err) {
    return html(layout("Invalid request", `<p class="note">Invalid authorization request: ${e(String(err))}</p>`), 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return html(layout("Unknown client", `<p class="note">Unknown client.</p>`), 400);
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(`consent:${id}`, JSON.stringify({ oauthReq, email: who.email }), { expirationTtl: 600 });
  const name = client.clientName || client.clientId;
  return html(
    layout(
      "Authorize access",
      `<h2>Authorize MCP client</h2>
<p class="note"><b>${e(name)}</b> wants read-only access to your Blog Library as <b>${e(who.email)}</b>.<br>
It will be redirected to <code>${e(oauthReq.redirectUri)}</code>.</p>
<form method="post" action="/authorize"><input type="hidden" name="consent" value="${id}">
<button type="submit" name="decision" value="allow" style="min-height:44px;padding:0 20px">Allow</button>
<button type="submit" name="decision" value="deny" style="min-height:44px;padding:0 20px">Deny</button></form>`,
    ),
  );
}

async function authorizePost(req: Request, env: Env, who: AccessIdentity): Promise<Response> {
  const form = await req.formData();
  const id = String(form.get("consent") ?? "");
  const stored = await env.OAUTH_KV.get<{ oauthReq: AuthRequest; email: string }>(`consent:${id}`, "json");
  if (!stored || stored.email !== who.email) return html(layout("Expired", `<p class="note">This authorization request expired. Start again from your MCP client.</p>`), 400);
  await env.OAUTH_KV.delete(`consent:${id}`);
  if (form.get("decision") !== "allow") {
    const u = new URL(stored.oauthReq.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (stored.oauthReq.state) u.searchParams.set("state", stored.oauthReq.state);
    return Response.redirect(u.toString(), 302);
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.oauthReq,
    userId: who.email,
    metadata: { label: who.email },
    scope: stored.oauthReq.scope,
    props: { email: who.email },
  });
  return Response.redirect(redirectTo, 302);
}

// ---------- Web UI + JSON API ----------

async function footer(env: Env): Promise<string> {
  try {
    const s = await stats(env);
    const at = (s.last_sync?.finished_at as string) ?? (s.last_sync?.started_at as string);
    return `Synced ${at ? e(new Date(at).toUTCString()) : "never"} · ${s.posts} posts${s.last_sync?.status ? ` · last run ${e(String(s.last_sync.status))}` : ""}`;
  } catch {
    return "";
  }
}

export async function appFetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const p = url.searchParams;

  // Public, content-free endpoints.
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });

  const who = await verifyAccess(req, env);
  if (!who) return new Response("Forbidden: Cloudflare Access identity required", { status: 403 });

  if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json" } });
  if (path === "/icon.svg") return new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" } });
  if (path === "/apple-touch-icon.png") return new Response(Uint8Array.from(atob(APPLE_ICON_B64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });

  if (path === "/authorize") return req.method === "POST" ? authorizePost(req, env, who) : authorizeGet(req, env, who);

  // Admin: identity + same-origin POST (no cross-site triggering).
  if (path === "/admin/sync") {
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Bad origin", { status: 403 });
    const inst = await env.SYNC.create({ params: { full: p.get("full") === "1" } });
    return json({ instance_id: inst.id });
  }

  // JSON API
  if (path === "/api/search") {
    const q = p.get("q")?.trim() ?? "";
    if (!q) return json({ error: "q is required" }, 400);
    const mode = (["keyword", "semantic", "hybrid"].includes(p.get("mode") ?? "") ? p.get("mode") : "keyword") as Mode;
    const t0 = Date.now();
    const r = await search(env, q, mode, filtersFrom(p), clamp(Number(p.get("limit") ?? 20), 1, 50), _ctx);
    console.log(JSON.stringify({ stage: "search", mode: r.mode, ms: Date.now() - t0, n: r.posts.length }));
    return json({ ...r, ms: Date.now() - t0 });
  }
  if (path === "/api/posts") {
    return json(await listPosts(env, { ...filtersFrom(p), sort: p.get("sort") === "oldest" ? "oldest" : "newest", limit: Number(p.get("limit") ?? 50), cursor: p.get("cursor") ?? undefined }));
  }
  const apiPost = path.match(/^\/api\/posts\/([^/]+)$/);
  if (apiPost) {
    const post = await getPost(env, decodeURIComponent(apiPost[1]).toLowerCase(), p.get("include") === "body", 1_000_000);
    return post ? json(post) : json({ error: "not found" }, 404);
  }
  if (path === "/api/tags") return json(await listFacet(env, "tags", p.get("prefix") ?? undefined, 5000));
  if (path === "/api/authors") return json(await listFacet(env, "authors", p.get("prefix") ?? undefined, 5000));
  if (path === "/api/stats") return json(await stats(env));

  // HTML pages
  if (path === "/") {
    const [recent, years, tags, authors, foot] = await Promise.all([
      listPosts(env, { limit: 20 }), yearCounts(env), listFacet(env, "tags", undefined, 30), listFacet(env, "authors", undefined, 5000), footer(env),
    ]);
    const letters = [...new Set(authors.map((a) => a.name.trim()[0]?.toUpperCase()).filter((c) => c && /[A-Z]/.test(c)))].sort();
    const body = `
<h2>Newest</h2>${resultsBlock(recent.posts)}
<p><a href="/browse?sort=newest">All posts →</a></p>
<h2>Years</h2><div class="chips">${years.map((y) => `<a href="/year/${y.year}">${y.year}<small>${y.count}</small></a>`).join("")}</div>
<h2>Top tags</h2><div class="chips">${tags.map((t) => `<a href="/tag/${e(t.slug)}">${e(t.name)}<small>${t.count}</small></a>`).join("")}</div>
<p><a href="/tags">All tags →</a></p>
<h2>Authors A–Z</h2><div class="chips az">${letters.map((l) => `<a href="/authors#${l}">${l}</a>`).join("")}</div>`;
    return html(layout("Cloudflare Blog Library", body, { footer: foot, meaning: (await semanticStatus(env)) === "ok" }));
  }

  if (path === "/search") {
    const q = p.get("q")?.trim() ?? "";
    const mode = (p.get("mode") === "keyword" ? "keyword" : p.get("mode") ? (p.get("mode") as Mode) : "keyword") as Mode;
    const r = q ? await search(env, q, mode, filtersFrom(p), 30, _ctx) : { posts: [], mode };
    const kwLink = new URLSearchParams(p); kwLink.set("mode", "keyword"); kwLink.delete("partial");
    const note = ("degraded" in r && r.degraded ? `<p class="note">${e(r.degraded)}</p>` : "") +
      ("few" in r && r.few && r.mode !== "keyword" ? `<p class="note">Search by meaning found few matches with these filters. <a href="/search?${e(kwLink.toString())}">Try keyword mode →</a></p>` : "");
    const block = resultsBlock(r.posts, note);
    if (p.get("partial") === "1") return html(block);
    const tags = await listFacet(env, "tags", undefined, 300);
    return html(layout(q ? `${q} · Blog Library` : "Search", filtersForm("/search", p, tags) + block, { q, mode, footer: await footer(env), meaning: (await semanticStatus(env)) === "ok" }));
  }

  const browse = path.match(/^\/(year|tag|author)\/([^/]+)$/);
  if (path === "/browse" || browse) {
    const f = filtersFrom(p);
    let heading = "All posts";
    if (browse) {
      const [, kind, val] = browse;
      const v = decodeURIComponent(val).toLowerCase();
      if (kind === "year") { f.year = Number(v); heading = `Posts from ${Number(v)}`; }
      if (kind === "tag") { f.tag = v; heading = `Tag: ${(await env.DB.prepare("SELECT name FROM tags WHERE slug = ?").bind(v).first<{ name: string }>())?.name ?? v}`; }
      if (kind === "author") { f.author = v; heading = `Author: ${(await env.DB.prepare("SELECT name FROM authors WHERE slug = ?").bind(v).first<{ name: string }>())?.name ?? v}`; }
    }
    const sort = p.get("sort") === "oldest" ? "oldest" : "newest";
    const r = await listPosts(env, { ...f, sort, limit: 50, cursor: p.get("cursor") ?? undefined });
    const flip = new URLSearchParams(p); flip.set("sort", sort === "newest" ? "oldest" : "newest"); flip.delete("cursor");
    const next = new URLSearchParams(p); if (r.next_cursor) next.set("cursor", r.next_cursor);
    const tags = browse?.[1] === "tag" ? [] : await listFacet(env, "tags", undefined, 300);
    const body = `<h2>${e(heading)}</h2>
${browse?.[1] === "tag" ? "" : filtersForm(url.pathname, p, tags)}
<p class="meta">Sorted ${sort} first · <a href="?${e(flip.toString())}">sort ${sort === "newest" ? "oldest" : "newest"} first</a></p>
${resultsBlock(r.posts)}
<div class="pager"><span></span>${r.next_cursor ? `<a href="?${e(next.toString())}">More →</a>` : ""}</div>`;
    return html(layout(`${heading} · Blog Library`, body, { footer: await footer(env) }));
  }

  if (path === "/tags" || path === "/authors") {
    const kind = path === "/tags" ? "tags" : "authors";
    const list = await listFacet(env, kind, undefined, 10000);
    let body: string;
    if (kind === "authors") {
      const groups = new Map<string, typeof list>();
      for (const a of [...list].sort((x, y) => x.name.localeCompare(y.name))) {
        const l = /[A-Za-z]/.test(a.name[0] ?? "") ? a.name[0].toUpperCase() : "#";
        if (!groups.has(l)) groups.set(l, []);
        groups.get(l)!.push(a);
      }
      body = [...groups.entries()].map(([l, g]) => `<h2 id="${l}">${l}</h2><div class="chips">${g.map((a) => `<a href="/author/${e(a.slug)}">${e(a.name)}<small>${a.count}</small></a>`).join("")}</div>`).join("");
    } else {
      body = `<h2>All tags</h2><div class="chips">${list.map((t) => `<a href="/tag/${e(t.slug)}">${e(t.name)}<small>${t.count}</small></a>`).join("")}</div>`;
    }
    return html(layout(kind === "tags" ? "Tags" : "Authors", body, { footer: await footer(env) }));
  }

  return html(layout("Not found", `<p class="note">Not found.</p>`), 404);
}

