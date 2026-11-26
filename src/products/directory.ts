// Parser for the developer docs product directory (https://developers.cloudflare.com/directory/).
// Self-contained (no imports) so scripts/build-products.mjs can import it directly with Node's type stripping.

export const DOCS_ORIGIN = "https://developers.cloudflare.com";
export const DIRECTORY_URL = `${DOCS_ORIGIN}/directory/`;

export interface DirectoryEntry {
  /** Docs path, e.g. "/cloudflare-one/email-security/" */
  path: string;
  name: string;
  description: string;
  /** Directory groups in the order the page lists them; the first is the primary category. */
  groups: string[];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (NAMED[e.toLowerCase()]) return NAMED[e.toLowerCase()];
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return m;
  }).trim();
}

/**
 * Each product is a `<div data-directory-cell data-name=".." data-groups="A|B">` wrapping one card link.
 * Throws when the page no longer has that shape, so a layout change fails loudly instead of emptying the catalog.
 */
export function parseDirectory(html: string): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<div data-directory-cell([^>]*)>([\s\S]*?)<\/a>/g)) {
    const groups = m[1].match(/data-groups="([^"]*)"/)?.[1];
    const href = m[2].match(/href="(\/[^"#?]*)"/)?.[1];
    const name = m[2].match(/<strong[^>]*>([^<]+)<\/strong>/)?.[1];
    if (!groups || !href || !name) continue;
    const desc = m[2].match(/<p class="text-muted[^"]*"[^>]*>([^<]*)<\/p>/)?.[1] ?? "";
    const path = href.endsWith("/") ? href : `${href}/`;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: decode(name), description: decode(desc), groups: decode(groups).split("|").map((g) => g.trim()).filter(Boolean) });
  }
  if (out.length < 50) throw new Error(`docs directory parse found only ${out.length} products; page layout changed?`);
  return out;
}

/** Parent = the entry with the longest path that is a strict prefix of this one. */
export function parentPaths(entries: DirectoryEntry[]): Map<string, string | null> {
  const paths = entries.map((e) => e.path);
  const out = new Map<string, string | null>();
  for (const p of paths) {
    let best: string | null = null;
    for (const q of paths) if (q !== p && p.startsWith(q) && (!best || q.length > best.length)) best = q;
    out.set(p, best);
  }
  return out;
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Fetch the directory page. Only developers.cloudflare.com, no redirects off-host. */
export async function fetchDirectory(userAgent: string): Promise<DirectoryEntry[]> {
  const res = await fetch(DIRECTORY_URL, { headers: { Accept: "text/html", "User-Agent": userAgent }, redirect: "manual" });
  if (!res.ok) throw new Error(`docs directory ${res.status}`);
  return parseDirectory(await res.text());
}
