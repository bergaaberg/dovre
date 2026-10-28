/** The agents pack's hooks: what needs me, the menu, rung once through the core's notifier. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Desk, DeskView } from "../../../../agents/desk.ts";
import type { Dismissed } from "../../../../agents/dismissed.ts";
import { createNotifier } from "../../../../notify.ts";
import { needsFrom, ringsOf } from "../../../registry.ts";
import { testContext } from "../../../testing.ts";
import type { PackContext } from "../../../types.ts";
import { fixedHere } from "../here.ts";
import { agentsPack } from "../index.ts";
import { agentNeeds } from "../needs.ts";
import { H, assertInert, session, signedIn, snapshot } from "../../../../../test/helpers.ts";

type Live = ReturnType<typeof session>[];

const desk = (v: Partial<DeskView> = {}): Desk => ({ view: () => ({ here: true, online: true, harnesses: ["claude"], runs: [], workDir: "/w", ...v }) }) as unknown as Desk;
const none: Dismissed = { ready: Promise.resolve(), has: () => false, add: async () => {}, remove: async () => {} };
const ctxOf = (hosted = false) => () => testContext({ hosted }) as PackContext;

test("agents that need me: waiting for an OK rings, idle after a reply is listed but quiet, working isn't there", () => {
  const needs = agentNeeds([session({ status: "idle", title: "Self-review", statusSince: 1 }), session({ sessionId: "s-2", status: "busy" }), session({ sessionId: "s-3", status: "waiting", waitingFor: "Bash(npm test)", statusSince: 2 })]);
  assert.deepEqual(needs.map((n) => [n.title, n.ring, n.rank]), [
    ["Self-review is waiting for you", undefined, 1],
    ["s-3 needs your OK: Bash(npm test)", "agent-ask", 0],
  ]);
});

test("through the core: keyed under agents, rung once when an agent starts waiting, never for a reply ending", () => {
  const rings = ringsOf([agentsPack({ desk: desk(), dismissed: none })], ["deploy"], () => {});
  assert.deepEqual(rings.map((r) => r.kind), ["agent-ask", "agent-done", "agent-auto"]);
  const n = createNotifier();
  const at = (live: Live) => needsFrom([agentsPack({ desk: desk(), dismissed: none, here: fixedHere({ live, recent: [] }) })], ctxOf(), rings, () => {});
  n.observe(at([session({ status: "busy", statusSince: 1 })]));
  assert.deepEqual(n.observe(at([session({ status: "idle", statusSince: 2 })])), [], "a reply ending doesn't ring");
  const asks = n.observe(at([session({ status: "waiting", statusSince: 3, waitingFor: "Bash" })]));
  assert.deepEqual(asks.map((x) => [x.kind, x.title, x.url]), [["agent-ask", "s-1 needs your OK: Bash", "/agents/s/s-1"]]);
});

test("the menu: Agents with how many are live and whether one waits; Worktrees only on a machine; hosted, the Mac's sessions", () => {
  const here = fixedHere({ live: [session({ status: "busy" }), session({ sessionId: "s-2", status: "waiting" })], recent: [] });
  const nav = agentsPack({ desk: desk(), dismissed: none, here }).nav!(ctxOf()());
  assert.deepEqual(nav.map((x) => [x.href, x.count, x.hot]), [["/agents", 2, true], ["/worktrees", undefined, undefined]]);
  const hosted = agentsPack({ desk: desk({ remote: true, sessions: { live: [], recent: [] } }), dismissed: none, here }).nav!(ctxOf(true)());
  assert.deepEqual(hosted.map((x) => [x.href, x.count, x.hot]), [["/agents", 0, false]], "the Mac's sessions, not this machine's; no worktrees hosted");
});

test("the app: Agents and Worktrees in the menu from the pack, hostile session titles inert", async () => {
  const { get } = signedIn(snapshot(), {}, { sessions: { live: [session({ status: "waiting", title: H })] } });
  const page = await (await get("/prs")).text();
  assertInert("menu", page);
  assert.match(page, /href="\/agents"[^>]*title="Agents"[^>]*>[\s\S]*?<b class="hot">1<\/b>/);
  assert.match(page, /href="\/worktrees"/);
  assert.ok(page.indexOf('href="/agents"') < page.indexOf('href="/bino"') || !page.includes('href="/bino"'), "first in its group");
});

test("sessions I cleared away leave the lists; running ones always show, they're still going", async () => {
  const here = fixedHere({ live: [session({ sessionId: "s-2" })], recent: [session({ sessionId: "s-2", live: false }), session({ sessionId: "s-3", live: false })] });
  const cleared: Dismissed = { ...none, has: (sid) => sid === "s-2" };
  const finds = agentsPack({ desk: desk(), dismissed: cleared, here }).finds!(ctxOf()());
  assert.deepEqual(finds.filter((f) => f.kind === "agents").map((f) => f.href), ["/agents/s/s-2", "/agents/s/s-3"], "s-2 once, as the live one");
});

test("its pulse: a turn here and its session count once; waiting is asking", () => {
  const here = fixedHere({ live: [session({ sessionId: "a", status: "busy" }), session({ sessionId: "b", status: "waiting" }), session({ sessionId: "c", status: "probably-busy" })], recent: [] });
  const runs = [{ status: "running", sessionId: "a", events: [] }, { status: "running", sessionId: undefined, events: [] }, { status: "done", sessionId: "z", events: [] }] as never;
  assert.deepEqual(agentsPack({ desk: desk({ runs }), dismissed: none, here }).pulse!(ctxOf()()), { working: 3, asking: 1 });
});

test("linked: the PRs the sessions opened, for the gather to look up", () => {
  const pr = (n: number) => ({ url: `https://acme.ghe.com/ACME/shop-api/pull/${n}`, repo: "ACME/shop-api", number: n });
  const here = fixedHere({ live: [session({ prs: [pr(1)] })], recent: [session({ sessionId: "s-2", live: false, prs: [pr(2)] }), { ...session({ sessionId: "s-3" }), prs: undefined } as never] });
  assert.deepEqual(agentsPack({ desk: desk(), dismissed: none, here }).linked!(ctxOf()()), [pr(1).url, pr(2).url], "a session without its list (the Mac's, over the wire) adds none");
});

test("hosted, the Mac's sessions are brought up to date before a page; locally there's nothing to wait for", async () => {
  let refreshed = 0;
  const mac = { ...desk({ remote: true }), refresh: async () => void refreshed++ } as Desk;
  await agentsPack({ desk: mac, dismissed: none }).beforePage!(ctxOf(true)());
  assert.equal(refreshed, 1);
  assert.equal(agentsPack({ desk: desk(), dismissed: none }).beforePage, undefined);
});

test("a turn started here that ends rings: refused a tool, or a long one done or failed; a short reply or a stop doesn't", () => {
  const rung: unknown[] = [];
  let hear = (_r: never) => {};
  const pack = agentsPack({ desk: desk(), dismissed: none, onTurn: (fn) => (hear = fn as never), longTurnMs: () => 60_000 });
  pack.init!(testContext({ ring: (n) => rung.push([n.kind, n.title, n.href, n.tag]) }));
  const turn = (id: string, o: object) => ({ id, repo: "shop-api", prompt: "fix it\nmore", startedAt: 0, events: [], sessionId: `sid-${id}`, ...o }) as never;
  for (const [id, end] of [
    ["a", { status: "done", endedAt: 1000, events: [{ t: "denied" }] }],
    ["b", { status: "done", endedAt: 120_000 }],
    ["c", { status: "failed", endedAt: 120_000 }],
    ["d", { status: "done", endedAt: 1000 }],
    ["e", { status: "stopped", endedAt: 120_000 }],
  ] as const) {
    hear(turn(id, { status: "running" }));
    hear(turn(id, end));
    hear(turn(id, end));
  }
  hear(turn("f", { status: "done", endedAt: 120_000 }));
  assert.deepEqual(rung, [
    ["agent-ask", "Agent needs your OK in shop-api", "/agents/s/sid-a", "run:a"],
    ["agent-done", "Agent finished in shop-api", "/agents/s/sid-b", "run:b"],
    ["agent-done", "Agent failed in shop-api", "/agents/s/sid-c", "run:c"],
  ], "each once; a turn never seen running (from before a restart) doesn't ring");
});
