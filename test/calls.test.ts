/**
 * GitHub calls, counted (#253): every call by bucket and call site (a template, never a URL), the
 * quota from GitHub's headers, counts that add up across isolates in D1, and the backoff when low.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { autoTick } from "../src/actions/auto.ts";
import { DEFAULT_AUTO, saveAutoSettings } from "../src/agents/auto.ts";
import { openDb } from "../src/db.ts";
import { createCalls, graphqlSiteOf, isLow, siteOf } from "../src/forge/calls.ts";
import { githubForge } from "../src/forge/github.ts";
import { createGatherer } from "../src/gather.ts";
import { callsPanels, topSites } from "../src/pages/calls.ts";
import { d1Reads } from "../src/sources/files.ts";
import { createGhe } from "../src/sources/ghe.ts";
import { H, assertInert } from "./helpers.ts";

const HOUR = 3600_000;
const limits = (remaining: number, o: { limit?: number; reset?: number; resource?: string } = {}) =>
  new Headers({ "x-ratelimit-remaining": String(remaining), "x-ratelimit-limit": String(o.limit ?? 5000), "x-ratelimit-reset": String(o.reset ?? 2_000_000_000), ...(o.resource ? { "x-ratelimit-resource": o.resource } : {}) });

test("siteOf: names, numbers, refs, file paths and the query come out; the shape stays", () => {
  assert.equal(siteOf("get", "/repos/acme/web/actions/runs?status=waiting&per_page=100"), "GET /repos/:repo/actions/runs");
  assert.equal(siteOf("GET", "/repos/acme/web/actions/runs/12345/pending_deployments"), "GET /repos/:repo/actions/runs/:n/pending_deployments");
  assert.equal(siteOf("GET", "/users/me/events/orgs/acme?per_page=100&page=2"), "GET /users/:owner/events/orgs/:owner");
  assert.equal(siteOf("GET", "/repos/a/b/contents/docs/x%20y.md?ref=main"), "GET /repos/:repo/contents/:path");
  assert.equal(siteOf("GET", "/repos/a/b/compare/abc...def"), "GET /repos/:repo/compare/:range");
  assert.equal(siteOf("GET", "/repos/a/b/git/ref/heads/feat%2Fx"), "GET /repos/:repo/git/ref/:ref");
  assert.equal(siteOf("POST", "/repos/a/b/git/refs"), "POST /repos/:repo/git/refs");
  assert.equal(siteOf("DELETE", "/repos/a/b/issues/7/labels/dovre%3Aauto"), "DELETE /repos/:repo/issues/:n/labels/:name");
  assert.equal(siteOf("GET", "/search/issues?q=secret+repo:acme/x"), "GET /search/issues");
  assert.equal(siteOf("GET", "/user"), "GET /user");
  assert.equal(graphqlSiteOf("{ mine: search(query:\"x\") { nodes { id } } }"), "graphql mine:search");
  assert.equal(graphqlSiteOf("{r0: repository(owner:\"a\"){id} r1: repository(owner:\"b\"){id}}"), "graphql r:repository");
  assert.equal(graphqlSiteOf("query { viewer { login } }"), "graphql viewer");
});

test("the client counts each call with its bucket and keeps the quota GitHub said; a failed call counts too", async () => {
  const fetchFn = (async (url: string) => {
    if (String(url).endsWith("/graphql")) return new Response(JSON.stringify({ data: { viewer: { login: "me" } } }), { headers: limits(4000, { resource: "graphql" }) });
    if (String(url).includes("/search/")) return new Response(JSON.stringify({ items: [] }), { headers: limits(29, { limit: 30, resource: "search" }) });
    if (String(url).includes("/nope")) return new Response("gone", { status: 404, headers: limits(4998, { resource: "core" }) });
    return new Response(JSON.stringify({ login: "me" }), { headers: limits(4999, { resource: "core" }) });
  }) as typeof fetch;
  const ghe = createGhe({ host: "github.com", token: "t", fetchFn });
  await ghe.rest("/user");
  await ghe.rest("/search/issues?q=x");
  await ghe.graphql("{ viewer { login } }");
  await ghe.rest("/repos/a/b/nope").catch(() => {});
  const v = await ghe.calls!.view();
  assert.deepEqual(topSites(v.counts, 0).map((r) => `${r.bucket} ${r.site} ${r.n}`).sort(), ["core GET /repos/:repo/nope 1", "core GET /user 1", "graphql graphql viewer 1", "search GET /search/issues 1"]);
  assert.deepEqual(Object.fromEntries(v.quota.map((q) => [q.bucket, q.remaining])), { core: 4998, graphql: 4000, search: 29 });
  assert.equal(ghe.calls!.low(), false);
});

test("conditional GETs: the ETag goes back, a 304 returns the kept answer and counts as not modified, writes never send one", async () => {
  const sent: { url: string; method: string; inm?: string; ims?: string }[] = [];
  let runs = 1;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    sent.push({ url: String(url), method: String(init.method), inm: h["if-none-match"], ims: h["if-modified-since"] });
    if (String(url).includes("/notifications")) {
      if (h["if-modified-since"] === "Thu, 29 Oct 2026 10:00:00 GMT") return new Response(null, { status: 304, headers: limits(4990, { resource: "core" }) });
      return new Response("[]", { headers: { ...Object.fromEntries(limits(4991, { resource: "core" })), "last-modified": "Thu, 29 Oct 2026 10:00:00 GMT" } });
    }
    if (init.method === "POST") return new Response("{}", { status: 201, headers: limits(4980, { resource: "core" }) });
    const tag = `W/"runs-${runs}"`;
    if (h["if-none-match"] === tag) return new Response(null, { status: 304, headers: limits(4995, { resource: "core" }) });
    return new Response(JSON.stringify({ workflow_runs: [{ id: runs }] }), { headers: { ...Object.fromEntries(limits(4996, { resource: "core" })), etag: tag } });
  }) as unknown as typeof fetch;
  const ghe = createGhe({ host: "github.com", token: "t", fetchFn });
  const path = "/repos/a/b/actions/runs?status=waiting";
  const first = await ghe.rest<{ workflow_runs: { id: number }[] }>(path);
  first.workflow_runs.push({ id: 99 });
  assert.deepEqual(await ghe.rest(path), { workflow_runs: [{ id: 1 }] }, "the kept answer, not one a caller changed");
  assert.equal(sent[1]!.inm, 'W/"runs-1"');
  runs = 2;
  assert.deepEqual(await ghe.rest(path), { workflow_runs: [{ id: 2 }] }, "a changed answer comes through");
  await ghe.rest("/notifications");
  await ghe.rest("/notifications");
  assert.equal(sent.at(-1)!.ims, "Thu, 29 Oct 2026 10:00:00 GMT");
  await ghe.rest(path, { method: "POST", body: {} });
  assert.equal(sent.at(-1)!.inm, undefined, "a write is never conditional");
  const v = await ghe.calls!.view();
  assert.deepEqual(topSites(v.counts, 0).map((r) => `${r.bucket} ${r.site} ${r.n}`).sort(), [
    "core GET /notifications 1",
    "core GET /repos/:repo/actions/runs 2",
    "core POST /repos/:repo/actions/runs 1",
    "not modified GET /notifications (304) 1",
    "not modified GET /repos/:repo/actions/runs (304) 1",
  ]);
  assert.deepEqual(v.quota.map((q) => q.bucket), ["core"], "a 304's quota is core's");
});

test("shared (D1): a cold client asks with the ETag another one kept; who a token is, asked once an hour per token, never stored as the token", async () => {
  const db = openDb();
  const shared = d1Reads(db.DB);
  const sent: { url: string; auth: string; inm?: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    sent.push({ url: String(url), auth: h.authorization!, inm: h["if-none-match"] });
    if (String(url).endsWith("/user")) return new Response(JSON.stringify({ login: h.authorization === "Bearer secret-a" ? "ann" : "bob" }), { headers: limits(4990, { resource: "core" }) });
    if (h["if-none-match"] === '"e1"') return new Response(null, { status: 304, headers: limits(4995, { resource: "core" }) });
    return new Response(JSON.stringify({ events: [1] }), { headers: { ...Object.fromEntries(limits(4996, { resource: "core" })), etag: '"e1"' } });
  }) as unknown as typeof fetch;
  let t = Date.now();
  const now = () => t;
  const warm = createGhe({ host: "github.com", token: "secret-a", fetchFn, shared, now });
  await warm.rest("/users/ann/events");
  const cold = createGhe({ host: "github.com", token: "secret-a", fetchFn, shared, now });
  assert.deepEqual(await cold.rest("/users/ann/events"), { events: [1] });
  assert.equal(sent.at(-1)!.inm, '"e1"', "the cold client sent what the warm one kept");
  assert.deepEqual((await cold.calls!.view()).counts.map((c) => c.bucket), ["not modified"]);

  assert.equal((await warm.rest<{ login: string }>("/user")).login, "ann");
  assert.equal((await cold.rest<{ login: string }>("/user")).login, "ann", "kept in D1 for the other client");
  const other = createGhe({ host: "github.com", token: "secret-b", fetchFn, shared, now });
  assert.equal((await other.rest<{ login: string }>("/user")).login, "bob", "another token is asked for itself");
  assert.equal(sent.filter((x) => x.url.endsWith("/user")).length, 2);
  t += 3600_000;
  await cold.rest("/user");
  assert.equal(sent.filter((x) => x.url.endsWith("/user")).length, 3, "an hour on, asked again");
  const rows = (await db.DB.prepare("SELECT key, value FROM forge_reads").all<{ key: string; value: string }>()).results;
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => !r.key.includes("secret") && !r.value.includes("secret")), "no token in D1");
});

test("low: under a tenth of core or GraphQL, until the reset; search running out isn't", () => {
  let t = 1_000_000;
  const c = createCalls(() => t);
  c.record("GET /search/issues", limits(0, { limit: 30, resource: "search", reset: 2000 }));
  assert.equal(c.low(), false, "search fills every minute: it doesn't hold the snapshot");
  c.record("GET /user", limits(501, { reset: 2000 }));
  assert.equal(c.low(), false);
  c.record("GET /user", limits(499, { reset: 2000 }));
  assert.equal(c.low(), true);
  t = 2_000_001;
  assert.equal(c.low(), false, "filled again at the reset");
  assert.equal(isLow({ bucket: "core", remaining: 0, limit: 0, reset: 3e6, at: 0 }, t), true, "a zero limit is low");
});

test("counts reach D1 and add up across isolates; the newest quota wins; a week is kept", async () => {
  const db = openDb();
  let t = 10 * 24 * HOUR;
  const a = createCalls(() => t);
  const b = createCalls(() => t);
  a.record("GET /user", limits(4000));
  a.record("GET /user", limits(3999));
  b.record("GET /user", limits(3990));
  await a.flush(db.DB);
  await b.flush(db.DB);
  // Not flushed yet: still shown, once.
  a.record("GET /notifications", limits(3980));
  let v = await b.view(db.DB);
  assert.equal(topSites(v.counts, 0).find((r) => r.site === "GET /user")?.n, 3);
  assert.equal(topSites(v.counts, 0).find((r) => r.site === "GET /notifications"), undefined, "a's unflushed calls are a's");
  v = await a.view(db.DB);
  assert.equal(topSites(v.counts, 0).find((r) => r.site === "GET /notifications")?.n, 1);
  assert.equal(v.quota.find((q) => q.bucket === "core")?.remaining, 3980);

  // Within 30 s a flush waits (one batch at most that often); forced, it goes.
  await a.flush(db.DB);
  assert.equal((await db.DB.prepare("SELECT COUNT(*) AS n FROM forge_calls WHERE site = 'GET /notifications'").first<{ n: number }>())?.n, 0);
  await a.flush(db.DB, true);
  assert.equal((await db.DB.prepare("SELECT n FROM forge_calls WHERE site = 'GET /notifications'").first<{ n: number }>())?.n, 1);
  // An older isolate's quota doesn't overwrite a newer one's.
  const old = createCalls(() => t - 60_000);
  old.record("GET /user", limits(4500));
  await old.flush(db.DB, true);
  assert.equal((await db.DB.prepare("SELECT remaining FROM forge_quota WHERE bucket = 'core'").first<{ remaining: number }>())?.remaining, 3980);

  t += 8 * 24 * HOUR;
  const later = createCalls(() => t);
  later.record("GET /user");
  await later.flush(db.DB, true);
  assert.deepEqual((await db.DB.prepare("SELECT site FROM forge_calls").all<{ site: string }>()).results.map((r) => r.site), ["GET /user"], "past a week, gone");
});

test("a flush that fails keeps its counts for the next one", async () => {
  const db = openDb();
  const c = createCalls();
  c.record("GET /user");
  const broken = { prepare: db.DB.prepare.bind(db.DB), batch: async () => Promise.reject(new Error("D1 down")) } as unknown as typeof db.DB;
  const err = console.error;
  console.error = () => {};
  try {
    await c.flush(broken, true);
  } finally {
    console.error = err;
  }
  await c.flush(db.DB, true);
  assert.equal((await db.DB.prepare("SELECT n FROM forge_calls").first<{ n: number }>())?.n, 1);
});

test("while the quota is low, the snapshot waits 10 minutes instead of 45 s", async () => {
  let t = 1_000_000;
  let gathers = 0;
  const calls = createCalls(() => t);
  const forge = {
    ...githubForge({ host: "github.com", calls, rest: async () => [] as never, graphql: async () => ({ mine: { nodes: [] }, review: { nodes: [] } }) as never }),
    prs: async () => (gathers++, { mine: [], review: [] }),
  };
  const g = createGatherer({ env: { GHE_ORG: "acme", OWNERS: "acme" } as never, forge, login: "me", now: () => t });
  await g.get();
  assert.equal(gathers, 1);
  calls.record("GET /user", limits(100, { reset: 1e7 }));
  t += 60_000;
  await g.get();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gathers, 1, "low: a minute-old snapshot is fine");
  t += 10 * 60_000;
  await g.get();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gathers, 2, "ten minutes on, it gathers");
  await g.get({ fresh: true });
  assert.equal(gathers, 3, "one I asked for always goes");
});

test("the auto pass asks who the token is once an hour, not every pass", async () => {
  const db = openDb();
  let users = 0;
  const ghe = { host: "github.com", rest: async (p: string) => (p === "/user" ? (users++, { login: "me" }) : { items: [] }), graphql: async () => ({}) } as never;
  await saveAutoSettings(db.DB, { ...DEFAULT_AUTO, on: true });
  let t = 1_000_000;
  const deps = { db: db.DB, ghe, owners: "acme", desk: { view: () => ({ here: true, online: true, harnesses: ["claude"], runs: [], workDir: "/w" }), repos: async () => [], run: async () => undefined } as never, clicks: async () => new Map(), now: () => t };
  await autoTick(deps);
  t += 2 * 60_000;
  await autoTick(deps);
  assert.equal(users, 1);
  t += 61 * 60_000;
  await autoTick(deps);
  assert.equal(users, 2);
});

test("Settings → GitHub calls: hostile sites and buckets stay text; low says what waits", () => {
  const now = 5 * HOUR + 10;
  const out = String(
    callsPanels(
      {
        now,
        quota: [{ bucket: "core", remaining: 12, limit: 5000, reset: now + HOUR, at: now }, { bucket: H, remaining: 1, limit: 2, reset: now + 1, at: now }],
        counts: [{ hour: 5 * HOUR, bucket: H, site: H, n: 40 }, { hour: 5 * HOUR, bucket: "core", site: "GET /user", n: 2 }, { hour: 2 * HOUR, bucket: "core", site: "GET /notifications", n: 7 }],
      },
      H,
    ),
  );
  assertInert("/settings/calls", out);
  assert.match(out, /Low on core/);
  assert.match(out, /The last 24 hours/);
  const hourPanel = out.slice(out.indexOf('id="calls-hour"'), out.indexOf('id="calls-day"'));
  assert.doesNotMatch(hourPanel, /GET \/notifications/, "three hours ago isn't this hour");
  assert.match(out.slice(out.indexOf('id="calls-day"')), /GET \/notifications/);
  assert.match(String(callsPanels({ now, quota: [], counts: [] }, "GitHub")), /Nothing heard yet/);
});
