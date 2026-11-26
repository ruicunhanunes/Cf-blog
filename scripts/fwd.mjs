// Local test helper: plain-HTTP forwarder so workerd (which ignores HTTPS_PROXY) can reach the internet in `wrangler dev`.
import http from "node:http";
http.createServer(async (req, res) => {
  const target = new URL(req.url, "http://x").searchParams.get("u");
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers["accept-encoding"];
    const r = await fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
    const h = Object.fromEntries(r.headers); delete h["content-encoding"]; delete h["content-length"]; delete h["transfer-encoding"];
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502); res.end(String(e)); }
}).listen(9000, () => console.log("fwd on 9000"));
