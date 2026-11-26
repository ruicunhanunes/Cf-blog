#!/usr/bin/env node
// Unit tests for the product matcher and catalog invariants. No network.  node scripts/test-products.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { buildMatcher, BODY_MIN_MENTIONS } from "../src/products/match.ts";
import { parseDirectory, parentPaths } from "../src/products/directory.ts";

const catalog = JSON.parse(readFileSync(new URL("../src/products/catalog.json", import.meta.url), "utf8"));
const match = buildMatcher(catalog);
const strong = (post) => match({ description: "", body: "", tags: [], ...post }).filter((m) => m.signal !== "body").map((m) => m.product);
const all = (post) => Object.fromEntries(match({ description: "", body: "", tags: [], ...post }).map((m) => [m.product, m.signal]));
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

test("longest term wins: Workers KV is KV, not Workers", () => {
  assert.deepEqual(strong({ title: "We made Workers KV up to 3x faster" }), ["kv"]);
  assert.deepEqual(strong({ title: "Catching up with Cloudflare Workers KV" }), ["kv"]);
});
test("Workers AI is not Workers", () => assert.deepEqual(strong({ title: "Meta Llama 3.1 now available on Workers AI" }), ["workers-ai"]));
test("stop terms: Service Worker never counts as Workers", () => assert.deepEqual(strong({ title: "Service Workers and the offline web" }), []));
test("case-sensitive: lowercase prose does not match ambiguous names", () => {
  assert.deepEqual(strong({ title: "Secure access to your pages and stream" }), []);
  assert.deepEqual(strong({ title: "Cloudflare Access for your Cloudflare Pages" }).sort(), ["access", "pages"]);
});
test("former names: Argo Tunnel, Area 1, Magic WAN, Browser Rendering", () => {
  assert.deepEqual(strong({ title: "A free Argo Tunnel for your next project" }), ["cloudflare-tunnel"]);
  assert.deepEqual(strong({ title: "Argo Tunnels that live forever" }), ["cloudflare-tunnel"]);
  assert.deepEqual(strong({ title: "How Cloudflare Area 1 and DLP work together" }).sort(), ["data-loss-prevention", "email-security"]);
  assert.deepEqual(strong({ title: "Magic WAN goes global" }), ["cloudflare-wan"]);
  assert.deepEqual(strong({ title: "Workers Browser Rendering API enters open beta" }).sort(), ["browser-run", "workers"]);
});
test("2017 'Cloudflare Warp' is the tunnel, 'WARP' is the client", () => {
  assert.deepEqual(strong({ title: "Introducing Cloudflare Warp: Hide Behind The Edge" }), ["cloudflare-tunnel"]);
  assert.deepEqual(strong({ title: "WARP for Desktop" }), ["warp-client"]);
});
test("pre-2016 'CloudFlare' spelling", () => assert.deepEqual(strong({ title: "Tinfoil Security now easy in CloudFlare Apps" }), ["cloudflare-apps"]));
test("plurals: Durable Object(s)", () => {
  assert.deepEqual(strong({ title: "One Durable Object per user" }), ["durable-objects"]);
  assert.deepEqual(strong({ title: "Durable Objects: easy, fast, correct" }), ["durable-objects"]);
});
test("word boundaries: R2D2 is not R2, D1 inside a token is not D1", () => assert.deepEqual(strong({ title: "R2D2 and xD1 walk into a bar" }), []));
test("tags give a tag signal and take precedence over title", () => {
  const m = all({ title: "R2 is GA", tags: ["r2"] });
  assert.equal(m.r2, "tag");
});
test("body mentions: below threshold none, at threshold 'body'", () => {
  const body = (k) => Array(k).fill("We store it in R2.").join(" ");
  assert.equal(all({ title: "x", body: body(BODY_MIN_MENTIONS - 1) }).r2, undefined);
  assert.equal(all({ title: "x", body: body(BODY_MIN_MENTIONS) }).r2, "body");
});
test("description alone is 'body'; with enough body mentions it is 'title'", () => {
  assert.equal(all({ title: "x", description: "Built on R2." }).r2, "body");
  assert.equal(all({ title: "x", description: "Built on R2.", body: "R2 R2 R2" }).r2, "title");
});

test("catalog invariants: unique slugs, parents exist, no cycles, every product has a category", () => {
  const slugs = new Set();
  for (const p of catalog.products) {
    assert.ok(!slugs.has(p.slug), `duplicate ${p.slug}`);
    slugs.add(p.slug);
    assert.ok(p.categories.length, `${p.slug} has no category`);
  }
  const by = new Map(catalog.products.map((p) => [p.slug, p]));
  for (const p of catalog.products) {
    const seen = new Set([p.slug]);
    for (let q = p.parent; q; q = by.get(q).parent) {
      assert.ok(by.has(q), `${p.slug}: missing parent ${q}`);
      assert.ok(!seen.has(q), `${p.slug}: cycle`);
      seen.add(q);
    }
  }
});
test("no term credits two unrelated products by accident", () => {
  const owners = new Map();
  for (const p of catalog.products) for (const t of p.terms) owners.set(t, [...(owners.get(t) ?? []), p.slug]);
  const dup = [...owners].filter(([, v]) => v.length > 1);
  assert.deepEqual(dup, []);
});

test("directory parser: cells, groups, hierarchy from paths", () => {
  const cell = (name, path, groups) => `<div data-directory-cell data-name="${name.toLowerCase()}" data-groups="${groups}" class="x"><a href="${path}" class="c"><p class="pt-2"><strong class="t">${name}</strong></p><p class="text-muted-foreground x">Desc &amp; more</p></a></div>`;
  const html = Array.from({ length: 49 }, (_, i) => cell(`P${i}`, `/p${i}/`, "Core platform")).join("") + cell("Cloudflare One", "/cloudflare-one/", "Cloudflare One") + cell("Email security", "/cloudflare-one/email-security/", "Cloudflare One|Application security");
  const e = parseDirectory(html);
  assert.equal(e.length, 51);
  const es = e.find((x) => x.name === "Email security");
  assert.deepEqual(es.groups, ["Cloudflare One", "Application security"]);
  assert.equal(es.description, "Desc & more");
  assert.equal(parentPaths(e).get("/cloudflare-one/email-security/"), "/cloudflare-one/");
  assert.throws(() => parseDirectory("<html></html>"), /layout changed/);
});

console.log(`\n${n} tests passed`);
