import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { BLOG_ORIGIN, type Env, type FetchJob, type SyncParams } from "../env";
import { blogFetch, localeOf, parseSitemapIndex, parseUrlset, slugOf } from "./parse";
import { discoverEndpoint, fallbackSearch, primarySearch } from "../search/semantic";

interface ChildResult {
  discovered: number;
  enqueued: number;
  dropped: Record<string, number>;
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const runId = event.instanceId;
    const full = !!event.payload?.full;
    if (event.payload?.slugs?.length) {
      const n = await step.do("enqueue slugs", async () => {
        const list = event.payload.slugs!.slice(0, 5000);
        for (let i = 0; i < list.length; i += 100) {
          await this.env.FETCH_QUEUE.sendBatch(list.slice(i, i + 100).map((slug) => ({ body: { force: true, slug, url: `https://blog.cloudflare.com/${slug}/`, lastmod: null, run_id: runId } })));
        }
        return list.length;
      });
      return { refetch: n };
    }
    const startedAt = await step.do("start", async () => {
      const ts = new Date().toISOString();
      await this.env.DB.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").bind(ts).run();
      return ts;
    });

    const children = await step.do("discover", async () => {
      const res = await blogFetch(`${BLOG_ORIGIN}/sitemap.xml`, this.env.CONTACT, "application/xml");
      if (!res.ok) throw new Error(`sitemap index ${res.status}`);
      const list = parseSitemapIndex(await res.text());
      if (!list.length) throw new Error("no post sitemaps found");
      return list;
    });

    const totals: ChildResult = { discovered: 0, enqueued: 0, dropped: {} };
    for (const child of children) {
      // Each child sitemap is its own step: fetch, filter, diff against D1, enqueue. Returns counts only.
      const r = await step.do(`sitemap ${child}`, { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } }, async () => {
        const res = await blogFetch(child, this.env.CONTACT, "application/xml");
        if (!res.ok) throw new Error(`${child} ${res.status}`);
        const entries = parseUrlset(await res.text());
        const dropped: Record<string, number> = {};
        const english: { slug: string; lastmod: string | null; url: string }[] = [];
        for (const e of entries) {
          const loc = localeOf(e.loc);
          if (loc) { dropped[loc] = (dropped[loc] ?? 0) + 1; continue; }
          const slug = slugOf(e.loc);
          if (slug) english.push({ slug, lastmod: e.lastmod, url: e.loc });
        }
        const known = new Map<string, string | null>();
        for (let i = 0; i < english.length; i += 90) {
          const chunk = english.slice(i, i + 90);
          const rows = await this.env.DB.prepare(
            `SELECT slug, lastmod, deleted_at FROM posts WHERE slug IN (${chunk.map(() => "?").join(",")})`,
          ).bind(...chunk.map((c) => c.slug)).all<{ slug: string; lastmod: string | null; deleted_at: string | null }>();
          for (const row of rows.results) known.set(row.slug, row.deleted_at ? null : row.lastmod);
        }
        const jobs: FetchJob[] = english
          .filter((e) => full || !known.has(e.slug) || known.get(e.slug) === null || (e.lastmod ?? "") > (known.get(e.slug) ?? ""))
          .map((e) => ({ url: e.url, slug: e.slug, lastmod: e.lastmod, run_id: runId, force: full }));
        for (let i = 0; i < jobs.length; i += 100) {
          await this.env.FETCH_QUEUE.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
        }
        return { discovered: english.length, enqueued: jobs.length, dropped } satisfies ChildResult;
      });
      totals.discovered += r.discovered;
      totals.enqueued += r.enqueued;
      for (const [k, v] of Object.entries(r.dropped)) totals.dropped[k] = (totals.dropped[k] ?? 0) + v;
    }

    // Mark posts missing from every sitemap; delete only after 2 consecutive misses.
    await step.do("mark missing", async () => {
      const seen = new Set<string>();
      for (const child of children) {
        const res = await blogFetch(child, this.env.CONTACT, "application/xml");
        if (!res.ok) return "skipped: sitemap fetch failed";
        for (const e of parseUrlset(await res.text())) if (!localeOf(e.loc)) seen.add(slugOf(e.loc));
      }
      const all = await this.env.DB.prepare("SELECT slug FROM posts WHERE deleted_at IS NULL").all<{ slug: string }>();
      if (seen.size < all.results.length * 0.9) return "skipped: sitemap looks partial";
      const absent = all.results.map((r) => r.slug).filter((s) => !seen.has(s));
      // Some live posts are simply not in any sitemap: only count a miss when the URL itself is gone.
      const missing: string[] = [];
      for (const s of absent.slice(0, 200)) {
        const res = await blogFetch(`https://blog.cloudflare.com/${s}/`, this.env.CONTACT, "text/html");
        await res.body?.cancel();
        if (res.status === 404 || res.status === 410) missing.push(s);
      }
      const now = new Date().toISOString();
      const stmts = missing.flatMap((s) => [
        this.env.DB.prepare("UPDATE posts SET missing_runs = missing_runs + 1 WHERE slug = ?").bind(s),
        this.env.DB.prepare("UPDATE posts SET deleted_at = ? WHERE slug = ? AND missing_runs >= 2").bind(now, s),
      ]);
      for (let i = 0; i < stmts.length; i += 50) await this.env.DB.batch(stmts.slice(i, i + 50));
      return `not in sitemaps: ${absent.length}, gone: ${missing.length}`;
    });

    // Daily canary against both semantic endpoints (PRD section 8).
    await step.do("semantic canary", async () => {
      const q = "how does cloudflare mitigate ddos attacks";
      const day = new Date().toISOString().slice(0, 10);
      let primaryOk = false, fallbackOk = false;
      try {
        const ep = await discoverEndpoint();
        if (ep) {
          const r = await primarySearch(ep, q);
          primaryOk = r.hits.length >= 10;
          await this.env.OPS.put(`fixtures/${day}/primary.json`, r.raw);
        }
      } catch (e) { console.log(JSON.stringify({ stage: "canary", source: "primary", outcome: "error", error: String(e) })); }
      try {
        const r = await fallbackSearch(q);
        fallbackOk = r.hits.length >= 10;
        await this.env.OPS.put(`fixtures/${day}/fallback.md`, r.raw);
      } catch (e) { console.log(JSON.stringify({ stage: "canary", source: "fallback", outcome: "error", error: String(e) })); }
      const status = primaryOk || fallbackOk ? "ok" : "degraded";
      await this.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('semantic_status', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(status, new Date().toISOString()).run();
      if (status === "degraded") console.error(JSON.stringify({ stage: "canary", outcome: "ALERT", message: "semantic endpoints degraded; Meaning toggle hidden" }));
      return { primaryOk, fallbackOk, status };
    });

    // Wait for the queue consumer to drain this run's jobs (bounded), then write the report.
    let written = 0;
    if (totals.enqueued > 0) {
      for (let i = 0; i < 60; i++) {
        const p = await step.do(`progress ${i}`, async () => {
          const r = await this.env.DB.prepare(
            "SELECT SUM(checked_at >= ?1) AS checked, SUM(indexed_at >= ?1) AS written FROM posts",
          ).bind(startedAt).first<{ checked: number | null; written: number | null }>();
          const dlq = await this.env.OPS.list({ prefix: `dlq/${runId}/`, limit: 1000 });
          return { done: (r?.checked ?? 0) + dlq.objects.length, written: r?.written ?? 0 };
        });
        written = p.written;
        if (p.done >= totals.enqueued) break;
        await step.sleep(`wait ${i}`, "5 minutes");
      }
    }

    await step.do("report", async () => {
      const failedObjs = await this.env.OPS.list({ prefix: `dlq/${runId}/`, limit: 1000 });
      const failed = failedObjs.objects.length;
      const status = totals.discovered === 0 ? "failed" : failed > 0 ? "partial" : "ok";
      const finishedAt = new Date().toISOString();
      await this.env.DB.prepare(
        "UPDATE sync_runs SET finished_at=?, discovered=?, enqueued=?, written=?, failed=?, dropped_locales=?, status=? WHERE started_at=?",
      ).bind(finishedAt, totals.discovered, totals.enqueued, written, failed, JSON.stringify(totals.dropped), status, startedAt).run();
      await this.env.OPS.put(`runs/${runId}.json`, JSON.stringify({ runId, full, startedAt, finishedAt, ...totals, written, failed, failedUrls: failedObjs.objects.map((o) => o.key), status }, null, 2));
      console.log(JSON.stringify({ run_id: runId, stage: "report", outcome: status, ...totals, written, failed }));
      return status;
    });
  }
}
