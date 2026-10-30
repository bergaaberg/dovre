/** Auto review's automerge (#326 step 5): the checks right before a merge, the merge itself, and the issue told. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../../../db.ts";
import { HOLD_LABEL, mergePass, type MergeDeps } from "../merge.ts";
import { prsStore } from "../store.ts";
import { editorsOf, type Said, saidAt } from "./said.ts";

const PR = "https://github.com/acme/web/pull/7";
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const T = 1_000_000_000_000;

type World = { head: string; ci: string; mergeable: boolean | null; labels: string[]; config?: string; said: Said[]; mergeFails?: boolean };

function setup(o: Partial<World> = {}) {
  const { DB } = openDb();
  const w: World = { head: HEAD, ci: "success", mergeable: true, labels: [], config: '{"merge": true}', said: [], ...o };
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const ghe = {
    rest: async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const m = init?.method ?? "GET";
      calls.push(`${m} ${path}`);
      if (m !== "GET") bodies.push(init?.body);
      if (path === "/repos/acme/web/pulls/7") return { state: "open", merged: false, draft: true, node_id: "PR_1", html_url: PR, mergeable: w.mergeable, labels: w.labels.map((name) => ({ name })), head: { sha: w.head }, base: { sha: BASE } } as T;
      if (path === `/repos/acme/web/contents/.dovre/auto.json?ref=${BASE}`) {
        if (w.config === undefined) throw new Error("404");
        return { content: btoa(w.config), encoding: "base64", size: w.config.length } as T;
      }
      const said = saidAt(path, w.said);
      if (said) return said as T;
      if (path.includes("/check-runs")) return { check_runs: w.ci === "none" ? [] : [w.ci === "pending" ? { status: "in_progress", conclusion: null } : { status: "completed", conclusion: w.ci }] } as T;
      if (path.endsWith("/status")) return { statuses: [] } as T;
      if (path === "/repos/acme/web/pulls/7/merge" && m === "PUT") {
        if (w.mergeFails) throw new Error("405 Base branch was modified");
        return { merged: true } as T;
      }
      if (path === "/repos/acme/web/issues/3/comments" && m === "POST") return {} as T;
      throw new Error(`unexpected ${m} ${path}`);
    },
    graphql: async <T>(q: string): Promise<T> => (calls.push(`graphql ${q}`), editorsOf(q) as T),
  };
  let clicks = new Map<string, "once" | "twice">();
  const deps: MergeDeps = { db: DB, ghe, owners: "acme", login: "me", clicks: async () => clicks, log: () => {}, now: () => T + 60_000 };
  const store = prsStore(DB, () => T);
  /** Reviewed at HEAD (review 99) at level 5 after one fix round, on its way to merging. */
  const merging = async () => {
    await store.add({ pr: PR, issue: "acme/web#3", run: "r1" });
    await store.level(PR, "reviewing", { head: "f".repeat(40), level: 3 });
    await store.move(PR, "reviewing", "fixing", { round: 1 });
    await store.move(PR, "fixing", "reviewing");
    await store.level(PR, "reviewing", { head: HEAD, level: 5, review: 99 });
    await store.move(PR, "reviewing", "merging");
  };
  return { DB, w, calls, bodies, deps, store, merging, setClicks: (c: Map<string, "once" | "twice">) => (clicks = c) };
}

const row = async (s: ReturnType<typeof setup>) => (await s.store.all())[0]!;

test("a merge: the draft marked ready, a squash merge pinned to the reviewed commit, logged, and the issue told how the levels went", async () => {
  const s = setup({ said: [{ kind: "line", login: "me", at: T + 1, review: 99 }, { kind: "review", login: "me", at: T + 1, review: 99 }, { kind: "issue", login: "me", at: T - 5 }] });
  await s.merging();
  assert.equal(await mergePass(s.deps), true);
  assert.ok(s.calls.some((c) => c.startsWith("graphql mutation{markPullRequestReadyForReview(input:{pullRequestId:\"PR_1\"})")));
  const merge = s.calls.indexOf("PUT /repos/acme/web/pulls/7/merge");
  assert.ok(merge > 0);
  assert.deepEqual(s.bodies[0], { merge_method: "squash", sha: HEAD });
  const r = await row(s);
  assert.equal(r.state, "merged");
  assert.match(r.why!, /Merged by Auto review at level 5, after 1 fix round\./);
  assert.match(String((s.bodies[1] as { body: string }).body), /^Auto review merged https:\/\/github\.com\/acme\/web\/pull\/7 at level 5, after 1 fix round\.\n\nLevels by round: 3 \(fffffff\) → 5 \(aaaaaaa\)\.$/);
  const log = await s.DB.prepare("SELECT kind, target, ok FROM actions").all<{ kind: string; target: string; ok: number }>();
  assert.deepEqual(log.results.map((x) => [x.kind, x.target, x.ok]), [["autoreview.merge", "acme/web#7", 1], ["autoreview.merge", "acme/web#3", 1]]);
});

test("a merge waits: for CI still running (waiting-ci), while dovre:hold is on, while GitHub works out mergeability; never merging meanwhile", async () => {
  const s = setup({ ci: "pending" });
  await s.merging();
  await mergePass(s.deps);
  assert.equal((await row(s)).state, "waiting-ci");
  assert.equal(await mergePass(s.deps), false, "said once");
  s.w.ci = "success";
  s.w.labels = [HOLD_LABEL];
  await mergePass(s.deps);
  let r = await row(s);
  assert.equal(r.state, "waiting-ci");
  assert.match(r.why!, /Held: labelled dovre:hold/);
  s.w.labels = [];
  s.w.mergeable = null;
  await mergePass(s.deps);
  assert.match((await row(s)).why!, /still working out/);
  assert.ok(!s.calls.some((c) => c.startsWith("PUT")));
  s.w.mergeable = true;
  await mergePass(s.deps);
  r = await row(s);
  assert.equal(r.state, "merged");
});

test("a merge: an owner's word since the review starts a fix round instead, even past the rounds' limit; someone else's doesn't stop it", async () => {
  const cases: [Said[], RegExp][] = [
    [[{ kind: "issue", login: "Me", at: T + 5 }], /^Level 5, not merged: 1 owner comment since its review\. Round 2: a fix session for them\.$/],
    [[{ kind: "line", login: "acme", at: T + 5, review: 120 }], /1 owner comment since/],
    [[{ kind: "review", login: "me", at: T + 5, review: 120 }], /1 owner comment since/],
    [[{ kind: "review", login: "acme", at: T + 5, review: 121, state: "CHANGES_REQUESTED", body: "" }], /acme's Request changes since/],
  ];
  for (const [said, why] of cases) {
    const s = setup({ said });
    await s.merging();
    await mergePass(s.deps);
    const r = await row(s);
    assert.deepEqual([r.state, r.round], ["fixing", 2], `${why} ${r.why}`);
    assert.match(r.why!, why);
    assert.ok(!s.calls.some((c) => c.startsWith("PUT")));
  }
  // Dovre's own posts (marked) and a stranger's words don't count.
  const t = setup({ said: [{ kind: "issue", login: "stranger", at: T + 5 }, { kind: "line", login: "me", at: T + 5, review: 130, body: "Fixed in abc.\n\n<!-- dovre:autoreview -->" }] });
  await t.merging();
  await mergePass(t.deps);
  assert.equal((await row(t)).state, "merged");
  // An owner's comment someone else edited isn't acted on: it's mine.
  const u = setup({ said: [{ kind: "issue", login: "me", at: T + 5, edited: T + 50_000, id: 900 }] });
  u.deps.ghe.graphql = async <X>(q: string): Promise<X> => (u.calls.push(`graphql ${q}`), editorsOf(q, { N_900: "mallory" }) as X);
  await u.merging();
  await mergePass(u.deps);
  const r = await row(u);
  assert.equal(r.state, "yours");
  assert.match(r.why!, /mallory edited me's comment after it was posted, so Dovre doesn't act on it/);
});

test("a merge is handed to me: CI red or none, conflicts, the repo turned it off, Settings asks twice, GitHub refused", async () => {
  const cases: [Partial<World>, RegExp, Map<string, "once" | "twice">?][] = [
    [{ ci: "failure" }, /CI failed on it after its review/],
    [{ ci: "none" }, /no CI ran on it/],
    [{ mergeable: false }, /conflicts with its base/],
    [{ config: '{"merge": false}' }, /automerge is off/],
    [{ config: undefined }, /automerge is off/],
    [{}, /asks twice/, new Map([["autoreview.merge", "twice"]])],
    [{ mergeFails: true }, /GitHub didn't merge it: 405/],
  ];
  for (const [o, why, clicks] of cases) {
    const s = setup(o);
    await s.merging();
    if (clicks) s.setClicks(clicks);
    await mergePass(s.deps);
    const r = await row(s);
    assert.equal(r.state, "yours", String(why));
    assert.match(r.why!, why);
    assert.match(r.why!, /^Level 5, not merged: /);
    if (!o.mergeFails) assert.ok(!s.calls.some((c) => c.startsWith("PUT")), String(why));
  }
});

test("a merge: new commits since the level-5 review go back to review, unmerged", async () => {
  const s = setup({ head: "b".repeat(40) });
  await s.merging();
  await mergePass(s.deps);
  const r = await row(s);
  assert.equal(r.state, "reviewing");
  assert.ok(!s.calls.some((c) => c.startsWith("PUT")));
});
