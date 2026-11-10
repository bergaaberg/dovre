/** A pack's env (#475), the audit step: every key still comes back, and a read of one that isn't the pack's is noted once. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pack, PACK_API } from "../src/pack.ts";
import { packApp } from "../src/pack-testing.ts";
import { envReads, EVERY_KEY, ownKeys, packEnv, switchKey } from "../src/packs/env.ts";

const manifest = (id: string, keys: string[] = []) => ({ api: PACK_API, id, name: id, description: "", domain: "personal" as const, settings: keys.map((key) => ({ key, label: key })) });

test("its own keys: its settings, its switch, and the shared few", () => {
  assert.equal(switchKey("http-otel"), "PACK_HTTP_OTEL");
  const own = ownKeys(manifest("http-otel", ["HTTP_HEALTH_URLS", "not a key"]));
  assert.deepEqual([...own].sort(), ["CODE_DIR", "HTTP_HEALTH_URLS", "PACK_HTTP_OTEL", "PORT", "TZ_NAME"]);
});

test("every key still comes back; a set key that isn't its own is noted, an unset one isn't", () => {
  const all: Record<string, string | undefined> = { SHOP_URL: "https://shop.example", GHE_TOKEN: "ghp_secret", TZ_NAME: "Europe/Oslo", PACK_SHOP: "on" };
  const seen: string[] = [];
  const env = packEnv(manifest("shop", ["SHOP_URL"]), all, (k) => seen.push(k));
  assert.equal(env.SHOP_URL, "https://shop.example");
  assert.equal(env.TZ_NAME, "Europe/Oslo");
  assert.equal(env.PACK_SHOP, "on");
  assert.equal(env.NOT_SET, undefined);
  assert.deepEqual(seen, [], "its own and unset keys: nothing noted");
  assert.equal(env.GHE_TOKEN, "ghp_secret", "the audit step filters nothing yet");
  assert.deepEqual(seen, ["GHE_TOKEN"]);
  assert.ok(!seen.join().includes("ghp_secret"), "a name, never a value");
});

test("a view, not a copy: a key saved later is read", () => {
  const all: Record<string, string | undefined> = {};
  const env = packEnv(manifest("shop", ["SHOP_URL"]), all, () => {});
  all.SHOP_URL = "https://later.example";
  assert.equal(env.SHOP_URL, "https://later.example");
});

test("listing them all is noted as that, once, not key by key", () => {
  const seen: string[] = [];
  const env = packEnv(manifest("shop"), { A_TOKEN: "a", B_TOKEN: "b" }, (k) => seen.push(k));
  assert.deepEqual({ ...env }, { A_TOKEN: "a", B_TOKEN: "b" });
  assert.deepEqual(Object.keys(env), ["A_TOKEN", "B_TOKEN"]);
  assert.deepEqual(seen, [EVERY_KEY]);
});

test("the notes: once a key, by pack", () => {
  const r = envReads();
  assert.equal(r.note("shop", "GHE_TOKEN"), true);
  assert.equal(r.note("shop", "GHE_TOKEN"), false);
  assert.equal(r.note("mail", "GHE_TOKEN"), true);
  assert.deepEqual(r.of("shop"), ["GHE_TOKEN"]);
  assert.deepEqual(r.of("none"), []);
});

test("the Packs page says what a pack read beyond its settings, by name; the value is nowhere", async () => {
  const shop: Pack = {
    manifest: manifest("shop", ["SHOP_URL"]),
    routes: (app, ctx) => app.get("/shop", (c) => c.text(`${ctx.env.SHOP_URL} ${ctx.env.GHE_TOKEN ? "has" : "lacks"} ${ctx.env["<img src=x onerror=alert(1)>"] ?? ""}`)),
  };
  const quiet: Pack = { manifest: manifest("quiet", ["QUIET_URL"]), routes: (app, ctx) => app.get("/quiet", (c) => c.text(String(ctx.env.QUIET_URL))) };
  const { get } = packApp([shop, quiet], { env: { SHOP_URL: "https://shop.example", QUIET_URL: "https://quiet.example", GHE_TOKEN: "ghp_secret", "<img src=x onerror=alert(1)>": "x" } });
  const before = await (await get("/packs")).text();
  assert.ok(!before.includes("Also reads"), "nothing read yet");
  assert.equal(await (await get("/shop")).text(), "https://shop.example has x");
  await get("/shop");
  await get("/quiet");
  const page = await (await get("/packs")).text();
  assert.equal(page.split("Also reads").length - 1, 1, "shop's card only, once");
  assert.match(page, /Also reads[\s\S]{0,80}GHE_TOKEN, &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!page.includes("<img src=x"), "a hostile key name is escaped");
  assert.ok(!page.includes("ghp_secret"));
});
