/** Stats: weeks in Oslo, GHE's answers read into weeks, spend from transcripts, kept and gathered when due, and a page that draws any title inert. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { statsPage } from "../src/pages/stats.ts";
import { type History, historyOf, isBot, median, weekly, weeksOf } from "../src/stats/history.ts";
import { claudeCostDays, createSpend, ompCostDays } from "../src/stats/spend.ts";
import { createStats } from "../src/stats/stats.ts";
import { columns, niceTicks } from "../src/ui/chart.ts";
import { H, assertInert, fakeGhe, fixedGatherer, snapshot } from "./helpers.ts";

const NOW = Date.parse("2026-10-22T14:00:00Z"); // a Thursday, week 43

test("weeks: twelve, Monday to Monday in Oslo, the last one this week", () => {
  const w = weeksOf(NOW);
  assert.equal(w.length, 12);
  assert.deepEqual([w[11]!.key, w[11]!.label, w[0]!.key, w[0]!.label], ["2026-10-19", "w43", "2026-08-03", "w32"]);
  // Late Sunday evening in Oslo is still that week, though it's Monday in some other places.
  assert.equal(weeksOf(Date.parse("2026-10-25T21:30:00Z"))[11]!.key, "2026-10-19");
  assert.equal(weeksOf(Date.parse("2026-10-25T23:30:00Z"))[11]!.key, "2026-10-26");
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), undefined);
  assert.deepEqual(niceTicks(41), [0, 20, 40, 60]);
  assert.deepEqual(niceTicks(0), [0, 1]);
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
  assert.deepEqual([...claudeCostDays(claude)], [["2026-10-20", 1.5], ["2026-10-21", 3]]);
  const omp = [
    `{"type":"message","timestamp":"2026-10-21T08:00:00Z","message":{"role":"assistant","usage":{"cost":{"total":0.25}}}}`,
    `{"type":"message","timestamp":"2026-10-21T09:00:00Z","message":{"role":"user","content":"${"x"}"}}`,
    `{"type":"message","timestamp":"2026-10-22T09:00:00Z","message":{"role":"assistant","usage":{"cost":{"total":0.5}}}}`,
  ];
  assert.deepEqual([...ompCostDays(omp)], [["2026-10-21", 0.25], ["2026-10-22", 0.5]]);
});

test("spend from the folders: Claude Code's projects and omp's sessions, read again only when a file changes", async () => {
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
  const s = createStats({ ghe: fakeGhe({}).ghe, org: "ACME", login: () => "me", file, now: () => now, gather, onChange: () => changed.push(now) });
  s.refresh();
  s.refresh();
  assert.equal(s.view().gathering, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "once at a time");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).login, "me", "kept");
  assert.equal(createStats({ ghe: fakeGhe({}).ghe, org: "ACME", login: () => "me", file, now: () => now, gather }).view().history?.mine.length, 3, "read back after a restart");
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

test("the page: tiles, charts with a hover target and a table for each, open PRs by age; titles and repos drawn inert, links defused", async () => {
  const h: History = historyOf(people, repos, { login: "me", weeks: weeksOf(NOW), now: NOW });
  const page = String(statsPage({ operator: "me", nav: [] }, { history: h, gathering: false, spend: [{ day: "2026-10-22", claude: 329.1, omp: 0.17, sessions: 3 }] }, { now: NOW }));
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
  // Nothing gathered yet: says so, and draws without history.
  const empty = String(statsPage({ operator: "me", nav: [] }, { gathering: true }, { now: NOW }));
  assert.match(empty, /Gathering twelve weeks from GitHub/);
  // Names the forge when it is not GitHub
  const gitlab = String(statsPage({ operator: "me", nav: [] }, { gathering: true }, { now: NOW, forge: { name: "GitLab", can: ["stats"] } }));
  assert.match(gitlab, /Gathering twelve weeks from GitLab/);
  const errored = String(statsPage({ operator: "me", nav: [] }, { historyError: "502 Bad Gateway", gathering: false }, { now: NOW, forge: { name: "GitLab", can: ["stats"] } }));
  assert.match(errored, /GitLab didn't answer/);
  // Columns: a hostile series name and tip are text.
  assertInert("chart", String(columns({ title: H, labels: [H], tips: [H], fmt: String, series: [{ name: H, tone: "c1", values: [3] }] })));
});

test("/stats in the app: in the menu, a visit gathers when due, Gather again asks at once", async () => {
  let calls = 0;
  const s = snapshot({ login: "me" });
  const stats = createStats({ ghe: fakeGhe({}).ghe, org: "ACME", login: () => "me", gather: async () => (calls++, historyOf(people, repos, { login: "me", weeks: weeksOf(Date.now()), now: Date.now() })) });
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DB: openDb().DB }, { gatherer: fixedGatherer(s), ghe: fakeGhe({}).ghe, stats });
  const get = (p: string) => app.request(`http://localhost${p}`, { headers: { cookie: "u_tk=test-token" } });
  const first = await (await get("/stats")).text();
  assert.match(first, /<a href="\/stats" title="Stats" aria-current="page">/);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.match(await (await get("/stats")).text(), /Merged, this week/);
  const res = await app.request("http://localhost/stats/refresh", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost" } });
  assert.equal(res.status, 303);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
});
