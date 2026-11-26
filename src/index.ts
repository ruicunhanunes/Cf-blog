import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env, FetchJob } from "./env";
import { appFetch, SECURITY_HEADERS } from "./app";
import { handleMcp } from "./mcp/server";
import { handleDeadLetterBatch, handleFetchBatch } from "./sync/consumer";

export { SyncWorkflow } from "./sync/workflow";

// ---------- Wiring ----------

let provider: OAuthProvider<Env> | null = null;
function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
  resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, resource_name: "Cloudflare Blog Library" },
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(req: Request, env: Env, ctx: ExecutionContext) {
      const props = (ctx as unknown as { props?: { email?: string } }).props;
      return handleMcp(req, env, props?.email ?? "unknown");
    },
  },
  defaultHandler: { fetch: appFetch as unknown as ExportedHandlerFetchHandler<Env> },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read"],
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 86400,
  });
  return provider;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await getProvider(env).fetch(req, env, ctx);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
    return out;
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.SYNC.create({ params: {} }).then((i) => console.log(JSON.stringify({ stage: "cron", outcome: "started", run_id: i.id }))));
  },
  async queue(batch: MessageBatch<FetchJob>, env: Env) {
    if (batch.queue.endsWith("-dlq")) return handleDeadLetterBatch(batch, env);
    return handleFetchBatch(batch, env);
  },
} satisfies ExportedHandler<Env, FetchJob>;
