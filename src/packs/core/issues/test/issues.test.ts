/** The Issues pack (#38): reads the forge's sets into memory, draws /tracker from it, says when it failed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../../../../env.ts";
import type { IssueSets } from "../../../../forge/types.ts";
import { testAgentLinks, testContext } from "../../../testing.ts";
import { needsSeen } from "../../../registry.ts";
import { issuesPack } from "../index.ts";
import { setOf, staleDaysOf, staleFor, triageReposOf } from "../model.ts";
import { agentHref, agentPromptOf, issueRow } from "../view.ts";
import { issue, NOW } from "./fixtures.ts";

const sets = (o: Partial<IssueSets> = {}): IssueSets => ({ assigned: [issue()], mentioned: [], authored: [], triage: [], ...o });

function setup(o: { issues?: (login: string, owners: string, opts?: { triage?: string[] }) => Promise<IssueSets>; can?: string[]; env?: Record<string, string>; agents?: () => (repo: string) => string | undefined; /** The agents pack is off. */ noAgents?: boolean } = {}) {
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
    ...(o.agents ? { agents: o.agents } : {}),
  });
  const ctx = testContext({ env: o.env ?? {}, publish: (t) => published.push(t), page: async (_c, p) => new Response(String(p.body)), required: ((id: string, name: string) => (id === "agents" && name === "agent" && !o.noAgents ? testAgentLinks : undefined)) as never });
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

test("hosted (#544): the one kept copy is read for the instance's login, whoever's click starts the read; a write is still mine", async () => {
  const asked: string[] = [];
  let me = "two";
  const pack = issuesPack({
    forge: { host: "github.com", can: ["issues"] as never, viewer: async () => ({ login: "kari", name: null }), issues: async (login) => (asked.push(login), sets()) },
    owners: () => "bergaaberg",
    login: () => me,
    reads: () => "op",
    now: () => NOW,
  });
  const ctx = testContext({ env: {} });
  await pack.refresh!(ctx);
  me = "three";
  await pack.refresh!(ctx);
  assert.deepEqual(asked, ["op", "op"]);
  assert.equal(pack.kept()?.login, "op");
});

test("hosted (#544): a person whose snapshot is their own gets their own copy, read as they open the page; needs and the schedule stay the instance's; a guest is told whose issues they see", async () => {
  const asked: string[] = [];
  const wrote: string[] = [];
  /** The asking person's own login; none: the instance's snapshot is theirs. */
  let me: string | undefined;
  let guest: { connect?: string } | undefined;
  let t = NOW;
  let ops = [issue({ number: 1, title: "op's first" }), issue({ number: 2, title: "op's second" })];
  const published: string[][] = [];
  const pack = issuesPack({
    forge: {
      host: "github.com",
      name: "GitHub",
      can: ["issues"] as never,
      viewer: async () => ({ login: "op", name: null }),
      issues: async (login) => (asked.push(login), sets({ assigned: login === "<b>op" ? ops : [issue({ number: 7, title: `${login}'s own`, assignees: [] })] })),
      issue: async () => issue({ number: 7, assignees: [] }),
      issueAct: async (a) => void wrote.push(`${a.kind} ${a.repo}#${a.number}`),
    },
    owners: () => "bergaaberg",
    login: () => me ?? "<b>op",
    reads: () => "<b>op",
    own: () => me,
    guest: () => guest,
    now: () => t,
  });
  const ctx = testContext({ env: {}, db: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) } as never, publish: (topics) => published.push(topics), page: async (_c, p) => new Response(String(p.body)) });
  const app = new Hono<AppEnv>();
  pack.routes!(app, ctx);
  // What a route hands the Worker to finish after its answer.
  const jobs: Promise<unknown>[] = [];
  const worker = { waitUntil: (p: Promise<unknown>) => void jobs.push(p), passThroughOnException() {}, props: {} };
  const get = async (path: string) => (await app.request(`http://localhost${path}`, {}, {}, worker as never)).text();
  const settle = () => Promise.all(jobs.splice(0));

  await pack.refresh!(ctx);
  assert.deepEqual(asked, ["<b>op"]);
  assert.match(await get("/tracker"), /op&#39;s first/, "the operator, and anyone on the instance's snapshot");
  assert.equal(jobs.length, 0, "no read of their own for them");

  // A person with their own snapshot: nothing of the operator's, a read of their own behind the page.
  me = "two";
  assert.deepEqual(pack.glance!(ctx), [], "not the operator's count on Today");
  const [first] = await Promise.all([get("/tracker"), get("/tracker"), get("/tracker")]);
  assert.match(first!, /Reading your issues/);
  assert.doesNotMatch(first!, /op&#39;s/);
  await settle();
  assert.deepEqual(asked, ["<b>op", "two"], "one read, however many pages asked");
  assert.deepEqual(published.at(-1), ["tracker"], "and their page is told");
  const mine = await get("/tracker");
  assert.match(mine, /two&#39;s own/);
  assert.doesNotMatch(mine, /op&#39;s/);
  assert.equal(jobs.length, 0, "fresh: drawn from memory");
  assert.deepEqual(pack.glance!(ctx), [{ label: "Issues", value: 1 }]);
  assert.equal(pack.kept()?.login, "two");

  // Looked at again once it's old: read again. Another person's is apart.
  t += 5 * 60_000;
  await get("/tracker");
  await settle();
  me = "three";
  assert.match(await get("/tracker"), /Reading your issues/);
  await settle();
  assert.match(await get("/tracker"), /three&#39;s own/);
  assert.deepEqual(asked, ["<b>op", "two", "two", "three"]);

  // Their write shows on their own copy, which is read again; the instance's isn't touched.
  const res = await app.request("http://localhost/tracker/act", { method: "POST", body: new URLSearchParams({ kind: "assign", repo: "bergaaberg/dovre", number: "7", set: "assigned" }) }, {}, worker as never);
  assert.equal(res.status, 303);
  assert.deepEqual(wrote, ["assign bergaaberg/dovre#7"]);
  await settle();
  assert.deepEqual(asked.slice(4), ["three"]);

  // Needs and the brief are the instance's, whoever asks; the schedule reads only the instance's.
  ops = [...ops, issue({ number: 3, title: "op's third" })];
  t += 60_000;
  await pack.refresh!(ctx);
  assert.deepEqual(asked.slice(5), ["<b>op"]);
  const theirs = pack.needs!(ctx);
  assert.equal(theirs.length, 1);
  assert.match(theirs[0]!.title, /op's third/);
  me = undefined;
  assert.deepEqual(pack.needs!(ctx), theirs);
  assert.deepEqual(pack.glance!(ctx), [{ label: "Issues", value: 3 }]);

  // Named for the operator (#544): their needs carry their email, so a member's Today and rings
  // leave them out (needsSeen); the brief and Bino's "new for me" are the operator's alone.
  const named = issuesPack({ forge: { host: "github.com", can: ["issues"] as never, viewer: async () => ({ login: "op", name: null }), issues: async () => sets({ assigned: ops }) }, owners: () => "bergaaberg", reads: () => "op", own: () => me, person: () => " Op@X.dev ", now: () => t });
  await named.refresh!(ctx);
  ops = [...ops, issue({ number: 4, title: "op's fourth" })];
  t += 60_000;
  await named.refresh!(ctx);
  const as = (viewer: string | undefined) => ({ ...ctx, viewer: () => viewer });
  assert.deepEqual(named.needs!(ctx).map((n) => n.person), ["op@x.dev"]);
  assert.deepEqual(needsSeen(named.needs!(ctx), "op@x.dev").length, 1);
  assert.deepEqual(needsSeen(named.needs!(ctx), "two@x.dev"), [], "not on another person's Today");
  assert.equal(named.brief!(as("op@x.dev")).length, 1);
  assert.deepEqual(named.brief!(as("two@x.dev")), []);
  assert.match(named.bino!(as("op@x.dev")), /New for me: bergaaberg\/dovre#4/);
  assert.equal(named.bino!(as("two@x.dev")), "", "a guest of the instance's copy hears nothing of it as theirs");
  me = "two";
  assert.doesNotMatch(named.bino!(as("two@x.dev")), /New for me/, "someone with their own copy hears of theirs, nothing new of the operator's");
  me = undefined;
  // Unnamed (local, or the operator not known): everyone's, as before.
  assert.equal(pack.needs!(ctx)[0]!.person, undefined);

  // An isolate that hasn't met the person yet waits for who they are before it picks a copy or names "me".
  let known = false;
  const late = issuesPack({
    forge: { host: "github.com", can: ["issues"] as never, viewer: async () => ({ login: "op", name: null }), issues: async (login) => sets({ assigned: [issue({ number: 7, title: `${login}'s own`, assignees: [] })] }), issue: async () => issue({ number: 7, assignees: [] }), issueAct: async (a) => void wrote.push(`${a.kind} as ${a.kind === "assign" ? a.login : ""}`) },
    owners: () => "bergaaberg",
    login: () => (known ? "four" : undefined),
    reads: () => "op",
    own: () => (known ? "four" : undefined),
    now: () => t,
  });
  const lateCtx = { ...ctx, gathered: async () => ((known = true), undefined) };
  await late.refresh!(lateCtx);
  const lateApp = new Hono<AppEnv>();
  late.routes!(lateApp, lateCtx);
  const unmet = await (await lateApp.request("http://localhost/tracker", {}, {}, worker as never)).text();
  assert.doesNotMatch(unmet, /op&#39;s own/, "not the instance's copy");
  known = false;
  wrote.length = 0;
  await lateApp.request("http://localhost/tracker/act", { method: "POST", body: new URLSearchParams({ kind: "assign", repo: "bergaaberg/dovre", number: "7", set: "assigned" }) }, {}, worker as never);
  assert.deepEqual(wrote, ["assign as four"], "nor the instance's login as me");
  await settle();

  // A guest of the instance's snapshot: its issues, said whose, with where to sign in. Hostile text stays text.
  assert.match(await get("/tracker"), /From github\.com, read/, "the operator isn't told whose they are");
  guest = { connect: "/_auth/github" };
  const borrowed = await get("/tracker");
  assert.match(borrowed, /&lt;b&gt;op's issues, from github\.com, read [^<]*\. <a href="\/_auth\/github">Sign in with GitHub<\/a> to see your own\./);
  assert.ok(!borrowed.includes("<b>op"));
  guest = { connect: "javascript:alert(1)" };
  assert.match(await get("/tracker"), /<a href="#">Sign in with GitHub<\/a>/);
  guest = {};
  assert.doesNotMatch(await get("/tracker"), /Sign in with/, "nowhere to sign in: only whose they are");
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
  assert.match((await s.pack.about!(s.ctx, "/tracker")) ?? "", /1 assigned/);
  assert.equal(await s.pack.about!(s.ctx, "/elsewhere"), undefined);
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

test("a row starts a new agent session on its issue: the form filled in, in the repo's checkout", () => {
  const i = issue();
  const prompt = agentPromptOf(i);
  assert.match(prompt, /^Work on bergaaberg\/dovre#33: Today header on a wide screen\n/);
  assert.match(prompt, /https:\/\/github\.com\/bergaaberg\/dovre\/issues\/33/);
  assert.match(prompt, /"Closes bergaaberg\/dovre#33"/);
  const href = new URL(agentHref(testAgentLinks, i, "dovre-wt"), "http://localhost");
  assert.equal(href.pathname, "/agents/new");
  assert.equal(href.searchParams.get("repo"), "dovre-wt");
  assert.equal(href.searchParams.get("prompt"), prompt);
  assert.equal(new URL(agentHref(testAgentLinks, i), "http://localhost").searchParams.has("repo"), false, "no checkout: the form starts in Dovre's own folder");

  const asked: string[] = [];
  const acts = { me: "kari", task: false, set: "assigned" as const, write: true, agent: { links: testAgentLinks, dirOf: (repo: string) => (asked.push(repo), "dovre") } };
  const out = String(issueRow(i, { staleDays: 14, now: NOW, acts }));
  assert.deepEqual(asked, ["bergaaberg/dovre"]);
  assert.match(out, /<a class="btn" href="\/agents\/new\?repo=dovre&amp;prompt=Work\+on\+bergaaberg%2Fdovre%2333/);
  assert.match(out, />Start an agent</);
  assert.doesNotMatch(String(issueRow(i, { staleDays: 14, now: NOW, acts: { ...acts, agent: undefined } })), /Start an agent/);
});

test("a hostile title stays text in the agent link", () => {
  const out = String(issueRow(issue({ title: `"><script>alert(1)</script>` }), { staleDays: 14, now: NOW, acts: { me: "kari", task: false, set: "assigned", write: false, agent: { links: testAgentLinks, dirOf: () => undefined } } }));
  assert.doesNotMatch(out, /<script>/);
  const href = out.match(/href="(\/agents\/new\?[^"]*)"/)?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href);
  assert.match(new URL(href, "http://localhost").searchParams.get("prompt")!, /: "><script>alert\(1\)<\/script>\n/);
});

test("a read-only forge still offers an agent on each issue, and no writes", async () => {
  const s = setup({ agents: () => () => "dovre" });
  await s.pack.refresh!(s.ctx);
  const out = await s.get("/tracker");
  assert.match(out, /href="\/agents\/new\?repo=dovre&amp;prompt=/);
  assert.doesNotMatch(out, /Assign me|Close as done|Preview comment|Start a task/, "the test forge has no issue()/issueAct()");
  const none = setup();
  await none.pack.refresh!(none.ctx);
  assert.doesNotMatch(await none.get("/tracker"), /Start an agent|Act on it/);
  const off = setup({ agents: () => () => "dovre", noAgents: true });
  await off.pack.refresh!(off.ctx);
  assert.doesNotMatch(await off.get("/tracker"), /\/agents\/|Start an agent|Act on it/, "the agents pack is off: no link to its pages (#394)");
});

test("bulk (dovre#104): tick several, close or take them at once; each re-checked and logged; outsiders and junk refused", async () => {
  const current = sets({ assigned: [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3, state: "CLOSED" })] });
  const wrote: string[] = [];
  const logged: unknown[][] = [];
  const pack = issuesPack({
    forge: {
      host: "github.com",
      can: ["issues"],
      viewer: async () => ({ login: "kari", name: null }),
      issues: async () => current,
      issue: async (_r, n) => current.assigned.find((i) => i.number === n),
      issueAct: async (a) => void wrote.push(`${a.kind} ${a.repo}#${a.number}${a.kind === "close" ? ` ${a.reason}` : ""}`),
    },
    owners: () => "bergaaberg",
    login: () => "kari",
    now: () => NOW,
  });
  const ctx = testContext({ db: { prepare: () => ({ bind: (...v: unknown[]) => ({ run: async () => (logged.push(v), {}) }) }) } as never });
  await pack.refresh!(ctx);
  const app = new Hono<AppEnv>();
  pack.routes!(app, { ...ctx, page: async (_c, p) => new Response(String(p.body)) });

  const page = await (await app.request("http://localhost/tracker")).text();
  assert.match(page, /<form id="issues-bulk" method="post" action="\/tracker\/bulk"><input type="hidden" name="set" value="assigned"><\/form>/);
  assert.match(page, /<input type="checkbox" class="pick" form="issues-bulk" name="pick" value="bergaaberg\/dovre#1"/);
  assert.match(page, /value="not-planned" class="danger">Close as not planned/);

  const bulk = (body: string) => app.request("http://localhost/tracker/bulk", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const r = await bulk("set=assigned&do=done&pick=bergaaberg/dovre%231&pick=bergaaberg/dovre%232&pick=bergaaberg/dovre%233&pick=evil/repo%239&pick=junk");
  assert.equal(r.status, 303);
  assert.deepEqual(wrote, ["close bergaaberg/dovre#1 completed", "close bergaaberg/dovre#2 completed"]);
  const to = new URL(r.headers.get("location")!, "http://localhost");
  assert.equal(to.searchParams.get("bulk"), "done");
  assert.equal(to.searchParams.get("done"), "2");
  assert.equal(to.searchParams.get("of"), "5");
  assert.equal(to.searchParams.getAll("why").length, 3, "a few reasons, not all");
  assert.equal(logged.length, 3, "two written and the closed one refused are logged; the outsider never reaches the forge");
  const after = await (await app.request(`http://localhost${to.pathname}${to.search}`)).text();
  assert.match(after, /Closed as done: 2 of 5\. bergaaberg\/dovre#3: It&#39;s already closed\./);

  assert.equal((await bulk("set=assigned&do=burn&pick=bergaaberg/dovre%231")).status, 400, "an unknown act");
  assert.equal((await bulk("set=assigned&do=done")).status, 400, "nothing ticked");
  const many = Array.from({ length: 30 }, (_, i) => `pick=bergaaberg/dovre%23${i + 100}`).join("&");
  const capped = new URL((await bulk(`set=assigned&do=assign&${many}`)).headers.get("location")!, "http://localhost");
  assert.equal(capped.searchParams.get("of"), "20", "20 at most");
  assert.equal((await (await app.request("http://localhost/tracker?bulk=done&done=9&of=2")).text()).includes("9 of 2"), false, "a made-up count is ignored");
});

test("its setup (#418): ticks from the owners' repos, kept in Dovre's settings, and that pick is what's triaged", async () => {
  const { openDb } = await import("../../../../db.ts");
  const db = openDb().DB;
  const repos = ["bergaaberg/web", "bergaaberg/api", "bergaaberg/docs"];
  const { pack, ctx, asked } = setup({ env: { ISSUES_TRIAGE_REPOS: "bergaaberg/api" } });
  Object.assign(ctx, { db, forge: () => ({ id: "github", name: "GitHub", host: "github.com", login: "kari", owners: "bergaaberg", repos: async () => repos }) });
  const first = await pack.setup!.draw(ctx, "triage");
  assert.equal(first.form, true, "Next sends the ticks");
  assert.match(String(first.body), /value="bergaaberg\/api" checked/, "the setting's repos start ticked");
  assert.ok(String(first.body).indexOf("bergaaberg/api") < String(first.body).indexOf("bergaaberg/docs"), "ticked first");
  assert.deepEqual(await pack.setup!.save!(ctx, "triage", { repo: ["bergaaberg/web", "someone/else", "bergaaberg/docs"] }), { ok: true });
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'tracker.triage'").first<{ value: string }>();
  assert.deepEqual(JSON.parse(row!.value), ["bergaaberg/web", "bergaaberg/docs"], "only the owners' repos");
  await pack.refresh!(ctx);
  assert.deepEqual(asked.at(-1)?.triage, ["bergaaberg/web", "bergaaberg/docs"], "the pick wins over the setting");
  assert.deepEqual(await pack.setup!.save!(ctx, "triage", {}), { ok: true }, "none is fine");
  await pack.refresh!(ctx);
  assert.deepEqual(asked.at(-1)?.triage, []);
  // Before the forge is read: it waits, and says so.
  Object.assign(ctx, { forge: () => undefined });
  assert.ok((await pack.setup!.draw(ctx, "triage")).wait);
});

test("its setup sorts by untriaged issues and folds the rest (#447)", async () => {
  const { openDb } = await import("../../../../db.ts");
  const db = openDb().DB;
  const repos = ["bergaaberg/web", "bergaaberg/api", "bergaaberg/docs", "bergaaberg/old", "bergaaberg/<img src=x>"];
  const { pack, ctx } = setup({ env: { ISSUES_TRIAGE_REPOS: "bergaaberg/old" } });
  Object.assign(ctx, { db, forge: () => ({ id: "github", name: "GitHub", host: "github.com", login: "kari", owners: "bergaaberg", repos: async () => repos, untriaged: async () => ({ "bergaaberg/api": 2, "bergaaberg/web": 7 }) }) });
  const body = String((await pack.setup!.draw(ctx, "triage")).body);
  const [top, rest] = body.split("<details");
  assert.match(top!, /<legend class="t3">2 repos with issues to sort<\/legend>.*bergaaberg\/web<\/b><small>7 untriaged<\/small>.*bergaaberg\/api<\/b><small>2 untriaged.*value="bergaaberg\/old" checked/s, "most first, then the picked one");
  assert.match(rest!, /^ class="climb-more"><summary>2 more with nothing to triage<\/summary>.*bergaaberg\/docs/s, "the rest fold");
  assert.match(body, /<div class="su-filter" hidden><input type="search" class="su-find"[^>]*><button type="button" data-pick="none">None<\/button><button type="button" data-pick="hot">All with issues<\/button><\/div>/, "the filter shows with script only");
  assert.ok(!body.includes("<img src=x") && body.includes("&lt;img src=x&gt;"), "a repo's name is text");
  // Without counts: one list, as before.
  Object.assign(ctx, { forge: () => ({ id: "github", name: "GitHub", host: "github.com", login: "kari", owners: "bergaaberg", repos: async () => repos }) });
  const plain = String((await pack.setup!.draw(ctx, "triage")).body);
  assert.doesNotMatch(plain, /<details|su-filter/);
  assert.match(plain, /5 repos/);
});
