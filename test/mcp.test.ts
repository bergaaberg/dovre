/**
 * The agent turns' MCP server (src/mcp.ts, dovre#153):
 *  - each Claude Code turn gets --mcp-config with a token of its own, only while packs offer tools;
 *    the token stays out of the run (never drawn, never sent to the Worker) and dies with the turn
 *  - POST /mcp: local Host only, no Origin, a running turn's token (not the launch cookie);
 *    initialize, tools/list, tools/call with the turn's repo, results capped, every call logged
 *    without its arguments
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { createRunner, type Runner } from "../src/agents/runner.ts";
import { argsFor } from "../src/agents/harnesses/claude/harness.ts";
import { mcpConfig } from "../src/agents/harnesses/shared.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { activePacks } from "../src/packs/registry.ts";
import { MAX_RESULT, mountMcp } from "../src/mcp.ts";
import { PACK_API, type Pack, type ToolCall } from "../src/packs/types.ts";
import type { Env } from "../src/env.ts";
import { fakeGhe, fixedGatherer, snapshot } from "./helpers.ts";

const ENV: Omit<Env, "DB"> = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" } as Omit<Env, "DB">;

/** A turn that says its session and then waits (or ends, when `end`), recording its arguments. */
function spawner() {
  const calls: { bin: string; args: string[]; end: () => void }[] = [];
  const spawnFn = (bin: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined, kill: () => (child.emit("close", 1), true) });
    const end = () => {
      stdout.write(`${JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0 })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    };
    calls.push({ bin, args, end });
    setImmediate(() => stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000001" })}\n`));
    return child;
  };
  return { calls, spawnFn };
}
const tokenOf = (args: string[]) => {
  const at = args.indexOf("--mcp-config");
  if (at < 0) return undefined;
  return (JSON.parse(args[at + 1]!) as { mcpServers: { dovre: { headers: { Authorization: string } } } }).mcpServers.dovre.headers.Authorization.replace("Bearer ", "");
};
const ended = (r: Runner, id: string) => new Promise<void>((res) => {
  const t = setInterval(() => r.get(id)?.status !== "running" && (clearInterval(t), res()), 5);
});

test("argsFor: --mcp-config names Dovre's server with the turn's token, before --allowedTools (which takes the rest)", () => {
  const a = argsFor({ cwd: "/x", prompt: "p", mcp: { url: "http://127.0.0.1:4848/mcp", token: "t".repeat(43) }, allowed: ["Bash(ls)"] });
  assert.ok(a.indexOf("--mcp-config") < a.indexOf("--allowedTools"));
  assert.deepEqual(JSON.parse(a[a.indexOf("--mcp-config") + 1]!), { mcpServers: { dovre: { type: "http", url: "http://127.0.0.1:4848/mcp", headers: { Authorization: `Bearer ${"t".repeat(43)}` } } } });
  assert.ok(!a.includes("--strict-mcp-config"), "the user's own servers stay");
  assert.ok(!argsFor({ cwd: "/x", prompt: "p" }).includes("--mcp-config"));
  assert.equal(mcpConfig({ url: "u", token: "k" }), '{"mcpServers":{"dovre":{"type":"http","url":"u","headers":{"Authorization":"Bearer k"}}}}');
});

test("runner: a token per Claude Code turn while packs offer tools, valid only while it runs, never on the run", async () => {
  let on = true;
  const s = spawner();
  const r = createRunner({ spawnFn: s.spawnFn as never, mcp: { url: "http://127.0.0.1:4848/mcp", on: () => on } });
  const one = r.start({ cwd: "/code/shop", prompt: "a" });
  const two = r.start({ cwd: "/code/shop", prompt: "b" });
  const t1 = tokenOf(s.calls[0]!.args)!;
  const t2 = tokenOf(s.calls[1]!.args)!;
  assert.ok(t1 && t2 && t1 !== t2 && t1.length >= 43);
  assert.equal(r.byMcpToken(t1)?.id, one.id);
  assert.equal(r.byMcpToken(t2)?.id, two.id);
  assert.equal(r.byMcpToken(t1.slice(0, -1) + (t1.endsWith("A") ? "B" : "A")), undefined);
  assert.equal(r.byMcpToken(""), undefined);
  assert.ok(!JSON.stringify(one).includes(t1), "the token isn't part of the run");
  s.calls[0]!.end();
  await ended(r, one.id);
  assert.equal(r.byMcpToken(t1), undefined, "an ended turn's token is dead");
  assert.equal(r.byMcpToken(t2)?.id, two.id);
  r.stop(two.id);
  assert.equal(r.byMcpToken(t2), undefined, "a stopped one's too");
  on = false;
  r.start({ cwd: "/code/shop", prompt: "c" });
  assert.equal(tokenOf(s.calls[2]!.args), undefined, "no tools, no server");
});

const echo: Pack = {
  manifest: { api: PACK_API, id: "echo-pack", name: "Echo", description: "test", domain: "general" },
  tools: () => [
    { name: "say", description: "Says it back.", input: { type: "object", properties: { text: { type: "string" } } }, run: (a, _ctx, call: ToolCall) => ({ text: `${call.repo}: ${String(a.text)}` }) },
    { name: "big", description: "A lot.", input: { type: "object" }, run: () => ({ text: "x".repeat(MAX_RESULT + 10) }) },
    { name: "boom", description: "Throws.", input: { type: "object" }, run: () => { throw new Error("secret detail"); } },
    { name: "Bad Name", description: "Never offered.", input: { type: "object" }, run: () => ({ text: "" }) },
  ],
};

function mounted(o: { hosted?: boolean } = {}) {
  const app = new Hono();
  const logs: string[] = [];
  const db = openDb();
  const turns = new Map([["k".repeat(40), { id: "run-1", repo: "shop", cwd: "/code/shop" }]]);
  mountMcp(app, { shown: () => [echo], ctxOf: () => ({}) as never, turnOf: (t) => turns.get(t), hosted: !!o.hosted, isLocal: (req) => ["localhost", "127.0.0.1"].includes(new URL(req.url).hostname), db: () => db.DB, log: (l) => void logs.push(l), version: "9" });
  const rpc = (body: unknown, h: Record<string, string> = {}, host = "127.0.0.1:4848") =>
    app.request(`http://${host}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${"k".repeat(40)}`, ...h }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const actions = async () => (await db.DB.prepare("SELECT kind, target, detail, ok FROM actions ORDER BY id").all<{ kind: string; target: string; detail: string; ok: number }>()).results;
  return { app, rpc, logs, actions };
}

test("POST /mcp: local Host, no Origin, a running turn's token; anything else gets nothing", async () => {
  const m = mounted();
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  assert.equal((await m.rpc(init, {}, "evil.example")).status, 404);
  assert.equal((await m.rpc(init, { origin: "http://127.0.0.1:4848" })).status, 403, "a browser page, even this app's own");
  assert.equal((await m.rpc(init, { authorization: "" })).status, 401);
  assert.equal((await m.rpc(init, { authorization: `Bearer ${"z".repeat(40)}` })).status, 401);
  assert.equal((await m.app.request("http://127.0.0.1:4848/mcp")).status, 405);
  assert.equal((await mounted({ hosted: true }).rpc(init)).status, 404);
  const ok = await m.rpc(init);
  assert.equal(ok.status, 200);
  const j = (await ok.json()) as any;
  assert.equal(j.result.protocolVersion, "2025-06-18");
  assert.deepEqual(j.result.serverInfo, { name: "dovre", version: "9" });
  assert.equal((await (await m.rpc({ ...init, params: { protocolVersion: "1999-01-01" } })).json() as any).result.protocolVersion, "2025-06-18");
});

test("tools: listed as <pack>_<name>, called with the turn's repo, capped, a throw kept vague, logged without arguments", async () => {
  const m = mounted();
  assert.equal((await m.rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await (await m.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["echo_pack_say", "echo_pack_big", "echo_pack_boom"]);
  assert.deepEqual(list.result.tools[0].inputSchema, { type: "object", properties: { text: { type: "string" } } });
  const said = (await (await m.rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_pack_say", arguments: { text: "hi there" } } })).json()) as any;
  assert.deepEqual(said.result, { content: [{ type: "text", text: "shop: hi there" }], isError: false });
  const big = (await (await m.rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo_pack_big" } })).json()) as any;
  assert.ok(big.result.content[0].text.length < MAX_RESULT + 20 && big.result.content[0].text.endsWith("…(cut)"));
  const boom = (await (await m.rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo_pack_boom" } })).json()) as any;
  assert.deepEqual(boom.result, { content: [{ type: "text", text: "The tool failed." }], isError: true });
  assert.ok(m.logs.some((l) => l.includes("secret detail")), "the reason goes to the log, not the model");
  assert.equal(((await (await m.rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo_pack_Bad Name" } })).json()) as any).error.code, -32602);
  assert.equal(((await (await m.rpc({ jsonrpc: "2.0", id: 7, method: "resources/list" })).json()) as any).error.code, -32601);
  assert.equal((await m.rpc([{ jsonrpc: "2.0", id: 8, method: "ping" }])).status, 400, "no batches");
  assert.equal((await m.rpc("{nope")).status, 400);
  const log = await m.actions();
  assert.deepEqual(log.map((a) => [a.kind, a.target, a.ok]), [["mcp.call", "echo_pack_say", 1], ["mcp.call", "echo_pack_big", 1], ["mcp.call", "echo_pack_boom", 0]]);
  assert.ok(!JSON.stringify(log).includes("hi there"), "arguments aren't logged");
});

test("in the app: the launch cookie doesn't open /mcp, a turn's token does; hosted it isn't there", async () => {
  const s = spawner();
  const runner = createRunner({ spawnFn: s.spawnFn as never, mcp: { url: "http://127.0.0.1:4848/mcp" } });
  const db = openDb();
  const { ghe } = fakeGhe({});
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe, runner, packs: { ...activePacks([echo], { env: {}, hosted: false, which: () => "/bin/x" }), env: {} } });
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const post = (h: Record<string, string>) => app.request("http://127.0.0.1:4848/mcp", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(list) });
  assert.equal((await post({ cookie: "u_tk=test-token" })).status, 401);
  assert.equal((await post({ authorization: "Bearer test-token" })).status, 401);
  const run = runner.start({ cwd: "/code/shop", prompt: "go" });
  const res = await post({ authorization: `Bearer ${tokenOf(s.calls[0]!.args)}` });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as any).result.tools.map((t: any) => t.name), ["echo_pack_say", "echo_pack_big", "echo_pack_boom"]);
  runner.stop(run.id);
  assert.equal((await post({ authorization: `Bearer ${tokenOf(s.calls[0]!.args)}` })).status, 401);
  const hosted = createApp({ ...ENV, DB: db.DB, IS_HOSTED: "1" }, { gatherer: fixedGatherer(snapshot()), ghe, runner });
  assert.equal((await hosted.request("http://127.0.0.1:4848/mcp", { method: "POST", body: "{}" })).status, 404);
});
