/** Stacked PRs: chains bottom first, what each waits on, what's wrong, the page, and retargeting. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentActions } from "../src/actions/deploys.ts";
import { branchName, retarget } from "../src/actions/stacks.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { problemText, type StackPr, stacksOf, waitText } from "../src/home/stacks.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import { loadStackPrs, normalizeStackPr } from "../src/sources/stacks.ts";
import { assertInert, fakeGhe, fixedGatherer, H, signedIn, snapshot } from "./helpers.ts";

const pr = (o: Partial<StackPr> & { number: number }): StackPr => ({
  repo: "ACME/shop-api", title: `PR ${o.number}`, url: `https://acme.ghe.com/ACME/shop-api/pull/${o.number}`, author: "ola-nordmann",
  base: "main", head: `b${o.number}`, defaultBranch: "main", state: "OPEN", draft: false, closedAt: null, baseExists: true,
  review: "REVIEW_REQUIRED", checks: "ok", mergeState: "CLEAN", ...o,
});

test("a chain comes out bottom first, each in its place, waiting on the one below", () => {
  // 835 on main, 836 on 835's branch, … 840 on top (PR 840's real shape, six deep).
  const chain = [835, 836, 837, 838, 839, 840].map((n, i) => pr({ number: n, base: i ? `b${n - 1}` : "main" }));
  const [s, ...rest] = stacksOf([...chain].reverse());
  assert.equal(rest.length, 0);
  assert.deepEqual(s!.nodes.map((n) => [n.pr.number, n.position, n.lane]), [[835, 1, 0], [836, 2, 0], [837, 3, 0], [838, 4, 0], [839, 5, 0], [840, 6, 0]]);
  assert.equal(s!.nodes[0]!.waits, undefined, "the bottom waits on nothing");
  assert.equal(waitText(s!.nodes[5]!.waits!), "waits on #839 (not approved yet)");
  assert.equal(s!.ready, undefined, "nothing approved: nothing ready");
  assert.deepEqual([s!.approved, s!.red], [0, 0]);
});

test("ready means the bottom can merge now; what's above says why it waits", () => {
  const s = stacksOf([pr({ number: 1, review: "APPROVED" }), pr({ number: 2, base: "b1", checks: "bad" }), pr({ number: 3, base: "b2" })])[0]!;
  assert.equal(s.ready, 1);
  assert.equal(waitText(s.nodes[1]!.waits!), "waits on #1 to merge");
  assert.equal(waitText(s.nodes[2]!.waits!), "waits on #2 (checks failing)");
  assert.equal(s.red, 1);
  const draft = stacksOf([pr({ number: 1, review: "APPROVED", draft: true }), pr({ number: 2, base: "b1" })])[0]!;
  assert.equal(draft.ready, undefined, "a draft isn't ready");
  assert.equal(waitText(draft.nodes[1]!.waits!), "waits on #1 (a draft)");
});

test("a branching stack: the first PR on a branch carries its lane, the next steps right", () => {
  const s = stacksOf([pr({ number: 1 }), pr({ number: 2, base: "b1" }), pr({ number: 3, base: "b1" }), pr({ number: 4, base: "b2" })])[0]!;
  assert.deepEqual(s.nodes.map((n) => [n.pr.number, n.lane, n.below ?? 0]), [[1, 0, 0], [2, 0, 1], [4, 0, 2], [3, 1, 1]]);
});

test("a base PR that merged, closed or vanished is a problem; a lone PR on main isn't a stack", () => {
  const since = "2026-10-01T00:00:00Z";
  const stacks = stacksOf(
    [
      pr({ number: 10, base: "b9" }), // 9 merged: retarget
      pr({ number: 9, state: "MERGED", closedAt: "2026-10-20T00:00:00Z" }),
      pr({ number: 21, base: "b20" }), // 20 closed
      pr({ number: 20, state: "CLOSED", closedAt: "2026-10-20T00:00:00Z" }),
      pr({ number: 31, base: "gone", baseExists: false }),
      pr({ number: 41, base: "feature/x" }), // no PR, branch still there
      pr({ number: 51, base: "b50" }),
      pr({ number: 50, state: "MERGED", closedAt: "2026-09-01T00:00:00Z" }), // too long ago to count
      pr({ number: 60 }), // a plain PR
    ],
    { since },
  );
  const kinds = stacks.flatMap((s) => s.problems.map((p) => `${p.kind}:${p.pr}`)).sort();
  assert.deepEqual(kinds, ["base-closed:21", "base-deleted:31", "base-merged:10", "base-unknown:41", "base-unknown:51"]);
  assert.ok(!stacks.some((s) => s.nodes.some((n) => n.pr.number === 60)), "a PR on main alone isn't shown");
  const merged = stacks.find((s) => s.nodes[0]!.pr.number === 10)!.problems[0]!;
  assert.equal(problemText(merged), "#9 merged, but #10 still targets its branch: retarget #10 onto main.");
  // Problems come first.
  assert.ok(stacks.every((s) => s.problems.length > 0));
});

test("a PR into develop or a release branch isn't stacked on anything", () => {
  assert.equal(stacksOf([pr({ number: 1, base: "develop" }), pr({ number: 2, base: "release/2026.10" }), pr({ number: 3, base: "hotfix-x" })]).length, 0);
});

test("conflicts show as a problem but don't make a lone PR a stack", () => {
  assert.equal(stacksOf([pr({ number: 1, mergeState: "DIRTY" })]).length, 0);
  const s = stacksOf([pr({ number: 1 }), pr({ number: 2, base: "b1", mergeState: "DIRTY" })])[0]!;
  assert.deepEqual(s.problems, [{ kind: "conflicts", pr: 2 }]);
});

// ── The source ──

const node = (o: Record<string, unknown>) => ({
  number: 1, title: "t", url: "u", isDraft: false, state: "OPEN", mergedAt: null, closedAt: null, updatedAt: "2026-10-22T00:00:00Z",
  baseRefName: "main", headRefName: "h1", baseRef: { name: "main" }, author: { login: "ola-nordmann" },
  repository: { nameWithOwner: "ACME/a", defaultBranchRef: { name: "main" } }, reviewDecision: null, mergeStateStatus: "CLEAN",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, ...o,
});

test("the source walks a chain down and up, keeps to the org, and asks each branch once", async () => {
  const queries: string[] = [];
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest<T>() { return {} as T; },
    async graphql<T>(query: string) {
      queries.push(query);
      if (query.includes("search(")) return { mine: { nodes: [node({ number: 2, baseRefName: "h1", headRefName: "h2" }), node({ number: 9, repository: { nameWithOwner: "evil/x", defaultBranchRef: null } })] }, review: { nodes: [] } } as T;
      const out: Record<string, unknown> = {};
      for (const m of query.matchAll(/(\w+): repository\(owner:"ACME",name:"a"\)\{pullRequests\((headRefName|baseRefName):"([^"]+)"/g)) {
        const [, alias, which, branch] = m;
        if (which === "headRefName" && branch === "h1") out[alias!] = { pullRequests: { nodes: [node({ number: 1, state: "MERGED", mergedAt: "2026-10-21T00:00:00Z", headRefName: "h1" })] } };
        else if (which === "baseRefName" && branch === "h2") out[alias!] = { pullRequests: { nodes: [node({ number: 3, baseRefName: "h2", headRefName: "h3" })] } };
        else out[alias!] = { pullRequests: { nodes: [] } };
      }
      return out as T;
    },
  };
  const prs = await loadStackPrs(ghe, "ola-nordmann", "ACME");
  assert.deepEqual(prs.map((p) => `${p.repo}#${p.number}:${p.state}`).sort(), ["ACME/a#1:MERGED", "ACME/a#2:OPEN", "ACME/a#3:OPEN"]);
  assert.equal(prs.find((p) => p.number === 2)!.checks, "bad");
  const asked = queries.join("\n");
  assert.equal(asked.split('headRefName:"h1"').length - 1, 1, "each base asked about once");
  assert.ok(!asked.includes("evil"), "nothing outside the org is followed");
  const [s] = stacksOf(prs);
  assert.deepEqual(s!.nodes.map((n) => n.pr.number), [2, 3]);
  assert.equal(s!.problems[0]!.kind, "base-merged");
});

test("a node missing what makes it a PR is dropped", () => {
  assert.equal(normalizeStackPr({ number: 1 } as never), null);
  assert.equal(normalizeStackPr(node({ commits: undefined, reviewDecision: "APPROVED" }) as never)!.checks, "none");
});

// ── The page and the action ──

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

test("the stacks page renders hostile titles and branches inert, with a retarget offer for a merged base", async () => {
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest<T>() { return {} as T; },
    async graphql<T>(query: string) {
      if (query.includes("search(")) return { mine: { nodes: [node({ number: 2, title: H, baseRefName: "b1", headRefName: H, url: "javascript:alert(1)", author: { login: H } })] }, review: { nodes: [] } } as T;
      const out: Record<string, unknown> = {};
      for (const m of query.matchAll(/(\w+): repository/g)) out[m[1]!] = { pullRequests: { nodes: query.includes(`u${m[1]!.slice(1)}: `) && m[1]!.startsWith("u") ? [node({ number: 1, state: "MERGED", mergedAt: new Date().toISOString(), headRefName: "b1", title: H })] : [] } };
      return out as T;
    },
  };
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe });
  const res = await app.request("http://localhost/prs/stacks", { headers: { cookie: "u_tk=test-token" } });
  assert.equal(res.status, 200);
  const out = await res.text();
  assertInert("/prs/stacks", out);
  assert.ok(!out.includes('href="javascript:'), "a javascript: link got through");
  assert.match(out, /Retarget onto main/);
  assert.match(out, /action="\/prs\/stacks\/retarget"/);
});

test("with no stacks the page says so", async () => {
  const { get } = signedIn(snapshot());
  const out = await (await get("/prs/stacks")).text();
  assert.match(out, /No stacks/);
});

test("retarget re-checks GHE, moves the PR onto the default branch, and logs it", async () => {
  const { ghe, calls } = fakeGhe({
    "GET /repos/ACME/a/pulls/10": { state: "open", base: { ref: "b9", repo: { default_branch: "main" } } },
    "GET /repos/ACME/a/pulls?state=closed&head=ACME%3Ab9&per_page=10": [{ number: 9, merged_at: "2026-10-21T00:00:00Z" }],
    "PATCH /repos/ACME/a/pulls/10": {},
  });
  const db = openDb();
  const r = await retarget(ghe, db.DB, "ACME/a", 10, "b9");
  assert.deepEqual(r, { ok: true, message: "Retargeted ACME/a#10 onto main." });
  assert.deepEqual(calls.find((c) => c.method === "PATCH")!.body, { base: "main" });
  const log = await recentActions(db.DB);
  assert.deepEqual(log.map((a) => [a.kind, a.target, a.ok]), [["pr.retarget", "ACME/a#10", 1]]);
});

test("retarget leaves a PR alone when it moved on, closed, or its base never merged", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ "GET /repos/ACME/a/pulls/10": { state: "closed", base: { ref: "b9", repo: { default_branch: "main" } } } }, /isn't open/],
    [{ "GET /repos/ACME/a/pulls/10": { state: "open", base: { ref: "main", repo: { default_branch: "main" } } } }, /targets main now/],
    [{ "GET /repos/ACME/a/pulls/10": { state: "open", base: { ref: "b9", repo: { default_branch: "main" } } }, "GET /repos/ACME/a/pulls?state=closed&head=ACME%3Ab9&per_page=10": [{ number: 9, merged_at: null }] }, /has merged/],
  ];
  for (const [routes, why] of cases) {
    const { ghe, calls } = fakeGhe(routes);
    const r = await retarget(ghe, openDb().DB, "ACME/a", 10, "b9");
    assert.equal(r.ok, false);
    assert.match(r.message, why);
    assert.ok(!calls.some((c) => c.method === "PATCH"), "nothing written");
  }
});

test("the retarget route refuses what isn't a PR in the org, and other origins", async () => {
  const { post, calls } = signedIn(snapshot());
  for (const body of [{ repo: "evil/x", number: "1", from: "b" }, { repo: "ACME/a", number: "1; rm", from: "b" }, { repo: "ACME/a", number: "1", from: "../x" }, { repo: "ACME/a", number: "1", from: "a b" }]) await post("/prs/stacks/retarget", body);
  assert.equal(calls.length, 0);
  assert.equal((await post("/prs/stacks/retarget", { repo: "ACME/a", number: "1", from: "b" }, { origin: "http://evil.example" })).status, 403);
  assert.equal(branchName("feat/x-1.2"), "feat/x-1.2");
  assert.equal(branchName("a..b"), null);
});
