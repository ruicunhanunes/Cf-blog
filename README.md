# Cloudflare Blog Library

A private, self-updating library of every English post on blog.cloudflare.com. It offers keyword search (D1 FTS5), search by meaning (AI Search), browse by year, tag and author, and a remote MCP server for agents. Everything sits behind Cloudflare Access.

**Live:** https://blog-library.miguel-nunes-net.workers.dev (Access: rui.cunhanunes@gmail.com only)
**MCP:** `https://blog-library.miguel-nunes-net.workers.dev/mcp`

```bash
claude mcp add --transport http blog-library https://blog-library.miguel-nunes-net.workers.dev/mcp
```

In claude.ai: Settings → Connectors → Add custom connector → paste the `/mcp` URL. Both clients open a browser window: you sign in through Access, approve the client, and get a token.

## Architecture

```
Cron 04:00 UTC ─▶ SyncWorkflow ── sitemap index → child sitemaps (prefix sitemap-posts*) → English filter → diff vs D1 ──▶ Queue
                                                                                                                         │
Queue consumer (concurrency 2, batch 5) ◀────────────────────────────────────────────────────────────────────────────────┘
  GET post Accept: text/markdown  → body + tags ("Related tags" section)
  GET post HTML  → HTMLRewriter: canonical, og:*, article:published_time, JSON-LD, byline authors
  → R2 blog-library/posts/<slug>.md (frontmatter + body)   → AI Search items.upload(<slug>.md)
  → D1 posts / tags / authors / posts_fts (one batch)       → R2 blog-library-ops/raw/<slug>.html (30-day lifecycle)

Worker (behind Access) ── /            server-rendered mobile UI (no framework; works without JS)
                          /api/*       JSON API
                          /authorize   OAuth consent for MCP clients (Access identity required)
                          /mcp         MCP Streamable HTTP, bearer token from workers-oauth-provider
```

| Binding | Resource | Purpose |
|---|---|---|
| `DB` | D1 `blog-library` | Metadata, FTS5, sync runs |
| `POSTS` | R2 `blog-library` | Markdown corpus |
| `OPS` | R2 `blog-library-ops` | Raw HTML (30 days), run reports, dead letters |
| `FETCH_QUEUE` | Queue `blog-library-fetch` (+ `-dlq`) | Per-URL fetch jobs |
| `SYNC` | Workflow `blog-library-sync` | Discover, diff, enqueue, wait, report |
| `AI` | Workers AI | `toMarkdown` fallback |
| `AI_SEARCH` | AI Search `blog-library` | Semantic search, `ask_blog` |
| `OAUTH_KV` | KV | OAuth grants/tokens, consent state, `ask_blog` rate limit |

## Access model

* **Access app "Blog Library"** on the whole hostname allows only the emails in its policy (session 30 days). The Worker *also* validates `Cf-Access-Jwt-Assertion`: signature against the team JWKS, issuer, audience (`ACCESS_AUD` secret), expiry, and the email against `ALLOWED_EMAILS`. It fails closed: with no secret, every page returns 403.
* **Access app "Blog Library MCP endpoints"** bypasses Access only for `/mcp`, `/token`, `/register` and `/.well-known/oauth-*`. Those are machine endpoints. `/mcp` refuses requests without a valid bearer token, and tokens are minted only through `/authorize`, which stays behind Access and shows a consent screen.
* `robots.txt` disallows everything; every response carries `X-Robots-Tag: noindex`.
* The crawler's fetch helper refuses any host other than blog.cloudflare.com, including after redirects.

To allow another person, add their email to **both** the Access policy (Zero Trust → Access → Applications → Blog Library) and `ALLOWED_EMAILS` in `wrangler.jsonc`, then redeploy.

## Operations

```bash
export CLOUDFLARE_API_TOKEN=...      # account token
npx wrangler deploy
npx wrangler workflows trigger blog-library-sync '{}'               # incremental sync (cron does this daily)
npx wrangler workflows trigger blog-library-sync '{"full":true}'    # re-fetch everything, ignoring lastmod
npx wrangler workflows trigger blog-library-sync '{"reindex":true}' # re-upload stored Markdown to AI Search (no crawl)
npx wrangler d1 execute blog-library --remote --command "SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5"
```

`POST /admin/sync?full=1` does the same from a signed-in browser session. It requires the Access identity and a same-origin request.

## Local testing

`test/harness.ts` is a **test-only** Worker, never deployed. It exposes the consumer, search, MCP handler and UI without Access. For the UI it uses a locally generated JWKS and signed JWTs, so the real JWT verification is exercised.

```bash
node scripts/fwd.mjs &                       # only needed where workerd can't reach the internet directly
cd test && npx wrangler d1 migrations apply blog-library-test --local -c wrangler.test.jsonc
npx wrangler dev -c wrangler.test.jsonc --port 8799
curl "localhost:8799/consume?slug=details-of-the-cloudflare-outage-on-july-2-2019"
curl "localhost:8799/ui/search?q=regex+outage"            # signed in as the allowed test user
curl "localhost:8799/ui/?as=intruder@example.com"         # → 403
```

## Deviations from the PRD, and why

| PRD | Built | Reason |
|---|---|---|
| Drop any URL whose first segment matches `^[a-z]{2}-[a-z]{2}$` | Drop only multi-segment paths that match | The English post `/cf-ui` matches the regex and would have been dropped. |
| Tags and authors from HTML tag links | Tags from the Markdown "Related tags" section; authors from byline links (class `text-display`) and JSON-LD | Every page includes ~800 tag links in its navigation, so naive `/tag/` link parsing would tag every post with every tag. |
| AI Search with an R2 data source | AI Search **built-in storage**; the consumer uploads each post as it is written | An R2 source needs a separately registered AI Search service token. Uploading directly also makes semantic freshness immediate, instead of the 24-hour sync interval. |
| `library.<your-domain>` with workers.dev disabled | `blog-library.miguel-nunes-net.workers.dev`, protected by Access | Needs no DNS change on your zones. To move to a custom domain, add a `routes` custom domain and point the Access app at it. |
| MCP via Agents SDK `McpAgent` (Durable Object) | Stateless Streamable HTTP JSON-RPC handler in `src/mcp/server.ts` | The tools are read-only and need no sessions. This removes a Durable Object and avoids the Agents SDK's in-flight MCP SDK v1→v2 migration. Tool surface is unchanged (7 tools, `readOnlyHint`). |
| OAuth via Access for SaaS OIDC | `workers-oauth-provider`, with `/authorize` behind the Access self-hosted app | The same guarantee ("only identities in the Access policy get a token") without a second Access application or client secrets. |
| `/admin/*` needs an Access service token too | Access identity + same-origin POST check | Re-crawls are idempotent and rate-limited by the queue. Add a service-token check if you share the app. |
| Email alerts on failed or stale syncs | Structured logs (`stage`, `outcome`) and `sync_runs.status`; the footer shows the last run | No Email Service sender is configured on the account. |
| Keyword search ANDs every term | AND first; if nothing matches, stopwords are removed and terms ORed (still bm25-ranked) | Natural-language questions such as "What did Cloudflare write about the July 2019 outage?" otherwise return nothing. |

## Repository layout

```
migrations/0001_init.sql   D1 schema (FTS5 posts_fts, sync_runs, checked_at for run progress)
src/index.ts               OAuth provider wiring, cron, queue handlers
src/app.ts                 UI + JSON API + OAuth consent + admin
src/auth/access.ts         Cf-Access-Jwt-Assertion verification
src/sync/{workflow,consumer,parse}.ts
src/search/{data,keyword,semantic,hybrid}.ts
src/mcp/server.ts          MCP JSON-RPC handler + 7 tools
src/ui/views.ts            HTML, CSS, manifest, icons
test/harness.ts            local test harness (not deployed)
test/known-items.json      known-item and semantic test sets
```
