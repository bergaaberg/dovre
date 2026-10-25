/** What the agents pack adds to core pages: Today (card, numbers, sentence, horizon row, feed), search and Bino. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Desk, DeskView } from "../../../../agents/desk.ts";
import type { Dismissed } from "../../../../agents/dismissed.ts";
import type { Run } from "../../../../agents/runner.ts";
import { packFeedOf } from "../../../../home/feed.ts";
import { briefingFrom } from "../../../registry.ts";
import { testContext } from "../../../testing.ts";
import { aboutAgentPage, agentsForBino } from "../bino.ts";
import { agentFinds } from "../finds.ts";
import { fixedHere } from "../here.ts";
import { agentsPack } from "../index.ts";
import { agentBrief, agentFeed, agentGlance, agentLane, agentPicks, agentsCard } from "../today.ts";
import { H, assertInert, session, signedIn, snapshot } from "../../../../../test/helpers.ts";

const now = Date.parse("2026-10-22T20:00:00Z");
const run = (id: string, o: Partial<Run> = {}) => ({ id, harness: "claude", status: "done", startedAt: now - 3600e3, events: [], prompt: id, repo: "shop-api", forked: false, cost: 0, ...o }) as unknown as Run;
const denied = [{ t: "denied", tool: "Bash", spec: "Bash(x)", detail: "x" }] as Run["events"];
const none = { live: [], recent: [] };
const text = (bits: ReturnType<typeof agentBrief>) => bits.map((b) => (typeof b === "string" ? b : b.code ? `\`${b.code}\`` : b.text)).join("");
const desk = (v: Partial<DeskView> = {}): Desk => ({ view: () => ({ here: true, online: true, harnesses: ["claude"], runs: [], workDir: "/w", ...v }) }) as unknown as Desk;
const notDismissed: Dismissed = { ready: Promise.resolve(), has: () => false, add: async () => {}, remove: async () => {} };

// The session from the evening of 2026-10-22: six turns, each "needing an OK", one conversation.
const turns = [3.705, 4.165, 4.362, 4.456, 4.54, 4.582].map((cost, i) => run(`t${i}`, { sessionId: "s1", cost, startedAt: now - (60 - i) * 60e3, events: denied }));

test("the card shows what needs me first, five at most; runs here that finished fine are only counted", () => {
  const r = (id: string, status: Run["status"], o: Partial<Run> = {}) => run(id, { status, prompt: "x", repo: "r", ...o });
  const live = [session({ sessionId: "idle", status: "idle", statusSince: now - 60e3 }), session({ sessionId: "busy", status: "busy" }), session({ sessionId: "ok?", status: "waiting" })];
  const runs = [r("done", "done"), r("done2", "done"), r("asks", "done", { events: denied }), r("work", "running"), r("old", "done", { startedAt: now - 7 * 3600e3 })];
  const p = agentPicks(live, runs, now, 4);
  assert.deepEqual(p.shown.map((x) => (x.kind === "run" ? x.run.id : x.session.sessionId)), ["asks", "ok?", "work", "busy"]);
  assert.equal(p.more, 1, "the idle session is a link away");
  assert.equal(p.done, 2);
});

test("a session is one row on the card however many times it was answered", () => {
  const p = agentPicks([], [...turns, run("solo", { startedAt: now - 10e3 })], now);
  assert.equal(p.shown.filter((x) => x.kind === "run" && x.run.sessionId === "s1").length, 1, "one row for six turns");
});

test("the day's spend counts a session started here once, not once per turn and again from Claude Code's list", () => {
  const spend = (sessions: Parameters<typeof agentGlance>[0]) => Number(String(agentGlance(sessions, turns, now)[1]!.value).slice(1));
  assert.equal(spend({ live: [], recent: [session({ sessionId: "s1", live: false, lastAt: new Date(now - 60e3).toISOString(), cost: 4.582 })] }), 5);
  assert.equal(spend(none), 5, "from the runs alone, the turns add up to the total");
  const g = agentGlance({ live: [session({ cost: 2 })], recent: [session({ live: false, cost: 3, lastAt: new Date(now - 3600e3).toISOString() })] }, [], now);
  assert.deepEqual(g, [{ label: "Agents live", value: 1 }, { label: "Agent spend", value: "$5" }]);
});

test("the sentence: one agent asking names what for; several are counted; idle ones wait; none says nothing", () => {
  assert.equal(text(agentBrief([session({ status: "waiting", waitingFor: "dotnet test" })], [])), "one agent wants your OK for `dotnet test`.");
  assert.equal(text(agentBrief([session({ status: "waiting" })], [turns[5]!])), "two agents need your OK.", "a turn here that was refused asks too");
  assert.equal(text(agentBrief([session({ status: "idle" })], [])), "one agent waits for you.");
  assert.deepEqual(agentBrief([session({ status: "busy" })], []), []);
});

test("the horizon row: the day's stopped sessions by cost, the live ones at the right", () => {
  const lane = agentLane({ live: [session({ title: "Fix" })], recent: [session({ live: false, title: "Old", cost: 4, lastAt: new Date(now - 2 * 86400e3).toISOString() }), session({ live: false, title: "New", cost: 4, lastAt: new Date(now - 3600e3).toISOString() })] }, now);
  assert.deepEqual(lane.marks.map((m) => [m.title, !!m.live]), [["New · $4.00", false], ["Fix (running)", true]]);
  assert.equal(lane.label, "Agents");
});

test("feed events: sessions changing state and runs here, a new key when an agent's state changes", () => {
  const live = (status: "waiting" | "busy", since: number) => ({ live: [session({ sessionId: "s-9", status, waitingFor: "Bash", statusSince: since, title: "Fix the tests" })], recent: [] });
  const f = agentFeed(live("waiting", now - 60e3), [run("r1", { startedAt: now - 120e3, endedAt: now - 90e3, status: "failed" }), run("gone", { startedAt: now - 2 * 86400e3 })], now);
  assert.deepEqual(f.map((e) => [e.who, e.what, e.tone, !!e.mine]), [["Agent", "needs your OK: Bash", "bad", false], ["You", "started an agent", "acc", true], ["Agent", "failed", "bad", false]]);
  assert.notEqual(agentFeed(live("busy", now - 30e3), [], now)[0]!.key, f[0]!.key);
  const shown = packFeedOf(f.map((item) => ({ pack: { id: "agents", name: "Agents" }, item })), now);
  assert.deepEqual(shown.map((e) => [e.who, e.repo, e.mine]), [["Agent", undefined, false], ["Agent", "shop-api", false], ["You", "shop-api", true]], "the core keeps who, repo and mine");
});

test("through the core: the pack's numbers, sentence and row reach the briefing", () => {
  const s = snapshot();
  const sessions = { live: [session({ status: "waiting", title: H, waitingFor: H })], recent: [] };
  const b = briefingFrom([agentsPack({ desk: desk(), dismissed: notDismissed, here: fixedHere(sessions) })], () => testContext({ snapshot: () => s }), () => {});
  assert.deepEqual(b.glance.map((g) => g.label), ["Agents live", "Agent spend"]);
  assert.equal(b.brief.length, 1);
  assert.equal(b.lanes[0]!.marks.length, 1);
  assertInert("agents card", String(agentsCard(s, sessions, [], now)));
});

test("Today through the app: the agents card, numbers, sentence and feed come from the pack, hostile titles inert", async () => {
  const { get } = signedIn(snapshot(), {}, { sessions: { live: [session({ status: "waiting", title: H, waitingFor: H, statusSince: Date.now() - 60e3 })] } });
  const page = await (await get("/")).text();
  assertInert("today", page);
  assert.match(page, /<section class="card" id="agents"/);
  assert.match(page, /<dt>Agents live<\/dt><dd>1<\/dd>/);
  assert.match(page, /wants your OK for <code>/);
  assert.match(page, /class="hz-mark live"/);
  assert.match(page, /<strong>Agent<\/strong> needs your OK/);
});

test("search: Start an agent, sessions, runs whose session isn't listed yet, and worktrees, each in search's own group", () => {
  const f = agentFinds({ live: [session({ sessionId: "s1", title: "Fix", status: "waiting", repo: "shop-api" })], recent: [] }, [run("here", { sessionId: "s1" }), run("new")], [{ name: "shop-api-pr1", path: "x", main: "shop-api", branch: "feat/a", head: "abc", changedAt: 0 }]);
  assert.deepEqual(f.map((x) => [x.kind, x.title, x.href]), [["actions", "Start an agent", "/agents/new"], ["agents", "Fix", "/agents/s/s1"], ["agents", "new", "/agents/r/new"], ["code", "shop-api-pr1", "/code/shop-api-pr1"]]);
});

test("search through the app: > finds Start an agent under Do, from the pack", async () => {
  const { get } = signedIn(snapshot());
  const out = await (await get(`/search?q=${encodeURIComponent("> start an agent")}`)).text();
  assert.match(out, /id="pal-g-actions">Do<\/p><a class="pal-row"[^>]*href="\/agents\/new"/);
});

test("search through the app: a: finds a session from the pack", async () => {
  const { get } = signedIn(snapshot(), {}, { sessions: { live: [session({ sessionId: "s-7", title: `Review ${H}`, status: "busy" })] } });
  const out = await (await get(`/search?q=${encodeURIComponent("a: review")}`)).text();
  assertInert("agents in search", out);
  assert.match(out, /id="pal-g-agents">Agents<\/p><a class="pal-row"[^>]*href="\/agents\/s\/s-7"/);
});

test("Bino: the agents running by title and state, and the pack's pages by name, never a prompt or recap", () => {
  const live = [session({ sessionId: "s-9", title: "Fix the build", repo: "ACME/shop-api", status: "busy", lastPrompt: "SECRET-PROMPT", summary: "SECRET-RECAP" })];
  assert.equal(agentsForBino(live), "Agents running:\n- ACME/shop-api: Fix the build [busy]");
  assert.equal(agentsForBino([]), "");
  const page = aboutAgentPage("/agents/s/s-9", { live, recent: [] })!;
  assert.match(page, /Fix the build.*ACME\/shop-api.*busy/);
  assert.doesNotMatch(page + agentsForBino(live), /SECRET/);
  assert.equal(aboutAgentPage("/agents/s/nope", { live, recent: [] }), "an agent session's page.");
  assert.equal(aboutAgentPage("/worktrees", none), "the Worktrees page.");
  assert.equal(aboutAgentPage("/agents/elsewhere", none), undefined);
});
