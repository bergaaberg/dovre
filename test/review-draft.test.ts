/** Posting an agent's review (WP-A20), the pure part: reading the draft, my edits, where comments can sit, what GHE gets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftCounts, draftOf, editedDraft, MAX_COMMENTS, placeComments, postProblem, replyTargets, type ReviewDraft, reviewRequest, splitDraft, verdictOf, withOutside } from "../src/reviews/draft.ts";
import type { PrFile } from "../src/sources/prview.ts";

const block = (fence: string, o: unknown) => "```" + fence + "\n" + JSON.stringify(o) + "\n```";

test("the draft comes out of the report, and the report reads without it; the last block counts", () => {
  const first = { summary: "Old", comments: [] };
  const last = { summary: "Ser bra ut", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Hva om lista er tom?" }] };
  const s = splitDraft("review", `## Findings\n\n1. Something\n\n${block("review-draft", first)}\n\nCorrected:\n\n${block("review-draft", last)}`);
  assert.equal(s.text, "## Findings\n\n1. Something\n\n\n\nCorrected:");
  assert.deepEqual(s.draft, { kind: "review", summary: "Ser bra ut", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Hva om lista er tom?" }] });
  assert.deepEqual(splitDraft("review", "Just a report."), { text: "Just a report." });
  assert.deepEqual(splitDraft("review", "Report\n```review-draft\n{not json\n```"), { text: "Report", broken: true });
  assert.deepEqual(splitDraft("review", "Report\n" + block("review-draft", { comments: [{ path: "a", line: 0, body: "x" }] })), { text: "Report", broken: true }, "nothing usable is broken, not empty");
  assert.equal(splitDraft("triage", block("review-draft", last)).draft, undefined, "a triage reads its own fence only");
});

test("a comment is checked field by field: a path that climbs or has control characters, a bad line, an empty body are dropped", () => {
  const d = draftOf("review", {
    summary: "S\u0007um",
    comments: [
      { path: "../etc/passwd", line: 1, body: "x" },
      { path: "/abs.ts", line: 1, body: "x" },
      { path: "a\\b.ts", line: 1, body: "x" },
      { path: "a.ts\u0000", line: 1, body: "x" },
      { path: "a.ts", line: -1, body: "x" },
      { path: "a.ts", line: 1.5, body: "x" },
      { path: "a.ts", line: 3, body: "   " },
      { path: "a.ts", line: 3, start_line: 5, side: "LEFT", body: "range backwards" },
      { path: "src/..x/a.ts", line: 4, start_line: 2, body: "ok" },
    ],
  }) as ReviewDraft;
  assert.equal(d.summary, "Sum");
  assert.deepEqual(d.comments, [
    { path: "a.ts", line: 3, side: "LEFT", body: "range backwards" },
    { path: "src/..x/a.ts", line: 4, startLine: 2, side: "RIGHT", body: "ok" },
  ]);
  const many = draftOf("review", { comments: Array.from({ length: 60 }, (_, i) => ({ path: "a.ts", line: i + 1, body: "x" })) }) as ReviewDraft;
  assert.equal(many.comments.length, MAX_COMMENTS);
  assert.equal(draftOf("review", { summary: "", comments: [] }), null);
  assert.equal(draftOf("review", [1, 2]), null);
});

test("replies need a comment id and a body; ids may come as strings of digits", () => {
  assert.deepEqual(draftOf("triage", { replies: [{ comment_id: 12, body: "Fikset" }, { comment_id: "13", body: "Bevisst" }, { comment_id: "x1", body: "no" }, { comment_id: 14, body: "" }, { comment_id: -2, body: "no" }], comment: "" }), {
    kind: "triage",
    replies: [{ commentId: 12, body: "Fikset" }, { commentId: 13, body: "Bevisst" }],
    comment: "",
  });
  assert.deepEqual(draftOf("triage", { comment: "Takk!" }), { kind: "triage", replies: [], comment: "Takk!" });
});

test("my edits: text as I left it, dropped cards gone, positions always from the agent's draft", () => {
  const base: ReviewDraft = { kind: "review", summary: "S", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "one" }, { path: "a.ts", line: 2, side: "RIGHT", body: "two" }, { path: "a.ts", line: 3, side: "RIGHT", body: "three" }] };
  const d = editedDraft(base, { summary: " Ny oppsummering ", keep_0: "on", body_0: "one, changed", body_1: "dropped anyway", keep_2: "on", body_2: "  ", path_0: "../evil", line_0: "99" }) as ReviewDraft;
  assert.equal(d.summary, "Ny oppsummering");
  assert.deepEqual(d.comments, [{ path: "a.ts", line: 1, side: "RIGHT", body: "one, changed" }], "an emptied text drops the card too");
  const t = editedDraft({ kind: "triage", replies: [{ commentId: 5, body: "a" }, { commentId: 6, body: "b" }], comment: "c" }, { keep_1: "on", body_1: "B", comment: "" });
  assert.deepEqual(t, { kind: "triage", replies: [{ commentId: 6, body: "B" }], comment: "" });
});

const files: PrFile[] = [
  { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, sha: "x", patch: "@@ -1,3 +1,4 @@\n line1\n-old2\n+new2\n+new3\n line3" },
  { path: "big.bin", status: "modified", additions: 0, deletions: 0, sha: "y" },
];

test("a comment sits on a line of the diff on its side; the rest go to the summary, and a range off the diff keeps its last line", () => {
  const c = (o: Partial<ReviewDraft["comments"][number]>) => ({ path: "src/a.ts", line: 2, side: "RIGHT" as const, body: "b", ...o });
  const { inline, outside } = placeComments(
    [c({ line: 2 }), c({ line: 4 }), c({ line: 2, side: "LEFT" }), c({ line: 3, side: "LEFT" }), c({ line: 4, side: "LEFT" }), c({ line: 9 }), c({ path: "big.bin", line: 1 }), c({ path: "nope.ts", line: 1 }), c({ line: 3, startLine: 2 }), c({ line: 4, startLine: 1, body: "range" })],
    files,
  );
  assert.deepEqual(inline.map((x) => `${x.side}${x.startLine ?? ""}:${x.line}`), ["RIGHT:2", "RIGHT:4", "LEFT:2", "LEFT:3", "RIGHT2:3", "RIGHT1:4"]);
  assert.deepEqual(outside.map((x) => `${x.path}:${x.side}:${x.line}`), ["src/a.ts:LEFT:4", "src/a.ts:RIGHT:9", "big.bin:RIGHT:1", "nope.ts:RIGHT:1"]);
  const off = placeComments([{ path: "src/a.ts", line: 4, startLine: 1, side: "LEFT", body: "x" }], files);
  assert.deepEqual(off, { inline: [], outside: [{ path: "src/a.ts", line: 4, startLine: 1, side: "LEFT", body: "x" }] });
  const loose = placeComments([{ path: "src/a.ts", line: 3, startLine: 1, side: "LEFT", body: "x" }], [{ ...files[0]!, patch: "@@ -2,2 +2,2 @@\n-old2\n line3" }]);
  assert.deepEqual(loose.inline, [{ path: "src/a.ts", line: 3, side: "LEFT", body: "x" }], "the start isn't in the diff: the comment stays on its last line");
});

test("comments off the diff are listed at the end of the summary", () => {
  assert.equal(withOutside("Sum", []), "Sum");
  assert.equal(withOutside("Sum", [{ path: "a.ts", line: 9, side: "RIGHT", body: "Hei\n\nder" }, { path: "b.ts", line: 4, startLine: 2, side: "RIGHT", body: "x" }]), "Sum\n\n- `a.ts:9`: Hei der\n- `b.ts:2-4`: x");
  assert.equal(withOutside("", [{ path: "a.ts", line: 9, side: "RIGHT", body: "x" }]), "- `a.ts:9`: x");
});

test("what can't go: nothing left, or a Comment or Request changes with no summary (GHE refuses those)", () => {
  const r = (summary: string, n = 0): ReviewDraft => ({ kind: "review", summary, comments: Array.from({ length: n }, () => ({ path: "a", line: 1, side: "RIGHT", body: "x" })) });
  assert.match(postProblem(r(""), "comment")!, /Nothing left/);
  assert.match(postProblem(r("", 2), "comment")!, /Comment needs a summary/);
  assert.match(postProblem(r("", 2), "request-changes")!, /Request changes needs a summary/);
  assert.equal(postProblem(r(""), "approve"), undefined, "an approve may go bare");
  assert.equal(postProblem(r("S"), "comment"), undefined);
  assert.match(postProblem({ kind: "triage", replies: [], comment: "" }, "comment")!, /every reply is dropped/);
  assert.equal(verdictOf("approve"), "approve");
  assert.equal(verdictOf("APPROVE"), "comment", "anything else is a Comment");
  assert.equal(verdictOf(undefined), "comment");
});

test("GHE gets one review on the commit the agent read; the log line has counts and the verdict, never the text", () => {
  const d: ReviewDraft = { kind: "review", summary: "Sum", comments: [{ path: "a.ts", line: 4, startLine: 2, side: "RIGHT", body: "x" }, { path: "b.ts", line: 1, side: "LEFT", body: "y" }] };
  assert.deepEqual(reviewRequest(d, "request-changes", "abc"), {
    commit_id: "abc",
    event: "REQUEST_CHANGES",
    body: "Sum",
    comments: [
      { path: "a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "x" },
      { path: "b.ts", line: 1, side: "LEFT", body: "y" },
    ],
  });
  assert.equal(draftCounts(d, "request-changes"), "Request changes, 2 line comments");
  assert.equal(draftCounts({ ...d, comments: [] }, "approve"), "Approve");
  assert.equal(draftCounts({ kind: "triage", replies: [{ commentId: 1, body: "a" }], comment: "c" }), "1 reply and a comment");
  assert.equal(draftCounts({ kind: "triage", replies: [{ commentId: 1, body: "a" }, { commentId: 2, body: "b" }], comment: "" }), "2 replies");
});

test("a reply goes to its thread's first comment; one to a comment not on this PR is left out", () => {
  const out = replyTargets(
    [{ commentId: 11, body: "a" }, { commentId: 12, body: "b" }, { commentId: 99, body: "c" }],
    [{ id: 11 }, { id: 12, in_reply_to_id: 11 }, { id: 13, in_reply_to_id: null }],
  );
  assert.deepEqual(out, { replies: [{ commentId: 11, body: "a" }, { commentId: 11, body: "b" }], unknown: [{ commentId: 99, body: "c" }] });
});
