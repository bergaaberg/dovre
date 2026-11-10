/** A pack's MCP calls (#488): off until I tick it; exact calls, each tool's own result; reads and writes apart; logged by cost only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeMcp, type McpJob, type McpMade, mcpArgs, McpSetupError, readMcpStream } from "../src/ai/mcpcalls.ts";
import { aiAskOf, grantOf } from "../src/packs/ai.ts";
import { mcpAskOf } from "../src/packs/mcpcalls.ts";
import { assertInert, HOSTILE, packApp } from "../src/packs/testing.ts";
import { type Pack, PACK_API, type PackMcpCall } from "../src/packs/types.ts";

const MCP = { why: "Tickets where API tokens are locked down", server: { name: "tracker", url: "https://mcp.tracker.example/v1/mcp" }, reads: ["search", "types"], writes: { create: "ticket-create", drop: "not-mine" } };

/** A pack that makes the calls its page is told to, and says what came back. */
function caller(mcp: unknown = MCP): Pack {
  return {
    manifest: { api: PACK_API, id: "caller", name: "Caller", description: "Calls", domain: "general", ...(mcp ? { ai: { mcp } as never } : {}) },
    writes: [{ kind: "ticket-create", label: "File a ticket" }],
    routes(app, ctx) {
      app.post("/caller", async (c) => {
        const b = (await c.req.json()) as { calls?: PackMcpCall[]; write?: { kind: string; call: PackMcpCall } };
        try {
          return c.json({ ...(b.write ? await ctx.mcp.write(b.write.kind, b.write.call) : await ctx.mcp.call(b.calls!)), can: ctx.mcp.can() });
        } catch (e) {
          return c.json({ error: (e as Error).message, setup: (e as { setup?: string }).setup, can: ctx.mcp.can() });
        }
      });
    },
  };
}

/** A made-up Claude Code: answers each call it's asked, or as `made` says. */
function claude(o: { cost?: number; made?: (job: McpJob) => McpMade[]; fail?: Error } = {}) {
  const jobs: McpJob[] = [];
  return {
    jobs,
    run: async (job: McpJob) => {
      jobs.push(job);
      if (o.fail) throw o.fail;
      const asked = job.prompt.split("\n").slice(1).map((l) => /^\d+\) (\w+) (.*)$/.exec(l)!);
      return { cost: o.cost ?? 0.02, calls: o.made?.(job) ?? asked.map((m) => ({ tool: m[1]!, input: JSON.parse(m[2]!), result: `{"from":"${m[1]}"}`, error: false })) };
    },
  };
}

type Reply = { results?: { ok: boolean; text?: string; why?: string }[]; result?: { ok: boolean; text?: string; why?: string }; times?: number; cost?: number; error?: string; setup?: string; can: { ok: boolean; why?: string; reads?: string[]; writes?: string[] } };
const send = async (app: ReturnType<typeof packApp>, body: unknown) => (await (await app.app.request("http://localhost/caller", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Reply;
const allow = (app: ReturnType<typeof packApp>, form: Record<string, string> = {}) => app.post("/settings/packs/caller/ai", { level: "off", dayUsd: "1", mcp: "on", ...form });

test("off until I tick it: the pack is told why, and nothing is run", async () => {
  const cc = claude();
  const app = packApp([caller()], { mcp: cc.run });
  const r = await send(app, { calls: [{ tool: "search", input: { q: "a" } }] });
  assert.match(r.error ?? "", /not allowed/);
  assert.equal(r.can.ok, false);
  assert.equal(cc.jobs.length, 0);
  const page = await (await app.get("/settings/packs/caller")).text();
  assert.match(page, /MCP calls to <code>tracker<\/code>, reading with search, types, writing with create\. Why: Tickets/);
  assert.match(page, /MCP calls: not allowed\./);
  assert.equal((await allow(app)).status, 303);
});

test("ticked: exactly the calls asked, each tool's own result, matched by arguments at any depth; logged by cost only", async () => {
  const cc = claude({ cost: 0.03 });
  const app = packApp([caller()], { mcp: cc.run });
  await allow(app);
  const calls = [
    { tool: "search", input: { q: "mine", fields: ["a", "b"], page: { size: 5, from: 0 } } },
    { tool: "types", input: { project: "ABC" } },
  ];
  const r = await send(app, { calls });
  assert.deepEqual(r.results, [{ ok: true, text: '{"from":"search"}' }, { ok: true, text: '{"from":"types"}' }]);
  assert.equal(r.cost, 0.03);
  assert.deepEqual(r.can, { ok: true, reads: ["search", "types"], writes: ["create"] }, "a write whose kind isn't one of its `writes` is left out");
  const job = cc.jobs[0]!;
  assert.deepEqual([job.server, job.allowed, job.denied], [MCP.server, ["search", "types"], ["create"]], "reads only; every write tool refused outright");
  assert.equal(job.prompt, `Make these calls now, in parallel:\n1) search ${JSON.stringify(calls[0]!.input)}\n2) types {"project":"ABC"}`);
  const rows = (await app.db.DB.prepare("SELECT kind, cost, ok, run, state, place, repo FROM pack_ai_calls WHERE pack = 'caller'").all<Record<string, unknown>>()).results;
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ kind: "mcp", cost: 0.03, ok: 1, run: null, state: null, place: null, repo: null }], "when, cost and whether: never a call or a result");
  assert.match(await (await app.get("/settings/packs/caller")).text(), /\$0\.03 of \$1\.00 today[\s\S]*MCP calls: allowed\./);
  const logged = await app.db.DB.prepare("SELECT detail FROM actions WHERE kind = 'packs.ai'").first<{ detail: string }>();
  assert.match(logged!.detail, /MCP calls/);
});

test("the model can't change what's read: other arguments, a call not made, a failed tool and a missing result each say so", async () => {
  const made: McpMade[] = [
    { tool: "search", input: { q: "mine", page: { size: 50 } }, result: "[]", error: false },
    { tool: "types", input: { project: "ABC" }, result: "Unauthorized\nmore", error: true },
    { tool: "search", input: { q: "pending" }, error: false },
    { tool: "search", input: { q: "long" }, result: "x".repeat(200_001), error: false },
  ];
  const app = packApp([caller({ ...MCP, reads: ["search", "types", "fields"] })], { mcp: claude({ made: () => made }).run });
  await allow(app);
  const r = await send(app, { calls: [{ tool: "search", input: { q: "mine", page: { size: 5 } } }, { tool: "fields", input: {} }, { tool: "types", input: { project: "ABC" } }, { tool: "search", input: { q: "pending" } }, { tool: "search", input: { q: "long" } }] });
  assert.deepEqual(r.results, [
    { ok: false, why: "search was called with other arguments than asked" },
    { ok: false, why: "the fields call wasn't made" },
    { ok: false, why: "types: Unauthorized" },
    { ok: false, why: "search gave no result" },
    { ok: false, why: "search's result is too long to hand on" },
  ]);
});

test("only its manifest's read tools, 1 to 20 calls, as { tool, input }; refused before anything runs", async () => {
  const cc = claude();
  const app = packApp([caller()], { mcp: cc.run });
  await allow(app);
  assert.match((await send(app, { calls: [{ tool: "create", input: {} }] })).error ?? "", /create isn't one of the read tools/);
  assert.match((await send(app, { calls: [{ tool: "deleteEverything", input: {} }] })).error ?? "", /isn't one of the read tools/);
  assert.match((await send(app, { calls: [] })).error ?? "", /1 to 20 calls/);
  assert.match((await send(app, { calls: Array.from({ length: 21 }, () => ({ tool: "search", input: {} })) })).error ?? "", /1 to 20 calls/);
  assert.match((await send(app, { calls: [{ tool: "search", input: "q" }] })).error ?? "", /a call is \{ tool, input \}/);
  assert.match((await send(app, { calls: [{ tool: "search", input: { q: "x".repeat(50_000) } }] })).error ?? "", /over 50000 characters/);
  assert.equal(cc.jobs.length, 0);
});

test("a write: one call to one write tool under its mapped kind, nothing else allowed; how often it was called comes back", async () => {
  const cc = claude();
  const app = packApp([caller()], { mcp: cc.run });
  await allow(app);
  const call = { tool: "create", input: { summary: "A" } };
  const r = await send(app, { write: { kind: "ticket-create", call } });
  assert.deepEqual([r.result, r.times], [{ ok: true, text: '{"from":"create"}' }, 1]);
  assert.deepEqual([cc.jobs[0]!.allowed, cc.jobs[0]!.denied], [["create"], []]);
  assert.match(cc.jobs[0]!.prompt, /^Make this one call now, once:\n1\) create \{"summary":"A"\}$/);
  assert.match((await send(app, { write: { kind: "other", call } })).error ?? "", /isn't a write of kind other/);
  assert.match((await send(app, { write: { kind: "ticket-create", call: { tool: "search", input: {} } } })).error ?? "", /search isn't one of the write tools/);
  assert.match((await send(app, { write: { kind: "not-mine", call: { tool: "drop", input: {} } } })).error ?? "", /drop isn't one of the write tools/, "its kind isn't one of the pack's writes");
  assert.equal(cc.jobs.length, 1);
  const twice = packApp([caller()], { mcp: claude({ made: () => [{ tool: "create", input: { summary: "B" }, result: "{}", error: false }, { tool: "create", input: { summary: "B" }, result: "{}", error: false }] }).run });
  await allow(twice);
  const t = await send(twice, { write: { kind: "ticket-create", call } });
  assert.deepEqual([t.result, t.times], [{ ok: false, why: "create was called with other arguments than asked" }, 2], "something may have been written: the pack can tell");
});

test("the day's dollars hold MCP jobs too; a failed job is logged as one; setup trouble carries its `setup`", async () => {
  const app = packApp([caller()], { mcp: claude({ cost: 0.6 }).run });
  await allow(app);
  const one = { calls: [{ tool: "search", input: {} }] };
  assert.equal((await send(app, one)).results?.[0]?.ok, true);
  assert.equal((await send(app, one)).results?.[0]?.ok, true, "0.60 spent is under the cap: one more");
  assert.match((await send(app, one)).error ?? "", /today's cap \(\$1\.00\) is spent/);
  await app.post("/settings/packs/caller/ai", { level: "off", dayUsd: "5" });
  assert.match((await send(app, one)).error ?? "", /not allowed/, "unticked: stopped at once");

  const out = packApp([caller()], { mcp: claude({ fail: new McpSetupError("sign-in", "Claude Code's tracker MCP is needs-auth.") }).run });
  await allow(out);
  const r = await send(out, one);
  assert.deepEqual([r.error, r.setup], ["Claude Code's tracker MCP is needs-auth.", "sign-in"]);
  const row = await out.db.DB.prepare("SELECT kind, cost, ok FROM pack_ai_calls WHERE pack = 'caller'").first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { kind: "mcp", cost: 0, ok: 0 });
});

test("no Claude Code here, or not asked for: told so, with no tick to allow it", async () => {
  const none = packApp([caller()]);
  await allow(none);
  assert.match((await send(none, { calls: [{ tool: "search", input: {} }] })).error ?? "", /Claude Code isn't on this machine/);
  assert.match(await (await none.get("/settings/packs/caller")).text(), /MCP calls: allowed, but Claude Code isn/);
  const plain = packApp([caller(null)], { mcp: claude().run });
  assert.match((await send(plain, { calls: [{ tool: "search", input: {} }] })).error ?? "", /didn't ask for MCP calls/);
  assert.equal((await plain.post("/settings/packs/caller/ai", { mcp: "on" })).status, 404);
});

test("the manifest's ask is read safely and drawn inert", async () => {
  assert.equal(mcpAskOf({ ...MCP, server: { name: "tracker", url: "http://mcp.tracker.example" } }), undefined, "https only");
  assert.equal(mcpAskOf({ ...MCP, server: { name: "tracker", url: "https://u:p@mcp.tracker.example" } }), undefined, "no credentials in the url");
  assert.equal(mcpAskOf({ ...MCP, server: { name: "Tracker,Bash", url: MCP.server.url } }), undefined, "a plain server name");
  assert.equal(mcpAskOf({ ...MCP, why: "" }), undefined);
  assert.equal(mcpAskOf({ why: "x", server: MCP.server }), undefined, "no tools, nothing to allow");
  const a = mcpAskOf({ why: "x", server: MCP.server, reads: ["search", "a,Bash", "mcp__other__x*", 3, "create"], writes: { create: "ticket-create", "bad tool": "k", edit: "Bad Kind" } })!;
  assert.deepEqual([a.reads, a.writes], [["search"], { create: "ticket-create" }], "plain tool names; a tool is a read or a write, never both");
  assert.equal(grantOf({ mcp: "on" }, { text: { why: "y" } }).mcp, false, "no tick it didn't ask for");
  assert.equal(grantOf({ mcp: "on" }, aiAskOf({ ai: { mcp: MCP } })).mcp, true);
  const app = packApp([caller({ ...MCP, why: HOSTILE })], { mcp: claude().run });
  assertInert("pack MCP panel", await (await app.get("/settings/packs/caller")).text());
});

// ── Claude Code's side (src/ai/mcpcalls.ts) ──

const line = (o: unknown) => JSON.stringify(o);
const STREAM = [
  line({ type: "system", subtype: "init", mcp_servers: [{ name: "tracker", status: "connected" }] }),
  "not json",
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__tracker__search", input: { q: "a" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }, { type: "tool_use", id: "t3", name: "mcp__other__search", input: {} }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"issues":' }, { type: "text", text: "[]}" }] }, { type: "tool_result", tool_use_id: "t2", content: "files" }] } }),
  line({ type: "result", total_cost_usd: 0.011, is_error: false, result: "done" }),
].join("\n");

test("the stream: only the named server's calls, each with its tool's own result; the cost", () => {
  const s = readMcpStream(STREAM, "tracker");
  assert.deepEqual(s, { status: "connected", cost: 0.011, calls: [{ tool: "search", input: { q: "a" }, result: '{"issues":[]}', error: false }] });
});

test("a job's arguments: only that server and those tools; nothing built in, no settings, no session", () => {
  const args = mcpArgs({ server: MCP.server, allowed: ["search", "types"], denied: ["create"] });
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at("--tools"), "");
  assert.equal(at("--setting-sources"), "");
  assert.equal(at("--allowedTools"), "mcp__tracker__search,mcp__tracker__types");
  assert.equal(at("--disallowedTools"), "mcp__tracker__create");
  assert.deepEqual(JSON.parse(at("--mcp-config")!), { mcpServers: { tracker: { type: "http", url: MCP.server.url } } });
  for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(args.includes(flag), flag);
  assert.ok(!mcpArgs({ server: MCP.server, allowed: ["create"], denied: [] }).includes("--disallowedTools"));
});

test("claudeMcp: the prompt on stdin; not installed and not signed in are setup errors; no answer is an error", async () => {
  const seen: { bin: string; input?: string }[] = [];
  const job = { server: MCP.server, allowed: ["search"], denied: [], prompt: "Make these calls" };
  const ok = await claudeMcp({ bin: "cc", pre: ["shim.js"], run: async (bin, args, o) => (seen.push({ bin, input: o.input }), assert.equal(args[0], "shim.js"), { code: 0, stdout: STREAM, stderr: "" }) })(job);
  assert.deepEqual([ok.calls.length, ok.cost, seen], [1, 0.011, [{ bin: "cc", input: "Make these calls" }]]);
  const gone = claudeMcp({ run: async () => Promise.reject(new Error("spawn claude ENOENT")) })(job);
  await assert.rejects(gone, (e: McpSetupError) => e.setup === "no-claude");
  const out = claudeMcp({ run: async () => ({ code: 0, stdout: line({ type: "system", subtype: "init", mcp_servers: [{ name: "tracker", status: "needs-auth" }] }), stderr: "" }) })(job);
  await assert.rejects(out, (e: McpSetupError) => e.setup === "sign-in" && /tracker MCP is needs-auth/.test(e.message));
  await assert.rejects(claudeMcp({ run: async () => ({ code: 1, stdout: "", stderr: "boom" }) })(job), /no answer \(exit 1\) boom/);
});
