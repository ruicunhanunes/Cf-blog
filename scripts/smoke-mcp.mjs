// MCP smoke test. Usage: MCP_TOKEN=<bearer> node scripts/smoke-mcp.mjs https://blog-library.miguel-nunes-net.workers.dev/mcp
// (Get a token by connecting any MCP client once; or point at the local harness: http://localhost:8799/mcp with no token.)
const url = process.argv[2] ?? "http://localhost:8799/mcp";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
if (process.env.MCP_TOKEN) headers.authorization = `Bearer ${process.env.MCP_TOKEN}`;
let id = 0;
async function rpc(method, params) {
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const calls = [
  ["search_posts", { query: "What did Cloudflare write about the July 2019 outage?", limit: 3 }],
  ["get_post", { url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/", max_chars: 500 }],
  ["list_posts", { tag: "outage", limit: 3 }],
  ["list_tags", { prefix: "work" }],
  ["list_authors", { prefix: "john" }],
  ["library_stats", {}],
  ["ask_blog", { question: "Why did a regular expression take down Cloudflare in July 2019?" }],
];
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
const { tools } = await rpc("tools/list", {});
console.log(`tools: ${tools.map((t) => t.name).join(", ")} (${tools.length})`);
let fail = 0;
for (const [name, args] of calls) {
  try {
    const r = await rpc("tools/call", { name, arguments: args });
    const ok = !r.isError;
    if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${r.content[0].text.slice(0, 160).replace(/\s+/g, " ")}`);
  } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(fail ? 1 : 0);
