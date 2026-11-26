import type { Env } from "../env";

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function keys(env: Env): Promise<Map<string, CryptoKey>> {
  if (jwksCache && Date.now() - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const { keys: list } = (await res.json()) as { keys: Jwk[] };
  const m = new Map<string, CryptoKey>();
  for (const k of list) {
    m.set(k.kid, await crypto.subtle.importKey("jwk", k as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  jwksCache = { at: Date.now(), keys: m };
  return m;
}

export interface AccessIdentity {
  email: string;
  sub: string;
}

/** Validates Cf-Access-Jwt-Assertion: signature, issuer, audience, expiry, and email allowlist. */
export async function verifyAccess(req: Request, env: Env): Promise<AccessIdentity | null> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    let key = (await keys(env)).get(header.kid);
    if (!key) { jwksCache = null; key = (await keys(env)).get(header.kid); }
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now + 60) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    const email = String(payload.email ?? "").toLowerCase();
    if (!email || !allowedEmails(env).includes(email)) return null;
    return { email, sub: String(payload.sub ?? email) };
  } catch {
    return null;
  }
}

export function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
