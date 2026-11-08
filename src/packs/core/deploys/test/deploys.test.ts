/** Deploys, a pack (#406): its page and menu entry; off, its routes go and core's links to a waiting deploy open its run instead. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deploy, signedIn, snapshot } from "../../../../../test/helpers.ts";

const s = () => snapshot({ deploys: { ok: true, value: [deploy({ title: "Ship the cart" })] } });

test("on: the page lists the waiting run with its buttons, the menu counts it, search finds it", async () => {
  const { get } = signedIn(s());
  const page = await (await get("/deploys")).text();
  assert.match(page, /<title>Deploys · Dovre<\/title>/);
  assert.match(page, /Ship the cart/);
  assert.match(page, /action="\/deploys\/approve"/, "approve, here");
  assert.match(page, /href="\/deploys"[^>]*>[\s\S]{0,300}Deploys[\s\S]{0,80}<b class="hot">/, "in the menu, counted");
  assert.match(await (await get("/search?q=cart")).text(), /href="\/deploys"/);
});

test("off: no page or writes, and Today and search link the run itself", async () => {
  const { get, post, calls } = signedIn(s(), {}, { packEnv: { PACK_DEPLOYS: "off" } });
  assert.equal((await get("/deploys")).status, 404);
  assert.equal((await post("/deploys/approve", { repo: "ACME/shop-api", run: "1" })).status, 404);
  assert.equal(calls.length, 0, "nothing reached the forge");
  const today = await (await get("/")).text();
  assert.doesNotMatch(today, /href="\/deploys"/);
  assert.match(today, /<meta name="u-go-off" content="[^"]*\bd\b/, "g d does nothing");
  const found = await (await get("/search?q=cart")).text();
  assert.doesNotMatch(found, /href="\/deploys"/);
  assert.match(found, /class="pal-row"[^>]*href="https:\/\/acme.ghe.com\/[^"]*\/actions\/runs\/\d+"/, "still found, linking the run");
});
