/** A page's slow part (src/pages/later.ts): the page answers within its budget, fills in when the load lands, and a failure shows as failed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "../src/env.ts";
import { BUDGET_MS, later, Reading, within } from "../src/pages/later.ts";
import { createViewerRoutes } from "../src/pages/viewer.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import type { Git } from "../src/viewer/code.ts";
import { assertInert, H } from "./helpers.ts";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** A promise and its resolve/reject, to land a load when the test says. */
function gate<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { p, resolve, reject };
}

test("within: what's back in time, else undefined while it carries on", async () => {
  assert.equal(await within(Promise.resolve(7), 50), 7);
  const g = gate<number>();
  assert.equal(await within(g.p, 20), undefined);
  g.resolve(8);
  assert.equal(await within(g.p, 20), 8);
  assert.equal(await within(sleep(30).then(() => 9), Infinity), 9, "no budget: the whole load");
});

test("later: a fast load answers at once, a slow one reads on, lands once, and is reused", async () => {
  const landed: string[] = [];
  const get = later({ budgetMs: 20, landed: (k) => landed.push(k) });
  let loads = 0;
  assert.deepEqual(await get("fast", async () => (loads++, "here")), { ok: true, value: "here" });
  const g = gate<string>();
  const slow = () => (loads++, g.p);
  assert.equal(await get("slow", slow), undefined, "past the budget: still reading");
  assert.equal(await get("slow", slow), undefined, "the next look joins the same load");
  g.resolve("late");
  await sleep(0);
  assert.deepEqual(await get("slow", slow), { ok: true, value: "late" });
  assert.deepEqual(landed, ["fast", "slow"]);
  assert.equal(loads, 2, "one load per key");
});

test("later: a failure shows as failed (not reading again), and the next look after failMs tries again", async () => {
  let t = 0;
  const get = later({ budgetMs: 20, failMs: 1000, now: () => t });
  let tries = 0;
  const failing = async () => {
    tries++;
    throw new Error(`GHE 502 ${H}`);
  };
  assert.deepEqual(await get("k", failing), { ok: false, error: `GHE 502 ${H}` });
  assert.deepEqual(await get("k", failing), { ok: false, error: `GHE 502 ${H}` }, "kept a while");
  assert.equal(tries, 1);
  t = 2000;
  await get("k", failing);
  assert.equal(tries, 2, "then read again");
  // A load that throws before it's a promise is a failure too.
  assert.equal((await get("sync", () => { throw new Error("no"); }))?.ok, false);
});

test("later: fresh loads again; a value goes after ttlMs; only `max` keys are kept", async () => {
  let t = 0;
  const get = later({ ttlMs: 1000, max: 2, now: () => t });
  let n = 0;
  const load = async () => ++n;
  await get("a", load);
  assert.deepEqual(await get("a", load), { ok: true, value: 1 });
  assert.deepEqual(await get("a", load, { fresh: true }), { ok: true, value: 2 });
  t = 5000;
  assert.deepEqual(await get("a", load), { ok: true, value: 3 });
  await get("b", load);
  await get("c", load);
  assert.deepEqual(await get("a", load), { ok: true, value: 6 }, "the oldest key went");
});

test("Reading: the pending block the client fills in, its text inert", () => {
  const out = String(Reading({ title: H, text: H }));
  assert.match(out, /class="pending" data-pending aria-busy="true"/);
  assertInert("reading", out);
});

// ── Through a page: the PR's files (src/pages/viewer.ts) ──
const SHA = "a".repeat(40);
const VIEW = {
  repository: {
    pullRequest: {
      number: 9, title: "T", url: "https://acme.ghe.com/ACME/web/pull/9", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
      baseRefName: "main", headRefName: "feat/x", headRefOid: SHA, author: { login: "me" }, body: "", additions: 1, deletions: 0, changedFiles: 1,
      createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-22T08:00:00Z", reviewDecision: null, labels: { nodes: [] }, reviewRequests: { nodes: [] },
      reviews: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] }, timelineItems: { nodes: [] },
    },
  },
};
const FILES = [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, sha: "1", patch: "@@ -1,1 +1,2 @@\n ctx\n+new line\n" }];
const ENV = { GHE_ORG: "ACME", CODE_DIR: "C:/code" } as unknown as Env;
const frame = async () => ({ operator: "me", nav: [] });
function ghe(files: () => Promise<unknown>): Ghe {
  return {
    host: "acme.ghe.com",
    async rest<T>(path: string) {
      if (path.startsWith("/repos/ACME/web/pulls/9/files")) return (path.includes("page=1") ? await files() : []) as T;
      throw new Error(`GHE ${path}: 404`);
    },
    async graphql<T>() {
      return VIEW as T;
    },
  };
}
const timed = async (app: { request: (p: string) => Response | Promise<Response> }, path: string) => {
  const at = performance.now();
  const res = await app.request(path);
  return { res, out: await res.text(), ms: performance.now() - at };
};

test("the PR's files: slow on GHE, the page answers within its budget reading, then fills in", async () => {
  const g = gate<unknown>();
  const app = createViewerRoutes(ENV, { ghe: ghe(() => g.p), frame, checkouts: () => [] });
  const first = await timed(app, "/prs/ACME/web/9/files");
  assert.equal(first.res.status, 200);
  assert.match(first.out, /data-pending/);
  assert.match(first.out, /Reading the files from GHE/);
  assert.ok(first.ms < BUDGET_MS + 1000, `answered in ${Math.round(first.ms)} ms`);
  g.resolve(FILES);
  await sleep(0);
  const next = await timed(app, "/prs/ACME/web/9/files");
  assert.doesNotMatch(next.out, /data-pending/);
  assert.match(next.out, /new line/);
  assert.ok(next.ms < 500, "landed: at once");
});

test("the PR's files: a failed read shows as failed, its text inert; a fast one renders directly", async () => {
  const bad = createViewerRoutes(ENV, { ghe: ghe(async () => { throw new Error(`GHE 502 ${H}`); }), frame, checkouts: () => [] });
  const out = (await timed(bad, "/prs/ACME/web/9/files")).out;
  assert.match(out, /The files didn't load/);
  assert.doesNotMatch(out, /data-pending/, "failed, not reading forever");
  assertInert("failed files", out);
  const good = createViewerRoutes(ENV, { ghe: ghe(async () => FILES), frame, checkouts: () => [] });
  const fast = await timed(good, "/prs/ACME/web/9/files");
  assert.doesNotMatch(fast.out, /data-pending/);
  assert.match(fast.out, /new line/);
  assert.ok(fast.ms < BUDGET_MS, "no waiting when it's quick");
});

test("the PR's files: a slow git in the checkout doesn't hold the page", async () => {
  const g = gate<{ code: number; stdout: string; stderr: string }>();
  const git: Git = () => g.p;
  const app = createViewerRoutes(ENV, { ghe: ghe(async () => FILES), frame, checkouts: () => [{ dir: "web", repo: "ACME/web" }], git });
  const r = await timed(app, "/prs/ACME/web/9/files");
  assert.match(r.out, /new line/);
  assert.doesNotMatch(r.out, /isn't in your checkout yet/, "no fetch hint while git is still checking");
  assert.ok(r.ms < 1200, `answered in ${Math.round(r.ms)} ms`);
  g.resolve({ code: 1, stdout: "", stderr: "" });
  await sleep(0);
  assert.match((await timed(app, "/prs/ACME/web/9/files")).out, /isn't in your checkout yet/, "the hint on the next look");
});
