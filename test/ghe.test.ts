import assert from "node:assert/strict";
import { test } from "node:test";
import { apiEndpointsOf, apiToHtml, createGhe, byPerson, describeEvent, inFiles, isBot, loadDeploys, newestWaiting, normalizePr, prKeyOfUrl, type Run } from "../src/sources/ghe.ts";
import { fakeGhe, move } from "./helpers.ts";

test("apiEndpointsOf: github.com and GHE.com on api., GitHub Enterprise Server under /api/v3", () => {
  assert.deepEqual(apiEndpointsOf("github.com"), {
    rest: "https://api.github.com",
    graphql: "https://api.github.com/graphql",
  });
  assert.deepEqual(apiEndpointsOf("api.github.com"), {
    rest: "https://api.github.com",
    graphql: "https://api.github.com/graphql",
  });
  assert.deepEqual(apiEndpointsOf("acme.ghe.com"), {
    rest: "https://api.acme.ghe.com",
    graphql: "https://api.acme.ghe.com/graphql",
  });
  assert.deepEqual(apiEndpointsOf("github.acme.example"), {
    rest: "https://github.acme.example/api/v3",
    graphql: "https://github.acme.example/api/graphql",
  });
});

test("createGhe: a token function is asked before every call, and one that throws fails that call with its message", async () => {
  const seen: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ data: { ok: 1 } }));
  }) as typeof fetch;
  let n = 0;
  const ghe = createGhe({ host: "github.com", fetchFn, token: async () => `t${++n}` });
  await ghe.rest("/user");
  await ghe.graphql("{ viewer { login } }");
  assert.deepEqual(seen, ["Bearer t1", "Bearer t2"]);
  const gone = createGhe({ host: "github.com", fetchFn, token: () => Promise.reject(new Error("GitHub disconnected: reconnect it")) });
  await assert.rejects(gone.rest("/user"), /GitHub disconnected/);
  await assert.rejects(gone.graphql("{ viewer { login } }"), /GitHub disconnected/);
  assert.equal(seen.length, 2, "no token, no request");
  assert.deepEqual(await (async () => { seen.length = 0; await createGhe({ host: "github.com", fetchFn, token: "fixed" }).rest("/user"); return seen; })(), ["Bearer fixed"]);
});

test("a PR node becomes a Pr: checks from the last commit, unresolved threads counted", () => {
  const p = normalizePr({
    number: 7, title: "t", url: "https://acme.ghe.com/ACME/a/pull/7", isDraft: true, updatedAt: "x", headRefName: "feat/y", author: null,
    repository: { nameWithOwner: "ACME/a" }, reviewDecision: null,
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  });
  assert.equal(p.checks, "NONE");
  assert.equal(p.openThreads, 1);
  assert.equal(p.author, "ghost");
  assert.equal(p.branch, "feat/y");
});

test("a PR's file count comes from changedFiles, not the capped list, and is left out when unknown (#269)", () => {
  const f = { path: "a.ts", additions: 1, deletions: 0 };
  const node = { number: 7, title: "t", url: "u", isDraft: false, updatedAt: "x", headRefName: "b", author: null,
    repository: { nameWithOwner: "ACME/a" }, reviewDecision: null, reviewThreads: { nodes: [] }, commits: { nodes: [] } };
  const big = normalizePr({ ...node, changedFiles: 200, files: { nodes: Array(80).fill(f) } });
  assert.equal(big.changedFiles, 200);
  assert.equal(inFiles(big), " in 200 files");
  assert.equal(inFiles(normalizePr({ ...node, files: null })), "");
  assert.equal(inFiles({ files: [f] }), " in 1 file");
});

test("API urls become pages; a run without a url links to the repo's actions", () => {
  assert.equal(apiToHtml("github.com", "https://api.github.com/repos/bergaaberg/dovre/pulls/1", "bergaaberg/dovre"), "https://github.com/bergaaberg/dovre/pull/1");
  assert.equal(apiToHtml("github.acme.example", "https://github.acme.example/api/v3/repos/ACME/a/pulls/12", "ACME/a"), "https://github.acme.example/ACME/a/pull/12");
  assert.equal(apiToHtml("acme.ghe.com", "https://api.acme.ghe.com/repos/ACME/a/pulls/12", "ACME/a"), "https://acme.ghe.com/ACME/a/pull/12");
  assert.equal(apiToHtml("acme.ghe.com", "https://api.acme.ghe.com/repos/ACME/a/issues/3", "ACME/a"), "https://acme.ghe.com/ACME/a/issues/3");
  assert.equal(apiToHtml("acme.ghe.com", null, "ACME/a"), "https://acme.ghe.com/ACME/a/actions");
  assert.equal(prKeyOfUrl("https://acme.ghe.com/ACME/a/pull/12"), "ACME/a#12");
  assert.equal(prKeyOfUrl("https://acme.ghe.com/ACME/a/issues/12"), undefined);
});

test("events read as sentences; merges, PR comments and pushes are told apart", () => {
  const ev = (type: string, payload: object, actor = "per-hansen") => describeEvent({ type, created_at: "2026-10-22T06:00:00Z", actor: { login: actor }, repo: { name: "ACME/a" }, payload }, "acme.ghe.com");
  assert.equal(ev("PullRequestEvent", { action: "closed", pull_request: { number: 3, merged: true } }).verb, "merged");
  assert.equal(ev("PullRequestEvent", { action: "closed", pull_request: { number: 3 } }).verb, "closed");
  assert.equal(ev("PullRequestReviewEvent", { review: { state: "CHANGES_REQUESTED" }, pull_request: { number: 3 } }).verb, "reviewed (changes requested)");
  const onPr = ev("IssueCommentEvent", { issue: { number: 4, title: "T", pull_request: {} }, comment: { html_url: "https://acme.ghe.com/ACME/a/pull/4#c" } });
  assert.equal(onPr.ref, "ACME/a#4");
  const push = ev("PushEvent", { ref: "refs/heads/feat/x", size: 2 });
  assert.equal(push.title, "feat/x");
  assert.equal(push.url, "https://acme.ghe.com/ACME/a/commits/feat%2Fx");
  assert.equal(ev("WatchEvent", {}, "dependabot[bot]").bot, true);
});

test("Copilot and other quiet bots count as bots", () => {
  for (const b of ["Copilot", "github-actions[bot]", "dependabot[bot]"]) assert.ok(isBot(b), b);
  assert.ok(!isBot("per-hansen"));
});

test("people are ordered by how much they did", () => {
  const people = byPerson([move({ actor: "a" }), move({ actor: "b" }), move({ actor: "b", repo: "ACME/c" })]);
  assert.deepEqual(people.map((p) => [p.who, p.moves.length, p.repos.length]), [["b", 2, 2], ["a", 1, 1]]);
});

const run = (id: number, name: string, createdAt: string): Run => ({ id, name, title: name, actor: "x", createdAt, url: "", sha: "abc1234", headSha: "abc1234", branch: "main" });

test("waiting runs: per workflow the newest is the one to decide, the rest are superseded", () => {
  const groups = newestWaiting([run(1, "Deploy", "2026-10-20T00:00:00Z"), run(3, "Deploy", "2026-10-22T00:00:00Z"), run(2, "Other", "2026-10-21T00:00:00Z"), run(0, "Deploy", "2026-10-19T00:00:00Z")]);
  const deploy = groups.find((g) => g.top.name === "Deploy")!;
  assert.equal(deploy.top.id, 3);
  assert.deepEqual(deploy.superseded.map((r) => r.id), [1, 0]);
  assert.equal(groups.find((g) => g.top.name === "Other")!.superseded.length, 0);
});

test("a waiting deploy only counts when I may approve it", async () => {
  const raw = (id: number, created: string) => ({ id, name: "Deploy to PROD", display_title: "Deploy", actor: { login: "x" }, created_at: created, html_url: `u/${id}`, head_sha: "0123456789", head_branch: "main" });
  const { ghe } = fakeGhe({
    "GET /repos/ACME/a/actions/runs?status=waiting&per_page=100": { workflow_runs: [raw(2, "2026-10-22T00:00:00Z"), raw(1, "2026-10-21T00:00:00Z")] },
    "GET /repos/ACME/a/actions/runs/2/pending_deployments": [{ environment: { id: 9, name: "prod" }, current_user_can_approve: true }],
    "GET /repos/ACME/b/actions/runs?status=waiting&per_page=100": { workflow_runs: [raw(5, "2026-10-22T00:00:00Z")] },
    "GET /repos/ACME/b/actions/runs/5/pending_deployments": [{ environment: { id: 9, name: "prod" }, current_user_can_approve: false }],
  });
  const deploys = await loadDeploys(ghe, ["ACME/a", "ACME/b", "ACME/a"]);
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0]!.repo, "ACME/a");
  assert.deepEqual(deploys[0]!.superseded.map((r) => r.id), [1]);
  assert.deepEqual(deploys[0]!.envs, [{ id: 9, name: "prod" }]);
  assert.equal(deploys[0]!.sha, "0123456");
});
