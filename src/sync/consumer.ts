import type { Env, FetchJob } from "../env";
import { blogFetch, canonicalUrl, parseHtml, parseMarkdown, sha256, yamlString } from "./parse";

class PermanentError extends Error {}

export async function handleFetchBatch(batch: MessageBatch<FetchJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const t0 = Date.now();
    try {
      const outcome = await processPost(msg.body, env);
      log({ run_id: msg.body.run_id, slug: msg.body.slug, stage: "consume", ms: Date.now() - t0, outcome });
      msg.ack();
    } catch (err) {
      const permanent = err instanceof PermanentError;
      log({ run_id: msg.body.run_id, slug: msg.body.slug, stage: "consume", ms: Date.now() - t0, outcome: permanent ? "deleted" : "error", error: String(err) });
      if (permanent) msg.ack();
      else msg.retry({ delaySeconds: Math.min(600, 30 * 2 ** msg.attempts) });
    }
  }
}

export async function handleDeadLetterBatch(batch: MessageBatch<FetchJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    await env.OPS.put(`dlq/${msg.body.run_id}/${msg.body.slug}.json`, JSON.stringify({ ...msg.body, at: new Date().toISOString() }));
    log({ run_id: msg.body.run_id, slug: msg.body.slug, stage: "dlq", outcome: "failed" });
    msg.ack();
  }
}

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify(o));
}

export async function processPost(job: FetchJob, env: Env): Promise<string> {
  const url = canonicalUrl(job.slug);

  const mdRes = await blogFetch(url, env.CONTACT, "text/markdown");
  if (mdRes.status === 404 || mdRes.status === 410) {
    await env.DB.prepare("UPDATE posts SET deleted_at = ? WHERE slug = ?").bind(new Date().toISOString(), job.slug).run();
    throw new PermanentError(`gone: ${mdRes.status}`);
  }
  if (!mdRes.ok) throw new Error(`markdown fetch ${mdRes.status}`);
  const isMarkdown = (mdRes.headers.get("content-type") ?? "").includes("text/markdown");
  const mdText = await mdRes.text();

  const htmlRes = await blogFetch(url, env.CONTACT, "text/html");
  if (!htmlRes.ok) throw new Error(`html fetch ${htmlRes.status}`);
  const htmlText = await htmlRes.text();
  const meta = await parseHtml(new Response(htmlText, { headers: { "content-type": "text/html" } }));

  let body: string;
  let tags = meta.tags;
  let fm: Record<string, string> = {};
  let bodySource = "markdown";
  if (isMarkdown) {
    const parsed = parseMarkdown(mdText);
    body = parsed.body;
    fm = parsed.frontmatter;
    if (parsed.tags.length) tags = parsed.tags;
  } else {
    bodySource = "fallback";
    body = await fallbackMarkdown(htmlText, env);
  }

  const title = (meta.title ?? fm.title ?? "").trim();
  const published = meta.published ?? null;
  if (!title || !published) throw new Error(`missing ${!title ? "title" : "published_at"}`);

  const description = meta.description ?? fm.description ?? null;
  const image = meta.image ?? fm.image ?? null;
  const authors = meta.authors;
  const hash = await sha256(body);
  const words = body.split(/\s+/).filter(Boolean).length;
  const r2Key = `posts/${job.slug}.md`;
  const now = new Date().toISOString();

  const existing = await env.DB.prepare("SELECT content_hash FROM posts WHERE slug = ?").bind(job.slug).first<{ content_hash: string }>();

  // Raw HTML for re-parsing without re-crawling (ops bucket, invisible to AI Search).
  await env.OPS.put(`raw/${job.slug}.html`, htmlText, { httpMetadata: { contentType: "text/html" } });

  if (!job.force && existing && existing.content_hash === hash) {
    await env.DB.prepare("UPDATE posts SET lastmod = COALESCE(?, lastmod), checked_at = ?, missing_runs = 0, deleted_at = NULL WHERE slug = ?").bind(job.lastmod, now, job.slug).run();
    return "unchanged";
  }

  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    `url: ${yamlString(url)}`,
    `published_at: ${yamlString(published)}`,
    `authors: [${authors.map((a) => yamlString(a.name)).join(", ")}]`,
    `tags: [${tags.map((t) => yamlString(t.name)).join(", ")}]`,
    description ? `description: ${yamlString(description)}` : null,
    "---",
    "",
  ].filter((l) => l !== null).join("\n");

  const doc = `${frontmatter}# ${title}\n\n${body}\n`;
  await env.POSTS.put(r2Key, doc, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { url, published_at: published, title: title.slice(0, 200) },
  });

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO posts (slug, url, title, description, image_url, published_at, updated_at, lastmod, word_count, reading_minutes, body_source, r2_key, content_hash, indexed_at, checked_at, deleted_at, missing_runs)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, NULL, 0)
       ON CONFLICT(slug) DO UPDATE SET url=?2, title=?3, description=?4, image_url=?5, published_at=?6, updated_at=?7, lastmod=COALESCE(?8, posts.lastmod),
         word_count=?9, reading_minutes=?10, body_source=?11, r2_key=?12, content_hash=?13, indexed_at=?14, checked_at=?14, deleted_at=NULL, missing_runs=0`,
    ).bind(job.slug, url, title, description, image, published, meta.modified ?? null, job.lastmod, words, Math.max(1, Math.round(words / 230)), bodySource, r2Key, hash, now),
    env.DB.prepare("DELETE FROM post_tags WHERE post_slug = ?").bind(job.slug),
    env.DB.prepare("DELETE FROM post_authors WHERE post_slug = ?").bind(job.slug),
    env.DB.prepare("DELETE FROM posts_fts WHERE slug = ?").bind(job.slug),
  ];
  for (const t of tags) {
    stmts.push(env.DB.prepare("INSERT INTO tags (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name").bind(t.slug, t.name));
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO post_tags (post_slug, tag_slug) VALUES (?, ?)").bind(job.slug, t.slug));
  }
  for (const a of authors) {
    stmts.push(env.DB.prepare("INSERT INTO authors (slug, name) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name").bind(a.slug, a.name));
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO post_authors (post_slug, author_slug) VALUES (?, ?)").bind(job.slug, a.slug));
  }
  stmts.push(
    env.DB.prepare("INSERT INTO posts_fts (slug, title, description, tags, authors, body) VALUES (?, ?, ?, ?, ?, ?)").bind(
      job.slug, title, description ?? "", tags.map((t) => t.name).join(" "), authors.map((a) => a.name).join(" "), body,
    ),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return existing ? "updated" : "created";
}

/** Fallback: extract <article> and convert with Workers AI toMarkdown. */
async function fallbackMarkdown(html: string, env: Env): Promise<string> {
  const start = html.indexOf("<article");
  const end = html.lastIndexOf("</article>");
  const fragment = start !== -1 && end !== -1 ? html.slice(start, end + 10) : html;
  const results = await env.AI.toMarkdown([
    { name: "post.html", blob: new Blob([`<html><body>${fragment}</body></html>`], { type: "text/html" }) },
  ]);
  const r = Array.isArray(results) ? results[0] : results;
  if (!r || (r as { format: string }).format === "error") throw new Error("toMarkdown failed");
  return ((r as { data: string }).data ?? "").trim();
}

