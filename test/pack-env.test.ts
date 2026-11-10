/** A pack's env (#475, API 1.41): its own keys only; one that isn't the pack's reads as unset, and asking for a set one is noted once. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Pack, PACK_API } from "../src/pack.ts";
import { packApp } from "../src/pack-testing.ts";
import { envReads, namedKeys, namesIn, ownKeys, packBindings, packEnv, switchKey } from "../src/packs/env.ts";
import { packCan } from "../src/packs/can.ts";
import { CORE_PACKS } from "../src/packs/own.ts";

const manifest = (id: string, keys: string[] = []) => ({ api: PACK_API, id, name: id, description: "", domain: "personal" as const, settings: keys.map((key) => ({ key, label: key })) });

test("its own keys: its settings, its switch, and the shared few", () => {
  assert.equal(switchKey("http-otel"), "PACK_HTTP_OTEL");
  const own = ownKeys(manifest("http-otel", ["HTTP_HEALTH_URLS", "not a key"]));
  assert.deepEqual([...own].sort(), ["CODE_DIR", "HTTP_HEALTH_URLS", "PACK_HTTP_OTEL", "PORT", "TZ_NAME", "U_DB"]);
});

test("only its own keys come back; asking for a set key that isn't its own is noted, an unset one isn't", () => {
  const all: Record<string, string | undefined> = { SHOP_URL: "https://shop.example", GHE_TOKEN: "ghp_secret", TZ_NAME: "Europe/Oslo", PACK_SHOP: "on" };
  const seen: string[] = [];
  const env = packEnv(manifest("shop", ["SHOP_URL"]), all, (k) => seen.push(k));
  assert.equal(env.SHOP_URL, "https://shop.example");
  assert.equal(env.TZ_NAME, "Europe/Oslo");
  assert.equal(env.PACK_SHOP, "on");
  assert.equal(env.NOT_SET, undefined);
  assert.deepEqual(seen, [], "its own and unset keys: nothing noted");
  assert.equal(env.GHE_TOKEN, undefined, "another's key reads as unset");
  assert.equal("GHE_TOKEN" in env, false);
  assert.equal("SHOP_URL" in env, true);
  assert.deepEqual(seen, ["GHE_TOKEN"]);
  assert.equal(env.toString, undefined, "nothing from the prototype either");
  assert.ok(!seen.join().includes("ghp_secret"), "a name, never a value");
});

test("a view, not a copy: a key saved later is read", () => {
  const all: Record<string, string | undefined> = {};
  const env = packEnv(manifest("shop", ["SHOP_URL"]), all, () => {});
  all.SHOP_URL = "https://later.example";
  assert.equal(env.SHOP_URL, "https://later.example");
});

test("listing them all lists its own that are set, and notes nothing", () => {
  const seen: string[] = [];
  const env = packEnv(manifest("shop", ["SHOP_URL", "SHOP_KEY"]), { A_TOKEN: "a", SHOP_URL: "u", B_TOKEN: "b", TZ_NAME: "Europe/Oslo" }, (k) => seen.push(k));
  assert.deepEqual({ ...env }, { SHOP_URL: "u", TZ_NAME: "Europe/Oslo" });
  assert.deepEqual(Object.keys(env), ["SHOP_URL", "TZ_NAME"]);
  assert.deepEqual(Object.entries(env), [["SHOP_URL", "u"], ["TZ_NAME", "Europe/Oslo"]]);
  assert.ok(!JSON.stringify(env).includes("TOKEN"));
  assert.deepEqual(seen, []);
});

test("read-only: a pack can't set or remove a setting, its own or another's", () => {
  const all: Record<string, string | undefined> = { SHOP_URL: "u", GHE_TOKEN: "g" };
  const env = packEnv(manifest("shop", ["SHOP_URL"]), all, () => {});
  assert.throws(() => { env.GHE_TOKEN = "mine"; }, TypeError);
  assert.throws(() => { env.SHOP_URL = "other"; }, TypeError);
  assert.throws(() => { delete env.GHE_TOKEN; }, TypeError);
  assert.throws(() => Object.defineProperty(env, "NEW_KEY", { value: "x" }), TypeError);
  assert.deepEqual(all, { SHOP_URL: "u", GHE_TOKEN: "g" });
});

test("the notes: once a key, by pack", () => {
  const r = envReads();
  assert.equal(r.note("shop", "GHE_TOKEN"), true);
  assert.equal(r.note("shop", "GHE_TOKEN"), false);
  assert.equal(r.note("mail", "GHE_TOKEN"), true);
  assert.deepEqual(r.of("shop"), ["GHE_TOKEN"]);
  assert.deepEqual(r.of("none"), []);
});

test("the Packs page says what a pack asked for beyond its settings, by name; the pack didn't get it and the value is nowhere", async () => {
  const shop: Pack = {
    manifest: manifest("shop", ["SHOP_URL"]),
    routes: (app, ctx) => app.get("/shop", (c) => c.text(`${ctx.env.SHOP_URL} ${ctx.env.GHE_TOKEN ? "has" : "lacks"} ${ctx.env["<img src=x onerror=alert(1)>"] ?? ""}`)),
  };
  const quiet: Pack = { manifest: manifest("quiet", ["QUIET_URL"]), routes: (app, ctx) => app.get("/quiet", (c) => c.text(String(ctx.env.QUIET_URL))) };
  const { get } = packApp([shop, quiet], { env: { SHOP_URL: "https://shop.example", QUIET_URL: "https://quiet.example", GHE_TOKEN: "ghp_secret", "<img src=x onerror=alert(1)>": "x" } });
  const before = await (await get("/packs")).text();
  assert.ok(!before.includes("Asked for, not given"), "nothing asked for yet");
  assert.equal(await (await get("/shop")).text(), "https://shop.example lacks ", "GHE_TOKEN (the done-when of #475) and the odd key: unset for it");
  await get("/shop");
  await get("/quiet");
  const page = await (await get("/packs")).text();
  assert.equal(page.split("Asked for, not given").length - 1, 1, "shop's card only, once");
  assert.match(page, /Asked for, not given[\s\S]{0,80}GHE_TOKEN, &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!page.includes("<img src=x"), "a hostile key name is escaped");
  assert.ok(!page.includes("ghp_secret"));
});

test("a namesKeys setting (API 1.36): the keys its value names are the pack's own, as the value is now", () => {
  assert.deepEqual(namesIn("API_TOKEN@api.example.com, LOCAL_KEY@localhost:3000 API_TOKEN@other.example  plain a=b 9bad <x>@h"), ["API_TOKEN", "LOCAL_KEY", "plain", "a"]);
  assert.deepEqual(namesIn(undefined), []);
  const m = { ...manifest("http"), settings: [{ key: "HTTP_SECRETS", label: "Secrets", namesKeys: true }, { key: "HTTP_ENVS", label: "Envs" }, { key: "HTTP_HIDDEN", label: "Hidden", secret: true, namesKeys: true }] };
  const all: Record<string, string | undefined> = { HTTP_SECRETS: "API_TOKEN@api.example.com", HTTP_ENVS: "GHE_TOKEN", HTTP_HIDDEN: "MODEL_KEY", API_TOKEN: "t", OTHER_TOKEN: "o", GHE_TOKEN: "g", MODEL_KEY: "k" };
  assert.deepEqual(namedKeys(m, all), ["API_TOKEN"], "only the flagged setting's names, and never a secret one's");
  const seen: string[] = [];
  const env = packEnv(m, all, (k) => seen.push(k));
  assert.equal(env.API_TOKEN, "t");
  assert.deepEqual(seen, []);
  assert.equal(env.OTHER_TOKEN, undefined);
  assert.equal(env.GHE_TOKEN, undefined, "named by a setting that isn't flagged");
  assert.equal(env.MODEL_KEY, undefined, "named by a secret setting");
  assert.deepEqual(seen, ["OTHER_TOKEN", "GHE_TOKEN", "MODEL_KEY"]);
  assert.deepEqual(Object.keys(env).sort(), ["API_TOKEN", "HTTP_ENVS", "HTTP_HIDDEN", "HTTP_SECRETS"]);
  all.HTTP_SECRETS = "OTHER_TOKEN@x.example";
  assert.equal(env.OTHER_TOKEN, "o", "named now: its own now");
  assert.equal(env.API_TOKEN, undefined);
  assert.deepEqual(seen, ["OTHER_TOKEN", "GHE_TOKEN", "MODEL_KEY", "API_TOKEN"], "no longer named: no longer its own");
});

test("the Packs page lists the keys a pack reads by name, escaped", async () => {
  const pack: Pack = { manifest: { ...manifest("caller"), settings: [{ key: "CALLER_SECRETS", label: "Secrets", namesKeys: true }] }, routes: (app, ctx) => app.get("/caller", (c) => c.text(String(ctx.env.API_TOKEN))) };
  const { get } = packApp([pack], { env: { CALLER_SECRETS: "API_TOKEN@api.example.com, <b>@h", API_TOKEN: "tok_secret" } });
  assert.equal(await (await get("/caller")).text(), "tok_secret");
  const page = await (await get("/packs")).text();
  assert.match(page, /Reads by name[\s\S]{0,80}API_TOKEN/);
  assert.ok(!page.includes("Asked for, not given"), "a named key isn't beyond its settings");
  assert.ok(!page.includes("tok_secret"));
});

test("bindings (#484): only the ones its manifest names; another reads as missing and is noted; read-only", () => {
  const all: Record<string, unknown> = { OPS_DB: { d1: true }, MAIL: { r2: true }, DB: { core: true }, SECRET_STORE: { s: true } };
  const seen: string[] = [];
  const b = packBindings({ ...manifest("inbox"), requiredBindings: ["OPS_DB"], bindings: ["MAIL", "NOT_BOUND"] }, all, (k) => seen.push(k));
  assert.equal(b.OPS_DB, all.OPS_DB, "the binding itself, not a copy");
  assert.equal(b.MAIL, all.MAIL);
  assert.equal(b.NOT_BOUND, undefined);
  assert.deepEqual(seen, []);
  assert.equal(b.DB, undefined, "core's database isn't a pack's by asking");
  assert.equal(b.SECRET_STORE, undefined);
  assert.equal("DB" in b, false);
  assert.deepEqual(seen, ["DB", "SECRET_STORE"]);
  assert.deepEqual(Object.keys(b), ["OPS_DB", "MAIL"]);
  assert.deepEqual(Object.keys({ ...b }), ["OPS_DB", "MAIL"]);
  assert.throws(() => { b.DB = 1; }, TypeError);
  assert.throws(() => { delete b.OPS_DB; }, TypeError);
  assert.deepEqual(Object.keys(packBindings(manifest("none"), all, () => {})), [], "a pack that names none gets none");
  assert.deepEqual(Object.keys(packBindings({ ...manifest("odd"), requiredBindings: "OPS_DB" as never, bindings: [7 as never, "MAIL"] }, all, () => {})), ["MAIL"], "a wrong-shaped list names nothing");
});

test("ctx.db (#484): a pack with migrations or `db: \"raw\"` gets the database; any other gets one that throws, on its own page only; the card says raw", async () => {
  const use = (id: string, more: Partial<Pack> = {}, db?: "raw"): Pack => ({
    manifest: { ...manifest(id), ...(db ? { db } : {}) },
    ...more,
    routes: (app, ctx) => app.get(`/${id}`, async (c) => c.text(String((await ctx.db.prepare("SELECT 1 AS one").first<{ one: number }>())?.one))),
  });
  const { get } = packApp([use("plain"), use("rawone", {}, "raw"), use("tabled", { migrations: ["CREATE TABLE tabled_notes (id TEXT PRIMARY KEY)"] })]);
  assert.equal(await (await get("/rawone")).text(), "1");
  assert.equal(await (await get("/tabled")).text(), "1");
  const plain = await get("/plain");
  assert.equal(plain.status, 500, "its own error page");
  assert.match(await plain.text(), /ctx\.db needs migrations of its own, or db: &quot;raw&quot;/);
  const page = await (await get("/packs")).text();
  assert.equal(page.split("raw: reads and writes Dovre").length - 1, 1, "on the raw pack's card only");
});

test("ctx.can and the checkouts (#484): one answer for what's local only, with a line saying why", async () => {
  const pack: Pack = { manifest: manifest("asker"), routes: (app, ctx) => app.get("/asker", (c) => c.json({ ask: ctx.can("ask"), acts: ctx.can("acts"), tools: ctx.can("tools"), programs: ctx.can("programs"), checkouts: ctx.can("checkouts"), agent: ctx.can("agent"), odd: ctx.can("fly" as never), list: ctx.checkouts(), one: ctx.checkout("shop") })) };
  const local = (await (await packApp([pack]).get("/asker")).json()) as Record<string, { ok: boolean; why?: string }>;
  assert.deepEqual([local.ask, local.acts, local.tools, local.programs, local.checkouts], [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  assert.equal(local.agent!.ok, false, "not until I allow it");
  assert.ok(local.agent!.why);
  assert.equal(local.odd!.ok, false);
  // Hosted, and with no code folder: the same shape, saying why.
  const here = { hosted: true, rings: false, ai: () => ({ text: false as const, why: "no model" }), agent: () => ({ ok: false as const, why: "not allowed" }), mcp: () => ({ ok: true as const, reads: [], writes: [] }) };
  for (const what of ["ask", "acts", "tools", "programs", "checkouts"] as const) {
    const c = packCan(what, here);
    assert.ok(!c.ok && /only where Dovre runs on your own machine/.test(c.why), what);
  }
  assert.deepEqual(packCan("ring", here), { ok: false, why: "Nothing rings here" });
  assert.deepEqual(packCan("text", here), { ok: false, why: "no model" });
  assert.deepEqual(packCan("agent", here), { ok: false, why: "not allowed" });
  assert.deepEqual(packCan("mcp", here), { ok: true });
  assert.deepEqual(packCan("checkouts", { ...here, hosted: false }), { ok: false, why: "No code folder is set (CODE_DIR)" });
  assert.deepEqual(packCan("checkouts", { ...here, hosted: false, codeDir: "/code" }), { ok: true });
});

test("core's package exports name files, each one there: no wildcard into src (#484)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const exportsOf = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports as Record<string, string>;
  assert.ok(exportsOf["./pack.ts"] && exportsOf["./pack-testing.ts"], "the two doors");
  for (const [name, file] of Object.entries(exportsOf)) {
    assert.ok(!name.includes("*") && !file.includes("*"), `${name}: a wildcard`);
    assert.equal(file, `./src/${name.slice(2)}`);
    assert.ok(existsSync(join(root, file)), `${file} isn't there`);
  }
});

test("CORE_PACKS names every folder of Dovre's own packs, and no more", () => {
  const folders = readdirSync(fileURLToPath(new URL("../src/packs/core/", import.meta.url)), { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.equal(CORE_PACKS.length, folders.length, "a pack was added to or taken out of src/packs/core: fix src/packs/own.ts");
  assert.equal(new Set(CORE_PACKS).size, CORE_PACKS.length);
});
