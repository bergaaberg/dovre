/**
 * What an agent proposes to post after a review (WP-A20): a review of someone else's PR (summary
 * and line comments) or replies on mine (one per line comment, and a general comment). The agent
 * writes it as a fenced JSON block at the end of its report; I go through it as cards and
 * Dovre posts it (src/actions/reviews.ts). The agent never posts and never picks the verdict.
 * Pure; tested in test/review-draft.test.ts.
 */
import type { PrFile } from "../sources/prview.ts";
import { parsePatch } from "../viewer/diff.ts";
import type { ReviewKind } from "./agent.ts";

export const DRAFT_FENCE: Record<ReviewKind, string> = { review: "review-draft", triage: "review-replies" };
export const MAX_COMMENTS = 40;
export const MAX_BODY = 6000;
export const MAX_SUMMARY = 20_000;

export type Side = "LEFT" | "RIGHT";
export type LineComment = { path: string; line: number; startLine?: number; side: Side; body: string };
export type ReviewDraft = { kind: "review"; summary: string; comments: LineComment[] };
export type Reply = { commentId: number; body: string };
export type TriageDraft = { kind: "triage"; replies: Reply[]; comment: string };
export type Draft = ReviewDraft | TriageDraft;

/** Mine to pick, never the agent's: Comment unless I choose otherwise. */
export const VERDICTS = ["comment", "approve", "request-changes"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VERDICT_LABEL: Record<Verdict, string> = { comment: "Comment", approve: "Approve", "request-changes": "Request changes" };
export const EVENT: Record<Verdict, string> = { comment: "COMMENT", approve: "APPROVE", "request-changes": "REQUEST_CHANGES" };
export const verdictOf = (v: unknown): Verdict => (VERDICTS as readonly unknown[]).includes(v) ? (v as Verdict) : "comment";

/** Text as a comment takes it: newlines normalised, control characters out, trimmed, capped. */
export const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, "").trim().slice(0, max) : "");
const lineNo = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : undefined);
/** A path as the PR files API gives it: relative, forward slashes, no control characters. */
export const cleanPath = (v: unknown) => (typeof v === "string" && v.length <= 1000 && v && !/^[/\\]|\\|[\u0000-\u001f\u007f]|(^|\/)\.\.(\/|$)/.test(v) ? v : "");
/** A GHE comment id: a positive integer, as a number or a string of digits. */
export const commentId = (v: unknown) => {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

function commentOf(raw: unknown): LineComment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const path = cleanPath(r.path);
  const line = lineNo(r.line);
  const body = cleanText(r.body, MAX_BODY);
  if (!path || !line || !body) return null;
  const start = lineNo(r.start_line ?? r.startLine);
  return { path, line, ...(start && start < line ? { startLine: start } : {}), side: r.side === "LEFT" ? "LEFT" : "RIGHT", body };
}

/** The draft from the block's JSON, checked field by field; null when nothing in it is usable. */
export function draftOf(kind: ReviewKind, raw: unknown): Draft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  if (kind === "review") {
    const summary = cleanText(r.summary ?? r.body, MAX_SUMMARY);
    const comments = list(r.comments).map(commentOf).filter((c): c is LineComment => !!c).slice(0, MAX_COMMENTS);
    return summary || comments.length ? { kind, summary, comments } : null;
  }
  const replies = list(r.replies)
    .flatMap((x) => {
      const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
      const id = commentId(o.comment_id ?? o.commentId ?? o.id);
      const body = cleanText(o.body, MAX_BODY);
      return id && body ? [{ commentId: id, body }] : [];
    })
    .slice(0, MAX_COMMENTS);
  const comment = cleanText(r.comment, MAX_SUMMARY);
  return replies.length || comment ? { kind, replies, comment } : null;
}

/**
 * The report without its draft block, and the draft. `broken`: there was a block, but nothing in
 * it could be used (bad JSON, or no usable comment), so the card says so instead of offering nothing.
 * The last block counts: an agent that corrects itself writes a second one.
 */
export function splitDraft(kind: ReviewKind, report: string): { text: string; draft?: Draft; broken?: boolean } {
  const re = new RegExp("```" + DRAFT_FENCE[kind] + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```", "g");
  const blocks = [...report.matchAll(re)];
  if (!blocks.length) return { text: report };
  const rest = report.replace(re, "").trim();
  let draft: Draft | null = null;
  try {
    draft = draftOf(kind, JSON.parse(blocks[blocks.length - 1]![1]!));
  } catch {}
  return draft ? { text: rest, draft } : { text: rest, broken: true };
}

/**
 * The draft as I left it on the cards: each text as I edited it, the dropped ones gone. Where a
 * comment sits (path, line, side) and which comment a reply answers come from the agent's draft,
 * never from the form. Form fields: `summary` / `comment`, `body_<i>`, `keep_<i>`.
 */
export function editedDraft(base: Draft, form: Record<string, unknown>): Draft {
  const kept = (i: number) => form[`keep_${i}`] === "on";
  const body = (i: number, was: string) => (typeof form[`body_${i}`] === "string" ? cleanText(form[`body_${i}`], MAX_BODY) : was);
  if (base.kind === "review")
    return {
      kind: "review",
      summary: typeof form.summary === "string" ? cleanText(form.summary, MAX_SUMMARY) : base.summary,
      comments: base.comments.flatMap((c, i) => (kept(i) && body(i, c.body) ? [{ ...c, body: body(i, c.body) }] : [])),
    };
  return {
    kind: "triage",
    comment: typeof form.comment === "string" ? cleanText(form.comment, MAX_SUMMARY) : base.comment,
    replies: base.replies.flatMap((r, i) => (kept(i) && body(i, r.body) ? [{ ...r, body: body(i, r.body) }] : [])),
  };
}

/** The lines a review comment can sit on, per file and side, from the PR's patches. */
function anchors(files: PrFile[]): Map<string, { LEFT: Set<number>; RIGHT: Set<number> }> {
  const out = new Map<string, { LEFT: Set<number>; RIGHT: Set<number> }>();
  for (const f of files) {
    if (!f.patch) continue;
    const a = { LEFT: new Set<number>(), RIGHT: new Set<number>() };
    for (const l of parsePatch(f.patch)) {
      if (l.kind === "hunk" || l.kind === "note") continue;
      if (l.new !== undefined && l.kind !== "del") a.RIGHT.add(l.new);
      if (l.old !== undefined && l.kind !== "add") a.LEFT.add(l.old);
    }
    out.set(f.path, a);
  }
  return out;
}

/**
 * Which comments GHE will take on a line (the line is in the PR's diff on that side) and which
 * it would refuse. One refused line fails the whole review, so the others go into the summary
 * instead. A range whose start isn't in the diff becomes a comment on its last line.
 */
export function placeComments(comments: LineComment[], files: PrFile[]): { inline: LineComment[]; outside: LineComment[] } {
  const at = anchors(files);
  const inline: LineComment[] = [];
  const outside: LineComment[] = [];
  for (const c of comments) {
    const lines = at.get(c.path)?.[c.side];
    if (!lines?.has(c.line)) {
      outside.push(c);
      continue;
    }
    if (c.startLine && !lines.has(c.startLine)) {
      const { startLine: _s, ...one } = c;
      inline.push(one);
    } else inline.push(c);
  }
  return { inline, outside };
}

const where = (c: LineComment) => `${c.path}:${c.startLine ? `${c.startLine}-` : ""}${c.line}`;

/** The summary, with the comments that couldn't sit on a line added at its end. */
export function withOutside(summary: string, outside: LineComment[]): string {
  if (!outside.length) return summary;
  const list = outside.map((c) => `- \`${where(c)}\`: ${c.body.replace(/\n+/g, " ")}`).join("\n");
  return [summary, list].filter(Boolean).join("\n\n");
}

/** What's wrong with posting this, in words; undefined when it can go. */
export function postProblem(d: Draft, verdict: Verdict): string | undefined {
  if (d.kind === "triage") return d.replies.length || d.comment ? undefined : "Nothing left to post: every reply is dropped.";
  if (!d.summary && !d.comments.length && verdict !== "approve") return "Nothing left to post.";
  // GHE refuses a Comment or Request changes without a body.
  if (!d.summary && verdict !== "approve") return `${VERDICT_LABEL[verdict]} needs a summary: write one, or pick Approve.`;
  return undefined;
}

/** The review as GHE's "create a review" takes it, on the commit the agent read. */
export function reviewRequest(d: ReviewDraft, verdict: Verdict, commitId: string) {
  return {
    commit_id: commitId,
    event: EVENT[verdict],
    body: d.summary,
    comments: d.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, ...(c.startLine ? { start_line: c.startLine, start_side: c.side } : {}), body: c.body })),
  };
}

/** The draft as one line for the log and the card: counts and the verdict, never the text. */
export function draftCounts(d: Draft, verdict?: Verdict): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (d.kind === "review") return [VERDICT_LABEL[verdict ?? "comment"], d.comments.length ? n(d.comments.length, "line comment", "line comments") : ""].filter(Boolean).join(", ");
  return [d.replies.length ? n(d.replies.length, "reply", "replies") : "", d.comment ? "a comment" : ""].filter(Boolean).join(" and ");
}

/**
 * Where each reply goes: GHE takes a reply only to a thread's first comment, so a reply to a
 * reply goes to that thread's first comment. A reply to a comment that isn't on this PR is left
 * out (`unknown`). `comments`: the PR's line comments, as GHE lists them.
 */
export function replyTargets(replies: Reply[], comments: { id: number; in_reply_to_id?: number | null }[]): { replies: Reply[]; unknown: Reply[] } {
  const top = new Map<number, number>();
  for (const c of comments) top.set(c.id, c.in_reply_to_id ?? c.id);
  const out: Reply[] = [];
  const unknown: Reply[] = [];
  for (const r of replies) {
    const to = top.get(r.commentId);
    if (to) out.push({ ...r, commentId: to });
    else unknown.push(r);
  }
  return { replies: out, unknown };
}
