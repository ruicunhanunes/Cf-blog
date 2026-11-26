# Cloudflare Blog Library

A private, self-updating library of every English post on blog.cloudflare.com: exact keyword search (D1 FTS5), browse by year, tag and author, and hybrid search that reuses the blog's **own** public AI Search endpoint. Agents use the **official** Cloudflare Blog MCP server, plus a small add-on here for the gaps M0 found. Everything sits behind Cloudflare Access.

**Live:** https://blog-library.miguel-nunes-net.workers.dev (Access: rui.cunhanunes@gmail.com only)
## Agent access

```bash
# Official server: search by meaning, full post content, tags (no auth)
claude mcp add --transport http cloudflare-blog https://blog.mcp.cloudflare.com/mcp
# Library add-on: exact keyword search, filters, full-history listing (OAuth through Access)
claude mcp add --transport http blog-library https://blog-library.miguel-nunes-net.workers.dev/mcp
```

In the Claude iPhone app or claude.ai: Settings → Connectors → Add custom connector, once per URL. The add-on opens a browser window where you sign in through Access and approve the client.

### M0 results (2026-11-26): official Blog MCP server (v0.3.0)

| Check | Result |
|---|---|
| tools/list | `search_posts(query)`, `list_posts(limit, cursor, tag)`, `get_post(slug)`, `list_tags()` |
| Exact lookup: "regex outage 2019" → July 2, 2019 post in top 5 | **Fail**: rank 40 |
| Filters (date, tag, author) | **Fail**: search takes only `query`; `list_posts` filters by tag only |
| History back to 2010 | Pass: 75 pages, 3,708 posts, oldest 2009-04-28 |
| English only | **Fail**: 31 of 49 search results are translations |
| Full content | Pass: whole body, as HTML (32k chars for the 2019 post) |

Three checks fail, so the add-on is built: `keyword_search_posts`, `list_posts`, `list_authors`.

Public AI Search endpoint (from `/.well-known/api-catalog`): `POST /search` answers. Each chunk's post URL is in `item.key`, and its metadata carries `title`, `description`, `article:published_time` (epoch ms) and `language`. **`filters: {language: "en-us"}` works server-side:** 0 translations instead of 31 of 49, and the July 2019 post moves from rank 40 to 12. Hybrid (FTS5 + endpoint, RRF) puts it at #1.

## Status (2026-11-26)

| PRD measure | Result |
|---|---|
| Coverage | 3,704 / 3,704 English sitemap posts (100%), plus 1 live post missing from the sitemaps (`waf-content-scanning-for-malware-detection`). Matches the official server's 3,708 minus 3 `-uk-ua` translations. Oldest 2009-04-28. |
| Quality | 0 empty titles or dates, 0 fallback conversions, 100% of posts with authors and tags; 3 posts under 50 words, all genuinely that short |
| Second run writes 0 posts | Yes: incremental run wrote 0 |
| Known-item test set (keyword) | 18 / 20 in the top 5 (target ≥ 18). Misses: "cloudbleed parser memory leak" and "1.1.1.1 dns resolver launch" (the April 2018 launch post `announcing-1111` is #3; the test expects its companion post) |
| Hybrid: 10 questions | 10 / 10 with a relevant post in the top 3 (target ≥ 8 in the top 5) |
| Hybrid: "regex outage 2019" | July 2, 2019 post at #1 (official MCP server: #40) |
| Canary | primary ✓, fallback ✓ → `semantic_status = ok` |
| Locales dropped in the backfill | 4,428 URLs across 20 locales |

## Architecture

```
Cron 04:00 UTC ─▶ SyncWorkflow ── sitemaps (prefix sitemap-posts*) → English filter → diff vs D1 ──▶ Queue
                               └─ daily canary: public /search + /.well-known/search → settings.semantic_status
Queue consumer (concurrency 2, batch 5)
  GET post Accept: text/markdown → body + tags ("Related tags")
  GET post HTML → HTMLRewriter: canonical, og:*, article:published_time, JSON-LD, byline authors
  → R2 posts/<slug>.md   → D1 posts / tags / authors / posts_fts (one batch)   → R2 ops raw/<slug>.html (30 days)

Worker (behind Access)
  /, /search, /year|tag|author/*   server-rendered mobile UI (works without JS)
  /api/*                           JSON API
  Meaning mode = hybrid: D1 FTS5 ∥ blog's public AI Search /search (fallback /.well-known/search), RRF k=60
                 endpoint hostname from api-catalog (cached 1 day), responses cached 1 h, 30 queries/min, 3 s timeout,
                 unknown slugs are shown from endpoint metadata and enqueued for fetching
  /authorize, /mcp                 M4 add-on (OAuth via workers-oauth-provider; /authorize behind Access)
```

| Binding | Resource | Purpose |
|---|---|---|
| `DB` | D1 `blog-library` | Metadata, FTS5, sync runs, `settings.semantic_status` |
| `POSTS` | R2 `blog-library` | Markdown corpus (Plan B source) |
| `OPS` | R2 `blog-library-ops` | Raw HTML (30 days), run reports, dead letters, canary fixtures |
| `FETCH_QUEUE` | Queue `blog-library-fetch` (+ `-dlq`) | Per-URL fetch jobs |
| `SYNC` | Workflow `blog-library-sync` | Discover, diff, enqueue, canary, wait, report |
| `AI` | Workers AI | `toMarkdown` fallback |
| `SEMANTIC_RL` | Rate limiter | 30 semantic queries/minute |
| `caches.default` | Cache API | Endpoint responses (1 h), api-catalog (1 day) |
| `OAUTH_KV` | KV | M4: OAuth grants/tokens, consent state |

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
npx wrangler workflows trigger blog-library-sync '{"slugs":["a","b"]}' # force re-fetch specific posts
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
| Post-filter translations out of endpoint results | Also pushed down: `filters: {language: "en-us"}` on the public `/search` | Measured in M0: 50 English posts per query instead of ~18, so filters have more to work with. Locale-prefix stripping stays as a second line of defence (and for the fallback). |
| `library.<your-domain>` with workers.dev disabled | `blog-library.miguel-nunes-net.workers.dev`, protected by Access | Needs no DNS change on your zones. To move to a custom domain, add a `routes` custom domain and point the Access app at it. |
| M4 add-on via Agents SDK `McpAgent` (Durable Object) | Stateless Streamable HTTP JSON-RPC handler in `src/mcp/server.ts` | The 3 tools are read-only and need no sessions. This removes the `MCP_OBJECT` Durable Object and avoids the Agents SDK's in-flight MCP SDK v1→v2 migration. |
| OAuth via Access for SaaS OIDC | `workers-oauth-provider`, with `/authorize` behind the Access self-hosted app | The same guarantee ("only identities in the Access policy get a token") without a second Access application or client secrets. |
| `/admin/*` needs an Access service token too | Access identity + same-origin POST check | Re-crawls are idempotent and rate-limited by the queue. Add a service-token check if you share the app. |
| Email alerts (failed sync, degraded canary) | `console.error` lines with `outcome: "ALERT"` in Workers Logs, `sync_runs.status`, `settings.semantic_status`; the footer shows the last run | No Email Service sender is configured on the account. |
| Keyword search ANDs every term | AND first; if nothing matches, stopwords are removed and terms ORed (still bm25-ranked) | Natural-language questions such as "What did Cloudflare write about the July 2019 outage?" otherwise return nothing. |

## Repository layout

```
migrations/0001_init.sql   D1 schema (FTS5 posts_fts, sync_runs, checked_at for run progress)
src/index.ts               OAuth provider wiring, cron, queue handlers
src/app.ts                 UI + JSON API + OAuth consent + admin
src/auth/access.ts         Cf-Access-Jwt-Assertion verification
src/sync/{workflow,consumer,parse}.ts   workflow includes the daily canary
src/search/{data,keyword,semantic,hybrid}.ts   semantic = public endpoint client + fallback parser
src/mcp/server.ts          M4 add-on: MCP JSON-RPC handler + 3 tools
src/ui/views.ts            HTML, CSS, manifest, icons
test/harness.ts            local test harness (not deployed)
test/known-items.json      20 known posts + 10 questions (scripts/eval.mjs)
test/fixtures/             raw endpoint responses for the parsers (the canary adds daily ones in R2 ops/fixtures/)
```
