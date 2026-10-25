/**
 * The Data tab's production databases, against a stand-in `db mcp` (never the real one): nothing
 * reaches db until I ask, db's question goes to the bar and only my answer opens a database, a no
 * holds, Close and quiet end db, and what comes back is drawn inert, uncached, and never refetched.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { createApp } from "../src/app.ts";
import { colsOf, createData, tablesOf } from "../src/data/db.ts";
import { createDbMcp, tableOf } from "../src/data/mcp.ts";
import { createProd, prodOk } from "../src/data/prod.ts";
import { openDb } from "../src/db.ts";
import { askInBar, createAsks } from "../src/relay/asks.ts";
import { H, assertInert, fakeGhe, snapshot } from "./helpers.ts";
import { setDataNames } from "../src/data/db.ts";

// The names an org's db CLI uses: its test databases' prefix, and a DB2 database with no test copy.
setDataNames({ prefix: "acme-sqldb-", db2: "warehouse" });

/** db-cli's own question, as its MCP server puts it (the shape test/relay.test.ts reads). */
const question = (t: string) => ({ message: `Open PRODUCTION ${t}? A yes covers this database until the session ends.`, requestedSchema: { type: "object", properties: { decision: { type: "string", title: `Production access to ${t}`, enum: ["deny", "allow"] } }, required: ["decision"] } });
const table = (columns: string[], rows: (string | null)[][]) => ({ columns, rows, rowCount: rows.length, truncated: false });

/**
 * A stand-in for `db mcp`: answers tools/call like db does, and for a prod target asks first
 * (elicitation/create) and holds the answer, yes or no, until it ends. Records every call.
 */
function standIn(o: { answers?: Record<string, unknown>; ping?: boolean } = {}) {
  const calls: { tool: string; args: Record<string, any> }[] = [];
  const spawned: { killed: boolean }[] = [];
  const spawnFn = () => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const me = { killed: false };
    spawned.push(me);
    const approved = new Map<string, boolean>();
    const waiting = new Map<number, (r: any) => void>();
    let myId = 1000;
    const say = (m: unknown) => stdout.write(`${JSON.stringify(m)}\n`);
    const ask = (params: unknown) => new Promise<any>((res) => {
      const id = myId++;
      waiting.set(id, res);
      say({ jsonrpc: "2.0", id, method: "elicitation/create", params });
    });
    let buf = "";
    stdin.on("data", async (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (m.id !== undefined && waiting.has(m.id)) {
          waiting.get(m.id)!(m);
          waiting.delete(m.id);
          continue;
        }
        if (m.method === "initialize") {
          assert.ok(m.params.capabilities.elicitation, "says it can ask");
          say({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "db", version: "stand-in" } } });
          if (o.ping) say({ jsonrpc: "2.0", id: 999, method: "ping" });
        } else if (m.method === "tools/call") {
          const { name, arguments: args } = m.params;
          calls.push({ tool: name, args });
          const t = String(args.target);
          if (t.endsWith(":prod")) {
            if (!approved.has(t)) {
              const r = await ask(question(t));
              approved.set(t, r.result?.action === "accept" && r.result.content?.decision === "allow");
            }
            if (!approved.get(t)) {
              say({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: `production access to ${t} was declined for this session` }] } });
              continue;
            }
          }
          const a = o.answers?.[name] ?? table(["schema", "tables"], [["dbo", "3"]]);
          say({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(a) }], structuredContent: a } });
        }
      }
    });
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: 1, kill: () => ((me.killed = true), stdout.end(), setImmediate(() => child.emit("close", 0)), true) });
    return child;
  };
  return { spawnFn, calls, spawned };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("which production databases the tab may ask for", () => {
  for (const ok of ["ledger:prod", "api-shop:prod", "warehouse:prod"]) assert.ok(prodOk(ok), ok);
  for (const bad of ["ledger:pre", "ledger:at", "ledger", "pre:prod", "prod:prod", "warehouse:pre", "Ledger:prod", "ledger:prod ", "ledger:prod;x", "", undefined]) assert.ok(!prodOk(bad), String(bad));
});

test("db's answer as rows; its question to whoever asks; a ping answered; quiet ends db", async () => {
  assert.deepEqual(tableOf(table(["a", "b"], [["1", null]])), { rows: [{ a: "1", b: null }], columns: ["a", "b"], truncated: false });
  // db mcp says every value as a string: counts and positions are read as numbers all the same.
  assert.deepEqual(tablesOf(tableOf(table(["Schema", "Table", "Rows"], [["dbo", "Event", "1204331"]])).rows), [{ schema: "dbo", table: "Event", rows: 1204331 }]);
  assert.equal(colsOf(tableOf(table(["pos", "column", "type", "nullable", "key"], [["3", "Id", "int", "NOT NULL", null]])).rows)[0]!.pos, 3);
  const f = standIn({ ping: true });
  const asked: string[] = [];
  let closed = 0;
  const mcp = createDbMcp({ bin: "db", spawnFn: f.spawnFn as never, idleMs: 60, onClose: () => closed++, ask: async (message) => (asked.push(message), { action: "accept", content: { decision: "allow" } }) });
  assert.deepEqual(await mcp.call("tables", { target: "ledger:prod" }), table(["schema", "tables"], [["dbo", "3"]]));
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /Open PRODUCTION ledger:prod/);
  await mcp.call("tables", { target: "ledger:prod" });
  assert.equal(asked.length, 1, "a yes holds while db runs");
  await tick(120);
  assert.ok(f.spawned[0]!.killed && !mcp.running() && closed === 1, "ended after quiet");
});

test("nothing reaches db until I ask; db asks in the bar; Allow opens it, Deny keeps it shut; Close ends db", async () => {
  const f = standIn({ answers: { tables: table(["schema", "table", "rows"], [["dbo", H, "12"]]), query: table([H, "n"], [[H, null]]), columns: table(["pos", "column", "type", "nullable", "key"], [["1", "Id", "int", "NOT NULL", "PK"]]), peek: table(["Id"], [["1"]]) } });
  const s = snapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const asks = createAsks();
  let changes = 0;
  const prod = createProd({ mcp: (onClose) => createDbMcp({ bin: "db", spawnFn: f.spawnFn as never, ask: askInBar(asks, "db"), onClose }), onChange: () => changes++ });
  const atCalls: string[][] = [];
  const data = createData({ bin: "db", run: async (_b, args) => (atCalls.push(args), { code: 0, stdout: args[0] === "ls" ? "acme-sqldb-ledger-at" : "[]", stderr: "" }) });
  const db = openDb();
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: db.DB }, { gatherer, ghe: fakeGhe({}).ghe, data, prod, asks });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const post = (path: string, body: Record<string, string>, referer?: string) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...(referer ? { referer } : {}) }, body: new URLSearchParams(body).toString() });

  const home = await (await get("/data")).text();
  assert.match(home, /Production <span class="pill warn">production<\/span>/);
  assert.match(home, /href="\/data\/db\?t=ledger%3Aprod"/);
  assert.match(home, /href="\/data\/db\?t=warehouse%3Aprod"/);

  // Closed: a gate, and db isn't even started.
  for (const res of [await get("/data/db?t=ledger:prod"), await get("/data/table?t=ledger:prod&n=dbo.Event"), await post("/data/q", { t: "ledger:prod", sql: "SELECT 1" })]) {
    const out = await res.text();
    assert.match(out, /Ask to open ledger:prod/);
    assert.match(out, /<meta name="u-topics" content="snapshot prod">/, "the gate follows along");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.spawned.length, 0, "nothing reached db");

  // I ask: db asks me in the bar, with Deny first; the gate says where.
  const opened = await post("/data/prod/open", { t: "ledger:prod" });
  assert.equal(opened.headers.get("location"), "/data/db?t=ledger%3Aprod");
  await tick();
  assert.deepEqual(f.calls.map((c) => [c.tool, c.args.target]), [["schemas", "ledger:prod"]]);
  const [q] = asks.list();
  assert.ok(q && q.server === "db");
  assert.deepEqual(q.choices.map((c) => [c.value, c.safe]), [["deny", true], ["allow", false]]);
  const waiting = await (await get("/data/db?t=ledger:prod")).text();
  assert.match(waiting, /db asks in the bar at the top/);
  assert.match(waiting, /id="prod-gate" data-pending/);
  assert.equal(f.calls.length, 1, "the gate itself calls nothing");

  // Allow: open, and the database's pages draw what db said, inert, never refetched.
  await post(`/relay/ask/${q.id}/answer`, { choice: "allow" }, "http://localhost/data/db?t=ledger:prod");
  await tick();
  assert.deepEqual(prod.opened(), ["ledger:prod"]);
  for (const res of [await get("/data/db?t=ledger:prod"), await get("/data/table?t=ledger:prod&n=dbo.Event"), await post("/data/q", { t: "ledger:prod", sql: `SELECT '${H}'` })]) {
    const out = await res.text();
    assertInert("prod", out);
    assert.match(out, /<span class="pill warn">production<\/span>/);
    assert.match(out, /<meta name="u-topics" content="data">/, "no live update fetches it again");
    assert.match(out, /action="\/data\/prod\/close"/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  const sent = f.calls.find((c) => c.tool === "query")!;
  assert.equal(sent.args.sql, `SELECT '${H}'`);
  assert.equal(sent.args.max_rows, 501);
  assert.ok(f.calls.every((c) => c.args.target === "ledger:prod"));
  assert.equal(asks.list().length, 0, "asked once");
  assert.ok(atCalls.every((a) => !a.some((x) => /prod/.test(x))), "the CLI never sees production");

  // Deny: shut for as long as db runs, and the page says how to be asked again.
  await post("/data/prod/open", { t: "warehouse:prod" });
  await tick();
  const [q2] = asks.list();
  await post(`/relay/ask/${q2!.id}/answer`, { decline: "1" });
  await tick();
  const refused = await (await get("/data/db?t=warehouse:prod")).text();
  assert.match(refused, /warehouse:prod stays closed/);
  assert.match(refused, /declined for this session/);
  assert.equal(f.calls.filter((c) => c.args.target === "warehouse:prod").length, 1);
  assert.equal((await post("/data/q", { t: "warehouse:prod", sql: "SELECT 1" })).status, 200);
  assert.equal(f.calls.filter((c) => c.args.target === "warehouse:prod").length, 1, "a query on a shut database never reaches db");

  // Close: db ends, everything is shut again.
  await post("/data/prod/close", {});
  assert.ok(f.spawned[0]!.killed);
  assert.deepEqual(prod.opened(), []);
  assert.match(await (await get("/data/db?t=ledger:prod")).text(), /Ask to open ledger:prod/);
  assert.ok(changes > 3, "every change is news for the gate");

  // The log holds what was asked for, never what came back.
  const log = await db.DB.prepare("SELECT kind, target, detail FROM actions ORDER BY id").all<{ kind: string; target: string; detail: string | null }>();
  assert.deepEqual(log.results.filter((r) => r.kind === "data.prod.open").map((r) => r.target), ["ledger:prod", "warehouse:prod"]);
  assert.ok(!JSON.stringify(log.results).includes("<script>"), "no result in the log");
});

test("the at pages don't refresh themselves either (a refresh would run db again)", async () => {
  const s = snapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const data = createData({ bin: "db", run: async () => ({ code: 0, stdout: "[]", stderr: "" }) });
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: openDb().DB }, { gatherer, ghe: fakeGhe({}).ghe, data });
  const page = await (await app.request("http://localhost/data/table?t=ledger:at&n=dbo.Event", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.match(page, /<meta name="u-topics" content="data">/);
  assert.doesNotMatch(page, /Production/, "no production without db mcp");
});

test("several production databases asked for at once: db asks about each, Allow all opens them together", async () => {
  const f = standIn({ answers: { tables: table(["schema", "table", "rows"], [["dbo", "T", "1"]]) } });
  const s = snapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const asks = createAsks();
  const prod = createProd({ mcp: (onClose) => createDbMcp({ bin: "db", spawnFn: f.spawnFn as never, ask: askInBar(asks, "db"), onClose }) });
  const data = createData({ bin: "db", run: async (_b, args) => ({ code: 0, stdout: args[0] === "ls" ? "acme-sqldb-ledger-at\nacme-sqldb-shop-at" : "[]", stderr: "" }) });
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: openDb().DB }, { gatherer, ghe: fakeGhe({}).ghe, data, prod, asks });
  const send = (path: string, body: [string, string][]) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });

  const home = await (await get("/data")).text();
  assert.match(home, /Ask to open several at once/);
  assert.match(home, /<input type="checkbox" name="t" value="shop:prod">/);
  assert.equal((await send("/data/prod/open", [])).headers.get("location"), "/data", "nothing ticked: back");
  assert.equal((await send("/data/prod/open", [["t", "ledger:pre"]])).status, 404, "never pre");
  assert.equal(f.calls.length, 0);

  const res = await send("/data/prod/open", [["t", "ledger:prod"], ["t", "shop:prod"], ["t", "ledger:prod"]]);
  assert.equal(res.headers.get("location"), "/data");
  for (let i = 0; i < 50 && asks.list().length < 2; i++) await tick();
  assert.deepEqual(f.calls.map((c) => c.args.target).sort(), ["ledger:prod", "shop:prod"], "each once");
  const asking = await (await get("/data")).text();
  assert.match(asking, /ledger<\/span><span class="n">asking/);
  assert.match(asking, /db asks 2 questions/);
  await send("/relay/asks/answer", [["ids", asks.list().map((q) => q.id).join(",")], ["choice", "allow"]]);
  for (let i = 0; i < 50 && prod.opened().length < 2; i++) await tick();
  assert.deepEqual(prod.opened().sort(), ["ledger:prod", "shop:prod"]);
  prod.close();
});
