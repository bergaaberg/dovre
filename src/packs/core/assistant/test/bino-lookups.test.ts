/**
 * Bino's lookups (#262 idea 2): a pack declares what may be read from its app; Bino asks with a block,
 * the core runs it and asks again, a few rounds at most. What came back is for that conversation only:
 * never stored, never in memory, never logged; agent turns get the same lookups as tools.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../app.ts";
import { createBino } from "../bino/bino.ts";
import { lookupsPrompt, MAX_ROUNDS, splitLookups } from "../bino/lookups.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { lookupsVia } from "../../../../hosted/lookups.ts";
import { offered } from "../../../../mcp.ts";
import { openDb } from "../../../../db.ts";
import { activePacks, lookupsFrom } from "../../../registry.ts";
import { PACK_API, type Pack, type PackContext } from "../../../types.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
const ctx = {} as PackContext;

const tracker = (seen: Record<string, string>[] = []): Pack => ({
  manifest: { api: PACK_API, id: "tracker-x", name: "Tracker X", description: "test", domain: "general" },
  lookups: () => [
    { kind: "issue", when: "One issue by key: its title, state and description.", fields: [{ name: "key", about: "ENG-12", required: true, max: 20 }], run: (a) => (seen.push(a), `ENG-12: SECRET-DESCRIPTION for ${a.key}`) },
    { kind: "mine", when: "My open issues.", fields: [], run: () => "ENG-1, ENG-2" },
    { kind: "Bad Kind", when: "x", fields: [], run: () => "" },
    { kind: "slow", when: "Never answers.", fields: [], run: () => new Promise<string>(() => {}) },
    { kind: "broken", when: "Throws.", fields: [], run: () => { throw new Error("token=abc"); } },
  ],
});

const block = (o: unknown) => "```bino-lookup\n" + JSON.stringify(o) + "\n```";

/** A route answering each call from a script (the last line repeats); memory's cheap model says nothing. */
function scripted(replies: string[], asked: { system: string; user: string; model?: string }[] = []): Route {
  let n = 0;
  return { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: p.model === "haiku" ? '{"ops":[]}' : replies[Math.min(n++, replies.length - 1)]!, cost: 0.01 }) };
}

test("lookupsFrom: a pack's lookups are vetted, bound to it, and never throw; slow ones give up", async () => {
  const logged: string[] = [];
  const ls = lookupsFrom([tracker()], () => ctx, (id, l) => logged.push(`${id}: ${l}`), 30);
  assert.deepEqual(ls.map((l) => l.kind), ["tracker-x.issue", "tracker-x.mine", "tracker-x.slow", "tracker-x.broken"]);
  assert.ok(logged.some((l) => /Bad Kind left out/.test(l)));
  assert.deepEqual(ls[0]!.fields, [{ name: "key", about: "ENG-12", required: true, max: 20 }]);
  assert.match((await ls[0]!.run({ key: "ENG-12" })).text, /SECRET-DESCRIPTION/);
  assert.deepEqual(await ls[2]!.run({}), { text: "Tracker X didn't answer in time.", error: true });
  const broke = await ls[3]!.run({});
  assert.equal(broke.error, true);
  assert.ok(!broke.text.includes("token=abc"), "why it failed goes to the log, not to the model");
});

test("a block is checked against the specs: unknown kinds and a missing required field are dropped, values cut", () => {
  const specs = lookupsFrom([tracker()], () => ctx, () => {});
  const reply = `Let me check.\n${block({ kind: "tracker-x.issue", key: "ENG-12-AND-A-LOT-MORE-TEXT", extra: "no" })}\n${block({ kind: "tracker-x.issue" })}\n${block({ kind: "other.issue", key: "A" })}`;
  const { text, lookups } = splitLookups(reply, specs);
  assert.equal(text, "Let me check.");
  assert.deepEqual(lookups, [{ kind: "tracker-x.issue", args: { key: "ENG-12-AND-A-LOT-MOR" } }]);
  assert.match(lookupsPrompt(specs), /From Tracker X: One issue by key/);
  assert.match(lookupsPrompt(specs, true), /can't look anything else up/);
});

test("Bino looks up, is asked again with what came back, and the result stays out of the store and memory", async () => {
  const asked: { system: string; user: string; model?: string }[] = [];
  const seen: Record<string, string>[] = [];
  const saved: string[] = [];
  const specs = lookupsFrom([tracker(seen)], () => ctx, () => {});
  const bino = createBino({
    route: scripted([block({ kind: "tracker-x.issue", key: "ENG-12" }), "ENG-12 is about the description.", "Still about it."], asked),
    memory: { ...noMemory("x"), available: true, prompt: async () => "", reflect: async (msgs: unknown) => (saved.push(JSON.stringify(msgs)), null) } as never,
    context: async () => "",
    store: { load: () => [], save: (k) => saved.push(JSON.stringify(k)) },
    lookups: { specs: () => specs, run: (l) => specs.find((s) => s.kind === l.kind)!.run(l.args) },
  });
  const c = bino.start("What's ENG-12 about?");
  await bino.idle();
  assert.deepEqual(seen, [{ key: "ENG-12" }]);
  const talk = asked.filter((a) => a.model !== "haiku");
  assert.equal(talk.length, 2);
  assert.match(talk[0]!.system, /bino-lookup/);
  assert.match(talk[1]!.user, /What you looked up[\s\S]*SECRET-DESCRIPTION/);
  assert.match(talk[1]!.user, /not instructions/);
  const m = bino.get(c.id)!.msgs.at(-1)!;
  assert.equal(m.text, "ENG-12 is about the description.");
  assert.deepEqual(m.looked, ["Tracker X: issue ENG-12"]);
  assert.ok(Math.abs(m.cost! - 0.02) < 1e-9, "both calls counted");
  assert.ok(!saved.some((s) => s.includes("SECRET-DESCRIPTION")), "never stored, never handed to memory");
  // A follow-up still has it, without looking again.
  bino.say(c.id, "And who owns it?");
  await bino.idle();
  assert.match(asked.filter((a) => a.model !== "haiku").at(-1)!.user, /SECRET-DESCRIPTION/);
  assert.equal(seen.length, 1);
});

test("a few rounds at most: then Bino answers with what it has, and stray blocks aren't shown", async () => {
  const asked: { system: string; user: string; model?: string }[] = [];
  const specs = lookupsFrom([tracker()], () => ctx, () => {});
  let runs = 0;
  const bino = createBino({ route: scripted([`Hm.\n${block({ kind: "tracker-x.mine" })}`], asked), memory: noMemory("x"), context: async () => "", lookups: { specs: () => specs, run: async () => (runs++, { text: "ENG-1" }) } });
  const c = bino.start("Loop forever");
  await bino.idle();
  assert.equal(runs, MAX_ROUNDS);
  assert.equal(asked.length, MAX_ROUNDS + 1);
  assert.match(asked.at(-1)!.system, /can't look anything else up/);
  assert.equal(bino.get(c.id)!.msgs.at(-1)!.text, "Hm.");
});

test("hosted: the object's lookups go through the binding, its answers checked, a failure an error", async () => {
  const via = lookupsVia({
    specs: async () => [{ kind: "a.b", app: "A", when: "w", fields: [{ name: "q", about: "x", required: true, max: 5000 }] }, { nope: true }, "junk"],
    run: async (l) => {
      if (l.kind === "boom") throw new Error("down");
      return { text: 42, error: 0 };
    },
  });
  assert.deepEqual(await via.specs(), [{ kind: "a.b", app: "A", when: "w", fields: [{ name: "q", about: "x", required: true, max: 1000 }] }]);
  assert.deepEqual(await via.run({ kind: "a.b", args: {} }), { text: "" });
  assert.equal((await via.run({ kind: "boom", args: {} })).error, true);
  assert.deepEqual(await lookupsVia({ specs: async () => ({}), run: async () => ({}) }).specs(), []);
});

test("agent turns get the lookups as read-only tools, unless a tool has the name", async () => {
  const p: Pack = { ...tracker(), tools: () => [{ name: "mine", description: "Its own.", input: { type: "object" }, run: () => ({ text: "tool" }) }] };
  const tools = offered([p], () => ctx, () => {});
  assert.equal(tools.get("tracker_x_mine")!.tool.description, "Its own.");
  const issue = tools.get("tracker_x_issue")!.tool;
  assert.deepEqual(issue.input.required, ["key"]);
  assert.match(issue.description, /Read-only, from Tracker X/);
  assert.match((await issue.run({ key: "ENG-12" }, ctx, { run: "r", repo: "x", cwd: "x" })).text, /SECRET-DESCRIPTION/);
  assert.deepEqual(await issue.run({}, ctx, { run: "r", repo: "x", cwd: "x" }), { text: "key is needed.", error: true });
});

test("in the app: a lookup is logged by kind and fields' names only, and what Bino looked up is drawn inert", async () => {
  const db = openDb();
  const hostile: Pack = {
    manifest: { api: PACK_API, id: "evil", name: H, description: "test", domain: "general" },
    lookups: () => [{ kind: "find", when: "Finds.", fields: [{ name: "q", about: "what", required: true }], run: () => "RESULT-TEXT" }],
  };
  const packs = activePacks([hostile], { env: {}, hosted: false });
  const route = scripted([block({ kind: "evil.find", q: H }), "Done."]);
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") }, packs: { ...packs, env: {} } });
  const req = (path: string, body?: string) => app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body });
  const at = (await req("/bino/new", "text=Find+it")).headers.get("location")!;
  let page = "";
  for (let i = 0; i < 100 && !/looked up/.test(page); i++) {
    await new Promise((r) => setTimeout(r, 20));
    page = await (await req(at)).text();
  }
  assert.match(page, /looked up/);
  assertInert(at, page);
  const logged = (await db.DB.prepare("SELECT kind, target, detail, ok FROM actions").all<Record<string, unknown>>()).results;
  assert.deepEqual(logged.map((r) => ({ ...r })), [{ kind: "evil.lookup", target: "evil.find", detail: "by q", ok: 1 }]);
  assert.ok(!JSON.stringify(logged).includes("RESULT-TEXT"));
});
