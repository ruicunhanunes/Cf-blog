import { BLOG_ORIGIN } from "../env";

const UA = (contact: string) => `blog-library/1.0 (private personal index; contact ${contact})`;
const LOCALE_RE = /^[a-z]{2}-[a-z]{2}$/;

/** Fetch only from blog.cloudflare.com, following redirects manually so a redirect cannot leave the host. */
export async function blogFetch(url: string, contact: string, accept: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (u.protocol !== "https:" || u.host !== new URL(BLOG_ORIGIN).host) {
      throw new Error(`refusing to fetch non-blog host: ${u.host}`);
    }
    const res = await fetch(u.toString(), {
      headers: { Accept: accept, "User-Agent": UA(contact) },
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((loc) => /\/sitemap-posts(-\d+)?\.xml$/.test(new URL(loc).pathname));
}

export function parseUrlset(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? null;
    out.push({ loc, lastmod });
  }
  return out;
}

/**
 * Returns the locale if the URL is a translated copy, else null.
 * Only multi-segment paths can be localized: a single-segment slug such as "/cf-ui"
 * matches the locale pattern but is an English post.
 */
export function localeOf(url: string): string | null {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  if (segs.length >= 2 && LOCALE_RE.test(segs[0])) return segs[0];
  return null;
}

export function slugOf(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(segs[segs.length - 1] ?? "").toLowerCase();
}

export function canonicalUrl(slug: string): string {
  return `${BLOG_ORIGIN}/${slug}/`;
}

export interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
  tags: { slug: string; name: string }[];
}

/** Parse the Markdown for Agents response: YAML frontmatter, trimmed article body, tags from "Related tags". */
export function parseMarkdown(md: string): ParsedMarkdown {
  const frontmatter: Record<string, string> = {};
  let rest = md;
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    rest = md.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (!kv || !kv[2]) continue;
      let v = kv[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) {
        try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
      }
      frontmatter[kv[1]] = v;
    }
  }

  const tags: { slug: string; name: string }[] = [];
  const rel = rest.indexOf("\n## Related tags");
  if (rel !== -1) {
    const section = rest.slice(rel, rest.indexOf("\n## ", rel + 5) === -1 ? undefined : rest.indexOf("\n## ", rel + 5));
    const para = section.split("\n").find((l) => l.includes("/tag/")) ?? "";
    for (const m of para.matchAll(/\[([^\]]+)\]\(https:\/\/blog\.cloudflare\.com\/tag\/([^/)]+)\/?\)/g)) {
      if (!tags.some((t) => t.slug === m[2])) tags.push({ name: m[1].trim(), slug: m[2].toLowerCase() });
    }
  }

  // Trim site chrome: start after the hero image line, end before the share links / Related tags.
  let body = rest;
  const lines = body.split("\n");
  // Leading chrome is "[Skip to content](...)" and "[Cloudflare home](...)" links; a hero image may follow.
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (/^\[(Skip to content|Cloudflare home)\]\(/.test(lines[i])) start = i + 1;
  }
  while (start < lines.length && !lines[start].trim()) start++;
  if (start < lines.length && /^!\[[^\]]*\]\([^)]*\)/.test(lines[start])) start++;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith("## Related tags") || lines[i].startsWith("[Discuss on Hacker News") || lines[i] === "Discuss Online") {
      end = i;
      break;
    }
  }
  body = lines.slice(start, end).join("\n").trim();
  return { frontmatter, body, tags };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** HTMLRewriter hands back attribute values and text with entities still encoded. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export interface HtmlMeta {
  canonical?: string;
  title?: string;
  description?: string;
  image?: string;
  published?: string;
  modified?: string;
  authors: { slug: string; name: string }[];
  tags: { slug: string; name: string }[];
}

/** Extract metadata from the post HTML with HTMLRewriter. */
export async function parseHtml(res: Response): Promise<HtmlMeta> {
  const meta: HtmlMeta = { authors: [], tags: [] };
  let ldText = "";
  let inLd = false;
  let authorSlug: string | null = null;
  let authorName = "";
  let tagSlug: string | null = null;
  let tagName = "";

  const rw = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(e) { meta.canonical ??= e.getAttribute("href") ?? undefined; } })
    .on("meta", {
      element(e) {
        const p = e.getAttribute("property") ?? e.getAttribute("name");
        const raw = e.getAttribute("content");
        const c = raw ? decodeEntities(raw) : undefined;
        if (!p || !c) return;
        if (p === "og:title") meta.title ??= c;
        else if (p === "og:description") meta.description ??= c;
        else if (p === "og:image") meta.image ??= c;
        else if (p === "article:published_time") meta.published ??= c;
        else if (p === "article:modified_time") meta.modified ??= c;
      },
    })
    .on('script[type="application/ld+json"]', {
      element(e) { inLd = true; e.onEndTag(() => { inLd = false; }); },
      text(t) { if (inLd) ldText += t.text; },
    })
    // The post byline: author links styled as the byline (related-post cards use other classes).
    .on('a[href^="/author/"]', {
      element(e) {
        const cls = e.getAttribute("class") ?? "";
        if (!cls.includes("text-display")) { authorSlug = null; return; }
        authorSlug = (e.getAttribute("href") ?? "").split("/").filter(Boolean)[1] ?? null;
        authorName = "";
        e.onEndTag(() => {
          if (authorSlug && !meta.authors.some((a) => a.slug === authorSlug)) {
            meta.authors.push({ slug: authorSlug.toLowerCase(), name: decodeEntities(authorName).trim() || authorSlug });
          }
          authorSlug = null;
        });
      },
      text(t) { if (authorSlug) authorName += t.text; },
    })
    // Tag pills in the post header (fallback when the Markdown has no "Related tags").
    .on('a[href^="/tag/"]', {
      element(e) {
        const cls = e.getAttribute("class") ?? "";
        if (!cls.includes("border-tag-border")) { tagSlug = null; return; }
        tagSlug = (e.getAttribute("href") ?? "").split("/").filter(Boolean)[1] ?? null;
        tagName = "";
        e.onEndTag(() => {
          if (tagSlug && meta.tags.length < 25 && !meta.tags.some((t) => t.slug === tagSlug)) {
            meta.tags.push({ slug: tagSlug.toLowerCase(), name: decodeEntities(tagName).trim() || tagSlug });
          }
          tagSlug = null;
        });
      },
      text(t) { if (tagSlug) tagName += t.text; },
    });

  await rw.transform(res).arrayBuffer();

  try {
    for (const chunk of ldText.split(/(?<=\})\s*(?=\{)/)) {
      const ld = JSON.parse(chunk);
      if (ld["@type"] === "BlogPosting") {
        meta.published ??= ld.datePublished;
        meta.modified ??= ld.dateModified;
        meta.title ??= ld.headline;
        meta.description ??= ld.description;
        const a = Array.isArray(ld.author) ? ld.author : ld.author ? [ld.author] : [];
        for (const x of a) {
          const slug = String(x.url ?? "").split("/").filter(Boolean).pop();
          if (slug && x.name && !meta.authors.some((m) => m.slug === slug)) meta.authors.push({ slug, name: x.name });
        }
      }
    }
  } catch {
    /* malformed JSON-LD: ignore */
  }
  return meta;
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function yamlString(s: string): string {
  return JSON.stringify(s);
}
