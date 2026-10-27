/** Dependabot cleanup (dovre#108): the queue, combining a repo's bumps into one PR, and the page. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addGroups, bumpedPackage, combine, combinedBody, loadQueue, mergeCombined, withGroups } from "../src/actions/dependabot.ts";
import { openDb } from "../src/db.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import { H, assertInert, fakeGhe, signedIn, snapshot } from "./helpers.ts";

const bot = { login: "dependabot[bot]", type: "Bot" };
const pull = (number: number, title: string, user = bot, repo = "ACME/web") => ({ number, title, html_url: `https://acme.ghe.com/${repo}/pull/${number}`, state: "open", created_at: `2026-10-0${number % 9}T00:00:00Z`, user, head: { sha: `sha${number}`, ref: `dependabot/npm/x-${number}`, repo: { full_name: repo } } });

function combineRoutes(conflicts: number[] = []) {
  const merges: number[] = [];
  const routes: Record<string, unknown> = {
    "GET /repos/ACME/web/pulls?state=open&per_page=100&sort=created&direction=asc": [pull(1, "Bump lodash from 4.17.20 to 4.17.21"), pull(2, "Bump hono from 4.1 to 4.2"), pull(3, "Bump x from 1 to 2"), pull(4, "Mine", { login: "me", type: "User" }), { ...pull(5, "Bump fork from 1 to 2"), head: { sha: "s5", ref: "r", repo: { full_name: "evil/web" } } }],
    "GET /repos/ACME/web": { default_branch: "main" },
    "GET /repos/ACME/web/git/ref/heads/main": { object: { sha: "base" } },
    "POST /repos/ACME/web/git/refs": {},
    "POST /repos/ACME/web/merges": (b: unknown) => {
      const n = Number(String((b as { head: string }).head).replace("sha", ""));
      if (conflicts.includes(n)) throw new Error("GHE POST /repos/ACME/web/merges: 409 Merge conflict");
      merges.push(n);
      return {};
    },
    "POST /repos/ACME/web/pulls": { number: 99, html_url: "https://acme.ghe.com/ACME/web/pull/99" },
  };
  return { routes, merges };
}

test("bumpedPackage reads the package from a bump's title", () => {
  assert.equal(bumpedPackage("Bump lodash from 4.17.20 to 4.17.21"), "lodash");
  assert.equal(bumpedPackage("build(deps): bump @types/node from 24.1 to 24.2"), "@types/node");
  assert.equal(bumpedPackage("Bump the npm group across 1 directory with 3 updates"), undefined);
});

test("combine: Dependabot's own PRs only, conflicts left out and listed, one PR opened, logged", async () => {
  const { routes, merges } = combineRoutes([2]);
  const { ghe, calls } = fakeGhe(routes);
  const db = openDb();
  const r = await combine(ghe, db.DB, "ACME/web", { security: [1], now: new Date("2026-10-26T10:00:00Z") });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(merges, [1, 3], "not mine, not a fork's head");
  assert.deepEqual(r.skipped, [{ number: 2, why: "conflicts" }]);
  const branch = calls.find((c) => c.path === "/repos/ACME/web/git/refs")!.body as { ref: string; sha: string };
  assert.deepEqual(branch, { ref: "refs/heads/dovre/dependabot-20261026-100000", sha: "base" });
  const opened = calls.find((c) => c.method === "POST" && c.path === "/repos/ACME/web/pulls")!.body as { title: string; body: string; head: string; base: string };
  assert.equal(opened.title, "Dependency updates (2)");
  assert.equal(opened.base, "main");
  assert.match(opened.body, /\*\*Security fixes \(1\)\*\*\n- #1 Bump lodash/);
  assert.match(opened.body, /Left out \(1\).*\n- #2 Bump hono from 4\.1 to 4\.2 \(conflicts\)/);
  const logged = db.raw.prepare("SELECT kind, target, ok, detail FROM actions").all() as { kind: string; ok: number; detail: string }[];
  assert.deepEqual(logged.map((l) => [l.kind, l.ok, l.detail]), [["pr.combine-dependabot", 1, "#99 from #1 #3; left out #2"]]);
});

test("combine: nothing merges, the branch is deleted and nothing is opened; one PR isn't combined", async () => {
  const { routes } = combineRoutes([1, 2, 3]);
  routes["DELETE /repos/ACME/web/git/refs/heads/dovre/dependabot-20261026-100000"] = null;
  const { ghe, calls } = fakeGhe(routes);
  const r = await combine(ghe, openDb().DB, "ACME/web", { now: new Date("2026-10-26T10:00:00Z") });
  assert.equal(r.ok, false);
  assert.ok(calls.some((c) => c.method === "DELETE"));
  assert.ok(!calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls")));

  const one = fakeGhe({ "GET /repos/ACME/web/pulls?state=open&per_page=100&sort=created&direction=asc": [pull(1, "Bump a from 1 to 2")] });
  const r1 = await combine(one.ghe, openDb().DB, "ACME/web");
  assert.equal(r1.ok, false);
  assert.match(r1.message, /Only one/);
  assert.equal(one.calls.length, 1, "re-checked, then left alone");
});

test("combinedBody keeps a title on one line", () => {
  const b = combinedBody([pull(1, "Bump a\n## injected") as never, pull(2, "Bump b") as never], [], new Set());
  assert.doesNotMatch(b, /\n## injected/);
});

test("loadQueue: by repo, owners only, security fixes first, alerts unreadable said so", async () => {
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async graphql<T>() {
      return {
        bots: { nodes: [
          { number: 1, title: "Bump a from 1 to 2", url: "u1", createdAt: "2026-10-01T00:00:00Z", repository: { nameWithOwner: "ACME/web" } },
          { number: 2, title: "Bump lodash from 1 to 2", url: "u2", createdAt: "2026-10-02T00:00:00Z", repository: { nameWithOwner: "ACME/web" } },
          { number: 3, title: "Bump b from 1 to 2", url: "u3", createdAt: "2026-10-03T00:00:00Z", repository: { nameWithOwner: "ACME/api" } },
          { number: 4, title: "Bump c from 1 to 2", url: "u4", createdAt: "2026-10-03T00:00:00Z", repository: { nameWithOwner: "other/x" } },
        ] },
        mine: { nodes: [{ number: 9, url: "u9", headRefName: "dovre/dependabot-1", mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, repository: { nameWithOwner: "ACME/web" } }, { number: 8, url: "u8", headRefName: "feature", repository: { nameWithOwner: "ACME/api" } }] },
      } as T;
    },
    async rest<T>(path: string) {
      if (path === "/repos/ACME/web/dependabot/alerts?state=open&per_page=100") return [{ dependency: { package: { name: "lodash" } } }] as T;
      throw new Error("GHE GET: 403");
    },
  };
  const q = await loadQueue(ghe, "ACME");
  assert.deepEqual(q.repos.map((r) => [r.repo, r.prs.map((p) => p.number), r.security, r.combined?.number]), [["ACME/web", [2, 1], 1, 9], ["ACME/api", [3], 0, undefined]]);
  assert.deepEqual(q.alertsUnread, ["ACME/api"]);
  assert.deepEqual(q.repos[0]!.combined, { number: 9, url: "u9", checks: "SUCCESS", mergeable: "MERGEABLE", draft: false });
});

test("mergeCombined (#108): only an open, green, mergeable PR from one of Dovre's combine branches, squashed at its head; each refusal logged", async () => {
  const pr = (o: Record<string, unknown> = {}) => ({ ...pull(99, "Dependency updates (3)", { login: "me", type: "User" }), head: { sha: "head99", ref: "dovre/dependabot-20261026-1000", repo: { full_name: "ACME/web" } }, mergeable: true, draft: false, ...o });
  const run = async (o: { pr?: Record<string, unknown>; checks?: string | null; mergeFails?: boolean } = {}) => {
    const db = openDb();
    const calls: string[] = [];
    const ghe: Ghe = {
      host: "acme.ghe.com",
      async rest<T>(path: string, init: { method?: string; body?: unknown } = {}) {
        calls.push(`${init.method ?? "GET"} ${path} ${init.body ? JSON.stringify(init.body) : ""}`.trim());
        if (path === "/repos/ACME/web/pulls/99" && !init.method) return pr(o.pr) as T;
        if (path === "/repos/ACME/web/pulls/99/merge" && init.method === "PUT") {
          if (o.mergeFails) throw new Error("GHE PUT: 409 Head branch was modified");
          return {} as T;
        }
        throw new Error(`GHE ${path}: 404`);
      },
      async graphql<T>(query: string) {
        calls.push(`graphql ${/oid:"(\w+)"/.exec(query)?.[1]}`);
        return { repository: { object: { statusCheckRollup: o.checks === null ? null : { state: o.checks ?? "SUCCESS" } } } } as T;
      },
    };
    const r = await mergeCombined(ghe, db.DB, "ACME/web", 99);
    const log = db.raw.prepare("SELECT kind, target, ok, error FROM actions").all().map((x) => ({ ...x }));
    return { r, calls, log };
  };
  const ok = await run();
  assert.equal(ok.r.ok, true);
  assert.ok(ok.calls.includes('PUT /repos/ACME/web/pulls/99/merge {"sha":"head99","merge_method":"squash"}'), "merged at the head it checked");
  assert.ok(ok.calls.includes("graphql head99"));
  assert.deepEqual(ok.log, [{ kind: "pr.merge-combined", target: "ACME/web#99", ok: 1, error: null }]);
  for (const [o, why] of [
    [{ pr: { state: "closed", merged: true } }, /already merged/],
    [{ pr: { head: { sha: "x", ref: "feature", repo: { full_name: "ACME/web" } } } }, /not a combined PR Dovre opened/],
    [{ pr: { head: { sha: "x", ref: "dovre/dependabot-1", repo: { full_name: "evil/web" } } } }, /not a combined PR Dovre opened/],
    [{ pr: { draft: true } }, /draft/],
    [{ pr: { mergeable: null } }, /still working out/],
    [{ pr: { mergeable: false } }, /doesn't merge cleanly/],
    [{ checks: "PENDING" }, /checks are pending/],
    [{ checks: null }, /no checks ran/],
    [{ mergeFails: true }, /couldn't merge: .*409/],
  ] as const) {
    const r = await run(o);
    assert.equal(r.r.ok, false, String(why));
    assert.match(r.r.message, why);
    assert.equal(r.log.length, 1, "logged");
    assert.equal(r.log[0]!.ok, 0);
    if (!("mergeFails" in o)) assert.ok(!r.calls.some((c) => c.startsWith("PUT")), `${why}: no merge tried`);
  }
});

test("page: combined PRs list their state; only green ones can be ticked, then merged after the redirect, owners only", async () => {
  const { dependabotPage } = await import("../src/pages/dependabot.ts");
  const repo = (name: string, combined: Record<string, unknown>) => ({ repo: name, oldest: "2026-10-01T00:00:00Z", security: 0, prs: [{ repo: name, number: 1, title: "Bump a", url: "u", createdAt: "2026-10-01T00:00:00Z", security: false }], combined: { url: "u", draft: false, ...combined } as never });
  const page = dependabotPage({ operator: "me", nav: [] }, {
    org: "ACME",
    repos: [repo("ACME/web", { number: 9, checks: "SUCCESS", mergeable: "MERGEABLE" }), repo("ACME/api", { number: 8, checks: "PENDING", mergeable: "MERGEABLE" }), repo("ACME/db", { number: 7, checks: "SUCCESS", mergeable: "CONFLICTING" })],
  });
  assert.match(page, /1 of 3 green/);
  assert.match(page, /name="pick" value="ACME\/web#9"/);
  assert.doesNotMatch(page, /value="ACME\/api#8"/);
  assert.match(page, /checks running/);
  assert.match(page, /conflicts/);
  assert.match(page, /action="\/prs\/dependabot\/merge"/);

  const { get, post } = signedIn(snapshot(), {});
  const send = (body: string) => post("/prs/dependabot/merge", body);
  assert.equal((await send("go=1")).status, 303);
  assert.match(await (await get("/prs/dependabot")).text(), /Tick one or more combined PRs first/);
  assert.equal((await send("go=1&pick=evil/web%239&pick=ACME/web%239")).status, 303);
  let text = "";
  for (let i = 0; i < 50 && !/Merged 0 of 2/.test((text = await (await get("/prs/dependabot")).text())); i++) await new Promise((res) => setTimeout(res, 10));
  assert.match(text, /Merged 0 of 2\. A PR outside the owners&#39;? repos was left alone\./);
  assert.equal((await post("/prs/dependabot/merge", "pick=ACME/web%239", { origin: "https://evil.example" })).status, 403, "only from this app");
});

test("page: the Dependabot tab, a repo outside the owners refused, a combine runs after the redirect", async () => {
  const { routes } = combineRoutes();
  const { get, post, gatherer } = signedIn(snapshot(), routes);
  const page = await (await get("/prs/dependabot")).text();
  assert.match(page, /No Dependabot PRs/);
  assert.match(await (await get("/prs")).text(), /href="\/prs\/dependabot"/);
  assert.equal((await post("/prs/dependabot/combine", { repo: "evil/web" })).status, 303);
  assert.match(await (await get("/prs/dependabot")).text(), /isn&#39;t a repo of the owners|isn't a repo of the owners/);
  const r = await post("/prs/dependabot/combine", { repo: "ACME/web" });
  assert.equal(r.status, 303);
  for (let i = 0; i < 50 && !/Opened ACME\/web#99/.test(await (await get("/prs/dependabot")).text()); i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(gatherer.staled > 0);
  assert.equal((await post("/prs/dependabot/combine", { repo: "ACME/web" }, { origin: "https://evil.example" })).status, 403, "only from this app");
});

test("page: hostile titles and repo names are inert", async () => {
  const { dependabotPage } = await import("../src/pages/dependabot.ts");
  const html = dependabotPage({ operator: "me", nav: [] }, {
    org: H,
    repos: [{ repo: H, oldest: "2026-10-01T00:00:00Z", security: 1, prs: [{ repo: H, number: 1, title: H, url: "javascript:alert(1)", createdAt: "2026-10-01T00:00:00Z", security: true }], combined: { number: 2, url: "javascript:alert(1)", checks: "SUCCESS", mergeable: "MERGEABLE", draft: false } }],
    jobs: [{ repo: H, what: "combine", state: "done", ok: false, message: H, url: "javascript:alert(1)" }, { repo: H, what: "groups", state: "running" }],
  });
  assertInert("dependabot page", html);
  assert.doesNotMatch(html, /href="javascript:/);
});

const YML = `# Dependabot, see the docs
version: 2
updates:
  - package-ecosystem: npm # the app
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      actions: { patterns: ["*"] }
`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");

test("withGroups: a group added to each update without one, comments kept, grouped ones left alone", async () => {
  const { parse } = await import("yaml");
  const { text, added } = withGroups(YML);
  assert.deepEqual(added, ["npm"]);
  assert.match(text, /# Dependabot, see the docs/);
  assert.match(text, /# the app/);
  const y = parse(text) as { updates: { groups: Record<string, unknown> }[] };
  assert.deepEqual(y.updates[0]!.groups, { "minor-and-patch": { patterns: ["*"], "update-types": ["minor", "patch"] } });
  assert.deepEqual(y.updates[1]!.groups, { actions: { patterns: ["*"] } });
  assert.deepEqual(withGroups(text), { text, added: [] }, "nothing to add the second time");
  assert.throws(() => withGroups("version: 2\n"), /no updates/);
  assert.throws(() => withGroups("updates: [\n"), /doesn't parse/);
});

function groupRoutes(file?: string) {
  const routes: Record<string, unknown> = {
    "GET /repos/ACME/web": { default_branch: "main" },
    "GET /repos/ACME/web/git/ref/heads/main": { object: { sha: "base" } },
    "POST /repos/ACME/web/git/refs": {},
    "PUT /repos/ACME/web/contents/.github/dependabot.yml": {},
    "POST /repos/ACME/web/pulls": { number: 77, html_url: "https://acme.ghe.com/ACME/web/pull/77" },
  };
  if (file !== undefined) routes["GET /repos/ACME/web/contents/.github/dependabot.yml?ref=main"] = { sha: "f1", content: b64(file) };
  return routes;
}

test("addGroups: a branch, the file written with groups, one PR, logged; nothing to do or no file says so", async () => {
  const { ghe, calls } = fakeGhe(groupRoutes(YML));
  const db = openDb();
  const r = await addGroups(ghe, db.DB, "ACME/web", new Date("2026-10-26T10:00:00Z"));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.url, "https://acme.ghe.com/ACME/web/pull/77");
  const put = calls.find((c) => c.method === "PUT")!.body as { content: string; sha: string; branch: string };
  assert.equal(put.sha, "f1");
  assert.equal(put.branch, "dovre/dependabot-groups-20261026-100000");
  assert.match(Buffer.from(put.content, "base64").toString("utf8"), /minor-and-patch/);
  const pr = calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!.body as { body: string; head: string };
  assert.match(pr.body, /\(npm\)/);
  assert.deepEqual(db.raw.prepare("SELECT kind, ok, detail FROM actions").all().map((l) => ({ ...l })), [{ kind: "pr.dependabot-groups", ok: 1, detail: "#77: npm" }]);

  const done = fakeGhe(groupRoutes(withGroups(YML).text));
  const r2 = await addGroups(done.ghe, openDb().DB, "ACME/web");
  assert.match(r2.message, /has groups already/);
  assert.ok(!done.calls.some((c) => c.method !== "GET"), "read only");

  const none = fakeGhe(groupRoutes());
  const r3 = await addGroups(none.ghe, openDb().DB, "ACME/web");
  assert.equal(r3.ok, false);
  assert.match(r3.message, /no \.github\/dependabot\.yml/);
  assert.deepEqual(none.calls.filter((c) => c.path.includes("/contents/")).map((c) => c.path), ["/repos/ACME/web/contents/.github/dependabot.yml?ref=main", "/repos/ACME/web/contents/.github/dependabot.yaml?ref=main"]);

  const broken = fakeGhe({ ...groupRoutes(YML), "POST /repos/ACME/web/pulls": () => { throw new Error("GHE POST: 422 nope"); }, "DELETE /repos/ACME/web/git/refs/heads/dovre/dependabot-groups-20261026-100000": null });
  const r4 = await addGroups(broken.ghe, openDb().DB, "ACME/web", new Date("2026-10-26T10:00:00Z"));
  assert.equal(r4.ok, false);
  assert.ok(broken.calls.some((c) => c.method === "DELETE"), "the branch is cleaned up");
});

test("page: adding groups runs after the redirect, owners only, this app only", async () => {
  const { get, post } = signedIn(snapshot(), groupRoutes(YML));
  assert.equal((await post("/prs/dependabot/groups", { repo: "evil/web" })).status, 303);
  assert.match(await (await get("/prs/dependabot")).text(), /isn&#39;t a repo of the owners|isn't a repo of the owners/);
  assert.equal((await post("/prs/dependabot/groups", { repo: "ACME/web" })).status, 303);
  let seen = false;
  for (let i = 0; i < 50 && !(seen = /Opened ACME\/web#77/.test(await (await get("/prs/dependabot")).text())); i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(seen);
  assert.equal((await post("/prs/dependabot/groups", { repo: "ACME/web" }, { origin: "https://evil.example" })).status, 403, "only from this app");
});
