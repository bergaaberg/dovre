/** Today's Pull requests card stays short, and the Workbench is gone from Today (2026-10-23). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pr, signedIn, snapshot } from "./helpers.ts";

const rowsIn = (page: string) => {
  const card = page.slice(page.indexOf('id="prs"'), page.indexOf("</section>", page.indexOf('id="prs"')));
  return { card, rows: (card.match(/<details id=/g) ?? []).length };
};

test("Pull requests on Today: five rows at most, up to three to review, mine filling the rest; the rest a link away", async () => {
  const mine = Array.from({ length: 9 }, (_, i) => pr({ number: 100 + i, title: `Mine ${i}` }));
  const review = Array.from({ length: 4 }, (_, i) => pr({ number: 200 + i, title: `Theirs ${i}`, author: "kari" }));
  const both = rowsIn(await (await signedIn(snapshot({ prs: { ok: true, value: { mine, review } } })).get("/")).text());
  assert.equal(both.rows, 5);
  assert.equal((both.card.match(/Theirs \d/g) ?? []).length, 3);
  assert.match(both.card, /<a href="\/prs">8 more<\/a>/);
  const onlyMine = rowsIn(await (await signedIn(snapshot({ prs: { ok: true, value: { mine, review: [] } } })).get("/")).text());
  assert.equal(onlyMine.rows, 5);
  assert.match(onlyMine.card, /4 more/);
});

test("the Workbench card is gone from Today", async () => {
  const page = await (await signedIn(snapshot()).get("/")).text();
  assert.doesNotMatch(page, /Workbench|id="bench"/);
});
