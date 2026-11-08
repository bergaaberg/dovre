/** Moved, a pack (#405): its page from the snapshot, in the menu and search; off, its links go from Today, the g keys and the app's shortcuts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { move, signedIn, snapshot } from "../../../../../test/helpers.ts";

const s = () => ({ ...snapshot(), moves: { ok: true as const, value: [move({ actor: "kari", title: "Fix the login", verb: "merged" }), move({ bot: true, actor: "dependabot", title: "Bump x" })] } });

test("on: the page draws the org's moves, by person and as a timeline, and Today links it", async () => {
  const { get } = signedIn(s());
  const people = await (await get("/movement")).text();
  assert.match(people, /<title>Movement · Dovre<\/title>/);
  assert.match(people, /id="p-kari"[\s\S]*Fix the login/, "by person");
  assert.match(people, /href="\/movement"[^>]*>[\s\S]{0,200}Moved/, "in the menu");
  assert.match(await (await get("/movement?view=bots")).text(), /Bump x/, "the bots");
  assert.match(await (await get("/movement?view=nonsense")).text(), /id="p-kari"/, "an unknown view is people");
  assert.match(await (await get("/")).text(), /href="\/movement">Moved</, "Today's feed links it");
  assert.match(await (await get("/search?q=timeline")).text(), /href="\/movement"/, "search finds it");
  assert.doesNotMatch(await (await get("/")).text(), /u-go-off[^>]*\bm\b/, "g m goes there");
});

test("off: the page is gone, and so is every core link to it", async () => {
  const { get } = signedIn(s(), {}, { packEnv: { PACK_MOVEMENT: "off", PACK_TODO: "off" } });
  assert.equal((await get("/movement")).status, 404);
  const today = await (await get("/")).text();
  assert.doesNotMatch(today, /href="\/movement"/, "not in Today's feed or the menu");
  assert.match(today, /<meta name="u-go-off" content="m c t">/, "g m and g t do nothing (and g c: no tracker in tests)");
  assert.doesNotMatch(await (await get("/search?q=timeline")).text(), /href="\/movement"/);
  const shortcuts = (await (await get("/manifest.webmanifest")).json()).shortcuts.map((x: { url: string }) => x.url);
  assert.ok(shortcuts.includes("/deploys") && shortcuts.includes("/agents"), "the shortcuts to pages that answer stay");
});
