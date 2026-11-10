/** A pack's agent turns (#467): off until I allow it, only where and in the repos I allowed, one at a time within its dollars, its own tools only, logged by cost. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { createRunner, type Run } from "../src/agents/runner.ts";
import type { SandboxOut } from "../src/agents/sandbox.ts";
import { mountMcp } from "../src/mcp.ts";
import { type AgentHost, aiAskOf, grantOf } from "../src/packs/ai.ts";
import { packsOf } from "../src/app.ts";
import { assertInert, HOSTILE, packApp, soonOf, testContext } from "../src/packs/testing.ts";
import { type Pack, type PackAgentAsk, PACK_API, type PackAgentStart, type PackTool } from "../src/packs/types.ts";

/** A pack whose page starts, reads and lands turns as its query says. */
function runner(agent: PackAgentAsk | undefined, o: { writes?: boolean } = {}): Pack {
  return {
    manifest: { api: PACK_API, id: "runner", name: "Runner", description: "Runs", domain: "general", ...(agent ? { ai: { agent } } : {}) },
    ...(o.writes === false ? {} : { writes: [{ kind: "open", label: "Opens a draft PR" }] }),
    routes(app, ctx) {
      app.get("/runner/start", async (c) => c.json({ ...(await ctx.agent.start({ repo: c.req.query("repo") ?? "me/app", prompt: "look", where: (c.req.query("where") ?? "read") as PackAgentStart["where"], ...(c.req.query("size") ? { size: "large" as const } : {}) })), can: ctx.agent.can() }));
      app.get("/runner/result", async (c) => c.json((await ctx.agent.result(c.req.query("run") ?? "")) ?? null));
      app.get("/runner/land", async (c) => c.json(await ctx.agent.land(c.req.query("run") ?? "")));
    },
  };
}

/** A made-up runner: what it was asked to start, and runs that end when the test says. */
function host() {
  const started: Parameters<AgentHost["start"]>[0][] = [];
  const runs = new Map<string, Run>();
  const landed: { run: string; kind: string }[] = [];
  let n = 0;
  const h: AgentHost = {
    start(s) {
      const run = { id: `run-${++n}`, status: "running", cost: 0, events: [], ...(s.sandbox ? { sandbox: {} } : {}) } as unknown as Run;
      started.push(s);
      runs.set(run.id, run);
      return run;
    },
    get: (id) => runs.get(id),
    checkout: async (repo) => (repo.toLowerCase() === "me/app" || repo === "me/other" ? `/code/${repo.split("/")[1]}` : undefined),
    sandbox: () => ({ ok: true }),
    owners: () => "me",
    land: async (r, kind) => (landed.push({ run: r.id, kind }), { number: 7, url: "https://github.com/me/app/pull/7" }),
  };
  const end = (id: string, cost: number, out?: SandboxOut) => Object.assign(runs.get(id)!, { status: "done", cost, events: [{ t: "result", text: "found two things" }], ...(out ? { out } : {}) });
  return { h, started, landed, end };
}

const ASK: PackAgentAsk = { why: "Looks into my repos", where: ["read", "sandbox"], tools: ["todo_add"], lands: "open" };
const allow = (extra: Record<string, string> = {}) => ({ level: "agent", size: "small", dayUsd: "5", where_read: "on", reposAll: "named", repos: "me/app", runUsd: "2", turns: "10", ...extra });
const json = async (r: Response | Promise<Response>) => (await (await r).json()) as any;

test("a turn that ends is told to its pack's refresh once ({ agent }), a sandbox run's once its commits are home; ctx.soon asks for the next refresh (#479)", async () => {
  const k = host();
  const seen: unknown[] = [];
  let ctxSeen: Parameters<NonNullable<Pack["refresh"]>>[0] | undefined;
  const follower: Pack = {
    ...runner(ASK),
    refresh: async (ctx, o) => {
      ctxSeen = ctx;
      seen.push(o);
    },
  };
  const other: Pack = { manifest: { api: PACK_API, id: "other", name: "Other", description: "x", domain: "general" }, refresh: async (_ctx, o) => void seen.push(["other", o]) };
  const { app, get, post } = packApp([follower, other], { agents: k.h });
  const mounted = packsOf(app)!;
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  };
  await post("/settings/packs/runner/ai", allow({ where_sandbox: "on" }));
  assert.equal((await json(get("/runner/start"))).run, "run-1");
  const run = k.h.get("run-1")!;
  Object.assign(run, { scope: { pack: "runner", tools: [] } });
  mounted.agentChanged(run);
  await settle();
  assert.deepEqual(seen, [], "still running: nothing yet");
  k.end("run-1", 0.25);
  mounted.agentChanged(run);
  mounted.agentChanged(run);
  await settle();
  assert.deepEqual(seen, [{ agent: { run: "run-1", where: "read", repo: "me/app", status: "done", cost: 0.25, said: "found two things" } }], "once, as result() gives it, to its own pack only");

  // A sandbox run: told when its commits are home, not when it stops.
  assert.equal((await json(get("/runner/start?where=sandbox"))).run, "run-2");
  const box = k.h.get("run-2")!;
  Object.assign(box, { scope: { pack: "runner", tools: [] } });
  k.end("run-2", 0.5);
  mounted.agentChanged(box);
  k.end("run-2", 0.5, { state: "collecting" });
  mounted.agentChanged(box);
  await settle();
  assert.equal(seen.length, 1, "its commits aren't home yet");
  k.end("run-2", 0.5, { state: "ready", commits: [{ sha: "a", subject: "x" }], repo: "me/app", ci: false } as never);
  mounted.agentChanged(box);
  await settle();
  assert.deepEqual(seen[1], { agent: { run: "run-2", where: "sandbox", repo: "me/app", status: "done", cost: 0.5, said: "found two things", commits: 1 } });

  // A turn no pack started, or one of a pack that isn't on: no one is told.
  mounted.agentChanged({ id: "run-9", status: "done", cost: 0, events: [] } as unknown as Run);
  mounted.agentChanged({ id: "run-8", status: "done", cost: 0, events: [], scope: { pack: "nope", tools: [] } } as unknown as Run);
  mounted.agentChanged({ id: "run-7", status: "done", cost: 0, events: [], scope: { pack: "other", tools: [] } } as unknown as Run);
  await settle();
  assert.equal(seen.length, 2, "and a run id that isn't the pack's own turn is no turn of its");

  // ctx.soon: the pack's next refresh says so; the schedule's due() finds it too.
  await mounted.refresh.due(true);
  seen.length = 0;
  ctxSeen!.soon();
  await mounted.refresh.due(false, Date.now() + 11_000);
  assert.deepEqual(seen, [{ soon: true }]);

  // In a pack's own tests: what was asked.
  const ctx = testContext();
  ctx.soon();
  ({ ...ctx }).soon(20_000);
  assert.deepEqual(soonOf(ctx), [undefined, 20_000]);
  assert.deepEqual(soonOf(testContext()), []);
});

test("off until I allow it: the pack is told why, and nothing starts", async () => {
  const k = host();
  const { get } = packApp([runner(ASK)], { agents: k.h });
  const r = await json(get("/runner/start"));
  assert.match(r.error, /not allowed/);
  assert.equal(r.can.ok, false);
  assert.equal(k.started.length, 0);
  const none = packApp([runner(undefined)], { agents: k.h });
  assert.match((await json(none.get("/runner/start"))).error, /didn't ask/);
});

test("allowed: read only, in the repos I named, the small model, its caps; its own tools and the ones I ticked", async () => {
  const k = host();
  const { get, post, db } = packApp([runner(ASK)], { agents: k.h });
  const page = await (await get("/settings/packs/runner")).text();
  assert.match(page, /id="ai"[\s\S]*Looks into my repos[\s\S]*name="where_read"[\s\S]*name="where_sandbox"[\s\S]*name="tool_todo_add"/);
  assert.equal((await post("/settings/packs/runner/ai", allow(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/settings/packs/runner/ai", allow({ tool_todo_add: "on" }))).status, 303);
  assert.match((await json(get("/runner/start?where=sandbox"))).error, /sandbox turns aren't allowed/);
  assert.match((await json(get("/runner/start?repo=you/app"))).error, /isn't in your repos/);
  assert.match((await json(get("/runner/start?repo=me/other"))).error, /isn't one of the repos allowed/);
  assert.match((await json(get("/runner/start?size=large"))).error, /only the small model/);
  assert.equal(k.started.length, 0);
  const r = await json(get("/runner/start"));
  assert.equal(r.run, "run-1");
  assert.deepEqual(r.can, { ok: true, where: ["read"], repos: ["me/app"], tools: ["todo_add"], runUsd: 2, turns: 10, minutes: 30 });
  assert.deepEqual(k.started[0], { cwd: "/code/app", prompt: "look", sandbox: false, model: "haiku", budget: 2, turns: 10, maxMs: 30 * 60_000, scope: { pack: "runner", tools: ["todo_add"] } });
  const row = await db.DB.prepare("SELECT * FROM pack_ai_calls WHERE pack = 'runner'").first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { pack: "runner", at: row!.at, cost: 2, ok: 0, kind: "agent", run: "run-1", state: "running", place: "read", repo: "me/app" }, "its run's dollars held; never the prompt");
  const logged = (await db.DB.prepare("SELECT target, detail FROM actions WHERE kind = 'packs.agent'").all<Record<string, unknown>>()).results;
  assert.deepEqual(logged.map((l) => ({ ...l })), [{ target: "runner", detail: "read turn in me/app" }]);
});

test("one at a time; once it ends, what it cost replaces what was held, and it says what it found", async () => {
  const k = host();
  const { get, post, db } = packApp([runner(ASK)], { agents: k.h });
  await post("/settings/packs/runner/ai", allow());
  assert.equal((await json(get("/runner/start"))).run, "run-1");
  assert.match((await json(get("/runner/start"))).wait, /One turn at a time/);
  k.end("run-1", 0.25);
  const res = await json(get("/runner/result?run=run-1"));
  assert.deepEqual(res, { run: "run-1", where: "read", repo: "me/app", status: "done", cost: 0.25, said: "found two things" });
  const row = await db.DB.prepare("SELECT cost, state, ok FROM pack_ai_calls WHERE run = 'run-1'").first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { cost: 0.25, state: "done", ok: 1 });
  assert.equal((await json(get("/runner/start"))).run, "run-2");
  assert.equal(await json(get("/runner/result?run=nope")), null, "not one of its own");
});

test("the day's dollars hold a whole run: when one more doesn't fit, it waits for tomorrow", async () => {
  const k = host();
  const { get, post } = packApp([runner(ASK)], { agents: k.h });
  await post("/settings/packs/runner/ai", allow({ dayUsd: "3", runUsd: "2" }));
  assert.equal((await json(get("/runner/start"))).run, "run-1");
  k.end("run-1", 1.5);
  assert.match((await json(get("/runner/start"))).wait, /Today's cap \(\$3\.00\) can't hold another \$2\.00 run/);
  await post("/settings/packs/runner/ai", allow({ level: "off" }));
  assert.match((await json(get("/runner/start"))).error, /not allowed/, "taking it back stops it at once");
});

test("a sandbox run lands as a draft PR under its own write kind, never CI changes, and only with a kind it lists", async () => {
  const k = host();
  const { get, post } = packApp([runner(ASK)], { agents: k.h });
  await post("/settings/packs/runner/ai", allow({ where_sandbox: "on", where_read: "" }));
  assert.match((await json(get("/runner/start"))).error, /read turns aren't allowed/);
  assert.equal((await json(get("/runner/start?where=sandbox"))).run, "run-1");
  assert.equal(k.started[0]!.sandbox, true);
  assert.match((await json(get("/runner/land?run=run-1"))).error, /still running/);
  const ready: Extract<SandboxOut, { state: "ready" }> = { state: "ready", branch: "sandbox/run-1", base: "a", head: "b", repo: "me/app", commits: [{ sha: "b", subject: "fix" }], files: [], ci: false };
  k.end("run-1", 1, { ...ready, ci: true });
  assert.match((await json(get("/runner/land?run=run-1"))).error, /CI config/);
  k.end("run-1", 1, ready);
  assert.equal((await json(get("/runner/result?run=run-1"))).commits, 1);
  assert.deepEqual(await json(get("/runner/land?run=run-1")), { number: 7, url: "https://github.com/me/app/pull/7" });
  assert.deepEqual(k.landed, [{ run: "run-1", kind: "runner.open" }]);
  k.end("run-1", 1, { ...ready, repo: "you/app" });
  assert.match((await json(get("/runner/land?run=run-1"))).error, /origin isn't the repo/);

  const j = host();
  const bare = packApp([runner(ASK, { writes: false })], { agents: j.h });
  await bare.post("/settings/packs/runner/ai", allow({ where_sandbox: "on" }));
  await json(bare.get("/runner/start?where=sandbox"));
  j.end("run-1", 1, ready);
  assert.match((await json(bare.get("/runner/land?run=run-1"))).error, /which write kind/, "a lands kind it doesn't list in writes is left out");
});

test("a grant is never more than the manifest asks; a manifest's ask is read safely", () => {
  const ask = aiAskOf({ ai: { agent: { why: "x", where: ["read"], tools: ["a_b", "Bad Name", 3] } } })!;
  assert.deepEqual(ask, { agent: { why: "x", where: ["read"], tools: ["a_b"] } }, "no lands without sandbox; odd tool names dropped");
  const g = grantOf({ level: "agent", where_read: "on", where_sandbox: "on", tool_a_b: "on", tool_c: "on", reposAll: "named", repos: "me/a, ../x, me/b", runUsd: "999", turns: "9999" }, ask);
  assert.deepEqual({ where: g.where, tools: g.tools, repos: g.repos, runUsd: g.runUsd, turns: g.turns }, { where: ["read"], tools: ["a_b"], repos: ["me/a", "me/b"], runUsd: 20, turns: 200 });
  assert.equal(grantOf({ level: "agent" }, { text: { why: "y" } }).level, "off", "no agent level it didn't ask for");
  assert.equal(grantOf({ level: "agent", reposAll: "mine" }, ask).repos, "mine");
  assert.equal(aiAskOf({ ai: { agent: { why: "x", where: ["host"] } } }), undefined, "only read or sandbox");
});

test("its why and its tools' names are drawn inert", async () => {
  const k = host();
  const { get } = packApp([runner({ ...ASK, why: HOSTILE })], { agents: k.h });
  const page = await (await get("/settings/packs/runner")).text();
  assertInert("pack agent panel", page);
});

test("a pack's turn: capped outside a sandbox too, its scope kept on the run, and none of my own MCP servers", async () => {
  const spawned: string[][] = [];
  const spawnFn = (_bin: string, args: string[]) => {
    spawned.push(args);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => (child.emit("close", 1), true) });
    return child;
  };
  const r = createRunner({ spawnFn: spawnFn as never, mcp: { url: "http://127.0.0.1:4848/mcp" } });
  const run = r.start({ cwd: "/code/app", prompt: "look", mode: "plan", budget: 2, turns: 10, maxMs: 60_000, scope: { pack: "runner", tools: ["todo_add"] }, allowed: ["mcp__dovre"] });
  const a = spawned[0]!;
  assert.deepEqual(run.scope, { pack: "runner", tools: ["todo_add"] });
  assert.deepEqual([a[a.indexOf("--max-budget-usd") + 1], a[a.indexOf("--max-turns") + 1], a[a.indexOf("--permission-mode") + 1]], ["2", "10", "plan"]);
  assert.ok(a.includes("--strict-mcp-config") && a.includes("--mcp-config"));
  assert.ok(!a.includes("--dangerously-skip-permissions"));
  const tok = JSON.parse(a[a.indexOf("--mcp-config") + 1]!).mcpServers.dovre.headers.Authorization.replace("Bearer ", "");
  assert.deepEqual(r.byMcpToken(tok)?.scope, { pack: "runner", tools: ["todo_add"] });
  r.stop(run.id);
  const plain = r.start({ cwd: "/code/app", prompt: "p" });
  assert.ok(!spawned[1]!.includes("--strict-mcp-config") && !plain.scope);
  r.stop(plain.id);
});

test("/mcp: a pack's turn sees its own pack's tools and those granted by name, nothing else", async () => {
  const tool = (name: string): PackTool => ({ name, description: name, input: { type: "object" }, run: () => ({ text: name }) });
  const mine: Pack = { manifest: { api: PACK_API, id: "runner", name: "R", description: "r", domain: "general" }, tools: () => [tool("look")] };
  const todo: Pack = { manifest: { api: PACK_API, id: "todo", name: "T", description: "t", domain: "general" }, tools: () => [tool("add"), tool("drop")] };
  const app = new Hono();
  const turns = new Map([
    ["k".repeat(40), { id: "r1", repo: "app", cwd: "/code/app", scope: { pack: "runner", tools: ["todo_add"] } }],
    ["j".repeat(40), { id: "r2", repo: "app", cwd: "/code/app" }],
  ]);
  mountMcp(app, { shown: () => [mine, todo], ctxOf: () => ({}) as never, turnOf: (t) => turns.get(t), hosted: false, isLocal: () => true, db: () => undefined, log: () => {} });
  const rpc = async (tok: string, body: unknown) => (await app.request("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: `Bearer ${tok.repeat(40)}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
  const names = (await rpc("k", { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["runner_look", "todo_add"]);
  const refused = await rpc("k", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "todo_drop" } });
  assert.match(refused.error.message, /No tool todo_drop/);
  assert.equal((await rpc("j", { jsonrpc: "2.0", id: 3, method: "tools/list" })).result.tools.length, 3, "a turn without a scope: every shown pack's");
});
