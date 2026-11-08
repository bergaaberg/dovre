/** The PRs pack (#409): /prs and the viewer are its pages; off, they're gone and core's links to them follow. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInert, H, pr, signedIn, snapshot } from "../../../../../test/helpers.ts";

const mine = pr({ repo: "ACME/shop-api", number: 840, title: `Fix ${H}`, url: "https://acme.ghe.com/ACME/shop-api/pull/840" });
const snap = () => snapshot({ prs: { ok: true, value: { mine: [mine], review: [pr({ repo: "ACME/web", number: 9, title: "Review me", url: "https://acme.ghe.com/ACME/web/pull/9" })] } } });

test("on: /prs lists mine and my reviews in the menu and on Today, a PR opens in the viewer, the old sub-pages redirect", async () => {
  const on = signedIn(snap());
  const list = await on.get("/prs");
  assert.equal(list.status, 200);
  const out = await list.text();
  assertInert("/prs", out);
  assert.match(out, /href="\/prs\/ACME\/shop-api\/840"/);
  const today = await (await on.get("/")).text();
  assert.match(today, /<a href="\/prs"[^>]*>/, "the menu and Today's card link the list");
  assert.match(today, /href="\/prs\/ACME\/web\/9"/, "a PR opens in Dovre's viewer");
  for (const [from, to] of [["/prs/stacks", "/stacks"], ["/prs/dependabot", "/dependabot"]]) {
    const r = await on.get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get("location"), to);
  }
});

test("off: /prs and the viewer 404, and Today, search, the menu and the PR tabs link the forge or nothing", async () => {
  const off = signedIn(snap(), {}, { packEnv: { PACK_PRS: "off" } });
  assert.equal((await off.get("/prs")).status, 404);
  assert.equal((await off.get("/prs/ACME/shop-api/840")).status, 404);
  assert.equal((await off.get("/prs/ACME/shop-api/840/files")).status, 404);
  const today = await (await off.get("/")).text();
  assertInert("Today without the prs pack", today);
  assert.doesNotMatch(today, /href="\/prs/, "no link to the list or the viewer");
  assert.match(today, /href="https:\/\/acme\.ghe\.com\/ACME\/web\/pull\/9"/, "a PR opens on the forge");
  const found = await (await off.get("/search?q=840&frag=1")).text();
  assert.doesNotMatch(found, /href="\/prs/);
  assert.match(found, /href="https:\/\/acme\.ghe\.com\/ACME\/shop-api\/pull\/840"/);
  assert.doesNotMatch(await (await off.get("/stacks")).text(), /href="\/prs"/, "no Open tab on Stacks");
});
