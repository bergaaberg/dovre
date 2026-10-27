/**
 * My own review of a PR (dovre#106), kept until I submit it (migrations/0014_my_reviews.sql): the
 * commit it's on, a summary, and line comments. One per person and PR. Posting goes through the
 * same checks and request as an agent's draft (src/actions/reviews.ts).
 */
import type { D1 } from "../db.ts";
import { cleanPath, cleanText, type LineComment, MAX_BODY, MAX_COMMENTS, MAX_SUMMARY, type ReviewDraft, type Side } from "./draft.ts";

export type Pending = LineComment & { id: number };
export type MyReview = { sha: string; summary: string; comments: Pending[] };

type ReviewRow = { head_sha: string; summary: string };
type CommentRow = { id: number; path: string; side: string; line: number; start_line: number | null; body: string };

const lineNo = (v: unknown) => {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1_000_000 ? n : undefined;
};

/** Where a new comment goes, from a form: path, side, line, and a start line for a range. Null when it isn't one. */
export function anchorOf(form: Record<string, unknown>): Omit<LineComment, "body"> | null {
  const path = cleanPath(form.path);
  const line = lineNo(form.line);
  if (!path || !line) return null;
  const side: Side = form.side === "LEFT" ? "LEFT" : "RIGHT";
  const start = lineNo(form.start);
  return { path, line, side, ...(start && start < line ? { startLine: start } : {}) };
}

export async function myReview(db: D1, who: string, pr: string): Promise<MyReview | undefined> {
  const r = await db.prepare("SELECT head_sha, summary FROM my_reviews WHERE who = ? AND pr = ?").bind(who, pr).first<ReviewRow>();
  if (!r) return undefined;
  const rows = (await db.prepare("SELECT id, path, side, line, start_line, body FROM my_review_comments WHERE who = ? AND pr = ? ORDER BY id").bind(who, pr).all<CommentRow>()).results;
  return {
    sha: r.head_sha,
    summary: r.summary,
    comments: rows.map((c) => ({ id: Number(c.id), path: c.path, side: c.side === "LEFT" ? "LEFT" : "RIGHT", line: Number(c.line), ...(c.start_line ? { startLine: Number(c.start_line) } : {}), body: c.body })),
  };
}

/** Starts the review on `sha` if there isn't one; an existing one keeps its commit. */
async function ensure(db: D1, who: string, pr: string, sha: string) {
  await db.prepare("INSERT INTO my_reviews (who, pr, head_sha, summary, updated_at) VALUES (?, ?, ?, '', ?) ON CONFLICT (who, pr) DO NOTHING").bind(who, pr, sha, Date.now()).run();
}

export type Added = { ok: true; id: number } | { ok: false; message: string };

/** A line comment, on the review's commit. Refused when the review is on another commit than `sha` (the page I wrote it on), or it's full. */
export async function addComment(db: D1, who: string, pr: string, sha: string, c: LineComment): Promise<Added> {
  const body = cleanText(c.body, MAX_BODY);
  if (!body) return { ok: false, message: "The comment is empty: nothing added." };
  await ensure(db, who, pr, sha);
  const r = await myReview(db, who, pr);
  if (r && r.sha !== sha) return { ok: false, message: `Your review is on ${r.sha.slice(0, 7)} and this page shows ${sha.slice(0, 7)}: move it to the new commit first.` };
  if ((r?.comments.length ?? 0) >= MAX_COMMENTS) return { ok: false, message: `A review holds up to ${MAX_COMMENTS} line comments.` };
  const row = await db
    .prepare("INSERT INTO my_review_comments (who, pr, path, side, line, start_line, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(who, pr, c.path, c.side, c.line, c.startLine ?? null, body, Date.now())
    .first<{ id: number }>();
  await touch(db, who, pr);
  return { ok: true, id: Number(row?.id ?? 0) };
}

const touch = (db: D1, who: string, pr: string) => db.prepare("UPDATE my_reviews SET updated_at = ? WHERE who = ? AND pr = ?").bind(Date.now(), who, pr).run();

/** A comment's new text; empty text removes it. Only my own comment on this PR. */
export async function editComment(db: D1, who: string, pr: string, id: number, body: unknown) {
  const text = cleanText(body, MAX_BODY);
  if (!text) return dropComment(db, who, pr, id);
  await db.prepare("UPDATE my_review_comments SET body = ? WHERE id = ? AND who = ? AND pr = ?").bind(text, id, who, pr).run();
  await touch(db, who, pr);
}

export async function dropComment(db: D1, who: string, pr: string, id: number) {
  await db.prepare("DELETE FROM my_review_comments WHERE id = ? AND who = ? AND pr = ?").bind(id, who, pr).run();
  await touch(db, who, pr);
}

export async function saveSummary(db: D1, who: string, pr: string, sha: string, summary: unknown) {
  await ensure(db, who, pr, sha);
  await db.prepare("UPDATE my_reviews SET summary = ?, updated_at = ? WHERE who = ? AND pr = ?").bind(cleanText(summary, MAX_SUMMARY), Date.now(), who, pr).run();
}

/** The review onto another commit (the PR moved on): where each comment sits is checked again when it's posted. */
export async function moveReview(db: D1, who: string, pr: string, sha: string) {
  await db.prepare("UPDATE my_reviews SET head_sha = ?, updated_at = ? WHERE who = ? AND pr = ?").bind(sha, Date.now(), who, pr).run();
}

/** Gone: posted, or thrown away. */
export async function clearReview(db: D1, who: string, pr: string) {
  await db.batch([db.prepare("DELETE FROM my_review_comments WHERE who = ? AND pr = ?").bind(who, pr), db.prepare("DELETE FROM my_reviews WHERE who = ? AND pr = ?").bind(who, pr)]);
}

/**
 * An agent's draft added to mine (it read the same commit): its comments after mine, up to the
 * cap, and its summary when mine has none. Returns how many comments came across.
 */
export async function importDraft(db: D1, who: string, pr: string, sha: string, d: ReviewDraft): Promise<number> {
  await ensure(db, who, pr, sha);
  const r = (await myReview(db, who, pr))!;
  if (r.sha !== sha) return 0;
  const room = Math.max(0, MAX_COMMENTS - r.comments.length);
  const now = Date.now();
  const take = d.comments.slice(0, room);
  const stmts = take.map((c) => db.prepare("INSERT INTO my_review_comments (who, pr, path, side, line, start_line, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(who, pr, c.path, c.side, c.line, c.startLine ?? null, c.body, now));
  if (!r.summary && d.summary) stmts.push(db.prepare("UPDATE my_reviews SET summary = ? WHERE who = ? AND pr = ?").bind(d.summary, who, pr));
  if (stmts.length) await db.batch(stmts);
  await touch(db, who, pr);
  return take.length;
}

/** The review as a draft to check and post. */
export const asDraft = (r: MyReview, summary = r.summary): ReviewDraft => ({ kind: "review", summary, comments: r.comments.map(({ id: _id, ...c }) => c) });
