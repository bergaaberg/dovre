/** The app as a whole: who gets in, every page renders hostile data inert, the deploy actions do what they say. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentActions } from "../src/actions/deploys.ts";
import { H, assertInert, deploy, move, note, pr, session, signedIn, snapshot } from "./helpers.ts";

const PAGES = ["/", "/terminal", "/code", "/todo", "/bino", "/settings", "/agents", "/agents/new", "/issues/new", "/issues/new?repo=ACME/FORMS", "/issues/new?kind=ticket&project=DEV", "/issues/new?kind=task", "/prs", "/movement", "/movement?view=timeline", "/movement?view=bots", "/movement?view=me", "/worktrees", "/deploys", "/prs/stacks", "/search", "/search?q=a", "/stats"];

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

test("the Packs page keeps a copied pack's state, job output and Update inert; Update goes through the copies", async () => {
  const { PACK_API } = await import("../src/packs/types.ts");
  const manifest = { api: PACK_API, id: "copied", name: H, description: H, domain: "personal" as const };
  const started: string[] = [];
  const copy = { id: "copied", into: H, source: H, commit: H, state: { id: "copied", tracked: true, behind: 2, upstream: [H, "view.ts"], edited: [H] }, job: { at: 0, state: "failed" as const, step: H, out: H } };
  const copies = { get: () => new Map([["copied", copy]]), refresh: () => new Map(), update: (id: string) => (started.push(id), { ok: true as const }) };
  const { get, post } = signedIn(snapshot(), {}, { packs: [{ manifest }], copies });
  const out = await (await get("/packs")).text();
  assertInert("/packs", out);
  assert.match(out, /newer upstream/);
  assert.match(out, /action="\/packs\/copied\/update"/);
  assert.equal((await post("/packs/copied/update", {}, { origin: "http://evil.example" })).status, 403);
  assert.deepEqual(started, []);
  const res = await post("/packs/copied/update", {});
  assert.equal(res.status, 303);
  assert.deepEqual(started, ["copied"]);
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

test("bulk: tick several waiting runs, each re-checked and logged on its own; outside the org refused", async () => {
  const { app, calls, db, get } = signedIn(snapshot({ deploys: { ok: true, value: [deploy(), deploy({ id: 11, repo: "ACME/shop" })] } }), {
    "GET /repos/ACME/people/actions/runs/10/pending_deployments": [{ environment: { id: 5, name: "prod" }, current_user_can_approve: true }],
    "POST /repos/ACME/people/actions/runs/10/pending_deployments": null,
    "GET /repos/ACME/shop/actions/runs/11/pending_deployments": [],
  });
  const page = await (await get("/deploys")).text();
  assert.match(page, /<form id="deploys-bulk" method="post" action="\/deploys\/bulk">/);
  assert.match(page, /form="deploys-bulk" name="pick" value="ACME\/people#10"/);
  const res = await app.request("http://localhost/deploys/bulk", {
    method: "POST",
    headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
    body: "state=approved&pick=ACME%2Fpeople%2310&pick=ACME%2Fshop%2311&pick=evil%2Fx%2312",
  });
  assert.equal(res.status, 303);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "only the run still waiting");
  assert.ok(!calls.some((c) => c.path.includes("evil")), "never reaches a URL outside the org");
  const log = await recentActions(db.DB);
  assert.deepEqual(log.map((a) => [a.target, a.ok]), [["ACME/people run 10", 1]]);
  assert.match(await (await get("/deploys")).text(), /Approved 1 of 3\./);
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
    forge: { host: H, can: ["issues"], viewer: async () => ({ login: "me", name: null }), issues: async () => ({ assigned: [bad], mentioned: [bad], authored: [bad], triage: [bad] }), issue: async () => bad, issueAct: async () => {} },
    owners: () => "ACME",
    newHref: "/issues/new",
    tasks: true,
  });
  await pack.refresh!(testContext({ env: { ISSUES_TRIAGE_REPOS: "ACME/a" } }));
  const { get } = signedIn(snapshot(), {}, { packs: [pack], packEnv: { ISSUES_TRIAGE_REPOS: "ACME/a" } });
  for (const path of ["/", `/search?q=${encodeURIComponent("<")}`, `/tracker?done=close&ref=${encodeURIComponent(H)}`, "/tracker?done=close&ref=ACME%2Fa%231&reason=not_planned", "/tracker", "/tracker?set=mentioned", "/tracker?set=authored", "/tracker?set=triage", `/tracker?set=${encodeURIComponent(H)}`]) {
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

test("Issues actions (#40): the owners' repos only, re-checked, written once, logged; a comment is previewed first", async () => {
  const { issuesPack } = await import("../src/packs/core/issues/index.ts");
  const { testContext } = await import("../src/packs/testing.ts");
  type I = import("../src/forge/types.ts").Issue;
  type A = import("../src/forge/types.ts").IssueAct;
  const now: Record<string, I> = {};
  const mk = (n: number, o: Partial<I> = {}): I => ({ repo: "ACME/a", number: n, title: `Issue ${n}`, url: `https://github.com/ACME/a/issues/${n}`, state: "OPEN", labels: [], author: "x", assignees: [], comments: 0, createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", prs: [], ...o });
  now["1"] = mk(1);
  now["2"] = mk(2, { state: "CLOSED" });
  const asked: string[] = [];
  const acts: A[] = [];
  const pack = issuesPack({
    forge: {
      host: "github.com",
      can: ["issues"],
      viewer: async () => ({ login: "me", name: null }),
      issues: async () => ({ assigned: [], mentioned: [now["1"]!], authored: [], triage: [] }),
      issue: async (repo, n) => {
        asked.push(`${repo}#${n}`);
        return now[String(n)];
      },
      issueAct: async (a) => {
        acts.push(a);
      },
    },
    owners: () => "ACME",
    login: () => "me",
  });
  await pack.refresh!(testContext());
  const { get, post, db } = signedIn(snapshot(), {}, { packs: [pack] });

  const page = await (await get("/tracker?set=mentioned")).text();
  assert.match(page, /Assign me/);
  assert.match(page, /action="\/tracker\/act"/);
  assert.doesNotMatch(page, /Start a task/, "tasks only where they start (local)");

  const res = await post("/tracker/act", { kind: "assign", repo: "ACME/a", number: "1", set: "mentioned" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/tracker?set=mentioned&done=assign&ref=ACME%2Fa%231");
  assert.deepEqual(acts, [{ kind: "assign", repo: "ACME/a", number: 1, login: "me" }]);
  assert.equal(pack.kept()?.sets?.assigned[0]?.number, 1, "shown as mine before the next read");
  assert.match(await (await get("/tracker?set=mentioned&done=assign&ref=ACME%2Fa%231")).text(), /Assigned ACME\/a#1 to you/);

  assert.equal((await post("/tracker/act", { kind: "reopen", repo: "ACME/a", number: "1" })).status, 409, "it's open: nothing to reopen");
  assert.equal((await post("/tracker/act", { kind: "close", reason: "completed", repo: "ACME/a", number: "2" })).status, 409);
  assert.equal((await post("/tracker/act", { kind: "close", reason: "completed", repo: "evil/repo", number: "1" })).status, 400);
  assert.equal((await post("/tracker/act", { kind: "close", reason: "completed", repo: "ACME/a", number: "1" }, { origin: "http://evil.example" })).status, 403);
  assert.deepEqual(asked, ["ACME/a#1", "ACME/a#1", "ACME/a#2"], "the outside repo and the cross-site post never reach the forge");
  assert.equal(acts.length, 1);

  const preview = await post("/tracker/comment", { repo: "ACME/a", number: "1", set: "mentioned", body: H });
  assert.equal(preview.status, 200);
  const pv = await preview.text();
  assertInert("/tracker/comment", pv);
  assert.match(pv, /Post comment/);
  assert.equal(acts.length, 1, "a preview writes nothing");
  assert.equal((await post("/tracker/act", { kind: "comment", repo: "ACME/a", number: "1", body: H })).status, 303);
  assert.deepEqual(acts[1], { kind: "comment", repo: "ACME/a", number: 1, body: H });

  const closed = await post("/tracker/act", { kind: "close", reason: "not_planned", repo: "ACME/a", number: "1", set: "mentioned" });
  assert.equal(closed.headers.get("location"), "/tracker?set=mentioned&done=close&ref=ACME%2Fa%231&reason=not_planned");
  assert.deepEqual(pack.kept()?.sets?.mentioned, [], "a closed issue leaves the open sets at once");
  const after = await (await get(closed.headers.get("location")!)).text();
  assert.match(after, /Closed ACME\/a#1 \(not planned\)/);
  assert.match(after, /name="kind" value="reopen"/);

  const log = await recentActions(db.DB);
  assert.deepEqual(log.map((a) => [a.kind, a.target, a.ok]).reverse(), [
    ["issues.assign", "ACME/a#1", 1],
    ["issues.reopen", "ACME/a#1", 0],
    ["issues.close", "ACME/a#2", 0],
    ["issues.comment", "ACME/a#1", 1],
    ["issues.close", "ACME/a#1", 1],
  ]);
});

test("Storybook (#160): hostile stories files, titles and branches stay inert; frames only on its own page, for its origins; off and unknown repos 404", async () => {
  const { storybookPack } = await import("../src/packs/core/storybook/index.ts");
  const env = { STORYBOOK: "ACME/web https://acme.example.io/web/pr-{pr}/ https://acme.example.io/web/{base}/; OTHER/x https://other.example.io/{pr}/ https://other.example.io/main/" };
  const path = `src/${H}/Button.stories.tsx`;
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const src = `const meta = { title: "<script>x</script>/Button", component: Button };\nexport default meta;\nexport const Primary = {};\nexport const WithIcon = { args: { title: "${H}" } };`;
  const b64 = Buffer.from(src).toString("base64");
  const routes = {
    "GET /repos/ACME/web/pulls/7": { head: { ref: H, sha: "abc123" }, base: { ref: "main" } },
    "GET /repos/ACME/web/pulls/7/files?per_page=100&page=1": [{ filename: path, status: "modified" }, { filename: `src/${H}/Button.tsx`, status: "modified" }],
    [`GET /repos/ACME/web/contents/${enc(`src/${H}`)}?ref=abc123`]: [{ type: "file", path }, { type: "file", path: `src/${H}/Other.stories.tsx` }],
    [`GET /repos/ACME/web/contents/${enc(path)}?ref=abc123`]: { type: "file", encoding: "base64", content: b64, size: src.length },
    [`GET /repos/ACME/web/contents/${enc(`src/${H}/Other.stories.tsx`)}?ref=abc123`]: { type: "file", encoding: "base64", content: Buffer.from("export default {};\nexport const Big = {};").toString("base64"), size: 40 },
  };
  const { fakeGhe } = await import("./helpers.ts");
  const { ghe } = fakeGhe(routes);
  const pack = storybookPack({ ghe, owners: () => "ACME" });
  const { get } = signedIn(snapshot(), {}, { packs: [pack], packEnv: env });
  const res = await get("/storybook/ACME/web/7");
  assert.equal(res.status, 200);
  const out = await res.text();
  assertInert("/storybook", out);
  assert.ok(!out.includes('href="javascript:') && !out.includes('src="javascript:'));
  assert.match(out, /iframe\.html\?id=script-x-script-button--primary&amp;viewMode=story/);
  assert.match(out, /https:\/\/acme\.example\.io\/web\/main\/iframe\.html/);
  assert.match(out, /https:\/\/acme\.example\.io\/web\/pr-7\/iframe\.html/);
  assert.ok(out.includes("other--big") || out.includes("Big"), "the stories beside a changed file are found too");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-src 'self' https:\/\/acme\.example\.io https:\/\/other\.example\.io/);
  // Core pages never frame them.
  assert.doesNotMatch((await get("/prs")).headers.get("content-security-policy") ?? "", /example\.io/);
  // A repo STORYBOOK doesn't name, or one outside the owners: not found.
  assert.equal((await get("/storybook/ACME/api/7")).status, 404);
  assert.equal((await get("/storybook/OTHER/x/7")).status, 404);
  // Without STORYBOOK the pack is off: no page, no frames.
  const off = signedIn(snapshot(), {}, { packs: [storybookPack({ ghe, owners: () => "ACME" })] });
  assert.equal((await off.get("/storybook/ACME/web/7")).status, 404);
});

test("Storybook built here (#166): Build here starts the PR's build (from Dovre only, logged), a failure's output stays inert, a build is framed from the other host", async () => {
  const { storybookPack } = await import("../src/packs/core/storybook/index.ts");
  const { fakeGhe } = await import("./helpers.ts");
  const HEAD = "1".repeat(40), BASE = "2".repeat(40);
  const env = { STORYBOOK: "ACME/web https://acme.example.io/web/" };
  const src = "export default {};\nexport const Primary = {};";
  const { ghe } = fakeGhe({
    "GET /repos/ACME/web/pulls/7": { head: { ref: "feat/x", sha: HEAD }, base: { ref: "main", sha: BASE } },
    "GET /repos/ACME/web/pulls/7/files?per_page=100&page=1": [{ filename: "src/b/Button.stories.ts", status: "modified" }],
    [`GET /repos/ACME/web/contents/src/b/Button.stories.ts?ref=${HEAD}`]: { type: "file", encoding: "base64", content: Buffer.from(src).toString("base64"), size: src.length },
  });
  type S = import("../src/packs/core/storybook/build.ts").BuildState;
  let state: S = { status: "none" };
  const started: [string, string[]][] = [];
  const builds = { outDir: "x", state: () => state, start: (repo: string, shas: string[]) => (started.push([repo, shas]), true), url: (o: string, _r: string, sha: string) => `${o}/acme__web/${sha}/` };
  const pack = storybookPack({ ghe, owners: () => "ACME", build: { builds, port: 4849, ensure: () => {} } });
  const { get, post, db } = signedIn(snapshot(), {}, { packs: [pack], packEnv: env });
  const page = async () => {
    await get("/storybook/ACME/web/7");
    return (await get("/storybook/ACME/web/7")).text();
  };
  let out = await page();
  assert.match(out, /action="\/storybook\/ACME\/web\/7\/build"/);
  assert.match(out, /Not built yet/);
  assert.match(out, /https:\/\/acme\.example\.io\/web\/iframe\.html/, "the published base is framed");
  // Only Dovre's own pages start a build.
  assert.equal((await post("/storybook/ACME/web/7/build", {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/storybook/ACME/web/7/build", {}, { "sec-fetch-site": "same-site" })).status, 404, "a sibling site (a build on the other host) can't either");
  assert.equal(started.length, 0);
  const res = await post("/storybook/ACME/web/7/build", {}, { "sec-fetch-site": "same-origin" });
  assert.equal(res.status, 303);
  assert.deepEqual(started, [["ACME/web", [HEAD]]], "only the side CI doesn't publish");
  const logged = await db.DB.prepare("SELECT kind, target FROM actions WHERE kind = 'storybook.build'").all<{ kind: string; target: string }>();
  assert.deepEqual(logged.results.map((r) => r.target), ["ACME/web#7"]);
  state = { status: "building", step: "Installing packages", startedAt: 1 };
  out = await page();
  assert.match(out, /data-pending/);
  assert.match(out, /Installing packages/);
  state = { status: "failed", why: `storybook build failed: ${H}`, tail: H, at: 1 };
  out = await page();
  assertInert("/storybook build failed", out);
  assert.match(out, /Build again/);
  state = { status: "ready" };
  const ready = await get("/storybook/ACME/web/7");
  out = await ready.text();
  assert.match(out, new RegExp(`http://127\\.0\\.0\\.1:4849/acme__web/${HEAD}/iframe\\.html`), "Dovre on localhost: the build from 127.0.0.1");
  assert.match(ready.headers.get("content-security-policy") ?? "", /frame-src 'self' https:\/\/acme\.example\.io http:\/\/localhost:4849 http:\/\/127\.0\.0\.1:4849/);
  assert.doesNotMatch(out, /action="\/storybook\/ACME\/web\/7\/build"/, "nothing left to build");
});
