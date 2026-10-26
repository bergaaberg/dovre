/**
 * Packs (src/packs/, PLAN D23): which run where, and the core's side of each hook — mounted under
 * their own path, isolated, time-boxed, escaped — locally and in the Worker.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { html } from "hono/html";
import { loadPacks } from "../src/packs/load.ts";
import { activePacks, avatarFrom, actsFrom, briefingFrom, fillOf, linkedFrom, needsFrom, refreshLog, refresher, ringsOf, within } from "../src/packs/registry.ts";
import { createApp, packsOf } from "../src/app.ts";
import { noMemory } from "../src/packs/core/assistant/bino/memory.ts";
import type { Route } from "../src/packs/core/assistant/bino/route.ts";
import { testContext } from "../src/packs/testing.ts";
import { type Pack, PACK_API, type PackManifest } from "../src/packs/types.ts";
import type { D1 } from "../src/db.ts";
import { Card } from "../src/ui/kit.ts";
import { createWorker } from "../src/worker.ts";
import { loadEnv } from "../src/env.ts";
import { layoutOf } from "../src/layout.ts";
import { DEFAULT_POLICY, type Note } from "../src/notify.ts";
import { openDb } from "../src/db.ts";
import { H, appWithAgents, assertInert, deploy, fakeGhe, fixedGatherer, signedIn, snapshot } from "./helpers.ts";
import { logAction } from "../src/actions/deploys.ts";

const m = (o: Partial<PackManifest> & { id: string }): PackManifest => ({ api: PACK_API, name: o.id, description: "", domain: "personal", ...o });
const pack = (o: Partial<PackManifest> & { id: string }, hooks: Partial<Pack> = {}): Pack => ({ manifest: m(o), ...hooks });

test("activePacks: each pack on or off, with why", () => {
  const list = [
    pack({ id: "fine" }),
    pack({ id: "Bad_Id" }),
    pack({ id: "fine" }),
    { manifest: { ...m({ id: "old" }), api: 0 } },
    pack({ id: "switched" }),
    pack({ id: "machine", execution: "local-only" }),
    pack({ id: "edge", execution: "hosted-only", requiredBindings: ["QUILL"] }),
    pack({ id: "cli", requiredBinaries: ["wrangler"] }),
    pack({ id: "keyed", settings: [{ key: "CF_API_TOKEN", label: "token", required: true }] }),
  ];
  const local = activePacks(list, { env: { PACK_SWITCHED: "off" }, hosted: false, which: () => undefined });
  assert.deepEqual(local.on.map((c) => c.manifest.id), ["fine", "machine"]);
  const why = Object.fromEntries(local.off.map((o) => [o.id, o.why]));
  assert.match(why.Bad_Id!, /lowercase/);
  assert.match(why.fine!, /same id/);
  assert.match(why.old!, /contract 0/);
  assert.match(why.switched!, /switched off/);
  assert.match(why.edge!, /only hosted/);
  assert.match(why.cli!, /wrangler isn't on PATH/);
  assert.match(why.keyed!, /CF_API_TOKEN isn't set/);

  const hosted = activePacks(list, { env: { CF_API_TOKEN: "t" }, bindings: {}, hosted: true });
  assert.ok(!hosted.on.some((c) => c.manifest.id === "machine"), "local-only stays off hosted");
  assert.match(hosted.off.find((o) => o.id === "edge")!.why, /missing binding QUILL/);
  assert.ok(activePacks(list, { env: {}, bindings: { QUILL: {} }, hosted: true }).on.some((c) => c.manifest.id === "edge"));
  assert.ok(hosted.on.some((c) => c.manifest.id === "keyed"));
});

test("packs in the app: routes under their own path, nav, styles, search, Today; hostile text inert", async () => {
  const health = pack(
    { id: "health" },
    {
      styles: ".hl-x { color: var(--ok); }",
      nav: () => [{ href: "/health", title: "Health", icon: "health", group: "Ops" }],
      pages: () => [{ title: "Health", href: "/health", icon: "♥", about: "Every app's numbers", also: ["status"] }],
      routes: (app, ctx) => app.get("/health", (c) => ctx.page(c, { title: "Health", body: html`<h1>All ${H}</h1>` })),
      today: () => [{ id: "now", column: "left", render: Card({ id: "health-now", title: "Health", children: html`<p>${H}</p>` }) }],
    },
  );
  const { get } = signedIn(snapshot(), {}, { packs: [health] });
  const page = await (await get("/health")).text();
  assert.match(page, /<h1>All /);
  assertInert("pack page", page);
  const css = page.match(/href="(\/assets\/packs\.[^"]+\.css)"/)?.[1];
  assert.ok(css, "the packs' stylesheet is linked from every page");
  assert.match(await (await get(css!)).text(), /\.hl-x/);
  assert.match(page, /href="\/health" title="Health"/, "its nav item");
  const today = await (await get("/")).text();
  assert.match(today, /id="health-now"/);
  assert.match(today, /<meta name="u-topics" content="snapshot [^"]*\bhealth\b/, "Today refreshes when a pack publishes its id");
  assertInert("pack card", today);
  assert.match(await (await get("/search?q=status")).text(), /Every app&#39;s numbers|Every app's numbers/);
});

test("packs in the app: a route outside /<id>, or an id that's a core path, keeps the pack off; it can't shadow core", async () => {
  const sneaky = pack({ id: "sneaky" }, { routes: (app) => app.get("/prs", (c) => c.text("mine now")) });
  const prs = pack({ id: "prs" }, { routes: (app) => app.get("/prs", (c) => c.text("mine now")) });
  // Claiming more paths: a core one, another pack's, or an odd one keeps it off; its own claim works.
  const claims = pack({ id: "claims", paths: ["deploys"] }, { routes: (app) => app.get("/deploys", (c) => c.text("mine now")) });
  const twice = pack({ id: "twice", paths: ["worktrees"] }, { routes: (app) => app.get("/worktrees", (c) => c.text("mine now")) });
  const odd = pack({ id: "odd", paths: ["../x"] }, { routes: (app) => app.get("/odd", (c) => c.text("odd")) });
  const extra = pack({ id: "extra", paths: ["elsewhere"] }, { routes: (app) => app.get("/elsewhere", (c) => c.text("extra's")) });
  const { get, app } = signedIn(snapshot(), {}, { packs: [sneaky, prs, claims, twice, odd, extra] });
  assert.doesNotMatch(await (await get("/prs")).text(), /mine now/);
  assert.doesNotMatch(await (await get("/deploys")).text(), /mine now/);
  assert.doesNotMatch(await (await get("/worktrees")).text(), /mine now/, "the agents pack has it");
  assert.equal(await (await get("/elsewhere")).text(), "extra's");
  const off = packsOf(app)!.off.map((o) => `${o.id}: ${o.why}`);
  for (const id of ["sneaky", "prs", "claims", "twice", "odd"]) assert.ok(off.some((o) => o.startsWith(`${id}:`)), id);
});

test("packs on Today: a slow or failing pack is named, the rest still draw, and the page doesn't wait past the budget", async () => {
  const fine = pack({ id: "fine" }, { today: () => [{ id: "c", render: Card({ id: "fine-c", title: "Fine", children: "ok" }) }] });
  const slow = pack({ id: "slow", name: "Slowpoke" }, { today: () => new Promise((res) => setTimeout(() => res([]), 2000)) });
  const broken = pack({ id: "broken", name: "Broken" }, { today: () => { throw new Error("no data"); } });
  const { get } = signedIn(snapshot(), {}, { packs: [fine, slow, broken], budgetMs: 50 });
  const began = Date.now();
  const today = await (await get("/")).text();
  assert.ok(Date.now() - began < 1500, "Today didn't wait for the slow pack");
  assert.match(today, /id="fine-c"/);
  assert.match(today, /Slowpoke<\/b> took longer than 50 ms/);
  assert.match(today, /Broken<\/b> no data/);
});

test("within and refresher: answers in time or says why; a refresh still running isn't started twice", async () => {
  assert.deepEqual(await within(50, () => 1), { ok: true, value: 1 });
  assert.equal((await within(10, () => new Promise(() => {}))).ok, false);
  let runs = 0;
  let release!: () => void;
  const c = pack({ id: "r", everyMs: 60_000 }, { refresh: () => { runs++; return new Promise<void>((res) => (release = res)); } });
  const r = refresher([c], () => ({}) as never, () => {});
  const tick = () => new Promise((res) => setImmediate(res));
  const a = r.due();
  const b = r.due();
  await tick();
  release();
  await Promise.all([a, b]);
  assert.equal(runs, 1);
  await r.due();
  assert.equal(runs, 1, "not due again within everyMs");
  const done = r.due(true);
  await tick();
  release();
  await done;
  assert.equal(runs, 2);
});

test("refresher: a refresh stuck past maxMs is given up, and the next due() starts it again", async () => {
  let runs = 0;
  const lines: string[] = [];
  const clock = { t: 1_000_000 };
  const c = pack({ id: "stuck", everyMs: 1 }, { refresh: () => { runs++; return new Promise<void>(() => {}); } });
  const r = refresher([c], () => ({}) as never, (l) => lines.push(l), { maxMs: 25_000, now: () => clock.t });
  void r.due(true);
  await new Promise((res) => setImmediate(res));
  void r.due(true);
  await new Promise((res) => setImmediate(res));
  assert.equal(runs, 1, "still within the limit");
  clock.t += 30_000;
  void r.due(true);
  await new Promise((res) => setImmediate(res));
  assert.equal(runs, 2);
  assert.match(lines[0] ?? "", /pack stuck: gave up on a refresh running 30 s/);
});

test("loadPacks: a folder's packs.ts, and a pack folder that won't load is named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-packs-"));
  writeFileSync(join(dir, "packs.ts"), `export default (env: Record<string, string | undefined>) => [{ manifest: { api: 1, id: "fromdisk", name: env.NAME, description: "", domain: "personal" } }];\n`);
  const { packs, failed } = await loadPacks(`${dir}, ${join(dir, "missing")}`, { NAME: "From disk" });
  assert.deepEqual(packs.map((c) => c.manifest.name), ["From disk"]);
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.why, /didn't load/);
});

test("before WP-M4: an instance's crates.ts, CRATES, CRATE_<ID>, createWorker({ crates }), dovre/crates/types.ts and a saved cratesOff still work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-old-instance-"));
  writeFileSync(join(dir, "crates.ts"), `export default [{ manifest: { api: 1, id: "old", name: "Old", description: "", domain: "personal" } }];\n`);
  assert.deepEqual((await loadPacks(dir, {})).packs.map((c) => c.manifest.id), ["old"], "a folder without packs.ts: its crates.ts");
  writeFileSync(join(dir, "packs.ts"), `export default [{ manifest: { api: 1, id: "new", name: "New", description: "", domain: "personal" } }];\n`);
  assert.deepEqual((await loadPacks(dir, {})).packs.map((c) => c.manifest.id), ["new"], "packs.ts wins");

  if (!process.env.PACKS && !process.env.CRATES) {
    assert.equal(loadEnv({ CRATES: "~/src/x" }).PACKS, "~/src/x");
    assert.equal(loadEnv({ CRATES: "~/src/x", PACKS: "~/src/y" }).PACKS, "~/src/y");
  }
  const two = [pack({ id: "my-app" }), pack({ id: "other" })];
  assert.deepEqual(activePacks(two, { env: { CRATE_MY_APP: "off" }, hosted: false, which: () => undefined }).on.map((c) => c.manifest.id), ["other"]);
  assert.deepEqual(activePacks(two, { env: { PACK_MY_APP: "on", CRATE_MY_APP: "off" }, hosted: false, which: () => undefined }).on.length, 2, "PACK_ wins");

  const old = await import("../src/crates/types.ts");
  assert.equal(old.CRATE_API, PACK_API);
  assert.equal((await import("../src/crates/registry.ts")).activeCrates, activePacks);
  assert.equal((await import("../src/crates/load.ts")).loadCrates, loadPacks);
  assert.equal(typeof (await import("../src/crates/testing.ts")).testContext, "function");
  assert.deepEqual(layoutOf({ cratesOff: ["health"] }), { packsOff: ["health"] });

  const seen: string[] = [];
  const worker = createWorker({ crates: [pack({ id: "legacy", execution: "any" }, { init: () => void seen.push("init") })] });
  await worker.fetch(new Request("https://dovre.example.dev/"), { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud" });
  assert.deepEqual(seen, ["init"]);

  const { get } = signedIn(snapshot(), {}, { packs: [pack({ id: "x" })] });
  const res = await get("/crates");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/packs");
});

/** Enough of D1 for the hosted app to start. */
function mockD1(): D1 {
  const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0, last_row_id: 0 } }) };
  return { prepare: () => stmt, batch: async () => [] } as unknown as D1;
}

test("createWorker: hosted packs get the bindings; cron, email and stale refreshes reach them", async () => {
  const seen: string[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const quill = pack(
    { id: "quill", execution: "hosted-only", requiredBindings: ["QUILL"] },
    {
      init: (c) => void seen.push(`init ${typeof c.bindings.QUILL}`),
      refresh: async () => void seen.push("refresh"),
      scheduled: async (e) => void seen.push(`cron ${e.cron}`),
      email: async (msg) => (seen.push(`mail ${(msg as { to: string }).to}`), true),
    },
  );
  const worker = createWorker({ packs: [quill] });
  const bindings = { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud", QUILL: { ops: () => 1 } };
  assert.equal((await worker.fetch(new Request("https://dovre.example.dev/"), bindings, ctx)).status, 404, "no Access token: nobody in");
  await Promise.all(pending);
  assert.ok(seen.includes("init object"), "init sees its bindings");
  assert.ok(seen.includes("refresh"), "a due refresh runs after the response");
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: 0 }, bindings, ctx);
  assert.ok(seen.includes("cron */5 * * * *"));
  let rejected = "";
  await worker.email({ to: "support@example.app", setReject: (r: string) => (rejected = r) } as never, bindings, ctx);
  assert.ok(seen.includes("mail support@example.app"));
  assert.equal(rejected, "");

  const none = createWorker({ packs: [] });
  await none.email({ setReject: (r: string) => (rejected = r) }, bindings, ctx);
  assert.match(rejected, /No one here/);
});

test("createWorker: POST /_dovre/scheduled runs the cron with the right CRON_KEY, else it's a 404", async () => {
  const seen: string[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const tick = pack({ id: "tick", execution: "any" }, { scheduled: async (e) => void seen.push(`cron ${e.cron}`) });
  const worker = createWorker({ packs: [tick] });
  const KEY = "k".repeat(40);
  const bindings = { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud", CRON_KEY: KEY };
  const call = (init: RequestInit, b: Partial<typeof bindings> = bindings) => worker.fetch(new Request("https://t.example.dev/_dovre/scheduled", init), b as typeof bindings, ctx);
  const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

  assert.equal((await call({ method: "POST" })).status, 404, "no key");
  assert.equal((await call({ method: "POST", headers: bearer("x".repeat(40)) })).status, 404, "wrong key");
  assert.equal((await call({ method: "GET", headers: bearer(KEY) })).status, 404, "GET");
  assert.equal((await call({ method: "POST", headers: bearer("short") }, { ...bindings, CRON_KEY: "short" })).status, 404, "a key under 32 characters keeps the route closed");
  const { CRON_KEY: _, ...noKey } = bindings;
  assert.equal((await call({ method: "POST", headers: bearer(KEY) }, noKey)).status, 404, "no CRON_KEY set");
  assert.equal(seen.length, 0);

  assert.equal((await call({ method: "POST", headers: bearer(KEY) }, { ...bindings, CF_ACCESS_AUD: "" })).status, 503, "not set up");

  const res = await call({ method: "POST", headers: { ...bearer(KEY), "x-dovre-cron": "*/5 * * * *" } });
  assert.equal(res.status, 204);
  assert.deepEqual(seen, ["cron */5 * * * *"]);
  await call({ method: "POST", headers: bearer(KEY) });
  assert.equal(seen[1], "cron http", "the default cron name");
  await Promise.all(pending);
});

test("createWorker: a start that never finishes (its request was cancelled) holds no page", async () => {
  const stuck = pack({ id: "stuck", execution: "any" }, { init: () => new Promise<void>(() => {}) });
  const worker = createWorker({ packs: [stuck] });
  const bindings = { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud" };
  const started = Date.now();
  assert.equal((await worker.fetch(new Request("https://dovre.example.dev/"), bindings)).status, 404, "answered (no Access token: nobody in)");
  assert.ok(Date.now() - started < 5000, "after a short wait, not never");
});

test("createWorker: what a request's work publishes after the response still reaches the hub", async () => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const heard: unknown[] = [];
  // A slow hub: each publish lands 30 ms after it's sent.
  const HUB = {
    idFromName: () => "hub",
    get: () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        await new Promise((r) => setTimeout(r, 30));
        if (String(input).endsWith("/publish")) heard.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      },
    }),
  };
  // The refresh ends after the response, and its end publishes "packs".
  const slow = pack({ id: "slow", execution: "hosted-only" }, { refresh: () => new Promise<void>((r) => setTimeout(r, 20)) });
  const worker = createWorker({ packs: [slow] });
  const bindings = { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud", HUB };
  await worker.fetch(new Request("https://dovre.example.dev/"), bindings, ctx);
  await Promise.all(pending);
  assert.ok(heard.some((b) => (b as { topics: string[] }).topics.includes("packs")), "the refresh's publish landed before the Worker was let go");
});

test("a pack's feed joins What's moving on Today; hostile text is inert and a javascript: link goes nowhere", async () => {
  const now = Date.now();
  const shop = pack(
    { id: "shop", name: "Shop" },
    {
      feed: () => [
        { key: "s1", at: now - 60_000, tone: "ok", what: "signed up", title: `Kari ${H}`, href: "javascript:alert(1)" },
        { key: "s2", at: now - 120_000, tone: "acc", what: `deployed ${H}`, app: "web", href: "/health" },
      ],
    },
  );
  const broken = pack({ id: "broken" }, { feed: () => { throw new Error("no memory"); } });
  const { get } = signedIn(snapshot(), {}, { packs: [shop, broken] });
  const today = await (await get("/")).text();
  const feed = today.match(/<aside class="card feed"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.match(feed, /What's moving/);
  assert.match(feed, /data-key="c:shop:s1"/);
  assert.match(feed, /<strong>web<\/strong> deployed/);
  assert.doesNotMatch(feed, /javascript:/);
  assertInert("pack feed", feed);
});

test("a pack's finds show in search under its name, hostile text inert, unsafe links and a pack that throws dropped; its refs link My list", async () => {
  const tracker: Pack = {
    manifest: { api: PACK_API, id: "tracker", name: "Tracker", description: "", domain: "work" },
    finds: () => [
      { title: `DEV-7 ${H}`, sub: H, href: "https://tracker.example/browse/DEV-7", also: ["DEV-7"] },
      { title: "Sneaky", href: "javascript:alert(1)" },
    ],
    refs: () => [{ pattern: /\bDEV-\d+\b/, href: (k) => `https://tracker.example/browse/${k}` }],
  };
  const broken: Pack = { manifest: { api: PACK_API, id: "broken", name: "Broken", description: "", domain: "work" }, finds: () => { throw new Error("no"); }, refs: () => { throw new Error("no"); } };
  const { get, post } = signedIn(snapshot(), {}, { packs: [tracker, broken] });
  const out = await (await get("/search?q=DEV-7")).text();
  assertInert("search", out);
  assert.match(out, /In your apps/);
  assert.match(out, /href="https:\/\/tracker\.example\/browse\/DEV-7"/);
  assert.match(out, /Tracker · /, "named after its pack");
  assert.doesNotMatch(await (await get("/search?q=Sneaky")).text(), /javascript:/);
  await post("/todo/add", { q: "Fix DEV-7 today" });
  assert.match(await (await get("/todo")).text(), /<a class="ref" href="https:\/\/tracker\.example\/browse\/DEV-7"[^>]*>DEV-7<\/a>/);
});

test("the Packs page: each pack on or off and why, what it answers, its refreshes; a secret setting only as set, never its value; hostile text inert", async () => {
  let fail = false;
  const health = pack(
    { id: "health", name: "Health", description: H, everyMs: 60_000, crons: ["0 5 * * *"], settings: [{ key: "CF_API_TOKEN", label: "Cloudflare token", secret: true, required: true }, { key: "CF_ACCOUNT_ID", label: H }, { key: "OPS_JOBS", label: "Jobs", help: H }] },
    { refresh: async () => { if (fail) throw new Error(`down ${H}`); }, feed: () => [], scheduled: async () => {} },
  );
  const off = pack({ id: "quill", name: "Quill", execution: "hosted-only", settings: [{ key: "QUILL_KEY", label: "Key", secret: true, required: true }] });
  const { app, get } = signedIn(snapshot(), {}, { packs: [health, off], packEnv: { CF_API_TOKEN: "sekrit-token-value", CF_ACCOUNT_ID: H } });
  const mounted = packsOf(app)!;
  let page = await (await get("/packs")).text();
  assertInert("packs page", page);
  assert.match(page, /href="\/packs" title="Packs"/, "in the menu");
  assert.match(page, /<meta name="u-topics" content="packs">/);
  assert.match(page, /3 on, 1 off · this machine/, "these two, and Dovre's own agents and terminal");
  assert.doesNotMatch(page, /sekrit-token-value/, "a secret's value is never shown");
  assert.match(page, /Cloudflare token <span class="pill ok">set<\/span>/);
  assert.match(page, /Key <span class="pill bad">missing, needed<\/span>/);
  assert.match(page, /runs only hosted/, "the off pack says why");
  assert.match(page, /<dd>feed, refresh, cron<\/dd>/);
  assert.match(page, /every 1 min · <span class="t3">not yet<\/span>/);
  assert.match(page, /<code>0 5 \* \* \*<\/code>/);

  const r = refresher(mounted.on, mounted.ctxOf, () => {}, { record: mounted.refreshes });
  await r.due(true);
  assert.match(await (await get("/packs")).text(), /<span class="pill ok">ok<\/span>/);
  fail = true;
  await r.due(true);
  page = await (await get("/packs")).text();
  assert.match(page, /<span class="pill bad">failed<\/span>/);
  assertInert("packs page, a failed refresh", page);
  assert.match(await (await get("/search?q=packs")).text(), /href="\/packs"/);
});

test("refreshLog: a refresh's start, end, time and failure, and a cron run; each end tells the page", () => {
  let told = 0;
  const log = refreshLog(() => told++);
  log.started("a", 1000);
  assert.equal(log.get("a")?.since, 1000);
  log.ended("a", 1250);
  assert.deepEqual(log.get("a"), { since: undefined, at: 1250, ms: 250, error: undefined });
  log.ended("a", 2000, "boom");
  assert.equal(log.get("a")?.error, "boom");
  log.cron("a", 3000);
  assert.equal(log.get("a")?.cronAt, 3000);
  assert.equal(told, 3);
});

test("Dovre's own packs (src/packs/core/) are reached only through the registry: nothing else in core imports them but the entry points", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const core = join(root, "packs", "core") + sep;
  const entry = new Set(["index.ts", "worker.ts", join("demo", "worker.ts")]);
  // Bino's engine sits in the assistant pack's folder (WP-M4) but is still wired by core (the dock,
  // the hub, Settings) until it goes through the Pack API: that one folder, and nothing else in it.
  const bino = join(core, "assistant", "bino") + sep;
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = relative(root, join(dir, e.name));
      if (e.isDirectory()) {
        if (rel !== join("packs", "core")) walk(join(dir, e.name));
      } else if (e.name.endsWith(".ts") && !entry.has(rel)) {
        const text = readFileSync(join(dir, e.name), "utf8");
        for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) if (resolve(dir, m[1]!).startsWith(core) && !resolve(dir, m[1]!).startsWith(bino)) bad.push(`${rel}: ${m[1]}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});

test("slots: each pack fills a core page's place; one that throws fills nothing, is logged, and the page still renders", async () => {
  const m = (id: string): PackManifest => ({ api: PACK_API, id, name: id, description: id, domain: "general" });
  const boom: Pack = {
    manifest: m("boom"),
    slots: () => {
      throw new Error("no slots today");
    },
  };
  const half: Pack = { manifest: m("half"), slots: () => ({ "pr.lead": () => { throw new Error("lead broke"); } }) };
  const ok: Pack = { manifest: m("ok"), slots: () => ({ "work.new": () => html`<p class="t3">from ok</p>`, "pr.lead": ({ repo }) => html`<span>${repo}</span>` }) };
  const logged: string[] = [];
  const fill = fillOf(() => [boom, half, ok], () => ({}) as never, (id, line) => logged.push(`${id}: ${line}`));
  assert.deepEqual(fill("pr.lead", { repo: H, number: 1, branch: "b", title: "t", url: "https://x" }).map(String), [`<span>${html`${H}`}</span>`]);
  assert.deepEqual(fill("pr.facts", { repo: "x", number: 1, branch: "b", title: "t", url: "https://x" }), []);
  assert.deepEqual(logged, ["boom: slot pr.lead: no slots today", "half: slot pr.lead: lead broke", "boom: slot pr.facts: no slots today"]);

  const { get } = signedIn(snapshot(), {}, { packs: [boom, ok] });
  const res = await get("/issues/new");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /from ok/);
  assert.equal((await get("/agents/new")).status, 200);
});

test("needs: each pack's, keyed under its id, cut to size, an unsafe link made harmless, a ring only of its own kinds; one that throws adds none", () => {
  const rings = ringsOf(
    [
      pack({ id: "shop", rings: [{ kind: "shop-down", label: `Shop is down ${H}` }, { kind: "deploy", label: "taken by the core" }, { kind: "Bad Kind", label: "x" }] }),
      pack({ id: "other", rings: [{ kind: "shop-down", label: "taken by shop" }] }),
    ],
    ["deploy"],
    () => {},
  );
  assert.deepEqual(rings.map((r) => `${r.pack}:${r.kind}`), ["shop:shop-down"], "the core's kinds, another pack's and odd ones refused");
  const shop = pack(
    { id: "shop" },
    {
      needs: () => [
        { key: "down", title: `Shop is down ${H}`, href: "javascript:alert(1)", tone: "bad", rank: -3, at: 5, ring: "shop-down" },
        { key: "slow", title: "Shop is slow", href: "/shop", tone: "nope" as never, at: 4, ring: "deploy" },
        { key: "x", title: "  ", href: "/", tone: "ok", at: 1 },
      ],
    },
  );
  const boom = pack({ id: "boom" }, { needs: () => { throw new Error("no needs"); } });
  const logged: string[] = [];
  const got = needsFrom([shop, boom], () => ({}) as never, rings, (id, line) => logged.push(`${id}: ${line}`));
  assert.deepEqual(got.map((n) => [n.key, n.ring, n.rank, n.href, n.tone, n.label]), [
    ["shop:down", "shop-down", 0, "#", "bad", "shop"],
    ["shop:slow", undefined, 2, "/shop", "neutral", "shop"],
  ], "an empty title dropped; a ring the pack didn't declare dropped");
  assert.deepEqual(logged, ["boom: needs: no needs"]);
});

test("banner: each pack's bar on every page, told the path; hostile text inert; one that throws leaves the page whole", async () => {
  const bar = pack({ id: "bar" }, { banner: (_ctx, { path }) => (path === "/prs" ? "" : html`<section class="approval"><h2>Bar asks ${H}</h2></section>`) });
  const boom = pack({ id: "boom" }, { banner: () => { throw new Error("no bar"); } });
  const { get } = signedIn(snapshot(), {}, { packs: [bar, boom] });
  const today = await (await get("/deploys")).text();
  assertInert("banner", today);
  assert.match(today, /<div data-live id="approvals"><section class="approval"><h2>Bar asks/);
  assert.doesNotMatch(await (await get("/prs")).text(), /Bar asks/, "the pack left that page out");
});

test("Today's briefing: each pack's numbers, sentence and horizon row; hostile text inert, links defused, cut to size; one that throws adds none", async () => {
  const now = Date.now();
  const shop = pack(
    { id: "shop", name: "Shop" },
    {
      glance: () => [{ label: `Sold ${H}`, value: H }, { label: "Carts", value: 3 }, { label: "Third", value: 9 }],
      brief: () => [`watch ${H} `, { text: `the till ${H}`, href: "javascript:alert(1)", tone: "bad" }, " for ", { text: "", href: "", code: H }, "."],
      lane: () => ({ label: `Orders ${H}`, legend: `Order ${H}`, marks: [{ at: now - 3600e3, size: 50, title: H }, { at: now, live: true, title: H }, { at: Number.NaN, title: "never drawn" }] }),
    },
  );
  const boom = pack({ id: "boom" }, { glance: () => { throw new Error("no"); }, brief: () => { throw new Error("no"); }, lane: () => { throw new Error("no"); } });
  const logged: string[] = [];
  const b = briefingFrom([shop, boom], () => ({}) as never, (id, line) => logged.push(`${id}: ${line}`));
  assert.deepEqual(b.glance.map((g) => g.label), [`Sold ${H}`.slice(0, 24), "Carts"], "two numbers a pack at most, labels cut");
  assert.equal(b.brief.length, 1);
  assert.equal(b.lanes.length, 1);
  assert.equal(b.lanes[0]!.marks.length, 2, "a mark without a time is left out");
  assert.deepEqual(logged.map((l) => l.split(":")[0]), ["boom", "boom", "boom"]);
  const { get } = signedIn(snapshot(), {}, { packs: [shop, boom] });
  const today = await (await get("/")).text();
  assertInert("briefing", today);
  assert.doesNotMatch(today, /javascript:/);
  assert.match(today, /<p class="lede">[^]*?Watch &lt;script&gt;[^]*?<a href="#" class="bad">the till[^]*?<code>&lt;script&gt;/, "the pack's sentence, capitalised, its link defused");
  assert.match(today, /<dt>Carts<\/dt><dd>3<\/dd>/);
  assert.doesNotMatch(today, /<dt>Third<\/dt>/);
  assert.equal((today.match(/class="hz-mark/g) ?? []).length, 2);
  assert.match(today, /<circle class="lg-mark"[^>]*><\/svg>Order &lt;script&gt;/, "its legend line");
});

test("a pack's finds with a kind go into search's own group (agents, code), without the pack's name, its icon cut short", async () => {
  const runner = pack({ id: "runner", name: "Runner" }, { finds: () => [{ kind: "agents", icon: `✦${H}`, title: `Agent ${H}`, sub: "busy", href: "/runner/a/1" }, { kind: "code", title: "wt-1", href: "/code/wt-1" }, { kind: "bogus" as never, title: "Odd one", href: "/runner/x" }] });
  const { get } = signedIn(snapshot(), {}, { packs: [runner] });
  const agents = await (await get(`/search?q=${encodeURIComponent("a: agent")}`)).text();
  assertInert("search kinds", agents);
  assert.match(agents, /id="pal-g-agents">Agents<\/p><a class="pal-row"[^>]*href="\/runner\/a\/1"><span class="pal-ic" aria-hidden="true">✦&lt;<\/span>/);
  assert.match(agents, /<span class="pal-s">busy<\/span>/, "not named after the pack");
  assert.match(await (await get(`/search?q=${encodeURIComponent("w: wt-1")}`)).text(), /href="\/code\/wt-1"/);
  assert.match(await (await get("/search?q=odd")).text(), /id="pal-g-apps">In your apps<\/p>[^]*<span class="pal-s">Runner<\/span>/, "an unknown kind is one of my apps");
});

test("ring: only a kind the pack declared and I have on; text cut, link made safe, tag under its id; nowhere to ring is quiet", () => {
  const bell = pack({ id: "bell", rings: [{ kind: "bell-done", label: "Done" }, { kind: "bell-quiet", label: "Quiet" }] });
  const rung: Note[] = [];
  const policy = { ...DEFAULT_POLICY, kinds: { ...DEFAULT_POLICY.kinds, "bell-quiet": false } };
  const env = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "t", CODE_DIR: "x", CLAUDE_DIR: "x", DB: openDb().DB };
  const notify = { policy: () => policy, setPolicy: async () => {}, log: () => [], test: () => {}, ring: (n: Note[]) => rung.push(...n) };
  const app = appWithAgents(env, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, notify, extra: [bell] });
  const mounted = packsOf(app)!;
  const ctx = mounted.ctxOf(mounted.on.find((c) => c.manifest.id === "bell")!);
  ctx.ring({ kind: "bell-done", title: `${H}${"x".repeat(300)}`, body: H, href: "javascript:alert(1)", tag: "t1" });
  ctx.ring({ kind: "bell-quiet", title: "Switched off", href: "/bell", tag: "t2" });
  ctx.ring({ kind: "agent-done", title: "Another pack's kind", href: "/bell", tag: "t3" });
  ctx.ring({ kind: "deploy", title: "The core's kind", href: "/bell", tag: "t4" });
  ctx.ring({ kind: "bell-done", title: "  ", href: "/bell", tag: "t5" });
  assert.equal(rung.length, 1);
  assert.equal(rung[0]!.title.length, 200);
  assert.equal(rung[0]!.kind, "bell-done");
  assert.equal(rung[0]!.tag, "bell:t1");
  assert.doesNotMatch(rung[0]!.url ?? "", /javascript/);
  const quiet = appWithAgents(env, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, extra: [bell] });
  const q = packsOf(quiet)!;
  q.ctxOf(q.on.find((c) => c.manifest.id === "bell")!).ring({ kind: "bell-done", title: "No notifier", href: "/", tag: "x" });
});

test("avatar and linked: summed and kept to size across the packs; troubles a line each, links only to this app; junk and a pack that throws add none", () => {
  const a = pack({ id: "a" }, { avatar: () => ({ working: 2.6, asking: -4, trouble: { level: "storm", why: `  2 red\n signals ${"x".repeat(200)}`, href: "/signals" } }), linked: () => ["https://acme.ghe.com/ACME/x/pull/1", "javascript:alert(1)", 7 as never, `https://acme.ghe.com/${"x".repeat(600)}`, "https://acme.ghe.com/ACME/x/pull/1"] });
  const b = pack({ id: "b" }, { avatar: () => ({ working: 1e9, asking: Number.NaN, trouble: { level: "fire", why: "burning", href: "//evil.example/x" } }) });
  const c = pack({ id: "c" }, { avatar: () => ({ trouble: { level: "flood" as never, why: "odd" } }) });
  const boom = pack({ id: "boom" }, { avatar: () => { throw new Error("no"); }, linked: () => { throw new Error("no"); } });
  const odd = pack({ id: "odd" }, { avatar: () => null, linked: () => "https://not-a-list" as never });
  const logged: string[] = [];
  const log = (id: string, line: string) => logged.push(`${id}: ${line}`);
  assert.deepEqual(avatarFrom([a, b, c, boom, odd], () => ({}) as never, log), { working: 3 + 99, asking: 0, trouble: [{ level: "storm", why: `2 red signals ${"x".repeat(66)}`, href: "/signals" }, { level: "fire", why: "burning" }] });
  assert.deepEqual(linkedFrom([a, b, boom, odd], () => ({}) as never, log), ["https://acme.ghe.com/ACME/x/pull/1"]);
  assert.deepEqual(logged, ["boom: avatar: no", "boom: linked: no"]);
  // On duty: one pack saying so is enough; anything but true says nothing.
  const duty = pack({ id: "duty" }, { avatar: () => ({ onDuty: true }) });
  const maybe = pack({ id: "maybe" }, { avatar: () => ({ onDuty: "yes" as never }) });
  assert.equal(avatarFrom([a, duty], () => ({}) as never, log).onDuty, true);
  assert.equal(avatarFrom([a, maybe], () => ({}) as never, log).onDuty, undefined);
});

test("beforePage: the core waits for the packs together, 1.5 s at most; one that throws or hangs leaves the page whole", async () => {
  let fresh = 0;
  const quick = pack({ id: "quick" }, { beforePage: async () => void fresh++ });
  const boom = pack({ id: "boom" }, { beforePage: async () => { throw new Error("no"); } });
  const stuck = pack({ id: "stuck" }, { beforePage: () => new Promise<void>(() => {}) });
  const { get } = signedIn(snapshot(), {}, { packs: [quick, boom, stuck] });
  const started = Date.now();
  assert.equal((await get("/prs")).status, 200);
  const took = Date.now() - started;
  assert.ok(took >= 1400 && took < 3000, `waited ${took} ms`);
  assert.equal(fresh, 1);
  const { get: plain } = signedIn(snapshot(), {}, { packs: [quick] });
  const t = Date.now();
  await plain("/prs");
  assert.ok(Date.now() - t < 1000, "nothing to wait for: no wait");
});

test("dock: a pack's button beside Bino's on every page but its own, cut to size, hostile text inert; its dock pages may be framed, others not; one that throws adds none", async () => {
  const chat = pack(
    { id: "chat" },
    {
      dock: () => ({ label: `Chat ${H} and much more than fits`, count: 1234.6, hot: true, title: `${H} new` }),
      routes: (app, ctx) => {
        app.get("/chat", (c) => ctx.page(c, { title: "Chat", body: "the chats" }));
        app.get("/chat/dock", (c) => ctx.dockPage(c, { title: "Chat", body: html`<p>docked ${H}</p>` }));
        app.get("/chat/other", (c) => c.text("not a dock"));
      },
      styles: ".chat-x { color: var(--ok); }",
    },
  );
  const quiet = pack({ id: "quiet" }, { dock: () => ({ label: "Quiet", count: -3 }), routes: (app) => app.get("/quiet/dock", (c) => c.text("q")) });
  const boom = pack({ id: "boom" }, { dock: () => { throw new Error("no dock"); } });
  const blank = pack({ id: "blank" }, { dock: () => ({ label: "  " }), routes: (app) => app.get("/blank/dock", (c) => c.text("b")) });
  const { get } = signedIn(snapshot(), {}, { packs: [chat, quiet, boom, blank] });
  const page = await (await get("/prs")).text();
  assertInert("a pack's dock", page);
  assert.match(page, /<div class="tdock" id="dock-chat" data-dock="\/chat\/dock" data-dock-title="Chat &lt;script&gt;x&lt;\/script&gt;&quot;">/, "its label, cut to 24");
  assert.match(page, /<a class="tdock-btn" id="dock-chat-btn" href="\/chat" aria-controls="dock-chat-panel"/);
  assert.match(page, /<span data-live id="dock-chat-n">[^]*?<b class="hot" title="[^"]*">@ 999<\/b>/, "the count kept to 999");
  assert.match(page, /<span data-live id="dock-quiet-n">Quiet<\/span>/, "no count, nothing hot");
  assert.doesNotMatch(page, /id="dock-boom"|id="dock-blank"/, "one that throws or has no label adds none");
  assert.doesNotMatch(await (await get("/chat")).text(), /id="dock-chat"/, "not on its own pages");

  const dock = await get("/chat/dock");
  const body = await dock.text();
  assertInert("a pack's dock page", body);
  assert.match(body, /<body class="dock-page">/);
  assert.match(body, /<link rel="stylesheet" href="\/assets\/packs\.[^"]+\.css">/, "the packs' styles");
  assert.equal(dock.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(dock.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  const other = await get("/chat/other");
  assert.match(other.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, "only its dock pages can be framed");
  assert.match((await get("/agents/dock")).headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, "nor a pack's without a dock");
});

test("callback: a pack's sign-in return answers before the sign-in check, on this machine only; a hidden, throwing or hosted one doesn't", async () => {
  const seen: boolean[] = [];
  const sso = pack(
    { id: "sso" },
    {
      callback: (c, _ctx, at) => (seen.push(at.signedIn), c.req.query("state") === "mine" ? c.text(`signed in ${H}`) : c.text("not mine", 400)),
      routes: (app, ctx) => app.get("/sso", (c) => ctx.page(c, { title: "SSO", body: "sso" })),
    },
  );
  const boom = pack({ id: "boomcb" }, { callback: () => { throw new Error("no state"); } });
  const { app, get, post } = signedIn(snapshot(), {}, { packs: [sso, boom] });
  const bare = (url: string) => app.request(url);
  const ok = await bare("http://localhost/sso/callback?state=mine&code=1");
  assert.equal(ok.status, 200, "no cookie: the pack answers");
  assert.equal(await ok.text(), `signed in ${H}`);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal((await bare("http://localhost/sso/callback?state=other")).status, 400, "the pack refuses what it didn't start");
  await get("/sso/callback?state=mine");
  assert.deepEqual(seen, [false, false, true], "told whether the browser is Dovre's");
  assert.equal((await bare("http://evil.example/sso/callback?state=mine")).status, 404, "not on another address");
  assert.equal((await bare("http://localhost/sso")).status, 404, "its other pages still need the cookie");
  assert.equal((await get("/sso")).status, 200, "and still mount");
  const thrown = await bare("http://localhost/boomcb/callback");
  assert.equal(thrown.status, 500);
  assert.doesNotMatch(await thrown.text(), /no state/, "what it threw stays in the log");
  assert.equal((await post("/settings/layout", { pack: "boomcb" })).status, 303, "only boomcb shown");
  assert.equal((await bare("http://localhost/sso/callback?state=mine")).status, 404, "hidden in Layout: gone");

  // Hosted, Access is in front of everything: no return skips it.
  let called = 0;
  const hosted = createWorker({ packs: [pack({ id: "sso", execution: "any" }, { callback: (c) => (called++, c.text("in")) })] });
  const pending: Promise<unknown>[] = [];
  const res = await hosted.fetch(new Request("https://dovre.example.dev/sso/callback?state=mine"), { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud" }, { waitUntil: (p: Promise<unknown>) => void pending.push(p) });
  await Promise.all(pending);
  assert.equal(res.status, 404);
  assert.equal(called, 0);
});

test("acts: each pack's kinds checked and cut to size, five a pack; a bad kind or one that throws is left out and logged", async () => {
  const logged: string[] = [];
  const log = (id: string, line: string) => logged.push(`${id}: ${line}`);
  const ok = { title: "A ticket", when: "When asked to file a ticket", button: "File", inputs: () => html`<input name="title">`, run: async () => ({ ok: true as const, done: "Filed" }) };
  const track = pack({ id: "track", name: "Track" }, {
    acts: () => [
      { ...ok, kind: "ticket", title: `T${"x".repeat(200)}`, fields: [{ name: "title", about: `what\u0000 it's about ${"y".repeat(300)}`, required: true, max: 99999 }, { name: "kind", about: "clashes" }, { name: "Bad Name", about: "dropped" }, { name: "body", about: "plain", text: true }] },
      { ...ok, kind: "ticket", fields: [{ name: "a", about: "a twice" }] },
      { ...ok, kind: "No Word", fields: [{ name: "a", about: "a" }] },
      { ...ok, kind: "nofields", fields: [] },
      { ...ok, kind: "norun", run: undefined as never, fields: [{ name: "a", about: "a" }] },
      { ...ok, kind: "sixth", fields: [{ name: "a", about: "a" }] },
    ],
  });
  const boom = pack({ id: "boom" }, { acts: () => { throw new Error("no acts"); } });
  const got = actsFrom([track, boom], () => testContext(), log);
  assert.deepEqual(got.map((k) => k.kind), ["track.ticket"], "only the good one; a sixth is past five");
  const k = got[0]!;
  assert.equal(k.title.length, 80);
  assert.equal(k.app, "Track");
  assert.deepEqual(k.fields.map((f) => f.name), ["title", "body"], "a field named kind or not a word is dropped");
  assert.equal(k.fields[0]!.max, 4000);
  assert.equal(k.fields[0]!.about.length, 160);
  assert.doesNotMatch(k.fields[0]!.about, /\u0000/);
  assert.equal(k.oneClick, false, "two clicks unless it says one");
  assert.match(k.question, /^Tx+\?$/);
  assert.ok(logged.some((l) => l.startsWith("boom: acts: no acts")));
  assert.equal(logged.filter((l) => l.includes("left out")).length, 4);
});

test("acts with Bino: a pack's block becomes its card, two clicks; run on my press only, in the background, how it went shown; hostile text inert", async () => {
  const fence = (o: unknown) => `\`\`\`bino-act\n${JSON.stringify(o)}\n\`\`\``;
  const runs: { form: Record<string, string>; act: Record<string, string> }[] = [];
  let fail: "throw" | "refuse" | undefined = "refuse";
  const track = pack({ id: "track", name: `Track ${H}` }, {
    acts: () => [{
      kind: "ticket",
      title: `A ticket ${H}`,
      when: "When the user asks to file a ticket",
      fields: [{ name: "title", about: "one line", required: true }, { name: "body", about: "plain text", text: true, max: 50 }],
      button: "File it",
      hint: `Goes to Track ${H}`,
      inputs: (act, kept) => html`<label class="field"><span class="label">Title</span><input type="text" name="title" value="${kept?.title ?? act.title ?? ""}"></label><p>${H}</p>`,
      run: async (form, act) => {
        runs.push({ form, act });
        if (fail === "throw") throw new Error("track is down: secret-detail");
        if (fail === "refuse") return { ok: false, error: `Track said no ${H}` };
        return { ok: true, done: `Filed ${H}`, href: "javascript:alert(1)" };
      },
    }],
  });
  const reply = `Here.\n${fence({ kind: "track.ticket", title: `Fix it ${H}`, body: "b".repeat(100), extra: "dropped" })}\n${fence({ kind: "track.ticket", body: "no title" })}\n${fence({ kind: "other.thing", a: "1" })}`;
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: reply, cost: 0 }) };
  const env = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
  const app = createApp({ ...env, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") }, packs: { ...activePacks([track], { env: {}, hosted: false }), env: {} } });
  const req = (path: string, body?: Record<string, string>) =>
    app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: new URLSearchParams(body).toString() });
  const until = async (at: string, re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const page = await (await req(at)).text();
      if (re.test(page)) return page;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${re}`);
  };
  const at = (await req("/bino/new", { text: "File a ticket" })).headers.get("location")!;
  const page = await until(at, /File it…/);
  assertInert("a pack's act card", page);
  assert.match(asked[0]!.system, /From Track [^\n]*: When the user asks to file a ticket \(needs title\)/, "Bino is told the kind");
  assert.match(asked[0]!.system, /\{"kind":"track\.ticket","title":"one line","body":"plain text"\}/);
  assert.equal((page.match(/<form method="post" action="\/bino\/c\/[^"]+\/act\//g) ?? []).length, 1, "the block without its title and the unknown kind give no card");
  assert.match(page, /<details class="confirm"><summary>File it…<\/summary><div class="confirm-body"><p>A ticket /, "two clicks");
  assert.equal(runs.length, 0, "nothing runs before the press");

  await req(`${at}/act/1/0`, { title: "Typed by me", junk_: "x", "Bad Name": "y" });
  await until(at, /Not done\.<\/strong> Track said no/);
  assert.deepEqual(runs[0]!.form, { title: "Typed by me", junk_: "x" }, "the form's fields, names that are words");
  assert.deepEqual(runs[0]!.act, { title: `Fix it ${H}`, body: "b".repeat(50) }, "Bino's, checked: cut to max, extras dropped");
  assert.match(await (await req(at)).text(), /value="Typed by me"/, "a refusal keeps what I typed");

  fail = "throw";
  await req(`${at}/act/1/0`, { title: "again" });
  const thrown = await until(at, /didn&#39;t go through|didn't go through/);
  assert.doesNotMatch(thrown, /secret-detail/, "what it threw stays in the log");

  fail = undefined;
  await req(`${at}/act/1/0`, { title: "last" });
  const done = await until(at, /Filed /);
  assertInert("a done act", done);
  assert.doesNotMatch(done, /javascript:/, "its link made harmless");
  await req(`${at}/act/1/0`, { title: "once more" });
  assert.equal(runs.length, 3, "a done act doesn't run again");

  await req(`${at}/say`, { text: "Thanks" });
  await until(at, /Thanks/);
  const last = asked.at(-1)!;
  assert.match(last.user, /"kind":"track\.ticket","title":"Fix it[^\n]*\n```\s*\(done\)/, "Bino hears its own proposal, and that it was done");
  assert.doesNotMatch(last.user, /Typed by me|once more/, "not what I typed");
});

test("the work slots and Settings: a deploy's prod line, My list's proposals, a name on the actions log, a pack's panel; hostile text inert, one that throws adds none", async () => {
  const work = pack({ id: "work", name: `Work ${H}` }, {
    slots: () => ({
      "deploy.prod": ({ repo }) => html`<span class="t3">prod for ${repo}: v1 ${H}</span>`,
      "todo.proposals": () => html`<section class="panel"><p>Proposed ${H}</p></section>`,
      "actions.where": ({ kind, target }) => (kind === "work.file" ? `ticket ${target.slice(7)} ${H}\nsecond line${"x".repeat(300)}` : undefined),
    }),
    settings: () => html`<p>Signed in as ${H}</p><form method="post" action="/work/signout"><button type="submit">Sign out</button></form>`,
  });
  const quiet = pack({ id: "quiet" }, { slots: () => ({ "actions.where": () => "" }), settings: () => "" });
  const boom = pack({ id: "boom" }, {
    slots: () => { throw new Error("no slots"); },
    settings: () => { throw new Error("no panel"); },
  });
  const { get, db } = signedIn(snapshot({ deploys: { ok: true, value: [deploy()] } }), {}, { packs: [quiet, boom, work] });
  await logAction(db.DB, { kind: "work.file", target: "ticket DEV-12", ok: true });
  await logAction(db.DB, { kind: "deploy.approve", target: "ACME/people 3f59045", ok: true });

  const deploys = await (await get("/deploys")).text();
  assertInert("a deploy's prod line", deploys);
  assert.match(deploys, /prod for ACME\/people: v1/);

  const todo = await (await get("/todo")).text();
  assertInert("My list's proposals", todo);
  assert.match(todo, /<p>Proposed /);

  const actions = await (await get("/actions")).text();
  assertInert("the actions log", actions);
  assert.match(actions, /ticket DEV-12 &lt;script&gt;/, "the pack names its entry; quiet's empty answer doesn't count");
  assert.doesNotMatch(actions, /\nsecond line/, "one line");
  assert.doesNotMatch(actions, /x{200}/, "cut to 120");
  assert.match(actions, /ACME\/people 3f59045/, "an entry no pack names stays as logged");
  assert.match(await (await get("/")).text(), /ticket DEV-12 &lt;script&gt;/, "on Today's card too");

  const settings = await (await get("/settings")).text();
  assertInert("a pack's Settings panel", settings);
  assert.match(settings, /id="pack-work"[^]*?Work &lt;script&gt;[^]*?Signed in as [^]*?action="\/work\/signout"/);
  assert.doesNotMatch(settings, /id="pack-(quiet|boom)"/, "nothing to show, or a throw: no panel");
});

test("POST /packs/:id/settings: configures pack settings in .dev.vars, transitions off->on live, and never leaks secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-pack-vars-"));
  const varsFile = join(dir, ".dev.vars");
  let inited = 0;
  let refreshed = 0;
  const linear = pack(
    {
      id: "linear",
      name: "Linear",
      settings: [
        { key: "LINEAR_API_KEY", label: `API Key ${H}`, secret: true, required: true, help: `Create on Linear ${H}` },
        { key: "LINEAR_TEAM", label: "Team key", help: "e.g. ENG" },
      ],
    },
    {
      init: () => {
        inited++;
      },
      refresh: async () => {
        refreshed++;
      },
      routes: (app, ctx) => {
        app.get("/linear", (c) => ctx.page(c, { title: "Linear", body: html`<p>Team: ${ctx.env.LINEAR_TEAM ?? "all"}</p>` }));
      },
    },
  );

  const { get, post, app } = signedIn(snapshot(), {}, { packs: [linear], varsFile });

  // Initially off because LINEAR_API_KEY isn't set; /linear is 404; form is open on /packs
  assert.equal((await get("/linear")).status, 404);
  const before = await (await get("/packs")).text();
  assertInert("packs page before", before);
  assert.match(before, /LINEAR_API_KEY isn&#39;t set|LINEAR_API_KEY isn't set/);
  assert.match(before, /action="\/packs\/linear\/settings"/);

  // Strict-origin guard: cross-origin is 403, cross-site sec-fetch-site is 404
  const crossOrigin = await app.request("http://localhost/packs/linear/settings", {
    method: "POST",
    headers: { cookie: "u_tk=test-token", origin: "https://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await app.request("http://localhost/packs/linear/settings", {
    method: "POST",
    headers: { cookie: "u_tk=test-token", "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 404);

  // Save settings: activates pack in-place, writes .dev.vars, runs init + refresh, mounts /linear
  const saveRes = await post("/packs/linear/settings", {
    LINEAR_API_KEY: "lin_api_secret_12345",
    LINEAR_TEAM: `ENG-${H}`,
  });
  assert.equal(saveRes.status, 303);
  assert.equal(saveRes.headers.get("location"), "/packs#pack-linear");
  assert.equal(inited, 1);
  assert.equal(refreshed, 1);

  const varsText = readFileSync(varsFile, "utf8");
  assert.match(varsText, /LINEAR_API_KEY=lin_api_secret_12345/);
  assert.match(varsText, /LINEAR_TEAM=ENG-/);

  // Secret value never appears on /packs, non-secret value is escaped, and /linear route is now live
  const after = await (await get("/packs")).text();
  assertInert("packs page after", after);
  assert.doesNotMatch(after, /lin_api_secret_12345/, "secret value never rendered to DOM");
  assert.match(after, /\(set — leave blank to keep\)/);
  assert.equal((await get("/linear")).status, 200);

  // Updating non-secret while leaving secret blank preserves the secret
  await post("/packs/linear/settings", { LINEAR_API_KEY: "", LINEAR_TEAM: "PLATFORM" });
  assert.match(readFileSync(varsFile, "utf8"), /LINEAR_API_KEY=lin_api_secret_12345/);
  assert.match(readFileSync(varsFile, "utf8"), /LINEAR_TEAM=PLATFORM/);
  assert.equal(refreshed, 2);

  // Clearing the required secret transitions the pack back to off and gates /linear with 404
  await post("/packs/linear/settings", { "clear.LINEAR_API_KEY": "1", LINEAR_TEAM: "PLATFORM" });
  assert.doesNotMatch(readFileSync(varsFile, "utf8"), /LINEAR_API_KEY=/);
  assert.equal((await get("/linear")).status, 404);
});

test(".dev.vars writes keep a value exactly, even with $& or $' in it, and remove only their own line", async () => {
  const { upsertDevVar, removeDevVar } = await import("../src/setup.ts");
  const file = join(mkdtempSync(join(tmpdir(), "devvars-")), ".dev.vars");
  writeFileSync(file, "A_KEY=old\nB_KEY=keep\n");
  upsertDevVar(file, "A_KEY", "p$&w$'d$`x$1");
  assert.equal(readFileSync(file, "utf8"), "A_KEY=p$&w$'d$`x$1\nB_KEY=keep\n");
  removeDevVar(file, "A_KEY");
  assert.equal(readFileSync(file, "utf8"), "B_KEY=keep\n");
});
