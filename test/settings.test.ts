/** Settings (dovre#184): an overview with search and what was changed, a page per area, Look and Layout kept apart. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { panesOf } from "../src/config.ts";
import { DEFAULT_KEYS } from "../src/keys.ts";
import { DEFAULT_POLICY } from "../src/notify.ts";
import { findRows, settingRows } from "../src/pages/settings.ts";
import { WRITES } from "../src/writes.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const base = { layout: {}, policy: DEFAULT_POLICY, rings: [], writes: { chosen: new Map(), kinds: WRITES }, keys: DEFAULT_KEYS, packs: [] };

test("rows: nothing is changed with the defaults; each change marks its row, with its value now", () => {
  assert.deepEqual(settingRows(base).filter((r) => r.changed), []);
  const rows = settingRows({ ...base, layout: { theme: "ember", packsOff: ["x"] }, writes: { chosen: new Map([["deploy.approve", "twice" as const]]), kinds: WRITES }, keys: { scroll: 140, off: ["hints"] }, policy: { ...DEFAULT_POLICY, workHoursOnly: true } });
  const changed = Object.fromEntries(rows.filter((r) => r.changed).map((r) => [r.label, r.now]));
  assert.deepEqual(changed, { Theme: "Ember (warm dark)", "Packs shown": "1 hidden", "Only on weekdays, 08:00–17:00": "On", "Approve a waiting deploy": "Asks twice", "j / k scroll": "Fast", "Keys: Hints": "Off · f, F" });
});

test("search: every word must match the label, the area, the value or what it's also called", () => {
  const rows = settingRows(base);
  assert.deepEqual(findRows(rows, "font").map((r) => r.label).slice(0, 2), ["Font", "Text size"]);
  assert.ok(findRows(rows, "deploy approve").some((r) => r.label === "Approve a waiting deploy"));
  assert.ok(findRows(rows, "DARK").some((r) => r.label === "Theme"), "case doesn't matter");
  assert.deepEqual(findRows(rows, "   "), []);
  assert.deepEqual(findRows(rows, "font zebra"), []);
});

test("/settings: the areas, a search that finds and links, what was changed; unknown areas and absent ones 404", async () => {
  const { get, post } = signedIn(snapshot());
  const home = await (await get("/settings")).text();
  for (const a of ["look", "layout", "notifications", "writes", "keys", "about"]) assert.match(home, new RegExp(`href="/settings/${a}"`), a);
  assert.doesNotMatch(home, /href="\/settings\/panes"/, "no config here: no Panes");
  assert.match(home, /Everything is as it came/);
  const found = await (await get("/settings?q=text+size")).text();
  assert.match(found, /Found for “text size”/);
  assert.match(found, /<a[^>]*href="\/settings\/look"[^]*?Text size/);
  const hostile = await (await get(`/settings?q=${encodeURIComponent(H)}`)).text();
  assertInert("a hostile search", hostile);
  assert.match(hostile, /No setting goes by that/);
  assert.equal((await get("/settings/nope")).status, 404);
  assert.equal((await get("/settings/panes")).status, 404);
  assert.equal((await get("/settings/packs/nope")).status, 404);

  await post("/settings/layout", { part: "look", theme: "ember", textSize: "large" });
  assert.match(await (await get("/settings/look")).text(), /Saved\./, "said once, on the next Settings page");
  const after = await (await get("/settings")).text();
  assert.match(after, /id="changed"[^]*?Theme[^]*?Ember/);
  assert.match(after, /2 changed/, "counted on its area");
  const look = await (await get("/settings/look")).text();
  assert.doesNotMatch(look, /Saved\./);
  assert.match(look, /Changed from the default: <a href="\/settings\/look">Theme<\/a>/);
  assert.match(look, /name="theme" value="ember" checked>/);
  assert.match(look, /aria-current[^>]*>Look</, "its tab marked");
});

test("Look and Layout each save and reset their own part, and leave the other as it was", async () => {
  const { get, post } = signedIn(snapshot());
  await post("/settings/layout", { part: "layout", tab1: "/prs" });
  const r = await post("/settings/layout", { part: "look", theme: "dark" });
  assert.equal(r.headers.get("location"), "/settings/look");
  const bar = (page: string) => [...(page.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  let page = await (await get("/prs")).text();
  assert.match(page, /data-theme="dark"/);
  assert.deepEqual(bar(page), ["/", "/prs"], "Look's save kept the tabs");
  await post("/settings/layout", { part: "layout", tab1: "/deploys" });
  page = await (await get("/prs")).text();
  assert.match(page, /data-theme="dark"/, "Layout's save kept the theme");
  const reset = await post("/settings/layout/reset", { part: "look" });
  assert.equal(reset.headers.get("location"), "/settings/look");
  page = await (await get("/prs")).text();
  assert.doesNotMatch(page, /data-theme=/);
  assert.deepEqual(bar(page), ["/", "/deploys"], "Look's reset kept the tabs");
});

test("with config: Panes and Work have pages, a stored key shows as changed, saves come back to their page", async () => {
  const all = { claude: true, omp: true, db: true, terminals: true };
  const config = { panes: panesOf({ LAB: "off" }, all), stored: { LAB: "off" } };
  const { get, post } = signedIn(snapshot(), {}, { config });
  assert.match(await (await get("/settings")).text(), /id="changed"[^]*?Lab[^]*?Off/);
  assert.match(await (await get("/settings/panes")).text(), /name="on\.lab"/);
  assert.match(await (await get("/settings/work")).text(), /action="\/settings\/work"/);
  assert.equal((await post("/settings/work", { CODE_DIR: "/tmp/x" })).headers.get("location"), "/settings/work");
  assert.equal((await post("/settings/panes", { "on.bino": "on", "via.bino": "nope" })).headers.get("location"), "/settings/panes");
});

test("the palette finds Settings' areas", async () => {
  const { get } = signedIn(snapshot());
  assert.match(await (await get("/search?q=notifications")).text(), /href="\/settings\/notifications"/);
});
