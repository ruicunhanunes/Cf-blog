// Pure product matcher: which catalog products a post is about, and how strongly.
// No imports, so Node scripts (eval, tests) can load it directly with type stripping.

export interface CatalogProduct {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  parent: string | null;
  status: "current" | "retired";
  docs_url: string | null;
  docs_path: string | null;
  aliases: string[];
  terms: string[];
  tags: string[];
}

export interface Catalog {
  version: string;
  source: string;
  excluded_paths: string[];
  categories: string[];
  /** Directory groups that are some product's first group; the rest (AI, Storage, ...) cut across them. */
  primary_categories: string[];
  stop_terms: string[];
  products: CatalogProduct[];
}

/**
 * tag   — the post carries one of the product's blog tags
 * title — a product term appears in the title, or in the description with at least BODY_MIN_MENTIONS body mentions
 * body  — no tag/title signal, but at least BODY_MIN_MENTIONS mentions in the body ("Also mentioned in")
 */
export type Signal = "tag" | "title" | "body";

export interface ProductMatch {
  product: string;
  signal: Signal;
  /** Body mentions (also recorded for tag/title matches). */
  mentions: number;
}

export interface MatchInput {
  title: string;
  description?: string | null;
  body: string;
  tags: string[];
}

/** Bump when matching rules change: the sync workflow re-matches every post when this or the catalog changes. */
export const MATCHER_VERSION = 1;
export const BODY_MIN_MENTIONS = 3;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function buildMatcher(catalog: Catalog): (post: MatchInput) => ProductMatch[] {
  // term -> products it credits ([] for stop terms, which exist only to swallow text like "Service Worker").
  const credit = new Map<string, Set<string>>();
  const add = (term: string, product: string | null) => {
    // "CloudFlare" is the pre-2016 spelling, so older posts need it too.
    const bare = term.replace(/^Cloud[Ff]lare /, "");
    const forms = bare === term ? [term, `Cloudflare ${term}`, `CloudFlare ${term}`] : [term, `Cloudflare ${bare}`, `CloudFlare ${bare}`];
    // Plural forms too ("Argo Tunnels", "Durable Objects" from "Durable Object"), so a plural never falls
    // through to a shorter term ("Argo") that credits a different product.
    for (const t of forms.flatMap((f) => (/[A-Za-z0-9]$/.test(f) && !f.endsWith("s") ? [f, `${f}s`] : [f]))) {
      if (!credit.has(t)) credit.set(t, new Set());
      if (product) credit.get(t)!.add(product);
    }
  };
  for (const t of catalog.stop_terms) add(t, null);
  for (const p of catalog.products) for (const t of p.terms) add(t, p.slug);

  // Longest alternative first: at any position "Cloudflare Workers KV" beats "Cloudflare Workers",
  // and "Workers AI" beats "Workers". Case-sensitive, so "access" or "pages" in prose never match.
  const alts = [...credit.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRe);
  const source = alts.length ? `(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])` : "(?!)";

  const byTag = new Map<string, string[]>();
  for (const p of catalog.products) for (const t of p.tags) byTag.set(t, [...(byTag.get(t) ?? []), p.slug]);

  const count = (text: string): Map<string, number> => {
    const out = new Map<string, number>();
    if (!text) return out;
    for (const m of text.matchAll(new RegExp(source, "gu"))) {
      for (const p of credit.get(m[0]) ?? []) out.set(p, (out.get(p) ?? 0) + 1);
    }
    return out;
  };

  return (post) => {
    const tagged = new Set(post.tags.flatMap((t) => byTag.get(t) ?? []));
    const title = count(post.title);
    const desc = count(post.description ?? "");
    const body = count(post.body);
    const out: ProductMatch[] = [];
    for (const slug of new Set([...tagged, ...title.keys(), ...desc.keys(), ...body.keys()])) {
      const mentions = body.get(slug) ?? 0;
      // A description often lists neighbouring products in passing, so alone it is only an "also mentioned".
      const signal: Signal | null = tagged.has(slug) ? "tag"
        : title.has(slug) || (desc.has(slug) && mentions >= BODY_MIN_MENTIONS) ? "title"
        : desc.has(slug) || mentions >= BODY_MIN_MENTIONS ? "body"
        : null;
      if (signal) out.push({ product: slug, signal, mentions });
    }
    return out.sort((a, b) => a.product.localeCompare(b.product));
  };
}
