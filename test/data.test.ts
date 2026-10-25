/** The Data tab: test databases only, SQL on stdin, a row cap, db's errors without the command, and pages that draw any value inert. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ROWS, appsOf, createData, problemOf, rowsOf, targetOk } from "../src/data/db.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Ran } from "../src/spawn.ts";
import { H, assertInert, fakeGhe, snapshot } from "./helpers.ts";
import { setDataNames } from "../src/data/db.ts";

// The names an org's db CLI uses: its test databases' prefix, and a DB2 database with no test copy.
setDataNames({ prefix: "acme-sqldb-", db2: "warehouse" });

test("only local and at open: never pre, prod, Warehouse, or anything that isn't plainly a target", () => {
  for (const ok of ["local", "local:ShopDb", "local:Ledger", "ledger:at", "api-shop:at", "billing-sync:at"]) assert.ok(targetOk(ok), ok);
  for (const bad of ["ledger:pre", "ledger:prod", "ledger", "warehouse:at", "warehouse", "WAREHOUSE:at", "pre:at", "ledger:at ", "ledger:at;x", "local:a b", "local:../x", "-f", "", undefined, 5, "Ledger:at"]) assert.ok(!targetOk(bad), String(bad));
});

test("apps in at come from db ls's database names; pre and dev ones are left out", () => {
  const ls = ["acme-sqldb-ledger-at", "acme-sqldb-ledger-pre", "acme-sqldb-api-shop-at", "acme-sqldb-rpa-dev", "acme-sqldb-ana-pre", "something-else-at", ""].join("\r\n");
  assert.deepEqual(appsOf(ls), ["api-shop", "ledger"]);
});

test("rows: db's JSON array, nothing for an empty result; anything else is refused", () => {
  assert.deepEqual(rowsOf(""), []);
  assert.deepEqual(rowsOf('[{"a":1},\n{"a":null}]'), [{ a: 1 }, { a: null }]);
  assert.throws(() => rowsOf('{"a":1}'));
  assert.equal(problemOf({ code: 1, stdout: "", stderr: "db: read-only: statement 1 starts with \"DELETE\"\nmore\n" }), 'read-only: statement 1 starts with "DELETE" more');
});

function fakeRun(answer: (args: string[], input?: string) => Ran | Error) {
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (_bin: string, args: string[], o: { input?: string }) => {
    calls.push({ args, input: o.input });
    const a = answer(args, o.input);
    if (a instanceof Error) throw a;
    return a;
  };
  return { run, calls };
}
const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });

test("a query goes in on stdin, comes back capped, and the cap says so", async () => {
  const many = JSON.stringify(Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ n: i })));
  const f = fakeRun(() => ok(many));
  const data = createData({ bin: "db", run: f.run });
  const r = await data.query("ledger:at", "  SELECT n FROM dbo.x WHERE s = 'a \"b\"'  ");
  assert.equal(f.calls[0]!.input, "SELECT n FROM dbo.x WHERE s = 'a \"b\"'");
  assert.deepEqual(f.calls[0]!.args, ["ledger:at", "q", "-", `SELECT * FROM t LIMIT ${MAX_ROWS + 1}`, "-f", "json"]);
  assert.equal(r.rows.length, MAX_ROWS);
  assert.ok(r.capped);
  assert.deepEqual(r.columns, ["n"]);
  await assert.rejects(data.query("ledger:pre", "SELECT 1"), /Only local and at/);
  await assert.rejects(data.query("ledger:at", "   "), /Write a query/);
  await assert.rejects(data.cols("ledger:at", "x; drop"), /schema\.table/);
  await assert.rejects(data.find("ledger:at", "a'b"), /part of a table/);
  assert.equal(f.calls.length, 1, "nothing refused reached db");
});

test("db's own complaint shows; a failure to run never shows its command line", async () => {
  const refused = createData({ bin: "db", run: fakeRun(() => ({ code: 1, stdout: "", stderr: "db: read-only: not a read" })).run });
  await assert.rejects(refused.query("ledger:at", "DELETE FROM x"), /^Error: read-only: not a read$/);
  const broken = createData({ bin: "db", run: fakeRun(() => new Error("Command failed: db ledger:at q SELECT secret_column FROM x")).run });
  await assert.rejects(broken.query("ledger:at", "SELECT 1"), (e: Error) => !e.message.includes("secret_column") && /couldn't be started/.test(e.message));
  const big = createData({ bin: "db", run: fakeRun(() => new Error("stdout maxBuffer length exceeded")).run });
  await assert.rejects(big.query("ledger:at", "SELECT 1"), /too big/);
});

test("targets: at apps from db ls, local databases when docker answers, kept an hour", async () => {
  let t = 0;
  const f = fakeRun((args) => (args[0] === "ls" ? ok("acme-sqldb-ledger-at\nacme-sqldb-ledger-pre\n") : args[1] === "dbs" ? ok('[{"name":"ShopDb"},{"name":"bad name"}]') : ok("")));
  const data = createData({ bin: "db", run: f.run, now: () => t });
  assert.deepEqual((await data.targets()).targets.map((x) => x.id), ["ledger:at", "local:ShopDb"]);
  t += 60_000;
  await data.targets();
  assert.equal(f.calls.length, 2, "the second ask is answered from what was kept");
  const down = createData({ bin: "db", run: fakeRun((args) => (args[0] === "ls" ? ok("acme-sqldb-ledger-at") : { code: 1, stdout: "", stderr: "db: cannot connect" })).run });
  assert.deepEqual((await down.targets()).targets.map((x) => x.id), ["ledger:at"], "local off: not offered, not an error");
});

function appWith(answer: (args: string[], input?: string) => Ran | Error) {
  const f = fakeRun(answer);
  const s = snapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: openDb().DB }, { gatherer, ghe: fakeGhe({}).ghe, data: createData({ bin: "db", run: f.run }) });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const post = (path: string, body: Record<string, string>) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  return { get, post, calls: f.calls };
}

test("the pages: Data in the top bar, databases, tables, a table, a query; hostile names and values drawn inert, results not cached", async () => {
  const hostileRows = JSON.stringify([{ [H]: H, n: null, o: { x: H } }]);
  const w = appWith((args) =>
    args[0] === "ls" ? ok(`acme-sqldb-ledger-at`) : args[1] === "dbs" ? ok("") : args[1] === "tables" ? ok(JSON.stringify([{ schema: H, table: H, rows: 3 }])) : args[1] === "find" ? ok(JSON.stringify([{ schema: "dbo", table: H, column: H, type: H }])) : args[1] === "cols" ? ok(JSON.stringify([{ pos: 1, column: H, type: H, nullable: "NULL", key: H }])) : ok(hostileRows),
  );
  const home = await (await w.get("/data")).text();
  assert.match(home, /<a href="\/data" title="Data" aria-current="page">/);
  assert.match(home, /href="\/data\/db\?t=ledger%3Aat"/);
  for (const [name, res] of [
    ["db", await w.get(`/data/db?t=ledger:at&find=${encodeURIComponent("Event")}`)],
    ["table", await w.get("/data/table?t=ledger:at&n=dbo.Event")],
    ["query", await w.post("/data/q", { t: "ledger:at", sql: `SELECT '${H}'` })],
  ] as const) {
    const out = await res.text();
    assertInert(name, out);
    assert.equal(res.headers.get("cache-control"), "no-store", name);
  }
  const q = await (await w.post("/data/q", { t: "ledger:at", sql: "SELECT 1" })).text();
  assert.match(q, /<span class="t3">NULL<\/span>/);
});

test("pre, prod and odd targets are refused before db starts", async () => {
  const w = appWith(() => ok("[]"));
  for (const t of ["ledger:pre", "ledger:prod", "warehouse:at", "ledger"]) {
    assert.equal((await w.get(`/data/db?t=${encodeURIComponent(t)}`)).status, 400, t);
    assert.equal((await w.get(`/data/table?t=${encodeURIComponent(t)}&n=dbo.x`)).status, 400, t);
    assert.equal((await w.post("/data/q", { t, sql: "SELECT 1" })).status, 400, t);
  }
  assert.equal((await w.get("/data/table?t=ledger:at&n=nodot")).status, 400);
  assert.equal(w.calls.length, 0);
});
