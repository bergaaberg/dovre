/**
 * Pack tools beyond Claude Code turns (#172):
 *  - Codex turns: -c mcp_servers.dovre.* with the token only in the environment; omp and agy get the
 *    environment for the stdio bridge; Claude Code gets no environment (its --mcp-config is enough)
 *  - the stdio bridge (src/mcp-stdio.ts): loopback only, no tools outside a turn, forwards to /mcp
 *  - Settings registers it in omp's mcp.json (keeping other servers, refusing what isn't plain JSON)
 *    and through `agy mcp add`; a moved Dovre shows as stale
 *  - terminals: a token while open, --mcp-config for claude, the environment for every program
 *  - agy's refusal of an MCP call names the rule that would allow it
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { Hono } from "hono";
import { agyApply, agyHarness } from "../src/agents/agy.ts";
import { codexArgs, codexHarness } from "../src/agents/codex.ts";
import { bridgeEntry, fileState, jsonc, ompFiles, registerTools, toolsState } from "../src/agents/mcpsetup.ts";
import { ompHarness } from "../src/agents/omp.ts";
import { claudeHarness, createRunner, type Run } from "../src/agents/runner.ts";
import { mountMcp } from "../src/mcp.ts";
import { alone, forward, targetOf } from "../src/mcp-stdio.ts";
import { createTerminals, withMcp } from "../src/packs/core/terminal/terms.ts";
import { PACK_API, type Pack } from "../src/packs/types.ts";
import { agentToolsPanel } from "../src/pages/settings.ts";

const URL_ = "http://127.0.0.1:4848/mcp";
const TOKEN = "a".repeat(43);

function spawner() {
  const calls: { bin: string; args: string[]; opts: { cwd: string; env?: Record<string, string> } }[] = [];
  const spawnFn = (bin: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined, kill: () => (child.emit("close", 1), true) });
    calls.push({ bin, args, opts });
    return child;
  };
  return { calls, spawnFn };
}

test("runner: Codex gets -c flags and the token in its environment only; omp and agy the environment; Claude Code none", () => {
  const s = spawner();
  const r = createRunner({ spawnFn: s.spawnFn as never, harnesses: { claude: claudeHarness("claude"), codex: codexHarness("codex"), omp: ompHarness("omp"), agy: agyHarness("agy") }, mcp: { url: URL_ } });
  const runs = (["claude", "codex", "omp", "agy"] as const).map((harness) => r.start({ harness, cwd: "/code/shop", prompt: "p" }));
  const [claude, codex, omp, agy] = s.calls;
  assert.equal(claude!.opts.env, undefined, "Claude Code: no token in its environment");
  for (const c of [codex!, omp!, agy!]) {
    assert.equal(c.opts.env?.DOVRE_MCP_URL, URL_);
    assert.match(c.opts.env?.DOVRE_MCP_TOKEN ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.ok(r.byMcpToken(c.opts.env!.DOVRE_MCP_TOKEN!), "the token belongs to the turn");
  }
  assert.ok(codex!.args.includes(`mcp_servers.dovre.url="${URL_}"`));
  assert.ok(codex!.args.includes('mcp_servers.dovre.bearer_token_env_var="DOVRE_MCP_TOKEN"'));
  assert.ok(!codex!.args.join(" ").includes(codex!.opts.env!.DOVRE_MCP_TOKEN!), "Codex's token isn't in its arguments");
  assert.ok(!omp!.args.join(" ").includes("mcp"), "omp's arguments don't change");
  for (const run of runs) r.stop(run.id);
  const off = spawner();
  const r2 = createRunner({ spawnFn: off.spawnFn as never, harnesses: { codex: codexHarness("codex") }, mcp: { url: URL_, on: () => false } });
  r2.start({ harness: "codex", cwd: "/code/shop", prompt: "p" });
  assert.equal(off.calls[0]!.opts.env, undefined, "no pack tools, nothing");
  assert.ok(!off.calls[0]!.args.join(" ").includes("mcp_servers"));
});

test("codexArgs: the -c flags go before resume", () => {
  const a = codexArgs({ cwd: "/x", prompt: "p", resume: "t-1", mcp: { url: URL_, token: TOKEN } });
  assert.ok(a.lastIndexOf("-c") < a.indexOf("resume"));
  assert.deepEqual(a.slice(-3), ["resume", "t-1", "-"]);
});

test("stdio bridge: only a loopback /mcp and a token-shaped token; without one, no tools", async () => {
  assert.deepEqual(targetOf({ DOVRE_MCP_URL: URL_, DOVRE_MCP_TOKEN: TOKEN }), { url: URL_, token: TOKEN });
  for (const url of ["http://evil.example:4848/mcp", "https://127.0.0.1:4848/mcp", "http://127.0.0.1:4848/other", "http://127.0.0.1.evil.example:1/mcp", ""]) assert.equal(targetOf({ DOVRE_MCP_URL: url, DOVRE_MCP_TOKEN: TOKEN }), undefined, url);
  assert.equal(targetOf({ DOVRE_MCP_URL: URL_, DOVRE_MCP_TOKEN: "short" }), undefined);
  assert.equal(targetOf({ DOVRE_MCP_URL: URL_, DOVRE_MCP_TOKEN: `${"a".repeat(40)} x` }), undefined);
  const init = JSON.parse(alone({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })!);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(JSON.parse(alone({ jsonrpc: "2.0", id: 2, method: "tools/list" })!).result, { tools: [] });
  assert.equal(JSON.parse(alone({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } })!).error.code, -32601);
  assert.equal(alone({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal(JSON.parse((await forward("not json", undefined))!).error.code, -32700);
});

const echo: Pack = {
  manifest: { api: PACK_API, id: "echo", name: "Echo", description: "test", domain: "general" },
  tools: () => [{ name: "say", description: "Says it back.", input: { type: "object" }, run: (a, _c, call) => ({ text: `${call.repo}: ${String(a.text)}` }) }],
};

test("stdio bridge → /mcp: lists and calls a pack's tool with the turn's token; an ended turn says so", async () => {
  const app = new Hono();
  let live = true;
  mountMcp(app, { shown: () => [echo], ctxOf: () => ({}) as never, turnOf: (t) => (live && t === TOKEN ? { id: "r", repo: "shop", cwd: "/code/shop" } : undefined), hosted: false, isLocal: () => true, db: () => undefined, log: () => {} });
  const fetchFn = (url: string, init: RequestInit) => app.request(url, init) as Promise<Response>;
  const t = { url: URL_, token: TOKEN };
  const list = JSON.parse((await forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), t, fetchFn))!);
  assert.deepEqual(list.result.tools.map((x: any) => x.name), ["echo_say"]);
  const call = JSON.parse((await forward(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_say", arguments: { text: "hi" } } }), t, fetchFn))!);
  assert.equal(call.result.content[0].text, "shop: hi");
  assert.equal(await forward(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), t, fetchFn), undefined, "a notification gets no line back");
  live = false;
  const gone = JSON.parse((await forward(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), t, fetchFn))!);
  assert.equal(gone.id, 3);
  assert.match(gone.error.message, /ended/);
  const down = JSON.parse((await forward(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }), t, () => Promise.reject(new Error("ECONNREFUSED"))))!);
  assert.match(down.error.message, /isn't answering/);
});

test("jsonc: comments and trailing commas, strings left alone", () => {
  assert.deepEqual(jsonc('{\n // a\n "u": "http://x//y", /* b */ "a": [1,2,],\n}'), { u: "http://x//y", a: [1, 2] });
  assert.equal(jsonc("{nope"), undefined);
});

test("omp: registered in mcp.json and each profile's, other servers kept; not plain JSON is refused; a moved Dovre is stale", () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-mcpsetup-"));
  const want = bridgeEntry("/opt/node", "/opt/dovre/src/mcp-stdio.ts");
  assert.deepEqual(want.args, ["--experimental-strip-types", "--no-warnings", "/opt/dovre/src/mcp-stdio.ts"]);
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  mkdirSync(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "mcp.json"), JSON.stringify({ mcpServers: { mine: { type: "http", url: "https://x" } }, other: 1 }));
  assert.equal(ompFiles(home).length, 2);
  assert.equal(toolsState("omp", home, want), "no");
  assert.deepEqual(registerTools("omp", { home, want }), { ok: true });
  const main = JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8"));
  assert.deepEqual(main.mcpServers.mine, { type: "http", url: "https://x" });
  assert.equal(main.other, 1);
  assert.deepEqual(main.mcpServers.dovre, { type: "stdio", command: "/opt/node", args: want.args });
  assert.equal(toolsState("omp", home, want), "yes");
  assert.equal(toolsState("omp", home, bridgeEntry("/opt/node2", "/opt/dovre/src/mcp-stdio.ts")), "stale");
  writeFileSync(join(home, ".omp", "profiles", "work", "agent", "mcp.json"), '{ // mine\n "mcpServers": {} }');
  const r = registerTools("omp", { home, want });
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /plain JSON/);
  assert.equal(readFileSync(join(home, ".omp", "profiles", "work", "agent", "mcp.json"), "utf8"), '{ // mine\n "mcpServers": {} }', "left as it was");
});

test("agy: registered through `agy mcp add dovre -- <node> <args>`, read back from its config (comments and all)", () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-mcpsetup-"));
  const want = bridgeEntry("/opt/node", "/opt/dovre/src/mcp-stdio.ts");
  const ran: string[][] = [];
  const file = join(home, ".gemini", "config", "mcp_config.json");
  const run = (bin: string, args: string[]) => {
    ran.push([bin, ...args]);
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(file, `// agy's\n${JSON.stringify({ mcpServers: { dovre: { command: want.command, args: want.args, disabled: false } } })}`);
  };
  assert.equal(registerTools("agy", { home, want, run }).ok, false, "no agy, nothing run");
  assert.deepEqual(registerTools("agy", { home, want, agy: ["/bin/agy"], run }), { ok: true });
  assert.deepEqual(ran[0], ["/bin/agy", "mcp", "add", "dovre", "--", "/opt/node", ...want.args]);
  assert.equal(fileState(file, want), "yes");
  writeFileSync(file, JSON.stringify({ mcpServers: { dovre: { command: want.command, args: want.args, disabled: true } } }));
  assert.equal(fileState(file, want), "stale", "turned off in agy counts as not set up");
  const failing = registerTools("agy", { home, want, agy: ["/bin/agy"], run: () => { throw new Error("boom"); } });
  assert.match((failing as { why: string }).why, /agy mcp add failed/);
});

test("agy: refusing an MCP call it couldn't ask about says which rule would allow it", () => {
  const run = { events: [], partial: "", cost: 0 } as unknown as Run;
  agyApply(run, JSON.stringify({ event: "step_update", step_update: { state: "ERROR", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { error: { type: "TOOL_ERROR", message: 'permission check failed for mcp "dovre/http_send": user denied permission for mcp(dovre/http_send)' } } } }));
  assert.equal(run.events.length, 1);
  assert.match((run.events[0] as { text: string }).text, /mcp\(dovre\/http_send\) to permissions\.allow/);
  agyApply(run, JSON.stringify({ event: "step_update", step_update: { state: "ERROR", tool_info: { error: { message: "something else" } } } }));
  assert.equal(run.events.length, 1);
});

test("terminals: a token while open (claude gets --mcp-config, every program the environment), dead once it ends", () => {
  const code = mkdtempSync(join(tmpdir(), "dovre-terms-"));
  mkdirSync(join(code, "shop", ".git"), { recursive: true });
  const spawned: { args: string[]; opts: any; child: ChildProcess }[] = [];
  const spawnFn = ((_bin: string, args: string[], opts: any) => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    spawned.push({ args, opts, child });
    return child;
  }) as never;
  let on = true;
  const programs = [
    { id: "claude", label: "Claude Code", argv: ["/bin/claude"], harness: "claude" as const },
    { id: "zsh", label: "zsh", argv: ["/bin/zsh"] },
  ];
  const t = createTerminals({ hostExe: "/bin/dovre", codeDir: code, programs, spawnFn, mcp: { url: URL_, on: () => on } });
  const a = t.start({ program: "claude", repo: "shop" });
  const b = t.start({ program: "zsh", repo: "shop" });
  assert.ok(!("problem" in a) && !("problem" in b));
  const [ca, cb] = spawned;
  const cfg = JSON.parse(ca!.args[ca!.args.indexOf("--mcp-config") + 1]!);
  const token = cfg.mcpServers.dovre.headers.Authorization.replace("Bearer ", "");
  assert.equal(ca!.opts.env.DOVRE_MCP_TOKEN, token);
  assert.ok(!cb!.args.includes("--mcp-config"));
  assert.match(cb!.opts.env.DOVRE_MCP_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(cb!.opts.env.DOVRE_MCP_TOKEN, token);
  assert.deepEqual(t.byMcpToken(token), { id: `terminal:${(a as { id: string }).id}`, repo: "shop", cwd: join(code, "shop") });
  assert.ok(!JSON.stringify(t.list()).includes(token), "never on the listed terminal");
  ca!.child.emit("close");
  assert.equal(t.byMcpToken(token), undefined);
  assert.ok(t.byMcpToken(cb!.opts.env.DOVRE_MCP_TOKEN));
  on = false;
  t.start({ program: "zsh", repo: "shop" });
  assert.equal(spawned[2]!.opts.env, undefined);
  assert.deepEqual(withMcp({ id: "codex", label: "Codex", argv: ["codex"], harness: "codex" }, ["codex"], { url: URL_, token: TOKEN }).argv.slice(1, 3), ["-c", `mcp_servers.dovre.url="${URL_}"`]);
});

test("Settings panel: Claude Code and Codex by themselves, a Confirm for omp and agy until set up, what Register said escaped", () => {
  const h = String(agentToolsPanel({ offered: true, rows: [{ id: "claude" }, { id: "omp", state: "no" }, { id: "agy", state: "yes" }], said: { ok: false, text: "<script>x</script>" } }));
  assert.ok(h.includes("/settings/agent-tools/omp"));
  assert.ok(!h.includes("/settings/agent-tools/agy"), "set up: no button");
  assert.ok(h.includes("&lt;script&gt;") && !h.includes("<script>x"));
  assert.ok(h.includes("mcp(dovre/http_send)"));
});

test("POST /settings/agent-tools/:h: Dovre's own origin, omp or agy only, logged; Settings shows what it said; hosted, nothing", async () => {
  const { createApp } = await import("../src/app.ts");
  const { openDb } = await import("../src/db.ts");
  const { fakeGhe, fixedGatherer, snapshot } = await import("./helpers.ts");
  const db = openDb();
  const { ghe } = fakeGhe({});
  const asked: string[] = [];
  const agentTools = { view: () => ({ offered: true, rows: [{ id: "omp" as const, state: "no" as const }] }), register: (h: string) => (asked.push(h), h === "omp" ? { ok: true as const } : { ok: false as const, why: "agy <b>broke</b>" }) };
  const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
  const app = createApp({ ...ENV, DB: db.DB } as never, { gatherer: fixedGatherer(snapshot()), ghe, agentTools });
  const post = (h: string, headers: Record<string, string> = { origin: "http://127.0.0.1:4848" }) => app.request(`http://127.0.0.1:4848/settings/agent-tools/${h}`, { method: "POST", headers: { cookie: "u_tk=test-token", ...headers } });
  assert.equal((await post("omp", { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("omp", { origin: "http://127.0.0.1:4848", "sec-fetch-site": "cross-site" })).status, 404);
  assert.equal((await post("claude")).status, 404);
  assert.deepEqual(asked, []);
  assert.equal((await post("agy")).status, 303);
  const page = await (await app.request("http://127.0.0.1:4848/settings", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.ok(page.includes("Pack tools for agents"));
  assert.ok(page.includes("agy &lt;b&gt;broke&lt;/b&gt;") && !page.includes("<b>broke"));
  assert.equal((await post("omp")).status, 303);
  const logged = (await db.DB.prepare("SELECT target, ok FROM actions WHERE kind = 'agents.tools' ORDER BY id").all<{ target: string; ok: number }>()).results;
  assert.deepEqual(logged.map((r) => [r.target, r.ok]), [["agy", 0], ["omp", 1]]);
  const hosted = createApp({ ...ENV, DB: db.DB, IS_HOSTED: "1" } as never, { gatherer: fixedGatherer(snapshot()), ghe, agentTools });
  assert.notEqual((await hosted.request("http://127.0.0.1:4848/settings/agent-tools/omp", { method: "POST", headers: { origin: "http://127.0.0.1:4848" } })).status, 303);
});
