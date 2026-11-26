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
| Known-item test set (merged search, what users get) | 19 / 20 in the top 5 |
| Hybrid: "regex outage 2019" | July 2, 2019 post at #1 (official MCP server: #40) |
| Canary | primary ✓, fallback ✓ → `semantic_status = ok` |
| Locales dropped in the backfill | 4,428 URLs across 20 locales |

## Product portfolio (2026-11-26)

Browse the Cloudflare portfolio at **`/products`** and see each product's posts at **`/product/<slug>`**.

**Catalog.** `src/products/catalog.json` is built from the [developer docs directory](https://developers.cloudflare.com/directory/) by `npm run products:build`, plus the hand-curated `data/product-overrides.json`. The directory gives 138 entries, each with its groups. Parent/child links come from the URL paths, e.g. `/cloudflare-one/email-security/` → Cloudflare One. The overrides do four things:
* Drop 10 docs-only entries (Fundamentals, Support, Billing and similar).
* Add 7 products missing from the directory, 5 of them retired: Railgun, Cloudflare Apps, Workers Sites, Pub/Sub, AMP.
* Add former names: Argo Tunnel, 2017's "Cloudflare Warp" and `cloudflared` → Cloudflare Tunnel; Area 1 → Email security; Magic WAN → Cloudflare WAN; Magic Firewall → Cloudflare Network Firewall; Browser Rendering → Browser Run; Page Shield → Client-side security; Cloudflare for Teams → Cloudflare One; and so on.
* Map products to blog tags, and give ordinary-word names qualified match terms: Access, Gateway, Pages, DNS, Queues and others only match as "Cloudflare Access", "Workers KV" and similar.

The result is 136 products in 12 groups. A product sits in every group the docs give it.

**How a post links to a product** (`src/products/match.ts`, stored in D1 `product_posts`):

| Signal | Rule | Shown as |
|---|---|---|
| `tag` | The post carries one of the product's blog tags | Posts about the product |
| `title` | A product term in the title, or in the description with ≥ 3 body mentions | Posts about the product |
| `body` | ≥ 3 body mentions, or a description mention alone | Collapsed "Also mentioned in" list, most mentions first |

Terms match case-sensitively on word boundaries, with "Cloudflare X", "CloudFlare X" (the pre-2016 spelling) and plural forms added automatically. The longest term wins, so "Workers KV" credits KV and not Workers, and "Workers AI" credits Workers AI. Stop terms consume "Service Worker(s)" and "Web Worker(s)" so they credit nothing.

**Measured on all 3,705 posts** (`npm run products:eval`):

| Measure | Result |
|---|---|
| Posts with ≥ 1 strong product link | 2,515 (67.9%); 2,717 with any link |
| Strong links | 4,246: 3,946 from tags, 300 from titles/descriptions |
| Text matching beyond tags | R2: 20 → 38 posts; Durable Objects: 41 → 53; KV: 33 → 41 (KV has no `kv` tag at all) |
| Precision of text-only strong links | 41 / 45 sampled clearly about the product (~90%). Tag links are author-assigned. |
| Products with ≥ 1 strong post | 118 / 136. The rest are mostly new or docs-only sub-products (Posture checks, DNS Firewall, Pulumi). |
| product-news posts with no product | 86 / 694, mostly protocols and programs (RPKI, Bandwidth Alliance, QUIC experiments) |
| Matching cost | ≈ 1.5 ms per post |

**Hierarchy.** A parent page shows its own posts by default, with a toggle to "Include N sub-products" (`?sub=1`). Cloudflare One has 13 sub-products, and rolling them all up by default would bury the posts about Cloudflare One itself. The same toggle scopes "Search within", which goes to `/search?product=…&sub=1`.

**Keeping it current.**
* The consumer matches every post it writes.
* The daily workflow compares `settings.products_version` (catalog version + `MATCHER_VERSION`) with the deployed one. When they differ, it re-matches all posts in pages of 100, from what D1 already holds; it doesn't fetch from the blog again. You can also force this with `wrangler workflows trigger blog-library-sync '{"rematch":true}'` or `POST /admin/sync?rematch=1`.
* The "catalog health" step fetches the docs directory and lists products added to or removed from it, plus new blog tags (first used in the last 45 days) that no product claims. It stores the result in `settings.catalog_health`, shows it on `/products`, and logs an `ALERT` on drift. To fix drift, run `npm run products:build`, review the report, and edit the overrides.

**API.** `/api/products` returns the catalog with counts and health. `/api/products/<slug>?sub=1&include=mentions` returns a product's posts. `/api/posts` and `/api/search` accept `product=`, `sub=1` and `mentions=1`.

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
  One search box, no modes: D1 FTS5 ∥ blog's public AI Search /search (fallback /.well-known/search), merged by RRF k=60.
                 While typing: keyword-only after 150 ms (instant), merged results after a 700 ms pause.
                 "Quoted text" = exact phrase only. If the semantic side fails or is degraded, keyword results show silently.
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
| A Keyword / Meaning toggle in the UI | One search box; every search is keyword + meaning merged | The merged ranking measured better on exact lookups too (19/20 vs 18/20), so the choice added nothing. The `/api/search?mode=` parameter still exists for scripts. |
| Keyword search ANDs every term | AND first; if nothing matches, stopwords are removed and terms ORed (still bm25-ranked) | Natural-language questions such as "What did Cloudflare write about the July 2019 outage?" otherwise return nothing. |

## Repository layout

```
migrations/0001_init.sql   D1 schema (FTS5 posts_fts, sync_runs, checked_at for run progress)
migrations/0003_products.sql  product_posts (post ↔ product links)
src/index.ts               OAuth provider wiring, cron, queue handlers
src/app.ts                 UI + JSON API + OAuth consent + admin
src/auth/access.ts         Cf-Access-Jwt-Assertion verification
src/sync/{workflow,consumer,parse}.ts   workflow includes the daily canary
src/search/{data,keyword,semantic,hybrid}.ts   semantic = public endpoint client + fallback parser
src/mcp/server.ts          M4 add-on: MCP JSON-RPC handler + 3 tools
src/ui/views.ts            HTML, CSS, manifest, icons
src/ui/products.ts         /products and /product/<slug> pages
src/products/              catalog.json (generated), match.ts (pure matcher), directory.ts (docs parser), index.ts (D1 + rematch + drift)
data/product-overrides.json  hand curation on top of the docs directory
scripts/build-products.mjs   rebuild the catalog (--check fails if stale)
scripts/eval-products.mjs    matcher evaluation on the production corpus (read-only)
scripts/test-products.mjs    matcher + parser unit tests (npm test)
test/harness.ts            local test harness (not deployed)
test/known-items.json      20 known posts + 10 questions (scripts/eval.mjs)
test/fixtures/             raw endpoint responses for the parsers (the canary adds daily ones in R2 ops/fixtures/)
```
