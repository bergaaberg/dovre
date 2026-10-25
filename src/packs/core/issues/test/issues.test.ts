/** The Issues pack (#38): reads the forge's sets into memory, draws /tracker from it, says when it failed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../../../../env.ts";
import type { IssueSets } from "../../../../forge/types.ts";
import { testContext } from "../../../testing.ts";
import { issuesPack } from "../index.ts";
import { setOf, staleDaysOf, staleFor, triageReposOf } from "../model.ts";
import { issueRow } from "../view.ts";
import { issue, NOW } from "./fixtures.ts";

const sets = (o: Partial<IssueSets> = {}): IssueSets => ({ assigned: [issue()], mentioned: [], authored: [], triage: [], ...o });

function setup(o: { issues?: (login: string, owners: string, opts?: { triage?: string[] }) => Promise<IssueSets>; can?: string[]; env?: Record<string, string> } = {}) {
  const asked: { login: string; owners: string; triage?: string[] }[] = [];
  const published: string[][] = [];
  const pack = issuesPack({
    forge: {
      host: "github.com",
      can: (o.can ?? ["issues"]) as never,
      viewer: async () => ({ login: "kari", name: null }),
      issues: async (login, owners, opts) => {
        asked.push({ login, owners, triage: opts?.triage });
        return (o.issues ?? (async () => sets()))(login, owners, opts);
      },
    },
    owners: () => "bergaaberg",
    newHref: "/issues/new",
    now: () => NOW,
  });
  const ctx = testContext({ env: o.env ?? {}, publish: (t) => published.push(t), page: async (_c, p) => new Response(String(p.body)) });
  const app = new Hono<AppEnv>();
  pack.routes!(app, ctx);
  const get = async (path: string) => (await app.request(`http://localhost${path}`)).text();
  return { pack, ctx, app, get, asked, published };
}

test("settings: stale days and triage repos are read plainly; odd values fall back", () => {
  assert.equal(staleDaysOf(undefined), 14);
  assert.equal(staleDaysOf(" 30 "), 30);
  assert.equal(staleDaysOf("0"), 14);
  assert.equal(staleDaysOf("2.5"), 14);
  assert.equal(staleDaysOf("x"), 14);
  assert.deepEqual(triageReposOf(" a/b, c/d  e/f,"), ["a/b", "c/d", "e/f"]);
  assert.deepEqual(triageReposOf(undefined), []);
  assert.equal(setOf("triage"), "triage");
  assert.equal(setOf("<x>"), "assigned");
  assert.equal(staleFor(issue({ updatedAt: "2026-10-01T00:00:00Z" }), 14, NOW), 24);
  assert.equal(staleFor(issue(), 14, NOW), undefined);
  assert.equal(staleFor(issue({ updatedAt: "nope" }), 14, NOW), undefined);
});

test("on wherever the forge reads issues", () => {
  assert.equal(setup().pack.available!(testContext()), true);
  assert.equal(setup({ can: [] }).pack.available!(testContext()), true, "a read-only forge (GitLab) has issues without core's forms");
  const bare = issuesPack({ forge: { host: "x", can: ["issues"], viewer: async () => ({ login: "k", name: null }) }, owners: () => "o" });
  assert.equal(bare.available!(testContext()), false);
});

test("refresh reads the sets once, with the triage repos, and publishes", async () => {
  const s = setup({ env: { ISSUES_TRIAGE_REPOS: "bergaaberg/dovre, bergaaberg/site" } });
  await s.pack.refresh!(s.ctx);
  assert.deepEqual(s.asked, [{ login: "kari", owners: "bergaaberg", triage: ["bergaaberg/dovre", "bergaaberg/site"] }]);
  assert.deepEqual(s.published, [["tracker"]]);
  assert.equal(s.pack.kept()?.sets?.assigned.length, 1);
});

test("the page: tabs with counts, rows with labels, PR, sub-issues, stale; triage only when set", async () => {
  const s = setup({ issues: async () => sets({ mentioned: [issue({ number: 9, title: "Old one", updatedAt: "2026-10-01T00:00:00Z", prs: [], subIssues: undefined, labels: [] })] }) });
  assert.match(await s.get("/tracker"), /Reading your issues/);
  await s.pack.refresh!(s.ctx);
  const out = await s.get("/tracker");
  assert.match(out, /Assigned<span class="n">1<\/span>/);
  assert.match(out, /Mentioned<span class="n">1<\/span>/);
  assert.doesNotMatch(out, /Triage/);
  assert.match(out, /dovre#33/);
  assert.match(out, /<span class="pill">layout<\/span>/);
  assert.match(out, /PR #36 open/);
  assert.match(out, /2\/3/);
  assert.match(out, /href="\/issues\/new"/);
  assert.match(out, /data-live id="tracker"/);
  const old = await s.get("/tracker?set=mentioned");
  assert.match(old, /pill warn[^>]*>stale 24 d/);
  assert.match(await s.get("/tracker?set=authored"), /You have no open issues/);
  const t = setup({ env: { ISSUES_TRIAGE_REPOS: "bergaaberg/dovre" } });
  await t.pack.refresh!(t.ctx);
  assert.match(await t.get("/tracker?set=triage"), /Nothing waits for triage/);
});

test("a merged PR is ok; labels never take a status colour", () => {
  const out = String(issueRow(issue({ labels: ["bad", "warn"], prs: [{ key: "a/b#1", state: "MERGED" }] }), { staleDays: 14, now: NOW }));
  assert.match(out, /pill ok[^>]*>PR #1 merged/);
  assert.match(out, /<span class="pill">bad<\/span>/);
});

test("a failed read says so and keeps what it had", async () => {
  let fail = false;
  const s = setup({
    issues: async () => {
      if (fail) throw new Error("GHE graphql: 502");
      return sets();
    },
  });
  await s.pack.refresh!(s.ctx);
  fail = true;
  await s.pack.refresh!(s.ctx);
  const out = await s.get("/tracker");
  assert.match(out, /Issues didn.t load from github.com: GHE graphql: 502/);
  assert.match(out, /dovre#33/);
});

test("Today (#39): the first read learns what's there; a new assignment or mention is a need, briefed and rung once", async () => {
  let t = NOW;
  let current = sets({ mentioned: [issue({ number: 5 })] });
  const published: string[][] = [];
  const pack = issuesPack({
    forge: { host: "github.com", can: ["issues"], viewer: async () => ({ login: "kari", name: null }), issues: async () => current },
    owners: () => "bergaaberg",
    now: () => t,
  });
  const ctx = testContext({ publish: (x) => published.push(x) });
  assert.deepEqual(pack.glance!(ctx), []);
  await pack.refresh!(ctx);
  assert.deepEqual(pack.glance!(ctx), [{ label: "Issues", value: 1 }]);
  assert.deepEqual(pack.needs!(ctx), [], "what was there at start isn't news");
  assert.deepEqual(pack.brief!(ctx), []);

  t += 60_000;
  current = sets({ assigned: [issue(), issue({ number: 40, title: "Verified row actions" })], mentioned: [issue({ number: 5 }), issue({ number: 40 })] });
  await pack.refresh!(ctx);
  const needs = pack.needs!(ctx);
  assert.deepEqual(needs.map((n) => [n.key, n.ring]), [["issues:assigned:bergaaberg/dovre#40", "assigned"], ["issues:mentioned:bergaaberg/dovre#40", "mentioned"]]);
  assert.match(needs[0]!.title, /^Assigned to you: bergaaberg\/dovre#40 Verified row actions/);
  assert.deepEqual(pack.brief!(ctx), [{ text: "1 new issue for you", href: "/tracker" }]);

  t += 60_000;
  await pack.refresh!(ctx);
  assert.equal(pack.needs!(ctx)[0]!.at, NOW + 60_000, "the key and time stay while it's the same");

  t += 25 * 3_600_000;
  assert.deepEqual(pack.needs!(ctx), [], "new for a day");
});

test("Today (#39): Bino gets counts and repo#n only; Ctrl K finds each issue once", async () => {
  const s = setup({ env: { ISSUES_TRIAGE_REPOS: "bergaaberg/dovre" }, issues: async () => sets({ assigned: [issue({ title: "Secret customer words" })], mentioned: [issue({ title: "Secret customer words" })], triage: [issue({ number: 2 })] }) });
  await s.pack.refresh!(s.ctx);
  const line = s.pack.bino!(s.ctx);
  assert.equal(line, "Open issues: 1 assigned to me, 1 mentioning me, 0 opened by me, 1 waiting for triage.");
  assert.doesNotMatch(line, /Secret/);
  const finds = s.pack.finds!(s.ctx);
  assert.equal(finds.length, 1);
  assert.equal(finds[0]!.sub, "bergaaberg/dovre#33 · assigned");
  assert.match(s.pack.about!(s.ctx, "/tracker") ?? "", /1 assigned/);
  assert.equal(s.pack.about!(s.ctx, "/elsewhere"), undefined);
});

test("my own writes show at once, stay shown over lagging reads for a while, and don't ring me", async () => {
  let t = NOW;
  const current = sets({ assigned: [], mentioned: [issue({ number: 7 })], authored: [issue({ number: 8 })] });
  const pack = issuesPack({
    forge: { host: "github.com", can: ["issues"], viewer: async () => ({ login: "kari", name: null }), issues: async () => current, issue: async () => issue({ number: 7, assignees: [] }), issueAct: async () => {} },
    owners: () => "bergaaberg",
    login: () => "kari",
    now: () => t,
  });
  const ctx = testContext({ db: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } as never });
  await pack.refresh!(ctx);
  const app = new Hono<AppEnv>();
  pack.routes!(app, { ...ctx, page: async (_c, p) => new Response(String(p.body)) });
  const post = (body: Record<string, string>) => app.request("http://localhost/tracker/act", { method: "POST", body: new URLSearchParams(body) });
  assert.equal((await post({ kind: "assign", repo: "bergaaberg/dovre", number: "7" })).status, 303);
  assert.equal((await post({ kind: "close", reason: "completed", repo: "bergaaberg/dovre", number: "8" })).status, 303);
  t += 30_000;
  await pack.refresh!(ctx);
  assert.deepEqual(pack.kept()!.sets!.assigned.map((i) => [i.number, i.assignees]), [[7, ["kari"]]], "search hasn't caught up; my write still shows");
  assert.deepEqual(pack.kept()!.sets!.authored, []);
  assert.deepEqual(pack.needs!(ctx), [], "assigning myself doesn't ring me");
  t += 3 * 60_000;
  await pack.refresh!(ctx);
  assert.deepEqual(pack.kept()!.sets!.assigned, [], "after a while the forge's word stands");
});
