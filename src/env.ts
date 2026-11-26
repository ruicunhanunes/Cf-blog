export interface Env {
  DB: D1Database;
  POSTS: R2Bucket;
  OPS: R2Bucket;
  FETCH_QUEUE: Queue<FetchJob>;
  SYNC: Workflow<SyncParams>;
  AI: Ai;
  AI_SEARCH: AiSearchInstance;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;

  /** e.g. "myteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application audience tag (secret). */
  ACCESS_AUD: string;
  /** Comma-separated list of allowed emails (defence in depth on top of the Access policy). */
  ALLOWED_EMAILS: string;
  AI_SEARCH_NAME: string;
  CONTACT: string;
  /** e.g. https://blog-library.example.workers.dev (no trailing slash) */
  PUBLIC_ORIGIN: string;
}

export interface FetchJob {
  /** Re-upload the stored Markdown to AI Search without re-crawling. */
  reindex?: boolean;
  /** Rewrite even when the body hash is unchanged (metadata parser fixes). */
  force?: boolean;
  url: string;
  slug: string;
  lastmod: string | null;
  run_id: string;
}

export interface SyncParams {
  full?: boolean;
  /** Enqueue every stored post for AI Search re-upload; no crawling. */
  reindex?: boolean;
  /** Re-fetch (forced) only these slugs. */
  slugs?: string[];
}

export const BLOG_ORIGIN = "https://blog.cloudflare.com";
