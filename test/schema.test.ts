/** The query box's schema: names only, from the test copy (never production), kept a day; and what the box suggests. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { createData, SCHEMA_SQL } from "../src/data/db.ts";
import { createSchemas, schemaOf, schemaSource } from "../src/data/schema.ts";
import { openDb } from "../src/db.ts";
import { SCRIPT } from "../src/ui/app.js.ts";
import { fakeGhe, fixedGatherer, snapshot } from "./helpers.ts";
import { setDataNames } from "../src/data/db.ts";

// The names an org's db CLI uses: its test databases' prefix, and a DB2 database with no test copy.
setDataNames({ prefix: "acme-sqldb-", db2: "warehouse" });

const ROWS = [
  { s: "dbo", t: "Kunde", c: "KundeId", ty: "int" },
  { s: "dbo", t: "Kunde", c: "Navn", ty: "nvarchar" },
  { s: "dbo", t: "Abonnement", c: "AbonnementId", ty: "int" },
  { s: "dbo", t: "Abonnement", c: "KundeId", ty: "int" },
  { s: "rapport", t: "Kunde Snitt", c: "Antall Kunder", ty: "int" },
  { s: "", t: "x", c: "y" },
];

test("where a database's schema comes from: itself in test, its app's at for production, nowhere for pre or Warehouse", () => {
  assert.equal(schemaSource("ledger:at"), "ledger:at");
  assert.equal(schemaSource("local:Ledger"), "local:Ledger");
  assert.equal(schemaSource("ledger:prod"), "ledger:at");
  for (const no of ["ledger:pre", "warehouse:prod", "warehouse:at", "pre:prod", "evil", "ledger:prod;x"]) assert.equal(schemaSource(no), undefined, no);
  const s = schemaOf(ROWS, "ledger:at", 1);
  assert.deepEqual(s.tables.map((t) => [t.name, t.cols.length]), [["dbo.Kunde", 2], ["dbo.Abonnement", 2], ["rapport.Kunde Snitt", 1]]);
});

test("the schema is read once, kept on disk a day, read again after, and an old copy beats a failure", async () => {
  let now = 1_000;
  let reads = 0;
  let fail = false;
  const dir = mkdtempSync(join(tmpdir(), "schemas-"));
  const read = async (t: string) => {
    reads++;
    assert.equal(t, "ledger:at");
    if (fail) throw new Error("db is away");
    return JSON.stringify(ROWS);
  };
  const a = createSchemas({ read, dir, now: () => now });
  await Promise.all([a.get("ledger:prod"), a.get("ledger:at")]);
  assert.equal(reads, 1, "one read for both, at once");
  const b = createSchemas({ read, dir, now: () => now });
  assert.equal((await b.get("ledger:at")).tables.length, 3);
  assert.equal(reads, 1, "from disk after a restart");
  now += 25 * 3600_000;
  fail = true;
  assert.equal((await b.get("ledger:at")).tables.length, 3, "the old copy when db fails");
  assert.equal(reads, 2);
  await assert.rejects(createSchemas({ read, now: () => now }).get("ledger:at"), /db is away/);
  await assert.rejects(a.get("warehouse:prod"), /No test copy/);
});

test("/data/schema: a production database's names come from its app's at; the CLI never sees production", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const data = createData({ bin: "db", run: async (_b, args, o) => (calls.push({ args, input: o.input }), { code: 0, stdout: JSON.stringify(ROWS), stderr: "" }) });
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DATA_PREFIX: "acme-sqldb-", DATA_DB2: "warehouse", DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, data });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const res = await get("/data/schema?t=ledger%3Aprod");
  assert.equal(res.status, 200);
  const j = (await res.json()) as { from: string; tables: [string, [string, string][]][] };
  assert.equal(j.from, "ledger:at");
  assert.deepEqual(j.tables[0], ["dbo.Kunde", [["KundeId", "int"], ["Navn", "nvarchar"]]]);
  assert.deepEqual(calls[0]!.args, ["ledger:at", "q", "-", "SELECT * FROM t LIMIT 60001", "-f", "json"]);
  assert.equal(calls[0]!.input, SCHEMA_SQL);
  for (const t of ["ledger:pre", "warehouse:prod", "x"]) assert.equal((await get(`/data/schema?t=${encodeURIComponent(t)}`)).status, 404, t);
  assert.ok(calls.every((c) => !c.args.some((a) => /prod|pre/.test(a))));
  assert.equal((await app.request("http://localhost/data/schema?t=ledger%3Aat")).status, 404, "no cookie, nothing");
  const page = await (await get("/data/db?t=ledger%3Aat")).text();
  assert.match(page, /data-schema="\/data\/schema\?t=ledger%3Aat"/);
});

/** The page script's suggestion logic, lifted out of it as it ships. */
const suggest = (() => {
  const from = SCRIPT.indexOf("const SQL_WORDS");
  const to = SCRIPT.indexOf("function sqlComplete");
  return new Function(`${SCRIPT.slice(from, to)}; return sqlSuggest;`)() as (text: string, word: string, tables: [string, [string, string][]][]) => { from: number; list: { label: string; insert: string; hint: string }[] };
})();
const T = schemaOf(ROWS, "ledger:at", 1).tables.map((t) => [t.name, t.cols] as [string, [string, string][]]);

test("the box suggests columns of the tables the query names first, then tables, then SQL words; after a dot, that table's columns", () => {
  const labels = (text: string, word: string) => suggest(text, word, T).list.map((x) => x.label);
  assert.deepEqual(labels("SELECT Ku", "Ku"), ["dbo.Kunde", "rapport.Kunde Snitt"]);
  assert.deepEqual(labels("SELECT Ku FROM dbo.Abonnement a", "Ku").slice(0, 2), ["KundeId", "dbo.Kunde"], "the named table's column first");
  assert.deepEqual(labels("SELECT a. FROM dbo.Abonnement a", "a."), ["AbonnementId", "KundeId"]);
  assert.deepEqual(labels("SELECT k.Na FROM Kunde AS k", "k.Na"), ["Navn"]);
  assert.deepEqual(labels("SELECT * FROM rapport.", "rapport."), ["rapport.Kunde Snitt"]);
  assert.equal(suggest("SELECT * FROM rapport.", "rapport.", T).list[0]!.insert, "[Kunde Snitt]", "an odd name in brackets");
  assert.equal(suggest("SELECT * FROM Kunde k WHERE k.", "k.", T).from, 2, "only what's after the dot is replaced");
  assert.ok(labels("SELECT * FROM Kunde WH", "WH").includes("WHERE"));
  assert.deepEqual(labels("x", "zz"), []);
});
