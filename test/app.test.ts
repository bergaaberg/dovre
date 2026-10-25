/** The app as a whole: who gets in, every page renders hostile data inert, the deploy actions do what they say. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentActions } from "../src/actions/deploys.ts";
import { H, assertInert, deploy, move, note, pr, session, signedIn, snapshot } from "./helpers.ts";

const PAGES = ["/", "/terminal", "/code", "/todo", "/bino", "/settings", "/agents", "/agents/new", "/issues/new", "/issues/new?repo=ACME/FORMS", "/issues/new?kind=ticket&project=DEV", "/issues/new?kind=task", "/prs", "/movement", "/movement?view=timeline", "/movement?view=bots", "/movement?view=me", "/worktrees", "/deploys", "/prs/stacks", "/data", "/search", "/search?q=a", "/stats"];

test("nobody without the cookie, or on another host, learns anything is here", async () => {
  const { app, get } = signedIn(snapshot());
  assert.equal((await app.request("http://localhost/")).status, 404);
  assert.equal((await app.request("http://localhost/", { headers: { cookie: "u_tk=wrong" } })).status, 404);
  assert.equal((await app.request("http://evil.example/", { headers: { cookie: "u_tk=test-token" } })).status, 404);
  assert.equal((await app.request("http://localhost/login?tk=wrong")).status, 404);
  const login = await app.request("http://localhost/login?tk=test-token");
  assert.equal(login.status, 303);
  assert.match(login.headers.get("set-cookie") ?? "", /u_tk=test-token; .*HttpOnly/);
  assert.equal((await get("/")).status, 200);
  const to = async (next: string) => (await app.request(`http://localhost/login?tk=test-token&next=${encodeURIComponent(next)}`)).headers.get("location");
  assert.equal(await to("/deploys"), "/deploys");
  assert.equal(await to("//evil.example"), "/");
  assert.equal(await to("/\\evil.example"), "/");
  assert.equal(await to("https://evil.example"), "/");
});

test("the app's shell is public (manifest, icon, service worker, offline page, health); nothing else is", async () => {
  const { app } = signedIn(snapshot());
  for (const path of ["/healthz", "/manifest.webmanifest", "/sw.js", "/offline", "/assets/icon-192.png", "/assets/icon.svg"]) assert.equal((await app.request(`http://localhost${path}`)).status, 200, path);
  for (const path of ["/", "/settings", "/agents", "/events"]) assert.equal((await app.request(`http://localhost${path}`)).status, 404, path);
  const m = await (await app.request("http://localhost/manifest.webmanifest")).json();
  assert.equal(m.name, "Dovre");
  assert.equal(m.start_url, "/");
  assert.ok(m.icons.some((i: { sizes: string }) => i.sizes === "512x512"), "installable needs a large icon");
  const health = await (await app.request("http://localhost/healthz")).json();
  assert.deepEqual(Object.keys(health).sort(), ["ok", "pid", "startedAt", "version"], "health says nothing about my work");
  const login = await app.request("http://localhost/login?tk=test-token");
  assert.match(login.headers.get("set-cookie") ?? "", /Max-Age=34560000/, "the installed app stays signed in");
});

test("a form from another origin is refused", async () => {
  const { post, calls } = signedIn(snapshot());
  const res = await post("/deploys/approve", { repo: "ACME/a", run: "1" }, { origin: "http://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("every page renders, and hostile text from every source stays text", async () => {
  const bad = { title: H, line: H };
  const s = snapshot({
    login: H,
    prs: { ok: true, value: { mine: [pr({ title: H, repo: `ACME/${H}`, branch: H, url: `javascript:alert(1)` })], review: [pr({ title: H, author: H })] } },
    notes: { ok: true, value: [note({ title: H, repo: H })] },
    moves: { ok: true, value: [move({ actor: H, title: H, verb: H, repo: H, url: "javascript:x" }), move({ bot: true, actor: H, title: H })] },
    deploys: { ok: true, value: [deploy({ title: H, name: H, actor: H, branch: H, envs: [{ id: 1, name: H }], superseded: [deploy({ id: 2 })] })] },
  });
  void bad;
  const { get } = signedIn(s, {}, {
    sessions: { live: [session({ title: H, summary: H, lastPrompt: H, repo: H, branch: H, status: "idle", prs: [{ url: "javascript:x", repo: H, number: 1 }] })], recent: [session({ live: false, title: H })] },
    worktrees: [{ name: H, path: H, main: H, branch: H, head: "", changedAt: 0 }],
  });
  for (const path of PAGES) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const out = await res.text();
    assertInert(path, out);
    assert.ok(!out.includes('href="javascript:'), `${path}: a javascript: link got through`);
  }
});

test("the Packs page keeps a pack's manifest and settings inert", async () => {
  const { PACK_API } = await import("../src/packs/types.ts");
  const manifest = { api: PACK_API, id: "hostile", name: H, description: H, domain: "personal" as const, crons: [H], requiredBindings: [H], settings: [{ key: H, label: H, help: H }, { key: "K", label: H, secret: true }] };
  const off = { manifest: { ...manifest, id: "off-one", execution: "hosted-only" as const } };
  const { get } = signedIn(snapshot(), {}, { packs: [{ manifest, refresh: async () => {}, scheduled: async () => {} }, off], packEnv: { [H]: H, K: H } });
  const res = await get("/packs");
  assert.equal(res.status, 200);
  assertInert("/packs", await res.text());
});

test("a source that fails says so on the page; the rest still renders", async () => {
  const { get } = signedIn(snapshot({ prs: { ok: false, error: "GHE graphql: 502" } }), {}, { sessions: { live: [session({ title: "Still here" })] } });
  const out = await (await get("/")).text();
  assert.match(out, /Pull requests didn.t load/);
  assert.match(out, /GHE graphql: 502/);
  assert.match(out, /Still here/);
});

test("approve re-checks the run, approves only the environments I may, and logs it", async () => {
  const { post, calls, db, gatherer, get } = signedIn(snapshot({ deploys: { ok: true, value: [deploy()] } }), {
    "GET /repos/ACME/people/actions/runs/10/pending_deployments": [
      { environment: { id: 5, name: "prod" }, current_user_can_approve: true },
      { environment: { id: 6, name: "other" }, current_user_can_approve: false },
    ],
    "POST /repos/ACME/people/actions/runs/10/pending_deployments": null,
  });
  const res = await post("/deploys/approve", { repo: "ACME/people", run: "10" });
  assert.equal(res.status, 303);
  const write = calls.find((c) => c.method === "POST")!;
  assert.deepEqual(write.body, { environment_ids: [5], state: "approved", comment: "Approved from Dovre" });
  assert.equal(gatherer.staled, 1, "it gathers again at once, and the next page waits a moment for it");
  const log = await recentActions(db.DB);
  assert.deepEqual(log.map((a) => [a.kind, a.target, a.ok]), [["deploy.approved", "ACME/people run 10", 1]]);
  const page = await (await get("/deploys")).text();
  assert.match(page, /Approved ACME\/people run 10/);
  assert.match(page, /Approved · updating/, "drawn as decided before the snapshot knows");
  assert.doesNotMatch(page, /action="\/deploys\/approve"/, "no buttons on a run already decided");
  assert.match(page, /<div data-live id="deploys">/, "the list swaps when the gather lands");
});

test("a run that moved on is left alone", async () => {
  const { post, calls } = signedIn(snapshot(), { "GET /repos/ACME/people/actions/runs/10/pending_deployments": [] });
  await post("/deploys/reject", { repo: "ACME/people", run: "10" });
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("repos outside the org and odd run ids never reach GHE", async () => {
  const { post, calls } = signedIn(snapshot());
  await post("/deploys/approve", { repo: "evil/repo", run: "10" });
  await post("/deploys/approve", { repo: "ACME/a/../b", run: "10" });
  await post("/deploys/approve", { repo: "ACME/a", run: "10; rm" });
  assert.equal(calls.length, 0);
});

test("reject superseded rejects every older waiting run of that workflow and keeps the newest", async () => {
  const raw = (id: number, created: string, name = "Deploy to PROD") => ({ id, name, display_title: "d", actor: { login: "x" }, created_at: created, html_url: "", head_sha: "0123456789", head_branch: "main" });
  const pending = [{ environment: { id: 5, name: "prod" }, current_user_can_approve: true }];
  const { post, calls } = signedIn(snapshot(), {
    "GET /repos/ACME/people/actions/runs?status=waiting&per_page=100": { workflow_runs: [raw(3, "2026-10-22T00:00:00Z"), raw(2, "2026-10-21T00:00:00Z"), raw(1, "2026-10-20T00:00:00Z"), raw(9, "2026-10-19T00:00:00Z", "Other")] },
    "GET /repos/ACME/people/actions/runs/2/pending_deployments": pending,
    "GET /repos/ACME/people/actions/runs/1/pending_deployments": pending,
    "POST /repos/ACME/people/actions/runs/2/pending_deployments": null,
    "POST /repos/ACME/people/actions/runs/1/pending_deployments": null,
  });
  await post("/deploys/reject-superseded", { repo: "ACME/people", workflow: "Deploy to PROD" });
  const writes = calls.filter((c) => c.method === "POST");
  // Sent a few at a time, so in no particular order.
  assert.deepEqual(writes.map((c) => c.path).sort(), ["/repos/ACME/people/actions/runs/1/pending_deployments", "/repos/ACME/people/actions/runs/2/pending_deployments"]);
  assert.ok(writes.every((c) => (c.body as { state: string }).state === "rejected"));
  assert.match((writes[0]!.body as { comment: string }).comment, /Superseded by run 3/);
});

test("Issues (/tracker): hostile issue text and links stay inert; /issues goes there when it's on", async () => {
  const { issuesPack } = await import("../src/packs/core/issues/index.ts");
  const { testContext } = await import("../src/packs/testing.ts");
  const bad = {
    repo: `ACME/${H}`,
    number: 1,
    title: H,
    url: "javascript:alert(1)",
    state: "OPEN" as const,
    labels: [H],
    author: H,
    assignees: [H],
    comments: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: H,
    milestone: H,
    type: H,
    subIssues: { done: 1, total: 2 },
    prs: [{ key: `${H}#${H}`, state: "OPEN" as const }],
  };
  const pack = issuesPack({
    forge: { host: H, can: ["issues"], viewer: async () => ({ login: "me", name: null }), issues: async () => ({ assigned: [bad], mentioned: [bad], authored: [bad], triage: [bad] }) },
    owners: () => "ACME",
    newHref: "/issues/new",
  });
  await pack.refresh!(testContext({ env: { ISSUES_TRIAGE_REPOS: "ACME/a" } }));
  const { get } = signedIn(snapshot(), {}, { packs: [pack], packEnv: { ISSUES_TRIAGE_REPOS: "ACME/a" } });
  for (const path of ["/tracker", "/tracker?set=mentioned", "/tracker?set=authored", "/tracker?set=triage", `/tracker?set=${encodeURIComponent(H)}`]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const out = await res.text();
    assertInert(path, out);
    assert.ok(!out.includes('href="javascript:'), `${path}: a javascript: link got through`);
  }
  const to = await get("/issues");
  assert.equal(to.status, 303);
  assert.equal(to.headers.get("location"), "/tracker");
  const without = signedIn(snapshot());
  assert.equal((await without.get("/issues")).headers.get("location"), "/issues/new");
});
