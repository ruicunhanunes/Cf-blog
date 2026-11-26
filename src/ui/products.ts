import type { CatalogProduct } from "../products/match";
import { ancestors, CATALOG, categorySlug, children, descendants, PRODUCT, type CatalogHealth } from "../products";
import type { PostCard } from "../search/data";
import { escapeHtml as e } from "../search/semantic";
import { card } from "./views";

type Counts = Map<string, { strong: number; body: number }>;

const count = (c: Counts, slug: string) => c.get(slug) ?? { strong: 0, body: 0 };

function row(p: CatalogProduct, c: Counts, depth: number): string {
  const n = count(c, p.slug);
  const label = n.strong ? `${n.strong} post${n.strong === 1 ? "" : "s"}` : "no posts";
  const extra = n.body ? ` · ${n.body} mention${n.body === 1 ? "" : "s"}` : "";
  return `<li class="prow d${Math.min(depth, 3)}${n.strong ? "" : " empty"}" data-name="${e([p.name, ...p.aliases].join(" ").toLowerCase())}">
<a href="/product/${e(p.slug)}">${e(p.name)}</a>${p.status === "retired" ? ` <span class="badge">retired</span>` : ""}<span class="meta"> ${label}${extra}</span></li>`;
}

/** Products in a category, children nested under their parent when the parent is in the same category. */
function categoryList(cat: string, c: Counts): string {
  const inCat = CATALOG.products.filter((p) => p.categories.includes(cat));
  const set = new Set(inCat.map((p) => p.slug));
  const out: string[] = [];
  const walk = (p: CatalogProduct, depth: number) => {
    out.push(row(p, c, depth));
    for (const ch of children(p.slug).filter((x) => set.has(x.slug)).sort((a, b) => a.name.localeCompare(b.name))) walk(ch, depth + 1);
  };
  for (const p of inCat.filter((p) => !p.parent || !set.has(p.parent)).sort((a, b) => a.name.localeCompare(b.name))) walk(p, 0);
  return `<ul class="plist">${out.join("")}</ul>`;
}

export function productsIndex(c: Counts, health: CatalogHealth | null): string {
  const cats = CATALOG.categories;
  const chip = (k: string) => `<a href="#${categorySlug(k)}">${e(k)}</a>`;
  const primary = cats.filter((k) => CATALOG.primary_categories.includes(k));
  const topics = cats.filter((k) => !CATALOG.primary_categories.includes(k));
  const nav = `<div class="chips">${primary.map(chip).join("")}</div>${topics.length ? `<p class="meta" style="margin:10px 0 4px">Across groups</p><div class="chips">${topics.map(chip).join("")}</div>` : ""}`;
  const sections = cats.map((k) => `<section class="pcat"><h2 id="${categorySlug(k)}">${e(k)}</h2>${categoryList(k, c)}</section>`).join("");
  const drift = health && (health.docs_added.length || health.docs_removed.length || health.error)
    ? `<p class="note">The docs directory changed since this catalog was built${health.docs_added.length ? `; new: ${e(health.docs_added.join(", "))}` : ""}${health.docs_removed.length ? `; gone: ${e(health.docs_removed.join(", "))}` : ""}${health.error ? `; check failed: ${e(health.error)}` : ""}.</p>`
    : "";
  const newTags = health?.new_unmapped_tags.length
    ? `<p class="meta">New blog tags not linked to a product: ${health.new_unmapped_tags.map((t) => `<a href="/tag/${e(t.slug)}">${e(t.name)}</a> (${t.count})`).join(", ")}</p>`
    : "";
  return `<h2>Products</h2>
<p class="meta">${CATALOG.products.length} products from the <a href="${e(CATALOG.source)}" rel="noreferrer">developer docs directory</a>, grouped as the docs group them (a product can sit in several groups). Counts are posts about the product; mentions are posts that only mention it.</p>
<input type="search" id="pfilter" placeholder="Filter products, incl. former names" aria-label="Filter products" autocomplete="off" class="pfilter">
${nav}${drift}${sections}
<p class="meta">${newTags}Catalog ${e(CATALOG.version)}${health ? ` · docs checked ${e(new Date(health.checked_at).toUTCString())}` : ""}</p>
<script>
(()=>{const i=document.getElementById('pfilter');i.addEventListener('input',()=>{const q=i.value.trim().toLowerCase();
const seen=new Set();document.querySelectorAll('.prow').forEach(r=>{const h=r.querySelector('a').getAttribute('href');r.hidden=!!q&&(!r.dataset.name.includes(q)||seen.has(h));if(q&&!r.hidden)seen.add(h)});
document.querySelectorAll('.pcat').forEach(s=>{s.hidden=!!q&&!s.querySelector('.prow:not([hidden])')})})})();
</script>`;
}

export interface ProductPageData {
  product: CatalogProduct;
  sub: boolean;
  year?: number;
  years: { year: number; count: number }[];
  posts: PostCard[];
  nextCursor: string | null;
  mentions: { posts: (PostCard & { mentions: number })[]; total: number };
  counts: Counts;
  filters: string;
  params: URLSearchParams;
}

export function productPage(d: ProductPageData): string {
  const p = d.product;
  const crumbs = [`<a href="/products">Products</a>`, ...p.categories.slice(0, 1).map((k) => `<a href="/products#${categorySlug(k)}">${e(k)}</a>`), ...ancestors(p.slug).map((a) => `<a href="/product/${e(a.slug)}">${e(a.name)}</a>`)].join(" › ");
  const kids = children(p.slug);
  const allKids = descendants(p.slug);
  const link = (mod: (q: URLSearchParams) => void) => { const q = new URLSearchParams(d.params); q.delete("cursor"); mod(q); const s = q.toString(); return s ? `?${e(s)}` : "?"; };

  const toggle = allKids.length
    ? `<div class="seg" role="group" aria-label="Scope">
<a href="${link((q) => q.delete("sub"))}"${d.sub ? "" : ' aria-current="true"'}>${e(p.name)} only</a>
<a href="${link((q) => q.set("sub", "1"))}"${d.sub ? ' aria-current="true"' : ""}>Include ${allKids.length} sub-product${allKids.length === 1 ? "" : "s"}</a></div>`
    : "";
  const chips = `<div class="chips">${kids.map((k) => `<a href="/product/${e(k.slug)}">${e(k.name)}<small>${count(d.counts, k.slug).strong}</small></a>`).join("")}</div>`;
  // Many sub-products (Cloudflare One has 20+) would push the posts below the fold on a phone.
  const kidChips = !kids.length ? "" : kids.length > 8 ? `<details class="kids"><summary>${kids.length} sub-products</summary>${chips}</details>` : chips;
  const years = d.years.length > 1
    ? `<div class="chips years">${d.year ? `<a href="${link((q) => q.delete("year"))}">All years</a>` : ""}${d.years.map((y) => `<a href="${link((q) => q.set("year", String(y.year)))}"${d.year === y.year ? ' aria-current="true"' : ""}>${y.year}<small>${y.count}</small></a>`).join("")}</div>`
    : "";
  const facts = [
    p.status === "retired" ? `<span class="badge">retired</span>` : "",
    p.docs_url ? `<a href="${e(p.docs_url)}" rel="noreferrer">Docs ↗</a>` : "",
    p.aliases.length ? `Also known as ${p.aliases.map((a) => `<b>${e(a)}</b>`).join(", ")}` : "",
    p.categories.length > 1 ? `In ${p.categories.map((k) => `<a href="/products#${categorySlug(k)}">${e(k)}</a>`).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  const total = d.years.reduce((a, y) => a + y.count, 0);
  const next = new URLSearchParams(d.params); if (d.nextCursor) next.set("cursor", d.nextCursor);
  const mentionList = d.mentions.total
    ? `<details class="mentions"><summary>Also mentioned in ${d.mentions.total} post${d.mentions.total === 1 ? "" : "s"}</summary>
<p class="meta">Posts that mention ${e(p.name)}${d.sub ? " or a sub-product" : ""} in passing, most mentions first${d.mentions.total > d.mentions.posts.length ? ` (top ${d.mentions.posts.length})` : ""}.</p>
${d.mentions.posts.map((m) => card(m, `${m.mentions} mention${m.mentions === 1 ? "" : "s"}`)).join("")}</details>`
    : "";

  return `<nav class="meta crumb">${crumbs}</nav>
<h1 class="ptitle">${e(p.name)}</h1>
${p.description ? `<p class="lede">${e(p.description)}</p>` : ""}
${facts ? `<p class="meta">${facts}</p>` : ""}
${kidChips}${toggle}
<form class="s within" action="/search" method="get" role="search"><input type="hidden" name="product" value="${e(p.slug)}">${d.sub ? `<input type="hidden" name="sub" value="1">` : ""}
<input type="search" name="q" placeholder="Search within ${e(p.name)}${d.sub ? " and sub-products" : ""}" aria-label="Search within ${e(p.name)}"></form>
<h2>${total} post${total === 1 ? "" : "s"} about ${e(p.name)}${d.sub ? " and its sub-products" : ""}</h2>
${years}${d.filters}
<section id="results">${d.posts.length ? d.posts.map((x) => card(x)).join("") : `<p class="note">No posts are tagged with or titled after ${e(p.name)}${d.year ? ` in ${d.year}` : ""}.</p>`}</section>
<div class="pager"><span></span>${d.nextCursor ? `<a href="?${e(next.toString())}">More →</a>` : ""}</div>
${mentionList}`;
}

export function productChipsForHome(c: Counts): string {
  return `<div class="chips">${CATALOG.categories.map((k) => {
    const n = CATALOG.products.filter((p) => p.categories.includes(k)).length;
    return `<a href="/products#${categorySlug(k)}">${e(k)}<small>${n}</small></a>`;
  }).join("")}</div>
<div class="chips" style="margin-top:8px">${[...c.entries()].sort((a, b) => b[1].strong - a[1].strong).slice(0, 16).filter(([s]) => PRODUCT.has(s))
    .map(([s, n]) => `<a href="/product/${e(s)}">${e(PRODUCT.get(s)!.name)}<small>${n.strong}</small></a>`).join("")}</div>`;
}
