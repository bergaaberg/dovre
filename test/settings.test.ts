/** Settings (dovre#184): an overview with search and what was changed, a page per area, Look and Layout kept apart. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { panesOf } from "../src/config.ts";
import { DEFAULT_KEYS } from "../src/keys.ts";
import { DEFAULT_POLICY, type Policy, policyOf } from "../src/notify.ts";
import { findRows, settingRows } from "../src/pages/settings.ts";
import { WRITES } from "../src/writes.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const base = { layout: {}, policy: DEFAULT_POLICY, rings: [], writes: { chosen: new Map(), kinds: WRITES }, keys: DEFAULT_KEYS, packs: [] };

test("rows: nothing is changed with the defaults; each change marks its row, with its value now", () => {
  assert.deepEqual(settingRows(base).filter((r) => r.changed), []);
  const rows = settingRows({ ...base, layout: { theme: "ember", packsOff: ["x"] }, writes: { chosen: new Map([["deploy.approve", "twice" as const]]), kinds: WRITES }, keys: { scroll: 140, off: ["hints"] }, policy: { ...DEFAULT_POLICY, quiet: { from: 17, to: 8, weekends: true } } });
  const changed = Object.fromEntries(rows.filter((r) => r.changed).map((r) => [r.label, r.now]));
  assert.deepEqual(changed, { Theme: "Ember (warm dark)", "Packs on": "1 off", "Quiet hours": "17:00–08:00 and weekends", "Approve a waiting deploy": "Asks twice", "j / k scroll": "Fast", "Keys: Hints": "Off · f, F" });
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
  // Deploys and PRs are packs (#406, #409): ticked in each Layout post, or the whole-form post turns them off.
  await post("/settings/layout", "part=layout&tab1=%2Fprs&pack=deploys&pack=prs");
  const r = await post("/settings/layout", { part: "look", theme: "dark" });
  assert.equal(r.headers.get("location"), "/settings/look");
  const bar = (page: string) => [...(page.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  let page = await (await get("/prs")).text();
  assert.match(page, /data-theme="dark"/);
  assert.deepEqual(bar(page), ["/", "/prs"], "Look's save kept the tabs");
  await post("/settings/layout", "part=layout&tab1=%2Fdeploys&pack=deploys&pack=prs");
  page = await (await get("/prs")).text();
  assert.match(page, /data-theme="dark"/, "Layout's save kept the theme");
  const reset = await post("/settings/layout/reset", { part: "look" });
  assert.equal(reset.headers.get("location"), "/settings/look");
  page = await (await get("/prs")).text();
  assert.doesNotMatch(page, /data-theme=/);
  assert.deepEqual(bar(page), ["/", "/deploys"], "Look's reset kept the tabs");
});

test("with config: Work has a page; Bino's route is the assistant pack's setting, a picker that keeps only its choices (#417)", async () => {
  const all = { claude: true, omp: true, db: true, terminals: true };
  const config = { panes: panesOf({}, all), stored: {} };
  const { get, post } = signedIn(snapshot(), {}, { config, packEnv: { ASSISTANT_VIA: "omp" } });
  assert.equal((await get("/settings/panes")).status, 404, "no Panes area");
  assert.match(await (await get("/settings/work")).text(), /action="\/settings\/work"/);
  assert.equal((await post("/settings/work", { CODE_DIR: "/tmp/x" })).headers.get("location"), "/settings/work");
  const page = await (await get("/settings/packs/assistant")).text();
  assert.match(page, /<select name="ASSISTANT_VIA">/);
  assert.match(page, /<option value="omp" selected>Copilot \(omp\)<\/option>/);
  assert.match(page, /How it answers[^]*?Copilot \(omp\)/, "the choice's label, not its value");
  await post("/packs/assistant/settings", { ASSISTANT_VIA: "gpt-at-home" });
  assert.match(await (await get("/settings/packs/assistant")).text(), /<option value="omp" selected>/, "a value outside its choices isn't kept");
  await post("/packs/assistant/settings", { ASSISTANT_VIA: "codex" });
  assert.match(await (await get("/settings/packs/assistant")).text(), /<option value="codex" selected>/);
});

test("the palette finds Settings' areas", async () => {
  const { get } = signedIn(snapshot());
  assert.match(await (await get("/search?q=notifications")).text(), /href="\/settings\/notifications"/);
});

test("one Agents area (#272): the long turn is set there, Notifications keeps it and sets quiet hours, Packs → Agents leads there", async () => {
  let policy = policyOf(undefined);
  const notify = { policy: () => policy, setPolicy: async (p: Policy) => void (policy = p), log: () => [], test() {} };
  const { get, post } = signedIn(snapshot(), {}, { notify });
  const agents = await (await get("/settings/agents")).text();
  assert.match(agents, /id="long-turn"[^]*?name="longTurnMin"[^]*?value="5"/);
  await post("/settings/agents/long-turn", { longTurnMin: "12" });
  assert.equal(policy.longTurnMin, 12);
  const notes = await (await get("/settings/notifications")).text();
  assert.doesNotMatch(notes, /name="longTurnMin"/);
  assert.match(notes, /href="\/settings\/agents#long-turn"/);
  await post("/settings/notify", { kind: "deploy", bundleSec: "30", quietFrom: "22", quietTo: "7", quietWeekends: "on" });
  assert.equal(policy.longTurnMin, 12, "the Notifications form leaves the long turn alone");
  assert.deepEqual(policy.quiet, { from: 22, to: 7, weekends: true });
  assert.match(await (await get("/settings/notifications")).text(), /name="quietFrom" min="0" max="23" value="22"/);
  const r = await get("/settings/packs/agents");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/settings/agents#auto");
});
