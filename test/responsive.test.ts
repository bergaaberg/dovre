/** Pages answer at once: nothing waits on GHE when there's something to draw, and the first start says it's gathering. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Gatherer, Snapshot } from "../src/gather.ts";
import { SERVICE_WORKER } from "../src/pwa.ts";
import { githubForge } from "../src/forge/github.ts";
import { appWithAgents, fakeGhe, signedIn, snapshot } from "./helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

/** A gatherer that has nothing yet and whose first gather never lands. */
const neverGathered = (): Gatherer => ({ get: () => new Promise<Snapshot>(() => {}), stale: () => {}, gathering: () => true, peek: () => undefined });

test("on the very first start a page says it's gathering instead of hanging, and fills itself in later", async () => {
  const app = appWithAgents({ ...ENV, DB: openDb().DB }, { gatherer: neverGathered(), ghe: fakeGhe({}).ghe });
  for (const path of ["/", "/deploys", "/agents"]) {
    const started = Date.now();
    const res = await app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
    assert.equal(res.status, 200, path);
    assert.ok(Date.now() - started < 3000, `${path} answered in time`);
    const out = await res.text();
    assert.match(out, /data-pending/, path);
    assert.match(out, /Gathering/, path);
  }
});

test("Refresh answers at once and gathers in the background", async () => {
  const { post, gatherer } = signedIn(snapshot());
  const res = await post("/refresh", {});
  assert.equal(res.status, 303);
  assert.equal(gatherer.staled, 1);
});

test("old data being gathered again says so in the top bar", async () => {
  const s = snapshot({ at: Date.now() - 10 * 60_000 });
  const g: Gatherer = { get: async () => s, stale: () => {}, gathering: () => true, peek: () => s };
  const app = appWithAgents({ ...ENV, DB: openDb().DB }, { gatherer: g, ghe: fakeGhe({}).ghe });
  const out = await (await app.request("http://localhost/", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.match(out, /Syncing…/);
});

test("the service worker lets the page's request start while it wakes (navigation preload)", () => {
  assert.match(SERVICE_WORKER, /navigationPreload\.enable\(\)/);
  assert.match(SERVICE_WORKER, /preloadResponse/);
});

test("a login arriving from the launcher's file page moves on from here, so the Strict cookie comes along; other sites go nowhere else", async () => {
  const { app } = signedIn(snapshot());
  const res = await app.request("http://localhost/login?tk=test-token&next=%2Fagents", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /SameSite=Strict/);
  assert.match(await res.text(), /http-equiv="refresh" content="0;url=\/agents"/);
  const evil = await app.request("http://localhost/login?tk=test-token&next=https%3A%2F%2Fevil.example", { headers: { "sec-fetch-site": "cross-site" } });
  assert.match(await evil.text(), /content="0;url=\/"/);
  assert.equal((await app.request("http://localhost/login?tk=wrong", { headers: { "sec-fetch-site": "cross-site" } })).status, 404);
});

test("the starting page: the service worker's asks the server, the launcher's watches for data/up-<port>.js and only ever goes on to this app", async () => {
  const { startingPage, STARTING_JS } = await import("../src/pwa.ts");
  const sw = String(startingPage());
  assert.match(sw, /data-probe="health"/);
  assert.match(sw, /<script src="\/starting.js">/);
  const file = String(startingPage({ file: { base: "http://127.0.0.1:4848", up: "up-4848.js", icon: "file:///x/icon.png" } }));
  assert.match(file, /data-probe="file" data-base="http:\/\/127.0.0.1:4848"/);
  assert.ok(file.includes(STARTING_JS), "inline: a file page has no server to load it from");
  assert.match(STARTING_JS, /to\.startsWith\(base \+ "\/"\)/);
  assert.match(file, /data-up="up-4848.js"/);
  const { app } = signedIn(snapshot());
  assert.equal((await app.request("http://localhost/starting.js")).status, 200, "public: it loads when nothing else may");
});

test("programs start on a worker thread: the server's thread never stalls while one starts", async () => {
  const { runOff } = await import("../src/spawn.ts");
  const ok = await runOff(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "æøå" });
  assert.deepEqual([ok.code, ok.stdout], [0, "æøå"]);
  assert.equal((await runOff(process.execPath, ["-e", "process.exit(3)"])).code, 3, "a non-zero exit is an answer");
  await assert.rejects(runOff(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 }), /timed out/);
  await assert.rejects(runOff("no-such-program-dovre", []), /ENOENT/);
  // Stopped (Bino's Stop): the program is killed at once, and the next one still runs.
  const ctl = new AbortController();
  const t0 = Date.now();
  const long = runOff(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(long, /stopped/);
  assert.ok(Date.now() - t0 < 2000, "not left to run out");
  await assert.rejects(runOff(process.execPath, ["-e", ""], { signal: ctl.signal }), /stopped/, "already stopped: never starts");
  assert.equal((await runOff(process.execPath, ["-e", "process.exit(0)"])).code, 0);
});

test("cached GHE answers: known ones come at once and load again in the background; kept ones survive a restart; a write reads fresh", async () => {
  const { memoize } = await import("../src/issues/templates.ts");
  const clock = { t: 0 };
  const store = new Map<string, { at: number; value: unknown }>();
  const kept = { get: (k: string) => store.get(k), set: (k: string, v: { at: number; value: unknown }) => void store.set(k, v) };
  let loads = 0;
  let release = () => {};
  const slow = () => { loads++; return new Promise<string>((res) => (release = () => res(`v${loads}`))); };
  const cached = memoize({ ttlMs: 1000, now: () => clock.t, kept });
  const first = cached("k", slow);
  release();
  assert.equal(await first, "v1");
  assert.equal(await cached("k", slow), "v1", "within the ttl: no load");
  clock.t = 5000;
  assert.equal(await cached("k", slow), "v1", "old: answered at once…");
  assert.equal(loads, 2, "…and loading again");
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await cached("k", slow), "v2");
  // A new run (a new memoize) answers from what was kept, without waiting.
  const again = memoize({ ttlMs: 1000, now: () => clock.t, kept });
  assert.equal(await again("k", slow), "v2");
  const fresh = again("k", slow, { fresh: true });
  release();
  assert.equal(await fresh, `v${loads}`, "fresh waits for a new load");
  // A failed load keeps what was there, and the next call tries again.
  clock.t = 99_000;
  const known = `v${loads}`;
  assert.equal(await again("k", () => Promise.reject(new Error("GHE 502"))), known);
  await new Promise((r) => setTimeout(r, 0));
  const before = loads;
  assert.equal(await again("k", slow), known, "still the last good answer, at once");
  assert.equal(loads, before + 1, "and loading again");
});

test("the Gathering page has the same menu as the real one (packs' items too), so nothing jumps when it fills in", async () => {
  const pack = { manifest: { api: 1, id: "notes", name: "Notes", description: "", domain: "personal" as const }, nav: () => [{ href: "/notes", title: "Notes", icon: "box" as const, group: "Apps" }] };
  const app = appWithAgents({ ...ENV, DB: openDb().DB, GITHUB_USER: "me" }, { gatherer: neverGathered(), ghe: fakeGhe({}).ghe, packs: { on: [pack], off: [], env: {} } });
  const out = await (await app.request("http://localhost/", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.match(out, /data-pending/);
  assert.match(out, /href="\/notes"/);
  assert.match(out, /as me</);
  assert.doesNotMatch(out, /deploys, Jira and agents/);
});

test("hosted keeps the last snapshot in D1: a fresh isolate draws it at once; writes are spaced out", async () => {
  const { d1SnapshotStore } = await import("../src/hosted/snapshot.ts");
  const { createGatherer } = await import("../src/gather.ts");
  const db = openDb().DB;
  let t = Date.now();
  const kept = d1SnapshotStore(db, "v1", { now: () => t, everyMs: 60_000 });
  assert.equal(await kept.load(), undefined);
  const s = snapshot({ at: t, prs: { ok: true, value: { mine: [], review: [], counts: new Map([["a", 1]]) } } as unknown as Snapshot["prs"] });
  kept.save(s);
  kept.save({ ...s, at: t + 1000 });
  await kept.drain();
  const again = d1SnapshotStore(db, "v1", { now: () => t });
  const back = await again.load();
  assert.equal(back?.at, t, "the second save within a minute was skipped");
  assert.ok((back?.prs as unknown as { value: { counts: Map<string, number> } }).value.counts instanceof Map, "Maps survive");
  assert.equal(await d1SnapshotStore(db, "v2").load(), undefined, "another version's snapshot is ignored");
  const g = createGatherer({ env: { GHE_ORG: "ACME" }, forge: githubForge(fakeGhe({}).ghe), login: "me" });
  g.seed?.(back!);
  assert.equal(g.peek()?.at, t);
  g.seed?.({ ...back!, at: t - 1 });
  assert.equal(g.peek()?.at, t, "an older one doesn't replace it");
  t += 1;
});

test("Today's header and horizon are responsive: wide screen brief has readable width, phone stacks, horizon peak leaves room for dock", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  const { horizon, W } = await import("../src/home/horizon.ts");

  // Wide screen layout rules
  assert.match(STYLE, /\.brief\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
  assert.match(STYLE, /\.brief\s*>\s*div\s*\{[^}]*max-width:\s*66ch/);
  assert.match(STYLE, /\.brief\s*>\s*figure\s*\{[^}]*grid-column:\s*2/);
  assert.match(STYLE, /\.brief\s*\.glance\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(STYLE, /\.eyebrow\s*\{[^}]*white-space:\s*nowrap/);

  // Phone / narrow width stacking under 860px
  assert.match(STYLE, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.brief\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(STYLE, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.brief\s*>\s*figure\s*\{[^}]*grid-column:\s*auto/);
  assert.match(STYLE, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.brief\s*\.glance\s*\{[^}]*grid-column:\s*auto/);

  // Horizon peak near now leaves room for the fixed dock button
  const now = Date.now();
  const moves = [
    { at: new Date(now - 5 * 60e3).toISOString(), actor: "alice", bot: false, repo: "org/repo", type: "PullRequestEvent", verb: "merged", title: "feature", url: "https://example.com" },
    { at: new Date(now - 2 * 60e3).toISOString(), actor: "bob", bot: false, repo: "org/repo", type: "IssuesEvent", verb: "opened", title: "bug", url: "https://example.com" },
  ];
  const out = String(await horizon({ moves, deploys: [], lanes: [], me: "alice", now }));
  const peakMatch = out.match(/<g class="hz-peak">[\s\S]*?<text x="([^"]+)" y="[^"]+" text-anchor="end">/);
  assert.ok(peakMatch, "a peak near now is drawn end-anchored");
  const tx = Number(peakMatch[1]);
  assert.ok(tx <= W - 72, `peak label tx (${tx}) leaves clearance from W (${W})`);
});

