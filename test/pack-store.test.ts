/** ctx.store.kv (#476): a pack's own small state under its id, capped, in the database or in memory. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pack, PACK_API, type PackContext } from "../src/pack.ts";
import { HOSTILE, openDb, packApp, testContext } from "../src/pack-testing.ts";
import { KV_KEYS_MAX, KV_PACK_MAX, KV_VALUE_MAX, kvFor, kvInMemory } from "../src/packs/store.ts";
import type { PackKv } from "../src/packs/types.ts";

const manifest = (id: string) => ({ api: PACK_API, id, name: id, description: "", domain: "personal" as const });

for (const [where, make] of [
  ["database", (now: () => number) => kvFor("shop", openDb().DB, now)],
  ["memory", (now: () => number) => kvInMemory(now)],
] as [string, (now: () => number) => PackKv][]) {
  test(`kv (${where}): set, get, delete and list by prefix; a ttl runs out`, async () => {
    let t = 1000;
    const kv = make(() => t);
    assert.equal(await kv.get("last"), undefined);
    await kv.set("last", { ok: true, text: HOSTILE, n: [1, 2] });
    assert.deepEqual(await kv.get("last"), { ok: true, text: HOSTILE, n: [1, 2] });
    await kv.set("last", null);
    assert.equal(await kv.get("last"), null, "null is a value");
    await kv.set("job/b", 2);
    await kv.set("job/a", 1, { ttlMs: 500 });
    await kv.set("job_x", 3);
    assert.deepEqual(await kv.list("job/"), ["job/a", "job/b"]);
    assert.deepEqual(await kv.list("job_"), ["job_x"], "a prefix is read as written, no wildcards");
    assert.deepEqual(await kv.list(), ["job/a", "job/b", "job_x", "last"]);
    t += 500;
    assert.equal(await kv.get("job/a"), undefined, "its time ran out");
    assert.deepEqual(await kv.list("job/"), ["job/b"]);
    await kv.delete("job/b");
    await kv.delete("never-there");
    assert.deepEqual(await kv.list("job/"), []);
  });

  test(`kv (${where}): a bad key, a value that isn't JSON and one over a cap throw, and nothing is kept`, async () => {
    const kv = make(() => 1000);
    for (const key of ["", "a b", "a%", "x".repeat(201), 7, undefined]) await assert.rejects(kv.set(key as string, 1), /isn't one/, String(key));
    await assert.rejects(kv.get("a'b"), /isn't one/);
    await assert.rejects(kv.list("%"), /isn't one/);
    await assert.rejects(kv.set("k", undefined), /isn't JSON/);
    await assert.rejects(kv.set("k", () => 1), /isn't JSON/);
    await assert.rejects(kv.set("k", 1, { ttlMs: 0 }), /ttlMs/);
    await assert.rejects(kv.set("k", "x".repeat(KV_VALUE_MAX)), /is the most/);
    await kv.set("k", "x".repeat(KV_VALUE_MAX - 2));
    assert.deepEqual(await kv.list(), ["k"]);
    const big = "x".repeat(KV_VALUE_MAX - 2);
    const fits = Math.floor(KV_PACK_MAX / KV_VALUE_MAX);
    for (let i = 1; i < fits; i++) await kv.set(`big/${i}`, big);
    await assert.rejects(kv.set("one-more", big), /is the most a pack keeps/);
    await kv.set("k", "small");
    await kv.set("one-more", big);
    assert.equal(await kv.get("k"), "small", "writing over a key counts its new size, not both");
  });

  test(`kv (${where}): ${KV_KEYS_MAX} keys at most, and one that ran out makes room`, async () => {
    let t = 1000;
    const kv = make(() => t);
    await kv.set("brief", 1, { ttlMs: 10 });
    for (let i = 1; i < KV_KEYS_MAX; i++) await kv.set(`k/${i}`, i);
    await assert.rejects(kv.set("over", 1), /keys is the most/);
    await kv.set("k/1", "again");
    t += 10;
    await kv.set("over", 1);
    assert.equal((await kv.list()).length, KV_KEYS_MAX - 1 + 1);
  });
}

test("kv: each pack sees only its own rows", async () => {
  const db = openDb().DB;
  const shop = kvFor("shop", db);
  const bank = kvFor("bank", db);
  await shop.set("last", "shop's");
  await bank.set("last", "bank's");
  await bank.set("only-bank", 1);
  assert.equal(await shop.get("last"), "shop's");
  assert.equal(await shop.get("only-bank"), undefined);
  assert.deepEqual(await shop.list(), ["last"]);
  await shop.delete("only-bank");
  assert.equal(await bank.get("only-bank"), 1);
});

test("ctx.store: a pack's context keeps under its id; a test's context keeps in memory", async () => {
  let ctx: PackContext | undefined;
  const pack: Pack = { manifest: manifest("shop"), routes: (_app, c) => void (ctx = c) };
  const other: Pack = { manifest: manifest("bank"), routes: (app, c) => void app.get("/bank/last", async (cx) => cx.json((await c.store.kv.get("last")) ?? null)) };
  const { get, db } = packApp([pack, other]);
  await ctx!.store.kv.set("last", { at: 1 });
  assert.deepEqual((await db.DB.prepare("SELECT pack, key, value FROM pack_kv").all<{ pack: string; key: string; value: string }>()).results.map((r) => [r.pack, r.key, r.value]), [["shop", "last", '{"at":1}']]);
  assert.equal(await (await get("/bank/last")).json(), null, "another pack's key of the same name is its own");

  const t = testContext();
  await t.store.kv.set("a", 1);
  assert.equal(await t.store.kv.get("a"), 1);
  assert.equal(await testContext().store.kv.get("a"), undefined, "each context its own");
});
