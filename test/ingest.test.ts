// Pack ingest (dovre#109): token-checked POSTs into a pack, before the sign-in check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pack, PACK_API, type IngestInput } from "../src/packs/types.ts";
import { rateLimiter, tokensPanel } from "../src/packs/ingest.ts";
import { openDb } from "../src/db.ts";
import { createWorker } from "../src/worker.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

function sink() {
  const got: IngestInput[] = [];
  const p: Pack = {
    manifest: { api: PACK_API, id: "sink", name: "Sink", description: "", domain: "personal" },
    ingest: { maxBytes: 64, perMinute: 3, handle: (input) => (got.push(input), { status: 200, body: "{}", contentType: "application/json" }) },
    // Its own pages too (dovre#113): ingest mustn't make /sink look like a core path.
    routes: (app, ctx) => app.get("/sink", (c) => ctx.page(c, { title: "Sink", body: "sink page" })),
  };
  return { p, got };
}

const tokenOf = (page: string) => /<code class="secret">(dvi_[A-Za-z0-9_-]+)<\/code>/.exec(page)?.[1];

test("ingest: a token made on Settings lets an app POST in, before the sign-in check; nothing else does", async () => {
  const { p, got } = sink();
  const { app, get, post } = signedIn(snapshot(), {}, { packs: [p] });
  const send = (token: string | undefined, body = "{\"a\":1}", url = "http://localhost/sink/ingest/v1/traces", extra: Record<string, string> = {}) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body });

  assert.match(await (await get("/sink")).text(), /sink page/, "its own pages mount beside ingest");
  const settings = await (await get("/settings/packs/sink")).text();
  assert.match(settings, /Ingest tokens/);
  assert.match(settings, /No tokens yet/);

  assert.equal((await send(undefined)).status, 401, "no token");
  assert.equal((await send("dvi_madeup")).status, 401, "a token nobody made");

  const made = await post("/settings/ingest/new", { pack: "sink", source: "checkout-api" });
  assert.equal(made.status, 200);
  assert.equal(made.headers.get("cache-control"), "no-store");
  const token = tokenOf(await made.text())!;
  assert.ok(token, "shown once on the page that answers");
  assert.doesNotMatch(await (await get("/settings/packs/sink")).text(), new RegExp(token), "and never again");

  const ok = await send(token);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "{}");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.path, "v1/traces");
  assert.equal(got[0]!.source, "checkout-api");
  assert.equal(new TextDecoder().decode(got[0]!.body), "{\"a\":1}");
  assert.ok(!JSON.stringify(got[0]).includes(token), "the pack never sees the token");

  assert.equal((await send(token, "x".repeat(65))).status, 413, "over the pack's cap");
  assert.equal((await send(token, "{}", "http://evil.example/sink/ingest/v1/traces")).status, 404, "local: only on this machine's own address");
  assert.equal((await app.request("http://localhost/sink/ingest/v1/traces", { headers: { authorization: `Bearer ${token}` } })).status, 404, "GET reads nothing");
  assert.equal((await send(token)).status, 200);
  assert.equal((await send(token)).status, 429, "over the rate");

  assert.match(await (await get("/settings/packs/sink")).text(), /checkout-api/);
  const row = await (await get("/settings/packs/sink")).text();
  const id = /name="id" value="(\d+)"/.exec(row)![1]!;
  assert.equal((await post("/settings/ingest/revoke", { pack: "sink", id })).status, 303);
  assert.equal((await send(token)).status, 401, "revoked");

  assert.equal((await post("/settings/ingest/new", { pack: "sink", source: "<bad>" })).status, 303, "a bad name is refused");
  assert.equal((await post("/settings/ingest/new", { pack: "nope", source: "x" })).status, 404, "only a pack that takes ingest");
  assert.equal((await post("/settings/ingest/new", { pack: "sink", source: "x" }, { origin: "https://evil.example" })).status, 403, "made only from this app");
});

test("ingest: a token is good for its own pack only, and a throwing pack's error stays in the log", async () => {
  const { p } = sink();
  const boom: Pack = { manifest: { api: PACK_API, id: "boom", name: "Boom", description: "", domain: "personal" }, ingest: { handle: () => { throw new Error(`secret ${H}`); } } };
  const { app, post } = signedIn(snapshot(), {}, { packs: [p, boom] });
  const token = tokenOf(await (await post("/settings/ingest/new", { pack: "sink", source: "a" })).text())!;
  const boomToken = tokenOf(await (await post("/settings/ingest/new", { pack: "boom", source: "b" })).text())!;
  const to = (id: string, t: string) => app.request(`http://localhost/${id}/ingest/x`, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "1" });
  assert.equal((await to("boom", token)).status, 401);
  const r = await to("boom", boomToken);
  assert.equal(r.status, 500);
  assert.doesNotMatch(await r.text(), /secret/);
});

test("ingest: a hostile source name is inert on Settings", () => {
  const { p } = sink();
  const row = { id: 1, source: H, created_at: H, last_used_at: H, revoked_at: null };
  assertInert("tokens panel", String(tokensPanel(p, [row], { hosted: true, made: { source: H, token: H } })));
});

test("ingest: hosted, the route skips Access and needs the token", async () => {
  const { p, got } = sink();
  const worker = createWorker({ packs: [{ ...p, manifest: { ...p.manifest, execution: "any" } }] });
  const pending: Promise<unknown>[] = [];
  const env = { DB: openDb().DB, IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud" };
  const ctx = { waitUntil: (x: Promise<unknown>) => void pending.push(x) };
  const res = await worker.fetch(new Request("https://dovre.example.dev/sink/ingest/v1/traces", { method: "POST", body: "{}" }), env as never, ctx);
  assert.equal(res.status, 401, "answered by the token check, not Access's 404");
  const page = await worker.fetch(new Request("https://dovre.example.dev/settings"), env as never, ctx);
  assert.equal(page.status, 404, "everything else still needs Access");
  await Promise.all(pending);
  assert.equal(got.length, 0);
});

test("ingest: the rate limiter's window resets each minute", () => {
  let t = 0;
  const ok = rateLimiter(() => t);
  assert.deepEqual([ok("k", 2), ok("k", 2), ok("k", 2)], [true, true, false]);
  t = 60_000;
  assert.equal(ok("k", 2), true);
});
