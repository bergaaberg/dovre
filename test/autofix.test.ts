/** Fix sessions on auto PRs, the agents pack's side (#326 step 4): the slot they share with auto runs, the caps, landing on the PR's branch, and following them. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { DEFAULT_AUTO, autoStore, fixStore, saveAutoSettings } from "../src/agents/auto.ts";
import type { Desk } from "../src/agents/desk.ts";
import type { Run } from "../src/agents/runner.ts";
import { followFixes, landFix, startFix } from "../src/actions/autofix.ts";
import type { AutoFixAsk } from "../src/packs/types.ts";

const HEAD = "a".repeat(40);
const NEW = "b".repeat(40);
const PR = "https://github.com/acme/app/pull/40";
const ASK: AutoFixAsk = { key: "acme/app#12", pr: PR, repo: "acme/app", head: HEAD, prompt: "Fix it.", model: "opus", budget: 9 };
const TO = { repo: "acme/app", branch: "sandbox/aaaa1111", base: HEAD, pr: { number: 40, url: PR }, kind: "autoreview.fix" };

function world() {
  const db = openDb();
  const runs = new Map<string, Run>();
  const started: Parameters<Desk["start"]>[0][] = [];
  const pushed: { id: string; to?: string }[] = [];
  const desk = {
    view: () => ({ here: true, online: true, harnesses: ["claude"], runs: [...runs.values()], workDir: "/w" }),
    repos: async () => ["app"],
    run: async (id: string) => runs.get(id),
    async start(f: Parameters<Desk["start"]>[0]) {
      started.push(f);
      const id = `fix-${started.length}`;
      runs.set(id, { id, status: "running", prompt: String(f.prompt), events: [], cost: 0 } as unknown as Run);
      return { to: `/agents/r/${id}`, run: id };
    },
    pushSandbox: async (id: string, to?: string) => (pushed.push({ id, to }), { repo: "acme/app", branch: to ?? "sandbox/other", head: NEW }),
    async landed(id: string, pr: { number?: unknown; url?: unknown }) {
      const r = runs.get(id)!;
      if (r.out?.state === "ready") r.out.pr = { number: pr.number as number, url: pr.url as string };
    },
  } as unknown as Desk;
  const t = Date.parse("2026-10-28T12:00:00Z");
  const deps = { db: db.DB, desk, owners: "acme", tz: "UTC", now: () => t };
  /** The fix run ended with commits made from `base`. */
  const ended = (id: string, o: { base?: string; ci?: boolean; repo?: string; none?: boolean } = {}) =>
    Object.assign(runs.get(id)!, {
      status: "done",
      cost: 1.5,
      endedAt: t,
      events: [{ t: "result", text: "Fixed.\n```auto-replies\n1: Fixed.\n```" }],
      out: o.none ? { state: "none" } : { state: "ready", branch: `sandbox/${id}`, base: o.base ?? HEAD, head: NEW, repo: o.repo ?? "acme/app", commits: [{ sha: NEW, subject: "Fix" }], files: [], ci: !!o.ci },
    });
  return { db, runs, started, pushed, desk, deps, ended };
}

const on = (db: ReturnType<typeof openDb>, o: Partial<typeof DEFAULT_AUTO> = {}) => saveAutoSettings(db.DB, { ...DEFAULT_AUTO, on: true, ...o });

test("startFix: a sandbox run from the PR's head, with Settings' minutes, the budget capped at runUsd and the turn cap", async () => {
  const w = world();
  await on(w.db, { runUsd: 4, minutes: 30 });
  assert.deepEqual(await startFix(w.deps, ASK), { run: "fix-1" });
  const f = w.started[0]!;
  assert.deepEqual([f.repo, f.sandbox, f.model, f.prompt], ["app", true, "opus", "Fix it."]);
  assert.deepEqual(f.caps, { base: HEAD, maxMs: 30 * 60_000, budget: 4, turns: 60 });
  const [row] = await fixStore(w.db.DB).open();
  assert.deepEqual([row!.state, row!.run, row!.key], ["running", "fix-1", "acme/app#12"]);
});

test("startFix and auto runs share the at-once slot, both ways", async () => {
  const w = world();
  await on(w.db);
  const autos = autoStore(w.db.DB);
  await autos.put({ repo: "acme/app", number: 5, title: "Other", state: "queued" });
  await autos.move("acme/app#5", "queued", "running", { run: "r1" });
  const r = await startFix(w.deps, ASK);
  assert.ok("wait" in r && /one slot/.test(r.wait));
  assert.equal(w.started.length, 0);
  // The auto run ends; the fix starts; a queued auto run now has to wait for it.
  await autos.move("acme/app#5", "running", "done");
  assert.ok("run" in (await startFix(w.deps, ASK)));
  await autos.put({ repo: "acme/app", number: 6, title: "Next", state: "queued" });
  assert.equal(await autos.claim("acme/app#6", 1), false);
});

test("startFix waits while auto runs are off, past the day's cap, and refuses repos outside my owners", async () => {
  const w = world();
  let r = await startFix(w.deps, ASK);
  assert.ok("wait" in r && /off/.test(r.wait));
  await on(w.db, { dayUsd: 2 });
  await w.db.DB.prepare("INSERT INTO auto_spend (key, run, cost, at) VALUES ('acme/app#1', 'old', 3, ?)").bind(w.deps.now()).run();
  r = await startFix(w.deps, ASK);
  assert.ok("wait" in r && /day's cap/.test(r.wait));
  r = await startFix(w.deps, { ...ASK, repo: "evil/app" });
  assert.ok("error" in r);
  assert.equal(w.started.length, 0);
  assert.deepEqual(await fixStore(w.db.DB).open(), [], "no slot held");
});

test("landFix: its commits pushed onto the PR's branch, never elsewhere, and logged; the slot goes back", async () => {
  const w = world();
  await on(w.db);
  await startFix(w.deps, ASK);
  assert.deepEqual(await landFix(w.deps, "fix-1", TO), { wait: "It's still running." });
  w.ended("fix-1");
  const r = await landFix(w.deps, "fix-1", TO);
  assert.deepEqual(r, { head: NEW, commits: 1, said: "Fixed.\n```auto-replies\n1: Fixed.\n```", cost: 1.5 });
  assert.deepEqual(w.pushed, [{ id: "fix-1", to: "sandbox/aaaa1111" }]);
  assert.deepEqual(await fixStore(w.db.DB).open(), []);
  const log = await w.db.DB.prepare("SELECT kind, target, ok FROM actions").all<{ kind: string; target: string; ok: number }>();
  assert.deepEqual(log.results.map((x) => [x.kind, x.target, x.ok]), [["autoreview.fix", "acme/app:sandbox/aaaa1111", 1]]);
  const spent = await w.db.DB.prepare("SELECT run, cost FROM auto_spend").all<{ run: string; cost: number }>();
  assert.deepEqual(spent.results.map((x) => [x.run, x.cost]), [["fix-1", 1.5]], "counts toward the day's cap");
  // Landed already (a pass that went away): the same answer, nothing pushed again.
  assert.ok("head" in (await landFix(w.deps, "fix-1", TO)));
  assert.equal(w.pushed.length, 1);
});

test("landFix refuses commits it shouldn't push: CI config, another base, another repo, a branch not a sandbox run's; nothing made is said so", async () => {
  for (const [o, to, why] of [
    [{ ci: true }, TO, /CI config/],
    [{ base: NEW }, TO, /another commit/],
    [{ repo: "acme/other" }, TO, /origin is acme\/other/],
    [{}, { ...TO, branch: "main" }, /isn't an auto run's branch/],
  ] as const) {
    const w = world();
    await on(w.db);
    await startFix(w.deps, ASK);
    w.ended("fix-1", o);
    const r = await landFix(w.deps, "fix-1", to);
    assert.ok("error" in r && why.test(r.error), String(why));
    assert.deepEqual(w.pushed, []);
  }
  const w = world();
  await on(w.db);
  await startFix(w.deps, ASK);
  w.ended("fix-1", { none: true });
  assert.deepEqual(await landFix(w.deps, "fix-1", TO), { none: "It committed nothing.", said: "Fixed.\n```auto-replies\n1: Fixed.\n```", cost: 1.5 });
  assert.deepEqual(await landFix(w.deps, "unknown", TO), { error: "That isn't a fix session Dovre started." });
});

test("followFixes: a running fix's cost kept, its slot back once it ends; a claim whose pass died is let go", async () => {
  const w = world();
  await on(w.db);
  await startFix(w.deps, ASK);
  Object.assign(w.runs.get("fix-1")!, { cost: 0.7 });
  await followFixes(w.deps);
  let [row] = await fixStore(w.db.DB).open();
  assert.equal(row!.cost, 0.7);
  Object.assign(w.runs.get("fix-1")!, { status: "done", cost: 1 });
  await followFixes(w.deps);
  assert.deepEqual(await fixStore(w.db.DB).open(), []);

  const fixes = fixStore(w.db.DB, () => 0);
  await fixes.claim({ id: "dead", key: "k", pr: PR }, 1);
  await followFixes(w.deps);
  assert.deepEqual(await fixStore(w.db.DB).open(), []);
});
