/** Settings → Keys (dovre#87): j/k scroll step and groups of shortcuts, per person, handed to the page script. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { cleanKeys, DEFAULT_KEYS, keyPrefsStore } from "../src/keys.ts";
import { keysPanel } from "../src/pages/keys.ts";
import { assertInert, signedIn, snapshot } from "./helpers.ts";

test("cleanKeys keeps a listed step and known groups only", () => {
  assert.deepEqual(cleanKeys({ scroll: "140", off: ["hints", "hints", "evil", 3] }), { scroll: 140, off: ["hints"] });
  assert.deepEqual(cleanKeys({ scroll: 99999 }), DEFAULT_KEYS);
  assert.deepEqual(cleanKeys(null), DEFAULT_KEYS);
});

test("the store keeps each person's own, and the defaults aren't stored", async () => {
  const db = openDb();
  const store = keyPrefsStore(db.DB);
  await store.set("kari@x.no", { scroll: 280, off: ["going"] });
  await store.set(undefined, { scroll: 40, off: [] });
  assert.deepEqual(await store.get("kari@x.no"), { scroll: 280, off: ["going"] });
  assert.deepEqual(await store.get("ola@x.no"), DEFAULT_KEYS, "not kari's");
  assert.deepEqual(await store.get(), { scroll: 40, off: [] });
  await store.set("kari@x.no", DEFAULT_KEYS);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'keys%'").get() as { n: number }).n, 1, "back to the defaults: the row goes");
  db.raw.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('keys:bad@x.no', '{not json', 'x')").run();
  assert.deepEqual(await keyPrefsStore(db.DB).get("bad@x.no"), DEFAULT_KEYS);
});

test("Settings → Keys saves, and every page then tells the script", async () => {
  const { get, post } = signedIn(snapshot());
  const before = await (await get("/")).text();
  assert.doesNotMatch(before, /name="u-keys"/, "nothing to say with the defaults");
  const settings = await (await get("/settings")).text();
  assert.match(settings, /id="keys"/);
  assert.match(settings, /<option value="70" selected>Normal/);
  assert.equal((await post("/settings/keys", "scroll=140&on=moving&on=page&on=docks")).status, 303);
  const after = await (await get("/")).text();
  assert.match(after, /<meta name="u-keys" content="\{&quot;scroll&quot;:140,&quot;off&quot;:\[&quot;hints&quot;,&quot;going&quot;\]\}">/);
  const again = await (await get("/settings")).text();
  assert.match(again, /<option value="140" selected>Fast/);
  assert.match(again, /value="hints">/, "hints unticked");
  assert.doesNotMatch(again, /value="hints" checked/);
  assert.equal((await post("/settings/keys", "scroll=140", { origin: "https://evil.example" })).status, 403, "only from this app");
});

test("the panel is inert", () => {
  assertInert("keys panel", String(keysPanel({ scroll: 70, off: ["hints"] }, true)));
});
