/** Pack.migrations (#476): a pack's own tables, run once each in order before init; a failed one keeps it off. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { html, type Pack, PACK_API } from "../src/pack.ts";
import { activePacks, assertTables, openDb, packApp, testContext } from "../src/pack-testing.ts";
import type { D1 } from "../src/db.ts";
import { bareSql, foreignTables, migratePack, migrationsGap } from "../src/packs/migrations.ts";
import { initAll } from "../src/packs/registry.ts";

const manifest = (id: string) => ({ api: PACK_API, id, name: id, description: "", domain: "personal" as const });
const names = async (db: D1) => (await db.prepare("SELECT name FROM _migrations WHERE name LIKE 'pack:%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
const ONE = "CREATE TABLE shop_orders (id TEXT PRIMARY KEY, total REAL)";
const TWO = "ALTER TABLE shop_orders ADD COLUMN note TEXT";

test("each runs once, in order, and a later one is added to a database that has the earlier", async () => {
  const { DB } = openDb();
  const log: string[] = [];
  assert.equal(await migratePack({ manifest: manifest("shop"), migrations: [ONE] }, DB, { log: (l) => log.push(l) }), undefined);
  await DB.prepare("INSERT INTO shop_orders (id, total) VALUES ('a', 1)").run();
  assert.equal(await migratePack({ manifest: manifest("shop"), migrations: [ONE, TWO] }, DB, { log: (l) => log.push(l) }), undefined);
  assert.equal(await migratePack({ manifest: manifest("shop"), migrations: [ONE, TWO] }, DB, { log: (l) => log.push(l) }), undefined, "nothing left: nothing run");
  assert.deepEqual(await names(DB), ["pack:shop:1", "pack:shop:2"]);
  assert.deepEqual({ ...(await DB.prepare("SELECT id, note FROM shop_orders").first<object>()) }, { id: "a", note: null }, "the row is still there, with the new column");
  assert.deepEqual(log, ["pack shop: migrations applied: 1", "pack shop: migrations applied: 2"]);
});

test("one pack's rows aren't another's: shop-2 isn't shop", async () => {
  const { DB } = openDb();
  await migratePack({ manifest: manifest("shop"), migrations: [ONE] }, DB);
  assert.equal(await migratePack({ manifest: manifest("shop-2"), migrations: ["CREATE TABLE shop_2_x (id TEXT)"] }, DB), undefined);
  assert.equal(await migratePack({ manifest: manifest("sho"), migrations: ["CREATE TABLE sho_x (id TEXT)"] }, DB), undefined);
  assert.deepEqual(await names(DB), ["pack:sho:1", "pack:shop-2:1", "pack:shop:1"]);
});

test("a failed one says which and why, leaves no row and none of itself; the ones before stay", async () => {
  const { DB } = openDb();
  const pack = { manifest: manifest("shop"), migrations: [ONE, "ALTER TABLE shop_nothing ADD COLUMN x TEXT", TWO] };
  assert.match((await migratePack(pack, DB))!, /^migration 2 failed: .*shop_nothing/);
  assert.deepEqual(await names(DB), ["pack:shop:1"]);
  // Fixed (it never ran anywhere, so it could be): the rest follow.
  assert.equal(await migratePack({ ...pack, migrations: [ONE, "CREATE TABLE shop_nothing (x TEXT)", TWO] }, DB), undefined);
  assert.deepEqual(await names(DB), ["pack:shop:1", "pack:shop:2", "pack:shop:3"]);
});

test("another isolate ran it first: the failure counts as done", async () => {
  const { DB } = openDb();
  let raced = false;
  const racing: D1 = {
    prepare: (sql) => DB.prepare(sql),
    async batch(statements) {
      if (!raced) {
        raced = true;
        await DB.batch([DB.prepare(ONE), DB.prepare("INSERT INTO _migrations (name, applied_at) VALUES ('pack:shop:1', 'then')")]);
      }
      return DB.batch(statements);
    },
  };
  assert.equal(await migratePack({ manifest: manifest("shop"), migrations: [ONE, TWO] }, racing), undefined);
  assert.deepEqual(await names(DB), ["pack:shop:1", "pack:shop:2"]);
});

test("a database without _migrations (hosted: core's are wrangler's) gets it the first time", async () => {
  const { DB, raw } = openDb();
  raw.exec("DROP TABLE _migrations");
  assert.equal(await migratePack({ manifest: manifest("shop"), migrations: [ONE] }, DB), undefined);
  assert.deepEqual(await names(DB), ["pack:shop:1"]);
});

test("a list core can't run keeps the pack off before anything runs", () => {
  const gap = (migrations: unknown) => migrationsGap({ manifest: manifest("shop"), migrations } as Pack);
  assert.equal(gap(undefined), undefined);
  assert.equal(gap([]), undefined);
  assert.equal(gap([ONE, `${TWO};\n`, "CREATE TABLE shop_t (a TEXT DEFAULT 'x; y') -- one; statement\n;"]), undefined, "a ; in a string or a comment, or at the end, isn't a second statement");
  assert.match(gap("CREATE TABLE x (a)")!, /aren't a list/);
  assert.match(gap([ONE, ""])!, /migration 2 isn't SQL/);
  assert.match(gap([ONE, 3])!, /migration 2 isn't SQL/);
  assert.match(gap([`${ONE}; DROP TABLE actions`])!, /migration 1 is more than one statement/);
  assert.match(gap(Array(201).fill(ONE))!, /201 migrations/);
  assert.match(gap([`CREATE TABLE shop_t (a TEXT) -- ${"x".repeat(20_000)}`])!, /migration 1 is 20\d\d\d characters/);
  const { on, off } = activePacks([{ manifest: manifest("shop"), migrations: [`${ONE}; DROP TABLE actions`] }], { env: {}, hosted: false });
  assert.equal(on.length, 0);
  assert.match(off[0]!.why, /more than one statement/);
});

test("bareSql blanks strings and comments and keeps quoted names", () => {
  assert.equal(bareSql(`a 'it''s; x' "t;1" /* ; */ b -- ; c`), `a ${" ".repeat(10)} "t;1" ${" ".repeat(7)} b ${" ".repeat(6)}`);
  assert.equal(bareSql("a 'open"), "a      ");
});

test("starting: migrations run before init; a failed one takes the pack off, and what requires it, uninitialised", async () => {
  const { DB } = openDb();
  const order: string[] = [];
  const shop: Pack = {
    manifest: manifest("shop"),
    migrations: [ONE],
    init: async (ctx) => {
      await ctx.db.prepare("INSERT INTO shop_orders (id, total) VALUES ('first', 2)").run();
      order.push("shop");
    },
  };
  const broken: Pack = { manifest: manifest("broken"), migrations: ["CREATE TABLE broken_t (a TEXT)", "CREATE TABLE broken_t (a TEXT)"], init: () => void order.push("broken") };
  const needs: Pack = { manifest: { ...manifest("needs"), requires: ["broken"] }, init: () => void order.push("needs") };
  const quiet: Pack = { manifest: manifest("quiet"), migrations: ["CREATE TABLE quiet_t (a TEXT)"] };
  const active = activePacks([shop, broken, needs, quiet], { env: {}, hosted: false });
  const log: string[] = [];
  await initAll(active, () => testContext({ db: DB }), (l) => log.push(l));
  assert.deepEqual(order, ["shop"]);
  assert.deepEqual(active.on.map((c) => c.manifest.id), ["shop", "quiet"]);
  assert.match(active.off.find((o) => o.id === "broken")!.why, /^didn't start: migration 2 failed: .*broken_t/);
  assert.ok(active.off.some((o) => o.id === "needs"));
  assert.ok(log.some((l) => /pack broken: didn't start: migration 2 failed/.test(l)));
  assert.deepEqual(await names(DB), ["pack:broken:1", "pack:quiet:1", "pack:shop:1"], "a pack with no init has its tables too");
});

test("packApp: a pack's page reads its table on the first request; a failed migration shows on Packs", async () => {
  const shop: Pack = {
    manifest: manifest("shop"),
    migrations: [ONE, "INSERT INTO shop_orders (id, total) VALUES ('seed', 7)"],
    routes: (app, ctx) => {
      app.get("/shop", async (c) => c.html(html`<p>${(await ctx.db.prepare("SELECT total FROM shop_orders WHERE id = 'seed'").first<{ total: number }>())?.total}</p>`));
    },
  };
  const broken: Pack = { manifest: manifest("broken"), migrations: ["ALTER TABLE broken_none ADD COLUMN <script>alert(1)</script> TEXT"] };
  const { get } = packApp([shop, broken]);
  const page = await get("/shop");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<p>7<\/p>/);
  const packs = await (await get("/packs")).text();
  assert.match(packs, /didn&#39;t start: migration 1 failed/);
  assert.ok(!packs.includes("<script>alert(1)"), "the error's text is escaped");
});

test("assertTables: a table or index not named after the pack fails", () => {
  const of = (id: string, ...migrations: string[]) => ({ manifest: manifest(id), migrations });
  assertTables({ manifest: manifest("none") });
  assertTables(of("summaries", "CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY)"));
  assertTables(
    of(
      "otel-sink",
      'CREATE TABLE IF NOT EXISTS "otel_sink_spans" (id TEXT PRIMARY KEY, name TEXT DEFAULT \'CREATE TABLE actions\') -- DROP TABLE actions',
      "CREATE UNIQUE INDEX IF NOT EXISTS otel_sink_spans_at ON otel_sink_spans (id)",
      "ALTER TABLE otel_sink_spans RENAME TO otel_sink_old",
      "INSERT INTO otel_sink_old (id) VALUES ('a') ON CONFLICT (id) DO UPDATE SET name = 'b'",
      "DROP TABLE IF EXISTS otel_sink_old",
    ),
  );
  assert.deepEqual(foreignTables(of("shop", "CREATE TABLE actions (id TEXT)", "create index i on shop_orders (id)", "ALTER TABLE Shopping ADD COLUMN x TEXT", "DELETE FROM actions", "CREATE INDEX shop_i ON pack_kv (key)")), [
    "migration 1: actions",
    "migration 2: i",
    "migration 3: Shopping",
    "migration 4: actions",
    "migration 5: pack_kv",
  ]);
  assert.throws(() => assertTables(of("shop", "CREATE TABLE orders (id TEXT)")), /aren't named after the pack \(start each "shop_"\)/);
  assert.throws(() => assertTables(of("shop", `${ONE}; ${TWO}`)), /more than one statement/);
  assertTables(of("storybook", "CREATE TABLE IF NOT EXISTS http_story_runs (id TEXT)"), { also: ["http_story_runs"] });
});
