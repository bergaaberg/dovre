/** The gatherer: pages never wait for GHE when there's something to show, and a restart draws at once. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGatherer, type Snapshot, snapshotStore } from "../src/gather.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import { githubForge } from "../src/forge/github.ts";
import { snapshot } from "./helpers.ts";

/** A GHE that answers nothing, and only once `open()` is called: a gather that takes as long as the test says. */
function slowGhe() {
  let gathers = 0;
  let release: () => void = () => {};
  let gate = new Promise<void>((res) => (release = res));
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest() {
      await gate;
      throw new Error("GHE: 404");
    },
    async graphql() {
      await gate;
      throw new Error("GHE: 404");
    },
  };
  return {
    ghe,
    get gathers() {
      return gathers;
    },
    open() {
      gathers++;
      release();
      gate = new Promise<void>((res) => (release = res));
    },
  };
}

const ENV = { GHE_ORG: "ACME" };
const tick = () => new Promise((res) => setTimeout(res, 5));

function gathererWith(opts: { last?: Snapshot; ttlMs?: number; clock?: { t: number }; onGathered?: (s: Snapshot) => void; staleWaitMs?: number; maxGatherMs?: number } = {}) {
  const slow = slowGhe();
  const clock = opts.clock ?? { t: 1_000_000 };
  const g = createGatherer({
    env: ENV, forge: githubForge(slow.ghe), login: "me", ttlMs: opts.ttlMs ?? 60_000, now: () => clock.t,
    store: { load: () => opts.last, save: () => {} }, onGathered: opts.onGathered, staleWaitMs: opts.staleWaitMs, maxGatherMs: opts.maxGatherMs,
  });
  return { g, slow, clock };
}

test("with nothing gathered yet, a page waits for the first gather", async () => {
  const { g, slow } = gathererWith();
  assert.equal(g.peek(), undefined);
  const first = g.get();
  await tick();
  assert.ok(g.gathering());
  slow.open();
  const s = await first;
  assert.equal(s.login, "me");
  assert.equal(g.peek(), s);
  assert.equal(g.gathering(), false);
});

test("an old snapshot is drawn at once, and gathered again in the background", async () => {
  const clock = { t: 1_000_000 };
  const old = snapshot({ at: clock.t - 120_000 });
  const got: Snapshot[] = [];
  const { g, slow } = gathererWith({ last: old, clock, onGathered: (s) => got.push(s) });
  const shown = await g.get();
  assert.equal(shown, old, "no wait for GHE");
  assert.ok(g.gathering(), "but a gather started");
  slow.open();
  await tick();
  assert.equal(got.length, 1, "the new one is handed on (the refresher publishes it)");
  assert.notEqual(g.peek(), old);
});

test("a fresh snapshot is drawn without gathering", async () => {
  const clock = { t: 1_000_000 };
  const recent = snapshot({ at: clock.t - 1_000 });
  const { g } = gathererWith({ last: recent, clock });
  assert.equal(await g.get(), recent);
  assert.equal(g.gathering(), false);
});

test("after stale() the next page waits a moment for the new gather, then draws what there is", async () => {
  const clock = { t: 1_000_000 };
  const recent = snapshot({ at: clock.t - 1_000 });
  const { g, slow } = gathererWith({ last: recent, clock, staleWaitMs: 30 });
  g.stale();
  const started = Date.now();
  assert.equal(await g.get(), recent, "GHE is slow: the page draws the old one after the wait");
  assert.ok(Date.now() - started >= 25);
  const waiting = g.get();
  slow.open();
  assert.notEqual(await waiting, recent, "GHE answered within the wait: the page draws the new one");
});

test("a snapshot that can't be kept on disk is still drawn", async () => {
  const clock = { t: 1_000_000 };
  const old = snapshot({ at: clock.t - 120_000 });
  const slow = slowGhe();
  const g = createGatherer({
    env: ENV, forge: githubForge(slow.ghe), login: "me", ttlMs: 60_000, now: () => clock.t,
    store: { load: () => old, save: () => { throw new Error("disk full"); } },
  });
  void g.get();
  slow.open();
  await tick();
  assert.notEqual(g.peek(), old);
  assert.equal(g.gathering(), false);
});

test("the kept snapshot survives a restart, Maps and all; another version's or a week-old one is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-snap-"));
  const file = join(dir, "snapshot.json");
  const now = 2_000_000_000_000;
  const s = snapshot({ at: now - 60_000, refs: new Map([["ACME/a#1", { state: "OPEN", title: "t" }]]) as Snapshot["refs"], changelogs: new Map([[7, { ok: false, error: "x" }]]) as Snapshot["changelogs"] });
  snapshotStore(file, "v1", () => now).save(s);
  const back = snapshotStore(file, "v1", () => now).load()!;
  assert.ok(back.refs instanceof Map && back.refs.get("ACME/a#1")?.title === "t");
  assert.ok(back.changelogs instanceof Map && back.changelogs.has(7));
  assert.equal(back.at, s.at);
  assert.equal(snapshotStore(file, "v2", () => now).load(), undefined, "other code made it");
  assert.equal(snapshotStore(file, "v1", () => now + 8 * 86_400_000).load(), undefined, "too old to be worth drawing");
  writeFileSync(file, "{not json");
  assert.equal(snapshotStore(file, "v1", () => now).load(), undefined);
  assert.equal(snapshotStore(join(dir, "missing.json"), "v1").load(), undefined);
});

test("a change during a gather gets a gather of its own after it, and Deploys can skip the wait", async () => {
  const clock = { t: 1_000_000 };
  const recent = snapshot({ at: clock.t - 1_000 });
  const { g, slow } = gathererWith({ last: recent, clock, staleWaitMs: 5_000 });
  g.stale();
  await tick();
  g.stale();
  const started = Date.now();
  assert.equal(await g.get({ wait: false }), recent, "no wait asked: the page draws at once");
  assert.ok(Date.now() - started < 1_000);
  slow.open();
  await tick();
  assert.ok(g.gathering(), "the second stale() came mid-gather: another one runs");
  slow.open();
  await tick();
  assert.equal(g.gathering(), false);
  assert.equal(slow.gathers, 2);
});

test("a gather stuck past maxGatherMs is given up: the next get gathers again (hosted: a cancelled request's fetches never settle)", async () => {
  const { g, slow, clock } = gathererWith({ maxGatherMs: 25_000 });
  let calls = 0;
  const graphql = slow.ghe.graphql.bind(slow.ghe);
  slow.ghe.graphql = ((...a: Parameters<typeof graphql>) => (calls++, graphql(...a))) as typeof graphql;
  void g.get().catch(() => undefined);
  await tick();
  const first = calls;
  assert.ok(first > 0);
  clock.t += 10_000;
  void g.get({ fresh: true });
  await tick();
  assert.equal(calls, first, "within the limit it waits on the running gather");
  clock.t += 20_000;
  const again = g.get({ fresh: true });
  await tick();
  assert.ok(calls > first, "past the limit a new gather starts");
  slow.open();
  assert.equal((await again).login, "me");
});

test("the PRs the packs link (agents' sessions) are looked up with the gather; a pack's list that throws is no list", async () => {
  const asked: string[] = [];
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest() {
      throw new Error("GHE: 404");
    },
    async graphql<T>(q: string) {
      if (!q.includes("pullRequest(number:")) throw new Error("GHE: 404");
      asked.push(q);
      return { p0: { pullRequest: { state: "MERGED", title: "Fix it", url: "https://acme.ghe.com/ACME/shop-api/pull/5" } } } as T;
    },
  };
  const g = createGatherer({ env: { GHE_ORG: "ACME" }, forge: githubForge(ghe), login: "me", linked: () => ["https://acme.ghe.com/ACME/shop-api/pull/5"] });
  const s = await g.get();
  assert.equal(s.refs.get("ACME/shop-api#5")?.state, "MERGED");
  assert.match(asked[0]!, /repository\(owner:"ACME",name:"shop-api"\)\{pullRequest\(number:5\)/);
  const broken = createGatherer({ env: { GHE_ORG: "ACME" }, forge: githubForge(ghe), login: "me", linked: () => { throw new Error("no"); } });
  assert.equal((await broken.get()).refs.size, 0);
});
