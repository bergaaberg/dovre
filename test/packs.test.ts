/**
 * Packs (src/packs/, PLAN D23): which run where, and the core's side of each hook — mounted under
 * their own path, isolated, time-boxed, escaped — locally and in the Worker.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { html } from "hono/html";
import { loadPacks } from "../src/packs/load.ts";
import { buildAssets } from "../src/packs/assets.ts";
import { sha16 } from "../src/packs/wasm.ts";
import { activePacks, binoOf, heldOff, initAll, pulseFrom, actsFrom, briefingFrom, docksFrom, fillOf, linkedFrom, needsFrom, refreshLog, refresher, ringsOf, settleRequires, TAKEN_KEYS, whatFrom, within } from "../src/packs/registry.ts";
import { createApp, packsOf } from "../src/app.ts";
import { noMemory } from "../src/packs/core/assistant/bino/memory.ts";
import type { Route } from "../src/packs/core/assistant/bino/route.ts";
import { packApp, testContext } from "../src/packs/testing.ts";
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
import { currentViewer } from "../src/viewer.ts";

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

test("requires (#326): a pack is off while a pack it requires is, starts after it, and comes back with it; a loop stays off", () => {
  const ids = (xs: Pack[]) => xs.map((c) => c.manifest.id);
  const list = [
    pack({ id: "review", name: "Review", requires: ["agents", "agents", "review", 7 as unknown as string] }),
    pack({ id: "agents", name: "Agents" }),
    pack({ id: "chain", requires: ["review"] }),
    pack({ id: "ghost", requires: ["nowhere"] }),
    pack({ id: "ping", requires: ["pong"] }),
    pack({ id: "pong", requires: ["ping"] }),
  ];
  const all = activePacks(list, { env: {}, hosted: false });
  assert.deepEqual(ids(all.on), ["agents", "review", "chain"], "each after what it requires; a repeat, itself and junk ignored");
  const why = Object.fromEntries(all.off.map((o) => [o.id, o.why]));
  assert.match(why.ghost!, /needs the nowhere pack, which isn't installed/);
  assert.match(why.ping!, /can't run either/);
  assert.match(why.pong!, /can't run either/);

  const off = activePacks(list, { env: { PACK_AGENTS: "off" }, hosted: false });
  assert.deepEqual(ids(off.on), []);
  assert.match(off.off.find((o) => o.id === "review")!.why, /needs Agents, which is off/);
  assert.match(off.off.find((o) => o.id === "chain")!.why, /needs Review, which can't run either/, "a chain falls together");

  // Agents comes on later (its settings saved): what was off only for want of it comes back, in order.
  const agents = list[1]!;
  off.off.splice(off.off.findIndex((o) => o.id === "agents"), 1);
  off.on.push(agents);
  const back = settleRequires(off);
  assert.deepEqual(ids(back).sort(), ["chain", "review"]);
  assert.deepEqual(ids(off.on), ["agents", "review", "chain"]);
  assert.ok(off.off.some((o) => o.id === "ping"), "a loop stays off");
});

test("requires (#326): a required pack that fails to start takes what requires it off, unstarted", async () => {
  const started: string[] = [];
  const init = (id: string, fail = false) => async () => {
    if (fail) throw new Error("no");
    started.push(id);
  };
  const a = activePacks([pack({ id: "review", requires: ["agents"] }, { init: init("review") }), pack({ id: "agents" }, { init: init("agents", true) }), pack({ id: "other" }, { init: init("other") })], { env: {}, hosted: false });
  await initAll(a, () => testContext(), () => {});
  assert.deepEqual(started, ["other"]);
  assert.deepEqual(a.on.map((c) => c.manifest.id), ["other"]);
  assert.match(a.off.find((o) => o.id === "review")!.why, /needs agents, which is off/);
});

test("requires (#326): switched off on the Packs page, what requires it is off too: no refresh, its pages 404, and the page says why", async () => {
  let refreshed = 0;
  const agents = pack({ id: "helper", name: "Helper" }, { refresh: async () => {} });
  const review = pack({ id: "review", name: "Review", requires: ["helper"] }, { refresh: async () => { refreshed++; }, routes: (r) => { r.get("/review", (c) => c.text("hi")); } });
  assert.deepEqual([...heldOff([agents, review], ["helper"])], [["helper", "helper"], ["review", "helper"]]);
  const { app, get, post } = signedIn(snapshot(), {}, { packs: [review, agents] });
  const mounted = packsOf(app)!;
  assert.equal((await get("/review")).status, 200);
  let page = await (await get("/packs")).text();
  assert.match(page, /<dt>Requires<\/dt><dd>Helper<\/dd>/);
  await post("/packs/helper/switch", { on: "" });
  assert.equal((await get("/review")).status, 404);
  await refresher(mounted.on, mounted.ctxOf, () => {}, { skip: mounted.hidden }).due(true);
  assert.equal(refreshed, 0);
  page = await (await get("/packs")).text();
  assert.match(page, /needs Helper, which is switched off here/);
  assert.doesNotMatch(page, /action="\/packs\/review\/switch"/, "its own switch can't turn it on");
  await post("/packs/helper/switch", { on: "1" });
  assert.equal((await get("/review")).status, 200);
});

test("requires (#326): a pack reads what a pack it requires shares, only that one, only while it's on, and a share that throws is nothing", async () => {
  const auto = { prs: async () => [], run: async () => undefined, limits: async () => ({ on: true, runUsd: 5, dayUsd: 20, minutes: 60 }), fix: async () => ({ wait: "" }), land: async () => ({ wait: "" }) };
  const agents = pack({ id: "helper", name: "Helper" }, { shares: () => ({ auto }) });
  const broken = pack({ id: "broken" }, { shares: () => { throw new Error("no"); } });
  const review = pack({ id: "review", requires: ["helper", "broken"] });
  const nosy = pack({ id: "nosy" });
  const { app, post } = signedIn(snapshot(), {}, { packs: [review, nosy, agents, broken] });
  const { ctxOf } = packsOf(app)!;
  assert.equal(ctxOf(review).required("helper", "auto"), auto);
  assert.equal(ctxOf(review).required("broken", "auto"), undefined);
  assert.equal(ctxOf(nosy).required("helper", "auto"), undefined, "not in its requires");
  assert.equal(ctxOf(review).required("nowhere", "auto"), undefined);
  await post("/packs/helper/switch", { on: "" });
  assert.equal(ctxOf(review).required("helper", "auto"), undefined, "switched off on the Packs page");
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

test("a pack's WebAssembly: served at a hashed path its ctx names; pages may compile it only while one ships any", async () => {
  const EMPTY = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const canary = pack(
    { id: "canary" },
    {
      wasm: { diff: EMPTY, Bad_Name: EMPTY, notwasm: new TextEncoder().encode("<script>alert(1)</script>"), big: Object.assign(new Uint8Array(8 * 1024 * 1024 + 1), EMPTY) },
      routes: (app, ctx) => app.get("/canary", (c) => ctx.page(c, { title: "Canary", body: html`<p id="w">${ctx.wasm("diff") ?? "none"}|${ctx.wasm("Bad_Name") ?? "none"}|${ctx.wasm("notwasm") ?? "none"}|${ctx.wasm("big") ?? "none"}|${ctx.wasm("nope") ?? "none"}</p>` })),
    },
  );
  const { get } = signedIn(snapshot(), {}, { packs: [canary] });
  const res = await get("/canary");
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /script-src 'self' 'wasm-unsafe-eval'/);
  const [path, ...rest] = (await res.text()).match(/<p id="w">([^<]*)<\/p>/)![1]!.split("|");
  assert.match(path!, /^\/assets\/wasm\/canary\.diff\.[a-z0-9]+\.wasm$/);
  assert.deepEqual(rest, ["none", "none", "none", "none"], "a bad name, bytes that aren't WebAssembly, an oversized module and an unknown name aren't served");
  const wasm = await get(path!);
  assert.equal(wasm.headers.get("Content-Type"), "application/wasm");
  assert.match(wasm.headers.get("Cache-Control") ?? "", /immutable/);
  assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), EMPTY);

  const plain = signedIn(snapshot(), {}, { packs: [pack({ id: "plain" })] });
  const csp = (await plain.get("/")).headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /wasm-unsafe-eval/, "no pack ships WebAssembly: pages can't compile any");
});

test("a pack's WebAssembly file: locally loaded on first use and checked; hosted served from the static assets the build wrote", async () => {
  const MOD = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 7]);
  const sha = await sha16(MOD);
  let loads = 0;
  const files = pack(
    { id: "big", execution: "any" },
    {
      wasm: {
        tree: { sha256: sha, load: () => (loads++, MOD) },
        stale: { sha256: "0123456789abcdef", load: () => MOD },
        broken: { sha256: sha, load: () => { throw new Error("no file"); } },
        noSha: { sha256: "<script>", load: () => MOD } as never,
      },
      routes: (app, ctx) => app.get("/big", (c) => c.text(["tree", "stale", "broken", "noSha"].map((n) => ctx.wasm(n) ?? "none").join("|"))),
    },
  );
  const { get } = signedIn(snapshot(), {}, { packs: [files] });
  const res = await get("/big");
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /'wasm-unsafe-eval'/);
  const [tree, stale, broken, noSha] = (await res.text()).split("|");
  assert.equal(tree, `/assets/wasm/big.tree.${sha}.wasm`, "the path names the hash the pack declares, known before anything is read");
  assert.equal(noSha, "none", "a sha256 that isn't 16 hex digits isn't served");
  assert.equal(loads, 0, "nothing is read until asked for");
  const got = await get(tree!);
  assert.equal(got.headers.get("Content-Type"), "application/wasm");
  assert.match(got.headers.get("Cache-Control") ?? "", /immutable/);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), MOD);
  await get(tree!);
  assert.equal(loads, 1, "read once");
  assert.equal((await get(stale!)).status, 404, "bytes that don't match the declared hash aren't served");
  assert.equal((await get(broken!)).status, 404, "a load that throws is a 404");

  // Hosted: never calls load; asks the static assets for the same path.
  const asked: string[] = [];
  const db = openDb();
  const hosted = createApp({ GHE_HOST: "github.com", GITHUB_USER: "me", IS_HOSTED: "1", ALLOWED_EMAILS: "me@example.com", PUBLIC_ORIGIN: "https://dovre.example", DB: db.DB } as never, {
    gatherer: fixedGatherer(snapshot()),
    ghe: fakeGhe({}).ghe,
    access: async () => ({ email: "me@example.com" }),
    packs: {
      ...activePacks([files], { env: {}, bindings: {}, hosted: true }),
      env: {},
      bindings: { ASSETS: { fetch: async (r: Request) => (asked.push(new URL(r.url).pathname), new URL(r.url).pathname.endsWith(`${sha}.wasm`) ? new Response(MOD) : new Response("", { status: 404 })) } },
    },
  });
  const h = await hosted.request(`https://dovre.example${tree}`);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("Content-Type"), "application/wasm");
  assert.deepEqual(new Uint8Array(await h.arrayBuffer()), MOD);
  assert.deepEqual(asked, [`/wasm/big.tree.${sha}.wasm`]);
  assert.equal(loads, 1, "hosted never calls load");
});

test("the hosted assets build: Dovre's own files plus each pack's WebAssembly files, checked; one that fails stops it, naming it", async () => {
  const MOD = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9]);
  const sha = await sha16(MOD);
  const root = mkdtempSync(join(tmpdir(), "assets-"));
  const core = join(root, "core");
  mkdirSync(join(core, "fonts"), { recursive: true });
  writeFileSync(join(core, "icon.svg"), "<svg/>");
  writeFileSync(join(core, "fonts", "f.woff2"), "f");
  const out = join(root, "out");
  mkdirSync(out);
  writeFileSync(join(out, "old.txt"), "gone");
  const good = pack({ id: "big" }, { wasm: { tree: { sha256: sha, load: async () => MOD }, inline: MOD } });
  assert.deepEqual(await buildAssets({ packs: [good], out, core }), [`wasm/big.tree.${sha}.wasm`]);
  assert.deepEqual(readdirSync(out).sort(), ["fonts", "icon.svg", "wasm"], "written afresh: the old file is gone; inline bytes stay in the bundle");
  assert.deepEqual(new Uint8Array(readFileSync(join(out, "wasm", `big.tree.${sha}.wasm`))), MOD);
  const stale = pack({ id: "old" }, { wasm: { tree: { sha256: "0123456789abcdef", load: () => MOD } } });
  await assert.rejects(buildAssets({ packs: [good, stale], out, core }), /pack old: wasm tree has SHA-256 [0-9a-f]{16}, not the 0123456789abcdef it declares \(rebuild the pack\)/);
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
      scheduled: async (e) => void seen.push(`cron ${e.cron} as ${currentViewer()}`),
      email: async (msg) => (seen.push(`mail ${(msg as { to: string }).to}`), true),
    },
  );
  const worker = createWorker({ packs: [quill] });
  const bindings = { DB: mockD1(), IS_HOSTED: "1", CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud", ALLOWED_EMAILS: " Me@Example.dev , other@example.dev", QUILL: { ops: () => 1 } };
  assert.equal((await worker.fetch(new Request("https://dovre.example.dev/"), bindings, ctx)).status, 404, "no Access token: nobody in");
  await Promise.all(pending);
  assert.ok(seen.includes("init object"), "init sees its bindings");
  assert.ok(seen.includes("refresh"), "a due refresh runs after the response");
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: 0 }, bindings, ctx);
  // The cron acts as the instance's owner: it sees what their pages see (their paired machines).
  assert.ok(seen.includes("cron */5 * * * * as me@example.dev"), seen.join(" | "));
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
      pack({ id: "shop", rings: [{ kind: "shop-down", label: `Shop is down ${H}` }, { kind: "shop-drift", label: "Drift", off: true }, { kind: "deploy", label: "taken by the core" }, { kind: "Bad Kind", label: "x" }] }),
      pack({ id: "other", rings: [{ kind: "shop-down", label: "taken by shop" }] }),
    ],
    ["deploy"],
    () => {},
  );
  assert.deepEqual(rings.map((r) => `${r.pack}:${r.kind}${r.off ? " (off)" : ""}`), ["shop:shop-down", "shop:shop-drift (off)"], "the core's kinds, another pack's and odd ones refused; one may start off");
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

test("a pack's ring that starts off shows unchecked on Settings → Notifications; the others checked", async () => {
  const shop = pack({ id: "shop", rings: [{ kind: "shop-down", label: "Shop is down" }, { kind: "shop-drift", label: "Shop drifts", off: true }] });
  const { get } = signedIn(snapshot(), {}, { packs: [shop] });
  const body = await (await get("/settings/notifications")).text();
  assert.match(body, /value="shop-down" checked> Shop is down/);
  assert.match(body, /value="shop-drift"> Shop drifts/);
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

test("pulse and linked: summed and kept to size across the packs; troubles a line each, links only to this app; junk and a pack that throws add none", () => {
  const a = pack({ id: "a" }, { pulse: () => ({ working: 2.6, asking: -4, trouble: { level: "storm", why: `  2 red\n signals ${"x".repeat(200)}`, href: "/signals" } }), linked: () => ["https://acme.ghe.com/ACME/x/pull/1", "javascript:alert(1)", 7 as never, `https://acme.ghe.com/${"x".repeat(600)}`, "https://acme.ghe.com/ACME/x/pull/1"] });
  const b = pack({ id: "b" }, { pulse: () => ({ working: 1e9, asking: Number.NaN, trouble: { level: "fire", why: "burning", href: "//evil.example/x" } }) });
  const c = pack({ id: "c" }, { pulse: () => ({ trouble: { level: "flood" as never, why: "odd" } }) });
  const boom = pack({ id: "boom" }, { pulse: () => { throw new Error("no"); }, linked: () => { throw new Error("no"); } });
  const odd = pack({ id: "odd" }, { pulse: () => null, linked: () => "https://not-a-list" as never });
  const logged: string[] = [];
  const log = (id: string, line: string) => logged.push(`${id}: ${line}`);
  assert.deepEqual(pulseFrom([a, b, c, boom, odd], () => ({}) as never, log), { working: 3 + 99, asking: 0, trouble: [{ level: "storm", why: `2 red signals ${"x".repeat(66)}`, href: "/signals" }, { level: "fire", why: "burning" }] });
  assert.deepEqual(linkedFrom([a, b, boom, odd], () => ({}) as never, log), ["https://acme.ghe.com/ACME/x/pull/1"]);
  assert.deepEqual(logged, ["boom: pulse: no", "boom: linked: no"]);
  // On duty: one pack saying so is enough; anything but true says nothing.
  // The old name (`avatar`) still counts; with both, `pulse` is read.
  const duty = pack({ id: "duty" }, { avatar: () => ({ onDuty: true }) });
  const both = pack({ id: "both" }, { pulse: () => ({ working: 1 }), avatar: () => ({ working: 50 }) });
  assert.equal(pulseFrom([both], () => ({}) as never, log).working, 1);
  const maybe = pack({ id: "maybe" }, { pulse: () => ({ onDuty: "yes" as never }) });
  assert.equal(pulseFrom([a, duty], () => ({}) as never, log).onDuty, true);
  assert.equal(pulseFrom([a, maybe], () => ({}) as never, log).onDuty, undefined);
});

test("script and pulse: the packs' scripts in one file after the core's, a block each, on pages and dock pages; none without one; ctx.pulse sums the shown packs", async () => {
  const seen: unknown[] = [];
  const glow = pack(
    { id: "glow" },
    {
      script: `document.addEventListener("dovre:change", () => {});`,
      routes: (app, ctx) => {
        app.get("/glow/dock", (c) => ctx.dockPage(c, { title: "Glow", body: "docked" }));
        app.get("/glow/pulse", (c) => c.json(ctx.pulse()));
      },
      pulse: (ctx) => (seen.push(ctx.pulse()), { asking: 2 }),
    },
  );
  const busy = pack({ id: "busy" }, { pulse: () => ({ working: 1, trouble: { level: "storm", why: "1 red signal" } }), script: "let n = 1;" });
  const { get } = signedIn(snapshot(), {}, { packs: [glow, busy] });
  const page = await (await get("/prs")).text();
  const src = page.match(/<script type="module" src="\/assets\/app\.[^"]+\.js"><\/script>\n<script type="module" src="(\/assets\/packs\.[0-9a-z]+\.js)"><\/script>/)?.[1];
  assert.ok(src, "linked right after the core's");
  const js = await get(src);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(js.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(await js.text(), `// glow\n{\ndocument.addEventListener("dovre:change", () => {});\n}\n// busy\n{\nlet n = 1;\n}`);
  assert.match(await (await get("/glow/dock")).text(), new RegExp(`<script type="module" src="${src.replace(/\./g, "\\.")}">`), "dock pages too");
  assert.deepEqual(await (await get("/glow/pulse")).json(), { working: 1, asking: 2, trouble: [{ level: "storm", why: "1 red signal" }], busy: true });
  assert.deepEqual(seen.at(-1), { working: 0, asking: 0, trouble: [], busy: false }, "a pack reading the pulse from its own pulse gets nothing back");
  assert.doesNotMatch(await (await signedIn(snapshot(), {}, { packs: [pack({ id: "plain" })] }).get("/prs")).text(), /assets\/packs\.[^"]+\.js/, "no pack script: none linked");
});

test("forge and startPicture: a pack reads the forge as me, in the owners' repos; its picture goes to the starting page, if it's an SVG and not too big", async () => {
  const asked: string[] = [];
  const work = { merged: 1, reviewed: 2, days: [], commits: [], languages: {} };
  const reader = pack(
    { id: "reader" },
    {
      routes: (app, ctx) => {
        app.get("/reader", async (c) => {
          const f = ctx.forge();
          ctx.startPicture("<svg viewBox='0 0 1 1'></svg>");
          ctx.startPicture(`<script>${H}</script>`);
          ctx.startPicture(`<svg>${"x".repeat(200_001)}</svg>`);
          return c.json({ id: f?.id, host: f?.host, login: f?.login, owners: f?.owners, work: await f?.work?.("2026-08-01"), merged: await f?.merged?.("2026-10-26T10:00:00Z") });
        });
      },
    },
  );
  const pictures: string[] = [];
  const { get } = signedIn(snapshot(), {}, { packs: [reader], startPicture: (svg) => pictures.push(svg), forge: { id: "github", name: "GitHub", can: [], host: "github.com", work: async (login, owners, since) => (asked.push(`${login} ${owners} ${since}`), work), merged: async (login, owners, since) => (asked.push(`${login} ${owners} ${since}`), 4) } });
  assert.deepEqual(await (await get("/reader")).json(), { id: "github", host: "github.com", login: snapshot().login, owners: "ACME", work, merged: 4 });
  assert.deepEqual(asked, [`${snapshot().login} ACME 2026-08-01`, `${snapshot().login} ACME 2026-10-26T10:00:00Z`]);
  assert.deepEqual(pictures, ["<svg viewBox='0 0 1 1'></svg>"], "only an SVG, 200 kB at most");
});

test("the Packs page lists the fun ones apart", async () => {
  const toy = pack({ id: "toy", name: "Toy", domain: "fun" });
  const page = await (await signedIn(snapshot(), {}, { packs: [toy] }).get("/packs")).text();
  const fun = page.indexOf('<p class="eyebrow">Fun</p>');
  assert.ok(fun > 0 && page.indexOf('id="pack-toy"') > fun && page.indexOf('id="pack-agents"') < fun);
  assert.doesNotMatch(await (await signedIn(snapshot()).get("/packs")).text(), /eyebrow">Fun/, "none: no group");
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

test("dock keys: a pack's dock may ask for a capital letter; the page's own keys, a second dock's ask and anything else are ignored", async () => {
  const ask = (id: string, key: unknown) => pack({ id }, { dock: () => ({ label: id, key: key as string }) });
  const docks = docksFrom([ask("one", "T"), ask("two", "T"), ask("three", "B")], (c) => testContext({ log: () => {} }), () => {});
  assert.deepEqual(docks.map((d) => [d.id, d.key]), [["one", "T"], ["two", undefined], ["three", undefined]], "first come; B is Bino's");
  for (const bad of [...TAKEN_KEYS, "t", "TT", "1", "", " ", 7, null, `${H}`]) assert.equal(docksFrom([ask("x", bad)], () => testContext(), () => {})[0]!.key, undefined, String(bad));
  const { get } = signedIn(snapshot(), {}, { packs: [ask("chat", "T"), ask("plain", undefined)] });
  const page = await (await get("/prs")).text();
  assert.match(page, /<div class="tdock" id="dock-chat" data-dock="\/chat\/dock" data-dock-title="chat" data-dock-key="T">/);
  assert.match(page, /id="dock-chat-btn" href="\/chat" aria-controls="dock-chat-panel" aria-expanded="false" title="chat \(T\)">/);
  assert.match(page, /<div class="tdock" id="dock-plain" data-dock="\/plain\/dock" data-dock-title="plain">/, "no key: no attribute");
});

test("actions.what: the first pack that names a kind it logged says what it was, cut to a line; none: undefined", () => {
  const a = pack({ id: "a" }, { slots: () => ({ "actions.what": ({ kind }) => (kind === "a.post" ? `Posted\nsomething ${"x".repeat(200)}` : undefined) }) });
  const b = pack({ id: "b" }, { slots: () => ({ "actions.what": () => "Anything" }) });
  const boom = pack({ id: "boom" }, { slots: () => ({ "actions.what": () => { throw new Error("no"); } }) });
  const fill = fillOf(() => [boom, a, b], () => testContext(), () => {});
  const said = whatFrom(fill, "a.post")!;
  assert.match(said, /^Posted something x+/);
  assert.ok(said.length <= 60);
  assert.equal(whatFrom(fill, "b.other"), "Anything");
  assert.equal(whatFrom(fillOf(() => [], () => testContext(), () => {}), "x"), undefined);
});

test("ask: a pack's question goes in the bar on every page as its asker; only an answer there resolves it; a test's context says no", async () => {
  const db = pack({ id: "db-ish" });
  const { app, get, post } = signedIn(snapshot(), {}, { packs: [db] });
  const ctx = packsOf(app)!.ctxOf(db);
  assert.equal(ctx.asking(), false);
  const schema = { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["deny", "allow"] } } };
  const answer = ctx.ask({ from: `db ${H}`, message: `Open PRODUCTION ledger:prod? ${H}`, schema });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.asking(), true, "its question waits");
  const page = await (await get("/prs")).text();
  assertInert("a pack's question in the bar", page);
  assert.match(page, /db &lt;script&gt;x&lt;\/script&gt;[^<]*asks for your OK/, "as its asker, escaped");
  const id = /\/relay\/ask\/([0-9a-f-]{36})\/answer/.exec(page)?.[1];
  assert.ok(id, "answered in the bar");
  assert.equal((await post(`/relay/ask/${id}/answer`, { choice: "allow" }, { origin: "http://evil.example" })).status, 403, "only this app's own form answers");
  await post(`/relay/ask/${id}/answer`, { choice: "allow" });
  assert.deepEqual(await answer, { action: "accept", content: { decision: "allow" } });
  assert.equal(ctx.asking(), false);
  const hosted = testContext();
  assert.deepEqual(await hosted.ask({ from: "db", message: "x", schema }), { action: "cancel" }, "a test's context says no");
});

test("available: a pack that says it can't run here, or throws asking, is off with why; its routes, nav and init never run", async () => {
  const started: string[] = [];
  const hooks = (id: string, available: () => boolean) => ({
    available,
    init: () => void started.push(id),
    nav: () => [{ href: `/${id}`, title: `The ${id} page` }],
    routes: (app: Parameters<NonNullable<Pack["routes"]>>[0], ctx: Parameters<NonNullable<Pack["routes"]>>[1]) => app.get(`/${id}`, (c) => ctx.page(c, { title: id, body: id })),
  });
  const yes = pack({ id: "yes" }, hooks("yes", () => true));
  const no = pack({ id: "no" }, hooks("no", () => false));
  const boom = pack({ id: "boom" }, hooks("boom", () => { throw new Error("can't tell"); }));
  const { app, get } = signedIn(snapshot(), {}, { packs: [yes, no, boom] });
  const set = packsOf(app)!;
  assert.deepEqual(set.on.filter((c) => ["yes", "no", "boom"].includes(c.manifest.id)).map((c) => c.manifest.id), ["yes"]);
  assert.deepEqual(set.off.filter((o) => o.id === "no" || o.id === "boom").map((o) => [o.id, o.why]), [["no", "can't run here (the pack says so)"], ["boom", "can't run here (the pack says so)"]]);
  assert.equal((await get("/yes")).status, 200);
  for (const path of ["/no", "/boom"]) assert.equal((await get(path)).status, 404, path);
  const page = await (await get("/prs")).text();
  assert.match(page, /The yes page/);
  assert.doesNotMatch(page, /The no page|The boom page/);
  const { initAll } = await import("../src/packs/registry.ts");
  await initAll(set, set.ctxOf, () => {});
  assert.deepEqual(started, ["yes"]);
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

test("a pack's page hosts another pack's slot (span.actions): the second pack's button shows, hostile text inert, one that throws adds none", async () => {
  const sink = pack({ id: "sink" }, {
    routes: (app, ctx) =>
      app.get("/sink/trace", (c) => ctx.page(c, { title: "Trace", body: html`<ul>${ctx.fill("span.actions", { service: "api", kind: "server", method: "GET", route: `/users/:id ${H}`, attrs: { "server.address": "api.local" } })}</ul>` })),
  });
  const client = pack({ id: "client" }, { slots: () => ({ "span.actions": (s) => html`<button type="submit">Open ${s.method} ${s.route} on ${String(s.attrs["server.address"])}</button>` }) });
  const boom = pack({ id: "boom" }, { slots: () => ({ "span.actions": () => { throw new Error("no button"); } }) });
  const { get } = signedIn(snapshot(), {}, { packs: [sink, boom, client] });
  const page = await (await get("/sink/trace")).text();
  assert.match(page, /<button type="submit">Open GET \/users\/:id .* on api\.local<\/button>/);
  assertInert("a span's actions", page);
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

  const settings = await (await get("/settings/packs/work")).text();
  assertInert("a pack's Settings panel", settings);
  assert.match(settings, /<h1>Work &lt;script&gt;[^]*?id="pack-work"[^]*?Signed in as [^]*?action="\/work\/signout"/);
  const list = await (await get("/settings/packs")).text();
  assertInert("Settings → Packs", list);
  assert.match(list, /href="\/settings\/packs\/work"/);
  assert.doesNotMatch(list, /href="\/settings\/packs\/(quiet|boom)"/, "nothing to show, or a throw: not listed");
  assert.equal((await get("/settings/packs/quiet")).status, 404);
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

  // Initially off because LINEAR_API_KEY isn't set; /linear is 404; /packs says why and links to its Settings page, where the form is
  assert.equal((await get("/linear")).status, 404);
  const before = await (await get("/packs")).text();
  assertInert("packs page before", before);
  assert.match(before, /LINEAR_API_KEY isn&#39;t set|LINEAR_API_KEY isn't set/);
  assert.match(before, /href="\/settings\/packs\/linear"/);
  const form = await (await get("/settings/packs/linear")).text();
  assertInert("its Settings page before", form);
  assert.match(form, /Off: LINEAR_API_KEY isn&#39;t set|Off: LINEAR_API_KEY isn't set/);
  assert.match(form, /action="\/packs\/linear\/settings"/);

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
  assert.equal(saveRes.headers.get("location"), "/settings/packs/linear");
  assert.equal(inited, 1);
  assert.equal(refreshed, 1);

  const varsText = readFileSync(varsFile, "utf8");
  assert.match(varsText, /LINEAR_API_KEY=lin_api_secret_12345/);
  assert.match(varsText, /LINEAR_TEAM=ENG-/);

  // Secret value never appears on /packs or Settings, non-secret value is escaped, and /linear route is now live
  const listed = await (await get("/packs")).text();
  assertInert("packs page after", listed);
  assert.doesNotMatch(listed, /lin_api_secret_12345/, "secret value never rendered to DOM");
  const after = await (await get("/settings/packs/linear")).text();
  assertInert("its Settings page after", after);
  assert.match(after, /Saved\./);
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

test("ctx.codeDir: a pack sees the code folder locally (#147)", async () => {
  const seen: (string | undefined)[] = [];
  const pack: Pack = { manifest: { api: PACK_API, id: "where", name: "Where", description: "x", domain: "general", execution: "any" }, routes: (app, ctx) => app.get("/where", (c) => (seen.push(ctx.codeDir), c.text("ok"))) };
  await packApp([pack], { codeDir: "/code" }).get("/where");
  assert.deepEqual(seen, ["/code"]);
});

test("one switch per pack (#271): Turn off on Packs takes it off everywhere, Layout shows the same, Turn on brings it back", async () => {
  const { get, post } = signedIn(snapshot());
  assert.equal((await get("/terminal")).status, 200);
  let page = await (await get("/packs")).text();
  assert.match(page, /id="pack-terminal"[^]*?action="\/packs\/terminal\/switch"[^]*?Turn off/);
  assert.equal((await post("/packs/terminal/switch", { on: "" })).status, 303);
  assert.equal((await get("/terminal")).status, 404, "off: its pages answer 404");
  assert.doesNotMatch(await (await get("/")).text(), /href="\/terminal"/, "and it's gone from the menu");
  page = await (await get("/packs")).text();
  assert.match(page, /id="pack-terminal"[^]*?Turn on[^]*?switched off here/);
  assert.match(await (await get("/settings/layout")).text(), /name="pack" value="terminal">/, "Layout's list unticked: the same switch");
  await post("/packs/terminal/switch", { on: "1" });
  assert.equal((await get("/terminal")).status, 200);
  assert.equal((await post("/packs/nope/switch", { on: "" })).status, 404, "only a pack that can run here");
});

test("binoOf: what a pack gives Bino and agents, as /packs says it (#262)", () => {
  const m = { api: PACK_API, id: "x", name: "X", description: "", domain: "personal" as const };
  assert.equal(binoOf({ manifest: m }), "context: nothing");
  assert.equal(binoOf({ manifest: m, bino: () => "", about: () => undefined, routes: () => {}, acts: () => [], tools: () => [] }), "context: its own lines · what its pages are · proposes acts · tools for agents");
  assert.equal(binoOf({ manifest: m, glance: () => [], routes: () => {} }), "context: what it shows on Today · its pages by name only");
  assert.equal(binoOf({ manifest: { ...m, private: true }, bino: () => "x", acts: () => [] }), "only its name: private · proposes acts");
});
