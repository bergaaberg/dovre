import assert from "node:assert/strict";
import { test } from "node:test";
import { needsOf } from "../src/home/needs.ts";
import { prNeeds } from "../src/sources/ghe.ts";
import { deploy, note, pr, snapshot } from "./helpers.ts";

test("a PR of mine needs me when checks fail, changes are asked, threads are open, or it's ready", () => {
  assert.deepEqual(prNeeds(pr({ checks: "FAILURE" })), ["checks failing"]);
  assert.deepEqual(prNeeds(pr({ review: "CHANGES_REQUESTED", openThreads: 2 })), ["changes requested", "2 unresolved threads"]);
  assert.deepEqual(prNeeds(pr({ review: "APPROVED", checks: "SUCCESS" })), ["approved and green: ready to merge"]);
  assert.deepEqual(prNeeds(pr({ review: "APPROVED", checks: "SUCCESS", draft: true })), [], "a draft isn't ready to merge");
  assert.deepEqual(prNeeds(pr()), [], "waiting on reviewers isn't mine to do");
});

test("needs come in order: deploys, reviews and ready PRs, stuck PRs, mentions (agents are the agents pack's)", () => {
  const s = snapshot({
    deploys: { ok: true, value: [deploy({ superseded: [deploy({ id: 9 })], more: true })] },
    prs: { ok: true, value: { mine: [pr({ number: 2, checks: "FAILURE" }), pr({ number: 3, review: "APPROVED" }), pr({ number: 4 })], review: [pr({ number: 5, author: "per-hansen" })] } },
    notes: { ok: true, value: [note(), note({ reason: "subscribed" })] },
  });
  const needs = needsOf(s);
  assert.deepEqual(
    needs.map((n) => n.kind),
    ["deploy", "review", "my-pr", "my-pr", "mention"],
  );
  assert.match(needs[0]!.line!, /1\+ older waiting runs superseded/);
  assert.equal(needs.find((n) => n.kind === "my-pr" && n.tone === "ok")!.title, "shop-api#3 A PR");
});

test("a failed source just adds nothing", () => {
  const needs = needsOf(snapshot({ prs: { ok: false, error: "boom" }, deploys: { ok: false, error: "boom" }, notes: { ok: false, error: "boom" } }));
  assert.deepEqual(needs, []);
});
