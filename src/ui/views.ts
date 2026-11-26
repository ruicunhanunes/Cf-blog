import type { PostCard } from "../search/data";
import { escapeHtml as e } from "../search/semantic";

const CSS = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--card:#fafafa;--accent:#f6821f;--mark:#ffe8b3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f2f7;--muted:#a1a1a6;--line:#2c2c2e;--card:#1c1c1e;--accent:#ff9f45;--mark:#5a4210}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
a{color:inherit}main{max-width:760px;margin:0 auto;padding:12px 16px 48px}
header{position:sticky;top:0;background:var(--bg);padding:10px 0 8px;z-index:2;border-bottom:1px solid var(--line)}
.brand{font-weight:700;text-decoration:none;font-size:15px;color:var(--muted)}
form.s{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
form.s input[type=search]{flex:1 1 100%;min-width:0;min-height:44px;font-size:17px;padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0;font-size:14px;color:var(--muted)}
.filters input,.filters select{min-height:36px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);padding:4px 8px;font-size:14px}
.card{display:block;text-decoration:none;padding:14px 0;border-bottom:1px solid var(--line);min-height:44px}
.card h3{margin:0 0 4px;font-size:17px;line-height:1.3}
.meta{font-size:13px;color:var(--muted)}
.snip{margin:6px 0 0;font-size:14px;color:var(--fg);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
mark{background:var(--mark);color:inherit;border-radius:2px}
.tags{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:24px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips a{display:inline-flex;align-items:center;min-height:36px;padding:4px 12px;border:1px solid var(--line);border-radius:999px;text-decoration:none;font-size:14px}
.chips small{color:var(--muted);margin-left:6px}
.pager{display:flex;justify-content:space-between;margin-top:16px}
.pager a{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:12px;text-decoration:none}
.note{padding:10px 12px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:14px;margin:12px 0}
footer{margin-top:32px;font-size:12px;color:var(--muted)}
.az a{min-width:36px;justify-content:center}
`;

export function layout(title: string, body: string, opts: { q?: string; footer?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Blog Library">
<meta name="theme-color" content="#f6821f">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${e(title)}</title><style>${CSS}</style></head><body><main>
<header><a class="brand" href="/">Cloudflare Blog Library</a>
<form class="s" action="/search" method="get" role="search">
<input type="search" name="q" value="${e(opts.q ?? "")}" placeholder="Search by title, topic or question" autocomplete="off" autocapitalize="off" enterkeyhint="search" aria-label="Search">
</form></header>
${body}
<footer>${opts.footer ?? ""}</footer></main>
<script>
// Two-phase live search: instant keyword results while typing (fast=1), then the full
// keyword + meaning results once typing pauses. Stale responses are dropped.
(()=>{const f=document.querySelector('form.s');if(!f)return;const i=f.querySelector('input[type=search]');let t1,t2,seq=0;
async function load(fast){const q=i.value.trim();if(q.length<2)return;const my=++seq;
const p=new URLSearchParams({q});new URLSearchParams(location.search).forEach((v,k)=>{if(['tag','from','to','author'].includes(k))p.set(k,v)});
const url='/search?'+p;p.set('partial','1');if(fast)p.set('fast','1');
const r=await fetch('/search?'+p,{credentials:'same-origin'});if(!r.ok||my!==seq)return;
const el=document.getElementById('results');if(el){el.outerHTML=await r.text();history.replaceState(null,'',url)}else location.href=url}
i.addEventListener('input',()=>{clearTimeout(t1);clearTimeout(t2);t1=setTimeout(()=>load(true),150);t2=setTimeout(()=>load(false),700)})})();
</script></body></html>`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function card(p: PostCard): string {
  const authors = p.authors.map((a) => e(a.name)).join(", ");
  const tags = p.tags.slice(0, 3).map((t) => `<span class="tag">${e(t.name)}</span>`).join("");
  // snippet is already escaped (only <mark> allowed through)
  const snip = p.snippet ? `<p class="snip">${p.snippet}</p>` : p.description ? `<p class="snip">${e(p.description)}</p>` : "";
  return `<a class="card" href="${e(p.url)}" rel="noreferrer"><h3>${e(p.title)}</h3><div class="meta">${fmtDate(p.published_at)}${authors ? ` · ${authors}` : ""}</div>${snip}${tags ? `<div class="tags">${tags}</div>` : ""}</a>`;
}

export function resultsBlock(posts: PostCard[], extra = ""): string {
  return `<section id="results">${extra}${posts.length ? posts.map(card).join("") : `<p class="note">No posts found.</p>`}</section>`;
}

export function filtersForm(action: string, p: URLSearchParams, tags: { slug: string; name: string }[]): string {
  const keep = ["q", "sort"].map((k) => (p.get(k) ? `<input type="hidden" name="${k}" value="${e(p.get(k)!)}">` : "")).join("");
  return `<form class="filters" action="${e(action)}" method="get">${keep}
<label>From <input type="number" name="from" min="2009" max="2100" inputmode="numeric" placeholder="year" value="${e(p.get("from") ?? "")}" style="width:84px"></label>
<label>To <input type="number" name="to" min="2009" max="2100" inputmode="numeric" placeholder="year" value="${e(p.get("to") ?? "")}" style="width:84px"></label>
<select name="tag" aria-label="Tag"><option value="">Any tag</option>${tags.map((t) => `<option value="${e(t.slug)}" ${p.get("tag") === t.slug ? "selected" : ""}>${e(t.name)}</option>`).join("")}</select>
<button type="submit" style="min-height:36px">Apply</button></form>`;
}

export const MANIFEST = JSON.stringify({
  name: "Cloudflare Blog Library",
  short_name: "Blog Library",
  start_url: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#f6821f",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  ],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="36" fill="#f6821f"/><path d="M48 52h36a14 14 0 0 1 14 14v66a12 12 0 0 0-12-12H48zM132 52H104a14 14 0 0 0-14 14v66a12 12 0 0 1 12-12h30z" fill="#fff"/></svg>`;
