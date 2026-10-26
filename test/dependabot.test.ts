/** Dependabot cleanup (dovre#108): the queue, combining a repo's bumps into one PR, and the page. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpedPackage, combine, combinedBody, loadQueue } from "../src/actions/dependabot.ts";
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
        mine: { nodes: [{ number: 9, url: "u9", headRefName: "dovre/dependabot-1", repository: { nameWithOwner: "ACME/web" } }, { number: 8, url: "u8", headRefName: "feature", repository: { nameWithOwner: "ACME/api" } }] },
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
    repos: [{ repo: H, oldest: "2026-10-01T00:00:00Z", security: 1, prs: [{ repo: H, number: 1, title: H, url: "javascript:alert(1)", createdAt: "2026-10-01T00:00:00Z", security: true }], combined: { number: 2, url: "javascript:alert(1)" } }],
    jobs: [{ repo: H, state: "done", ok: false, message: H, url: "javascript:alert(1)" }],
  });
  assertInert("dependabot page", html);
  assert.doesNotMatch(html, /href="javascript:/);
});
