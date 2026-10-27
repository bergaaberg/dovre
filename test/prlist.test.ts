/** The PR list's views, filters, sorts (dovre#157), and the page remembering them per viewer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPrQuery, parsePrQuery, prQueryString, viewCounts } from "../src/pages/prlist.ts";
import { assertInert, H, pr, signedIn, snapshot } from "./helpers.ts";

const mine = [
  pr({ number: 1, title: "green", updatedAt: "2026-10-22T07:00:00Z", createdAt: "2026-10-20T00:00:00Z", additions: 5 }),
  pr({ number: 2, title: "red", checks: "FAILURE", updatedAt: "2026-10-21T07:00:00Z", createdAt: "2026-10-01T00:00:00Z", additions: 500 }),
  pr({ number: 3, title: "approved", review: "APPROVED", repo: "ACME/forms", updatedAt: "2026-10-22T06:00:00Z" }),
  pr({ number: 4, title: "threads", openThreads: 2, draft: true, updatedAt: "2026-10-22T05:00:00Z" }),
];
const review = [pr({ number: 9, title: "theirs", author: "kari", openThreads: 1 }), pr({ number: 8, title: "theirs too", author: "per", repo: "ACME/forms" })];
const prs = { mine, review };
const nums = (l: { number: number }[] | null) => l?.map((p) => p.number) ?? null;
const q = (s: string) => parsePrQuery(new URLSearchParams(s));

test("quick views pick what needs action", () => {
  assert.deepEqual(nums(applyPrQuery(prs, q("view=failing")).mine), [2]);
  assert.equal(applyPrQuery(prs, q("view=failing")).review, null, "a view about my PRs leaves the review list out");
  assert.deepEqual(nums(applyPrQuery(prs, q("view=ready")).mine), [3]);
  assert.equal(applyPrQuery(prs, q("view=review")).mine, null);
  assert.deepEqual(nums(applyPrQuery(prs, q("view=review")).review), [9, 8]);
  const threads = applyPrQuery(prs, q("view=threads"));
  assert.deepEqual([nums(threads.mine), nums(threads.review)], [[4], [9]]);
  assert.deepEqual(nums(applyPrQuery(prs, q("view=needs")).mine), [2, 4, 3], "failing, threads, ready to merge… not the quiet green one");
  assert.deepEqual(viewCounts(prs, q("")), { all: 6, needs: 5, threads: 2, review: 2, failing: 1, ready: 1 });
});

test("filters and sorts", () => {
  assert.deepEqual(nums(applyPrQuery(prs, q("repo=ACME/forms")).mine), [3]);
  assert.deepEqual(nums(applyPrQuery(prs, q("author=KARI")).review), [9], "author matches without case");
  assert.deepEqual(nums(applyPrQuery(prs, q("state=draft")).mine), [4]);
  assert.deepEqual(nums(applyPrQuery(prs, q("ci=failing")).mine), [2]);
  assert.deepEqual(nums(applyPrQuery(prs, q("")).mine), [2, 4, 3, 1], "attention: failing, threads, ready, the rest");
  assert.deepEqual(nums(applyPrQuery(prs, q("sort=updated")).mine), [1, 3, 4, 2]);
  assert.deepEqual(nums(applyPrQuery(prs, q("sort=oldest")).mine), [2, 1, 4, 3], "opened first; no createdAt falls back to updatedAt");
  assert.deepEqual(nums(applyPrQuery(prs, q("sort=size")).mine)?.slice(0, 1), [2]);
});

test("the query takes only what it knows", () => {
  assert.deepEqual(q(`view=${H}&sort=x&repo=${encodeURIComponent(H)}&author=a b&state=nope&ci=`), { view: "all", sort: "attention" });
  assert.equal(prQueryString(q("view=failing&sort=size&repo=ACME/forms&author=kari&state=draft&ci=pending")), "view=failing&sort=size&repo=ACME%2Fforms&author=kari&state=draft&ci=pending");
  assert.equal(prQueryString(q("view=all&sort=attention&repo=")), "");
});

test("/prs: a choice is kept per viewer, a link wins, Reset forgets it", async () => {
  const { get } = signedIn(snapshot({ prs: { ok: true, value: prs } }));
  // A form's empty choices go to the clean address, and the cookie keeps the rest.
  const set = await get("/prs?view=failing&sort=attention&repo=&author=&state=&ci=");
  assert.equal(set.status, 303);
  assert.equal(set.headers.get("location"), "/prs?view=failing");
  const cookie = /dovre_prs=([^;]+)/.exec(set.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(cookie, "kept in a cookie");
  const back = await (await get("/prs", { cookie: `u_tk=test-token; dovre_prs=${cookie}` })).text();
  assert.match(back, /aria-current[^>]*>CI failing/);
  assert.ok(!back.includes(">green<") && back.includes("red"), "the kept view applies");
  const linked = await (await get("/prs?view=review", { cookie: `u_tk=test-token; dovre_prs=${cookie}` })).text();
  assert.match(linked, /aria-current[^>]*>Review requested/);
  const reset = await get("/prs?reset=1", { cookie: `u_tk=test-token; dovre_prs=${cookie}` });
  assert.equal(reset.headers.get("location"), "/prs");
  assert.match(reset.headers.get("set-cookie") ?? "", /dovre_prs=;/);
});

test("/prs: hostile PR text and a hostile query stay inert", async () => {
  const bad = pr({ repo: `ACME/${H}`, title: H, author: H, url: "javascript:alert(1)", createdAt: H });
  const { get } = signedIn(snapshot({ prs: { ok: true, value: { mine: [bad], review: [bad] } } }));
  for (const path of ["/prs", `/prs?sort=repo&view=${encodeURIComponent(H)}`]) {
    const res = await get(path);
    const out = await (res.status === 303 ? await get(res.headers.get("location")!) : res).text();
    assertInert(path, out);
    assert.ok(!out.includes('href="javascript:'), path);
  }
  // A cookie from somewhere else is read as a query, nothing more.
  assertInert("cookie", await (await get("/prs", { cookie: `u_tk=test-token; dovre_prs=${encodeURIComponent(`repo=${H}&author=${H}`)}` })).text());
});
