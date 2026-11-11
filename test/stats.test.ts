/** Stats: weeks in Oslo, GHE's answers read into weeks, spend from transcripts, kept and gathered when due, and a page that draws any title inert. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { statOffers, statsPage } from "../src/pages/stats.ts";
import { layoutFromForm, layoutOf, placeStats } from "../src/layout.ts";
import { statsFrom } from "../src/packs/registry.ts";
import { PACK_API, type Pack, type PackContext, type PackStat, type StatUnit } from "../src/packs/types.ts";
import { packApp } from "../src/packs/testing.ts";
import { daysOf, gatherHistory, type History, historyOf, isBot, median, weekly, weeksOf } from "../src/packs/core/history/history.ts";
import { historyPack } from "../src/packs/core/history/index.ts";
import { createHistory as createStats, d1HistoryKept, type HistoryView } from "../src/packs/core/history/store.ts";
import { historyStats } from "../src/packs/core/history/view.ts";
import { claudeCostDays, createSpend, ompCostDays, type SpendDay, spendStats } from "../src/packs/core/agents/spend.ts";
import { columns, niceTicks } from "../src/ui/chart.ts";
import { resetWhen, setWhen } from "../src/when.ts";
import { H, assertInert, fakeGhe, fixedGatherer, snapshot } from "./helpers.ts";

const NOW = Date.parse("2026-10-22T14:00:00Z"); // a Thursday, week 43

test("weeks: twelve, Monday to Monday in Oslo, the last one this week", () => {
  const w = weeksOf(NOW);
  assert.equal(w.length, 12);
  assert.deepEqual([w[11]!.key, w[11]!.label, w[0]!.key, w[0]!.label], ["2026-10-19", "w43", "2026-08-03", "w32"]);
  // Late Sunday evening in Oslo is still that week, though it's Monday in some other places.
  assert.equal(weeksOf(Date.parse("2026-10-25T21:30:00Z"), undefined, "Europe/Oslo")[11]!.key, "2026-10-19");
  assert.equal(weeksOf(Date.parse("2026-10-25T23:30:00Z"), undefined, "Europe/Oslo")[11]!.key, "2026-10-26");
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), undefined);
  assert.deepEqual(niceTicks(41), [0, 20, 40, 60]);
  assert.deepEqual(niceTicks(0), [0, 1]);
  // Counts step by whole numbers: no "0.5 releases".
  assert.deepEqual(niceTicks(1, true), [0, 1]);
  assert.deepEqual(niceTicks(7, true), [0, 5, 10]);
  assert.deepEqual(niceTicks(1), [0, 0.5, 1]);
});

const people = {
  mine: { nodes: [
    { number: 1, title: "Merged Monday", url: "u", createdAt: "2026-10-19T08:00:00Z", mergedAt: "2026-10-19T12:00:00Z", state: "MERGED", isDraft: false, repository: { nameWithOwner: "ACME/a" }, reviews: { nodes: [{ submittedAt: "2026-10-19T08:05:00Z", author: { login: "copilot-pull-request-reviewer" } }, { submittedAt: "2026-10-19T10:00:00Z", author: { login: "per" } }] }, timelineItems: { nodes: [{ createdAt: "2026-10-19T09:00:00Z" }] } },
    { number: 2, title: "Merged last week", url: "u", createdAt: "2026-10-12T08:00:00Z", mergedAt: "2026-10-14T08:00:00Z", state: "MERGED", isDraft: false, repository: { nameWithOwner: "ACME/a" }, reviews: { nodes: [{ submittedAt: "2026-10-12T09:00:00Z", author: { login: "me" } }] }, timelineItems: { nodes: [] } },
    { number: 3, title: "Open", url: "u", createdAt: "2026-10-20T08:00:00Z", state: "OPEN", isDraft: true, repository: { nameWithOwner: "ACME/a" }, reviews: { nodes: [] }, timelineItems: { nodes: [] } },
    null,
    { title: "no number" },
  ] },
  reviewed: { nodes: [{ reviews: { nodes: [{ submittedAt: "2026-10-20T10:00:00Z" }, { submittedAt: "2026-10-13T10:00:00Z" }] } }] },
  open: { nodes: [{ number: 3, title: H, url: "javascript:alert(1)", createdAt: "2026-09-01T08:00:00Z", isDraft: false, repository: { nameWithOwner: `ACME/${H}` } }] },
  asked: { nodes: [] },
  w11: { issueCount: 91 },
  w10: { issueCount: 169 },
};
const repos = { organization: { repositories: { nodes: [
  { nameWithOwner: "ACME/a", isArchived: false, releases: { nodes: [{ createdAt: "2026-10-20T10:00:00Z", tagName: "v2", isPrerelease: false, isDraft: false }, { createdAt: "2026-10-20T11:00:00Z", tagName: "v3-rc", isPrerelease: true, isDraft: false }] }, defaultBranchRef: { target: { history: { nodes: [{ committedDate: "2026-10-20T10:00:00Z", statusCheckRollup: { state: "FAILURE" } }, { committedDate: "2026-10-21T10:00:00Z", statusCheckRollup: { state: "SUCCESS" } }, { committedDate: "2026-10-21T11:00:00Z", statusCheckRollup: null }] } } } },
  { nameWithOwner: "ACME/old", isArchived: true, releases: { nodes: [{ createdAt: "2026-10-20T10:00:00Z", tagName: "x", isPrerelease: false, isDraft: false }] } },
] } } };

test("GHE's answers into weeks: merged, reviews given, the org's counts, releases, main red, waits (bots don't count as a review)", () => {
  const h = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  assert.equal(h.mine.length, 3, "odd nodes are left out");
  assert.equal(h.mine[0]!.firstReviewAt, "2026-10-19T10:00:00Z", "Copilot's review isn't someone looking");
  assert.equal(h.mine[1]!.firstReviewAt, undefined, "nor is my own");
  assert.ok(isBot("dependabot[bot]") && isBot("copilot-pull-request-reviewer") && !isBot("per"));
  const w = weekly(h, NOW);
  assert.deepEqual(w.mergedMine.slice(-2), [1, 1]);
  assert.deepEqual(w.reviewsGiven.slice(-2), [1, 1]);
  assert.deepEqual(w.orgMerged.slice(-2), [169, 91]);
  assert.equal(w.orgMerged[0], undefined, "a week GHE didn't count stays empty, not 0");
  assert.equal(w.releases[11], 1, "no prereleases, nothing from archived repos");
  assert.deepEqual(w.red[11], { pct: 50, bad: 1, of: 2 }, "a commit without checks isn't counted either way");
  assert.equal(w.red[0], undefined);
  assert.deepEqual(w.waits[11], { review: 1, merge: 3, n: 1 }, "from ready, not from opened");
});

test("spend: Claude Code's running total by the day of the line before it; omp's per message", () => {
  const claude = [
    `{"type":"user","timestamp":"2026-10-20T21:00:00.000Z","message":{}}`,
    `{"type":"cost-state","totalCostUSD":1.5}`,
    `{"type":"assistant","message":{"content":"x"},"timestamp":"2026-10-20T22:30:00.000Z"}`,
    `{"type":"cost-state","totalCostUSD":4}`,
    `{"type":"cost-state","totalCostUSD":4}`,
    `{"type":"cost-state","totalCostUSD":0.5}`,
    `not json`,
  ];
  // 22:30Z is past midnight in Oslo: the 21st.
  assert.deepEqual([...claudeCostDays(claude, "Europe/Oslo")], [["2026-10-20", 1.5], ["2026-10-21", 3]]);
  const omp = [
    `{"type":"message","timestamp":"2026-10-21T08:00:00Z","message":{"role":"assistant","usage":{"cost":{"total":0.25}}}}`,
    `{"type":"message","timestamp":"2026-10-21T09:00:00Z","message":{"role":"user","content":"${"x"}"}}`,
    `{"type":"message","timestamp":"2026-10-22T09:00:00Z","message":{"role":"assistant","usage":{"cost":{"total":0.5}}}}`,
  ];
  assert.deepEqual([...ompCostDays(omp, "Europe/Oslo")], [["2026-10-21", 0.25], ["2026-10-22", 0.5]]);
});

test("spend from the folders: Claude Code's projects and omp's sessions, read again only when a file changes", async (t) => {
  setWhen({ tz: "UTC" });
  t.after(resetWhen);
  const home = mkdtempSync(join(tmpdir(), "spend-"));
  mkdirSync(join(home, ".claude", "projects", "C--Code-a"), { recursive: true });
  mkdirSync(join(home, ".omp", "agent", "sessions", "-Code"), { recursive: true });
  const cf = join(home, ".claude", "projects", "C--Code-a", "s1.jsonl");
  writeFileSync(cf, `{"type":"user","timestamp":"2026-10-22T08:00:00.000Z"}\n{"type":"cost-state","totalCostUSD":2}\n`);
  writeFileSync(join(home, ".omp", "agent", "sessions", "-Code", "2026_x.jsonl"), `{"timestamp":"2026-10-22T09:00:00Z","message":{"role":"assistant","usage":{"cost":{"total":0.1}}}}\n`);
  const s = createSpend({ claudeDir: join(home, ".claude"), ompDirs: [join(home, ".omp", "agent")], days: 3, now: () => NOW });
  const days = await s.days();
  assert.equal(days.at(-1)!.day, "2026-10-22");
  assert.deepEqual({ ...days.at(-1)! }, { day: "2026-10-22", claude: 2, omp: 0.1, sessions: 2 });
  writeFileSync(cf, `{"type":"user","timestamp":"2026-10-22T08:00:00.000Z"}\n{"type":"cost-state","totalCostUSD":2}\n{"type":"cost-state","totalCostUSD":5}\n`);
  assert.equal((await s.days()).at(-1)!.claude, 5);
});

test("hosted: kept in D1, so a fresh isolate draws the last one; refresh resolves once it's kept; a lost gather starts again", async () => {
  const { DB } = openDb();
  let now = NOW;
  let calls = 0;
  let hang = false;
  const h = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  const gather = async () => {
    calls++;
    if (hang) return new Promise<never>(() => {});
    return { ...h, at: now };
  };
  const make = () => createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", kept: d1HistoryKept(DB), now: () => now, gather, log: () => {} });
  const a = make();
  await a.refresh();
  assert.equal(calls, 1);
  const row = await DB.prepare("SELECT value FROM settings WHERE key = 'history'").first<{ value: string }>();
  assert.equal(JSON.parse(row!.value).login, "me", "kept by the time refresh resolves");

  const b = make();
  await b.refresh();
  assert.equal(calls, 1, "a fresh isolate reads the kept one, no gather");
  assert.equal(b.view().history?.mine.length, 3);

  // A gather cut off with its request never settles: past five minutes it's lost, and one starts again.
  now += 7 * 3600e3;
  hang = true;
  void b.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(b.view().gathering, true);
  void b.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2, "still in flight");
  now += 6 * 60e3;
  assert.equal(b.view().gathering, false, "lost");
  hang = false;
  await b.refresh();
  assert.equal(calls, 3, "gathered again");
  assert.equal(b.view().gathering, false);
});

test("kept and gathered when due: once at a time, again after six hours or when asked; a failure keeps what was there", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "stats-")), "stats.json");
  let now = NOW;
  let calls = 0;
  let fail = false;
  const h = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  const changed: number[] = [];
  const gather = async () => {
    calls++;
    if (fail) throw new Error("GHE graphql: 502");
    return { ...h, at: now };
  };
  const s = createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", file, now: () => now, gather, onChange: () => changed.push(now) });
  s.refresh();
  s.refresh();
  assert.equal(s.view().gathering, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "once at a time");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).login, "me", "kept");
  assert.equal(createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", file, now: () => now, gather }).view().history?.mine.length, 3, "read back after a restart");
  now += 3600e3;
  s.refresh();
  assert.equal(calls, 1, "not due yet");
  now += 6 * 3600e3;
  fail = true;
  s.refresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.match(s.view().historyError!, /502/);
  assert.equal(s.view().history?.mine.length, 3, "what was there stays");
  assert.ok(changed.length >= 2);
});

const F = { operator: "me", nav: [] };
/** /stats as the history pack (and, given spend, the agents pack) draw it. */
function drawn(v: HistoryView, o: { spend?: SpendDay[]; forge?: string; layout?: { statsWeeks?: 4 | 12 | 26; statsDays?: 14 | 28; stats?: Record<string, { show: boolean; order: number }> } } = {}) {
  const weeks = o.layout?.statsWeeks ?? 12;
  const days = o.layout?.statsDays;
  const packs = [statPack(() => historyStats(v, { now: NOW, weeks, days, forge: o.forge ?? "GitHub" }), "history"), ...(o.spend ? [statPack(() => spendStats(o.spend), "agents")] : [])];
  const out = statsFrom(packs, () => ({}) as PackContext, days ? Math.ceil(days / 7) + 1 : weeks, () => {}, days);
  return String(statsPage(F, { packs: out, layout: o.layout, gather: true }));
}

test("the page: tiles, charts with a hover target and a table for each, open PRs by age; titles and repos drawn inert, links defused", async () => {
  const h: History = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  const page = drawn({ history: h, gathering: false }, { spend: [{ day: "2026-10-22", claude: 329.1, omp: 0.17, sessions: 3 }] });
  assertInert("stats", page);
  assert.doesNotMatch(page, /href="javascript:/);
  assert.match(page, /<p class="kpi-l">Merged, this week<\/p><p class="kpi-v">1<\/p>/);
  assert.match(page, /<p class="kpi-v">\$329<\/p>/);
  assert.match(page, /<g class="vt" tabindex="0" data-tip="1 Merged\n1 Reviews given\nw42 · 12 Oct – 18 Oct">/);
  assert.match(page, /<g class="vt part" tabindex="0"/, "this week, so far");
  assert.equal(page.match(/<details class="vtable">/g)?.length, 6, "every chart has its table (the age list shows its numbers as text)");
  assert.match(page, /<text class="vdl"[^>]*>\$329<\/text>/, "the label in money, the axis short");
  assert.match(page, /<meta name="u-topics" content="stats">/);
  assert.match(page, /class="vb warn"/, "a PR over two weeks old is marked");
  assert.match(page, /Gather again/);
  // Nothing gathered yet: says so, and draws without history.
  assert.match(drawn({ gathering: true }), /Gathering the weeks from GitHub/);
  // Names the forge when it is not GitHub
  assert.match(drawn({ gathering: true }, { forge: "GitLab" }), /Gathering the weeks from GitLab/);
  assert.match(drawn({ historyError: "502 Bad Gateway", gathering: false }, { forge: "GitLab" }), /GitLab didn&#39;t answer/);
  // Columns: a hostile series name and tip are text.
  assertInert("chart", String(columns({ title: H, labels: [H], tips: [H], fmt: String, series: [{ name: H, tone: "c1", values: [3] }] })));
});

test("/stats in the app: in the menu, a visit gathers when due, Gather again asks at once", async () => {
  let calls = 0;
  const pack = historyPack({ history: (changed) => createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", onChange: changed, gather: async () => (calls++, historyOf(people, repos, { login: "me", weeks: weeksOf(Date.now()), now: Date.now() })) }) });
  const { get, post } = packApp([pack]);
  const first = await (await get("/stats")).text();
  assert.match(first, /<a href="\/stats" title="Stats" aria-current="page">/);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.match(await (await get("/stats")).text(), /Merged, this week/);
  const res = await post("/stats/refresh", {});
  assert.equal(res.status, 303);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
});

// ── #142: 26 weeks ──

test("26 weeks: a visit asks for them, the kept 12 are gathered again at once, and the page says so meanwhile", async () => {
  const asked: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stats = createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", gather: async (_g, _o, _l, now, n) => (asked.push(n ?? 12), await gate, historyOf(people, repos, { login: "me", weeks: weeksOf(now, n), now })) });
  stats.refresh();
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [12], "12 by default");
  assert.equal(stats.view().history!.weeks, 12);
  stats.refresh(false, { weeks: 4 });
  assert.deepEqual(asked, [12], "4 shown: the kept 12 are enough");
  stats.refresh(false, { weeks: 26 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [12, 26], "26 shown: gathered at once, though not due");
  const h = stats.view().history!;
  assert.equal(h.weeks, 26);
  assert.equal(weekly(h, Date.now()).weeks.length, 26);
  stats.refresh(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [12, 26, 26], "and kept for the next gather");

  const short = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  const page = drawn({ history: short, gathering: true }, { layout: { statsWeeks: 26 } });
  assert.match(page, /Last 26 weeks/);
  assert.match(page, /12 weeks until the gather for 26 ends/);
  const long = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW, 26), now: NOW });
  assert.doesNotMatch(drawn({ history: long, gathering: false }, { layout: { statsWeeks: 26 } }), /until the gather/);
});

test("days: the last 14 by day, the org counted per day only when asked, the tiles stay weekly, packs told", async () => {
  const d = daysOf(NOW, 14);
  assert.deepEqual([d.length, d[13]!.key, d[0]!.key, d[13]!.label], [14, "2026-10-22", "2026-10-09", "22"]);
  const h = historyOf({ ...people, d13: { issueCount: 7 }, d12: { issueCount: 3 } }, repos, { login: "me", weeks: weeksOf(NOW), days: d, now: NOW });
  assert.deepEqual([h.days, h.orgMergedDays], [14, [{ day: "2026-10-21", n: 3 }, { day: "2026-10-22", n: 7 }]]);
  const w = weekly(h, NOW, 14);
  assert.equal(w.weeks.length, 14);
  assert.deepEqual(w.orgMerged.slice(-3), [undefined, 3, 7]);
  assert.equal(w.mergedMine[w.weeks.findIndex((x) => x.key === "2026-10-19")], 1, "merged Monday, counted on Monday");
  assert.deepEqual(w.red.slice(-3), [{ pct: 100, bad: 1, of: 1 }, { pct: 0, bad: 0, of: 1 }, undefined]);
  assert.equal(historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW }).days, undefined, "not asked: no days");

  const asked: [number | undefined, number | undefined][] = [];
  const stats = createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", gather: async (_g, _o, _l, now, n, nd) => (asked.push([n, nd]), historyOf(people, repos, { login: "me", weeks: weeksOf(now, n), days: nd ? daysOf(now, nd) : undefined, now })) });
  stats.refresh(false, { weeks: 12 });
  await new Promise((r) => setImmediate(r));
  stats.refresh(false, { weeks: 12, days: 28 });
  await new Promise((r) => setImmediate(r));
  stats.refresh(false, { weeks: 12, days: 14 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, [[12, 0], [12, 28]], "28 days gathered at once; 14 are inside them");

  const page = drawn({ history: h, gathering: false }, { layout: { statsDays: 14 } });
  assert.match(page, /Last 14 days\./);
  assert.match(page, /You, per day/);
  assert.match(page, /The org, merged PRs per day/);
  assert.match(page, /Thu 22 Oct/, "a day's tip");
  assert.match(page, /Merged, this week/, "the tiles stay weekly");
  const waiting = drawn({ history: historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW }), gathering: true }, { layout: { statsDays: 28 } });
  assert.match(waiting, /Last 28 days/);
  assert.match(waiting, /by day once the gather ends/);

  assert.deepEqual(layoutOf({ statsDays: 14 }), { statsDays: 14 });
  assert.deepEqual(layoutOf({ statsDays: 7 }), {});
  const form = layoutFromForm({ statsWeeks: "28d" }, { hrefs: [], cards: [], feeds: [], packs: [], stats: [] });
  assert.deepEqual([form.statsWeeks, form.statsDays], [undefined, 28]);
  let told: unknown;
  statsFrom([statPack((_c, o) => ((told = o), []))], () => ({}) as PackContext, 5, () => {}, 28);
  assert.deepEqual(told, { weeks: 5, days: 28 });
  statsFrom([statPack((_c, o) => ((told = o), []))], () => ({}) as PackContext, 12, () => {});
  assert.deepEqual(told, { weeks: 12 });
});

test("gatherHistory: each owner's repos by repositoryOwner, a user or an org, read together (#294)", async () => {
  const queries: string[] = [];
  const repo = (name: string) => ({ nameWithOwner: name, isArchived: false, releases: { nodes: [{ createdAt: new Date(NOW - 86400e3).toISOString(), tagName: "v1", isPrerelease: false, isDraft: false }] }, defaultBranchRef: null });
  const ghe = {
    ...fakeGhe({}).ghe,
    async graphql<T>(q: string): Promise<T> {
      queries.push(q);
      if (q.includes("repositoryOwner")) return { o0: { repositories: { nodes: [repo("me/app")] } }, o1: { repositories: { nodes: [repo("ACME/site")] } } } as T;
      if (q.includes("s: search")) return { s: { pageInfo: { hasNextPage: false }, nodes: [] } } as T;
      return {} as T;
    },
  };
  const h = await gatherHistory(ghe, "me, ACME", "me", NOW);
  const owners = queries.find((q) => q.includes("repositoryOwner")) ?? "";
  assert.match(owners, /o0: repositoryOwner\(login: "me"\)/);
  assert.match(owners, /o1: repositoryOwner\(login: "ACME"\)/);
  assert.doesNotMatch(queries.join("\n"), /organization\(/);
  assert.deepEqual(h.releases.map((r) => r.repo).sort(), ["ACME/site", "me/app"]);
});

test("a gather that fails is logged, and the background waits half an hour before the next; Gather again goes at once", async () => {
  let now = NOW;
  let calls = 0;
  const lines: string[] = [];
  const s = createStats({ ghe: fakeGhe({}).ghe, org: () => "ACME", login: () => "me", now: () => now, log: (l) => lines.push(l), gather: async () => (calls++, Promise.reject(new Error("Could not resolve to an Organization"))) });
  await s.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(lines, ["history: the gather failed: Could not resolve to an Organization"]);
  assert.equal(s.view().historyError, "Could not resolve to an Organization");
  now += 5 * 60e3;
  await s.refresh();
  assert.equal(calls, 1, "the next cron doesn't try again");
  await s.refresh(true);
  assert.equal(calls, 2, "Gather again does");
  now += 31 * 60e3;
  await s.refresh();
  assert.equal(calls, 3, "and half an hour on, the background does");
});

test("main red: a repo with more commits than one page counts only in the weeks that page reaches", () => {
  const busy = { organization: { repositories: { nodes: [
    { nameWithOwner: "ACME/busy", isArchived: false, defaultBranchRef: { target: { history: { pageInfo: { hasNextPage: true }, nodes: [{ committedDate: "2026-10-21T10:00:00Z", statusCheckRollup: { state: "SUCCESS" } }, { committedDate: "2026-10-20T10:00:00Z", statusCheckRollup: { state: "FAILURE" } }, { committedDate: "2026-10-16T10:00:00Z", statusCheckRollup: { state: "SUCCESS" } }] } } } },
    { nameWithOwner: "ACME/calm", isArchived: false, defaultBranchRef: { target: { history: { pageInfo: { hasNextPage: false }, nodes: [{ committedDate: "2026-10-13T10:00:00Z", statusCheckRollup: { state: "FAILURE" } }] } } } },
  ] } } };
  const h = historyOf(people, busy, { login: "me", weeks: weeksOf(NOW), now: NOW });
  assert.deepEqual(h.commitsFrom, { "ACME/busy": "2026-10-16T10:00:00Z" });
  const w = weekly({ ...h, commits: [...h.commits, { repo: "ACME/busy", at: "2026-10-14T10:00:00Z", state: "SUCCESS" }] }, NOW);
  assert.deepEqual(w.red[11], { pct: 50, bad: 1, of: 2 });
  assert.deepEqual(w.red[10], { pct: 100, bad: 1, of: 1 }, "the week busy's page starts in is partial: only calm counts");
  assert.equal(historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW }).commitsFrom, undefined);
});

// ── #93: packs add stats, and I choose what Stats shows ──

const statPack = (stats: Pack["stats"], id = "linear"): Pack => ({ manifest: { api: PACK_API, id, name: id === "linear" ? "Linear" : id, description: "", domain: "work" }, stats });
const cycle: PackStat = { id: "cycle", title: "Issues closed per week", unit: "count", labels: ["w41", "w42", "w43"], series: [{ name: "Closed", values: [4, 7, 2] }] };

test("layout: stats placements and weeks read strictly; placeStats hides and orders, the rest keep the code's order", () => {
  assert.deepEqual(layoutOf({ stats: { "you-weekly": { show: false, order: 3 }, "linear:cycle": { show: true, order: 1.6 }, "Bad Id": { show: true, order: 1 }, x: { show: "yes" } }, statsWeeks: 4 }), {
    stats: { "history:you-weekly": { show: false, order: 3 }, "linear:cycle": { show: true, order: 2 } },
    statsWeeks: 4,
  });
  assert.deepEqual(layoutOf({ statsWeeks: 26 }), { statsWeeks: 26 });
  assert.deepEqual(layoutOf({ statsWeeks: 52 }), {}, "52 weeks isn't on offer");
  const offers = ["a", "b", "c", "d"].map((id) => ({ id }));
  assert.deepEqual(placeStats(offers, { c: { show: true, order: 1 }, b: { show: false, order: 0 } }).map((o) => o.id), ["c", "a", "d"]);
  assert.deepEqual(placeStats(offers, undefined).map((o) => o.id), ["a", "b", "c", "d"]);
  const form = layoutFromForm({ "stat:a": "off", "statorder:a": "5", "stat:linear:cycle": "on", "statorder:linear:cycle": "1", "stat:nope": "on", statsWeeks: "4" }, { hrefs: [], cards: [], feeds: [], packs: [], stats: ["a", "linear:cycle"] });
  assert.deepEqual([form.stats, form.statsWeeks], [{ a: { show: false, order: 5 }, "linear:cycle": { show: true, order: 1 } }, 4]);
});

test("statsFrom: ids under the pack's, text cut, two series, finite numbers; a pack that throws adds nothing", () => {
  const logged: string[] = [];
  const out = statsFrom(
    [
      statPack(() => [cycle, { ...cycle }, { id: "Bad Id", title: "x", value: 1 }, { id: "big", title: "x".repeat(300), unit: "nope" as StatUnit, labels: ["a"], series: [{ name: "1", values: [Infinity] }, { name: "2", values: [1] }, { name: "3", values: [2] }] }, { id: "open", title: "Open", value: Number.NaN, empty: "Connect Linear" }]),
      statPack(() => {
        throw new Error("down");
      }, "broken"),
    ],
    () => ({}) as PackContext,
    12,
    (id, line) => logged.push(`${id}: ${line}`),
  );
  assert.deepEqual(out.map((s) => s.id), ["linear:cycle", "linear:big", "linear:open"]);
  const big = out[1]!;
  assert.ok(big.kind === "chart" && big.series.length === 2 && big.series[0]!.values[0] === undefined);
  assert.equal(big.title.length, 80);
  assert.equal(big.unit, "count");
  assert.ok(out[2]!.kind === "tile" && out[2]!.value === undefined);
  assert.deepEqual(logged, ["broken: stats: down"]);
});

test("the page: my order, hidden panels gone, 4 weeks, pack panels and tiles with empty states; hostile pack text is inert", () => {
  const h: History = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  const packs = statsFrom([statPack(() => [cycle, { id: "open", title: "Open issues", value: 12, note: "3 urgent", trend: [10, 11, 12] }, { id: "later", title: "Sentry", empty: "Connect Sentry to see errors", labels: [], series: [] }])], () => ({}) as PackContext, 4, () => {});
  const page = String(statsPage(F, { packs: [...packs, ...statsFrom([statPack(() => historyStats({ history: h, gathering: false }, { now: NOW, weeks: 4, forge: "GitHub" }), "history")], () => ({}) as PackContext, 4, () => {})], layout: { stats: { "linear:cycle": { show: true, order: 1 }, "history:org-merged": { show: false, order: 0 } }, statsWeeks: 4 } }));
  assert.ok(page.indexOf("Issues closed per week") < page.indexOf("You, per week"), "my order");
  assert.doesNotMatch(page, /The org, merged PRs per week/, "hidden");
  assert.match(page, /Last 4 weeks/);
  assert.match(page, /<p class="kpi-l">Open issues<\/p><p class="kpi-v">12<\/p><p class="kpi-n">3 urgent<\/p>/);
  assert.match(page, /Connect Sentry to see errors/);
  assert.equal((page.match(/<details class="vtable">[^]*?<\/details>/)![0].match(/<tr><th scope="row">/g) ?? []).length, 3, "the first chart (the pack's) has its three weeks");
  assert.match(page, /data-tip="2 Merged\n0 Reviews given\nw43|data-tip="[^"]*w40/, "the GitHub charts span 4 weeks");
  assert.doesNotMatch(page, /w32/, "not twelve");
  const all = String(statsPage(F, { packs, layout: { stats: Object.fromEntries(statOffers(packs).map((o) => [o.id, { show: false, order: 0 }])) } }));
  assert.match(all, /Every panel is hidden/);
  const hostile = statsFrom([statPack(() => [{ id: "h", title: H, meta: H, empty: H, labels: [H], tips: [H], series: [{ name: H, values: [1] }] }, { id: "t", title: H, value: 1, note: H }, { id: "e", title: H, empty: H, labels: [], series: [] }])], () => ({}) as PackContext, 12, () => {});
  assertInert("pack stats", String(statsPage(F, { packs: hostile })));
  // A bar list: hostile text inert, a hostile link defused.
  const bars = statsFrom([statPack(() => [{ id: "b", title: H, bars: [{ label: H, sub: H, note: H, href: "javascript:alert(1)", value: 3, warn: true }, { label: "", value: 1 }, { label: "x", value: Number.NaN }] }])], () => ({}) as PackContext, 12, () => {});
  assert.ok(bars[0]!.kind === "bars" && bars[0]!.bars.length === 1, "an empty label or no number is dropped");
  const barPage = String(statsPage(F, { packs: bars }));
  assertInert("pack bars", barPage);
  assert.doesNotMatch(barPage, /href="javascript:/);
});

test("/stats without the history pack: the packs' panels only, no Gather again; Settings chooses, and /stats follows", async () => {
  const { get, post } = packApp([statPack(() => [cycle])], { forge: { id: "plain", name: "Plain", can: [] } });
  const page = await (await get("/stats")).text();
  assert.match(page, /Issues closed per week/);
  assert.doesNotMatch(page, /Gather again|Merged, this week|Gathering the weeks/, "the pack reads nothing again when asked");
  const settings = await (await get("/settings/layout")).text();
  assert.match(settings, /name="stat:linear:cycle"/);
  assert.match(settings, /name="statsWeeks"/);
  const saved = await post("/settings/layout", { pack: "linear", "stat:linear:cycle": "off", "statorder:linear:cycle": "10", statsWeeks: "4" });
  assert.equal(saved.status, 303);
  const after = await (await get("/stats")).text();
  assert.doesNotMatch(after, /Issues closed per week/);
  assert.match(after, /Last 4 weeks/);
  assert.match(after, /Every panel is hidden/, "spend isn't read in this app, so the pack's panel was the only one");
  // No pack with stats: no Stats page at all.
  assert.equal((await packApp([], { forge: { id: "plain", name: "Plain", can: [] } }).get("/stats")).status, 404);
});
