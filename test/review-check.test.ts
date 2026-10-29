/** The agent's check of my review (dovre#299 phase 3): the prompt it reads and the cards taken from its reply. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardsOf, checkPrompt, contextOf, MAX_CARDS, MAX_DIFF } from "../src/reviews/check.ts";
import type { MyReview } from "../src/reviews/mine.ts";
import type { PrFile } from "../src/sources/prview.ts";

const FILES: PrFile[] = [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, sha: "1", patch: "@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+added\n tail" }];
const REVIEW: MyReview = { sha: "a".repeat(40), summary: "Fine", comments: [{ id: 4, path: "src/a.ts", side: "RIGHT", line: 11, body: "Why?" }, { id: 9, path: "src/a.ts", side: "LEFT", line: 11, body: "Was ok" }] };
const block = (cards: unknown) => "Thinking…\n```review-check\n" + JSON.stringify({ cards }) + "\n```";

test("a comment's context: numbered lines either side, a removed line by its old number", () => {
  assert.match(contextOf(REVIEW.comments[0]!, FILES), /^\s+10 {3}ctx\n\s+11 - old\n\s+11 \+ new/);
  assert.match(contextOf(REVIEW.comments[1]!, FILES), /11 - old/);
  assert.equal(contextOf({ path: "src/a.ts", side: "RIGHT", line: 99, body: "" }, FILES), "");
  assert.equal(contextOf({ path: "nope", side: "RIGHT", line: 11, body: "" }, FILES), "");
});

test("the prompt: the PR, my summary and comments by id, then the diff, capped", () => {
  const p = checkPrompt({ repo: "o/r", number: 3, title: "T", body: "B".repeat(9000) }, REVIEW, FILES);
  assert.match(p, /# PR o\/r#3: T/);
  assert.ok(!p.includes("B".repeat(4001)), "the description capped");
  assert.match(p, /### c4 on src\/a.ts:11\n```diff/);
  assert.match(p, /### c9 on src\/a.ts:11 \(removed lines\)/);
  assert.match(p, /--- src\/a.ts \(modified\)/);
  const big = [...FILES, { path: "b.ts", status: "added", additions: 1, deletions: 0, sha: "2", patch: "@@ -0,0 +1,1 @@\n+" + "x".repeat(MAX_DIFF) }];
  assert.match(checkPrompt({ repo: "o/r", number: 3, title: "T", body: "" }, REVIEW, big), /\(1 more file not shown/);
});

test("cards: each kind checked; bad targets, lines off the diff, no-op rewrites and broken blocks left out", () => {
  const got = cardsOf(
    block([
      { kind: "rewrite", on: "c4", why: "Clearer", text: "Why this?" },
      { kind: "rewrite", on: "c4", text: "Why?" },
      { kind: "rewrite", on: "c77", text: "x" },
      { kind: "nit", on: "summary", why: "Vague" },
      { kind: "nit", on: "c9" },
      { kind: "contradiction", on: "c4", also: "summary", why: "Disagree" },
      { kind: "contradiction", on: "c4", also: "c4", why: "Self" },
      { kind: "missed", path: "src/a.ts", line: 12, side: "RIGHT", why: "Bug", text: "Check null" },
      { kind: "missed", path: "src/a.ts", line: 40, why: "Off", text: "x" },
      { kind: "missed", path: "../etc", line: 12, why: "Bad", text: "x" },
      { kind: "praise", on: "c4", why: "Nice" },
    ]),
    REVIEW,
    FILES,
  )!;
  assert.deepEqual(got.map((c) => [c.id, c.kind, c.on ?? c.at?.line]), [[1, "rewrite", 4], [2, "nit", "summary"], [3, "contradiction", 4], [4, "missed", 12]]);
  assert.equal(got[2]!.also, "summary");
  assert.equal(cardsOf("no block", REVIEW, FILES), null);
  assert.equal(cardsOf("```review-check\n{bad\n```", REVIEW, FILES), null);
  assert.deepEqual(cardsOf(block([]), REVIEW, FILES), [], "an empty list: the review is fine");
  assert.equal(cardsOf(block([{ kind: "nit", on: "c4", why: "a" }]) + block([{ kind: "nit", on: "c9", why: "b" }]), REVIEW, FILES)![0]!.on, 9, "the last block counts");
  assert.equal(cardsOf(block(Array.from({ length: 30 }, () => ({ kind: "nit", on: "c4", why: "n" }))), REVIEW, FILES)!.length, MAX_CARDS);
});
