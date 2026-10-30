/**
 * Posting what an agent drafted after a review (WP-A20), once I've gone through it: a review on
 * someone else's PR, or replies on mine. Each re-checks GHE first (still open, still at the commit
 * the agent read, comments that sit in the diff, replies to comments on this PR), then posts, and
 * logs either way: what and where, counts and the verdict, never the text.
 */
import { currentActor } from "../actor.ts";
import type { D1 } from "../db.ts";
import { draftCounts, placeComments, replyTargets, type ReviewDraft, reviewRequest, type TriageDraft, type Verdict, VERDICT_LABEL, withOutside } from "../reviews/draft.ts";
import type { Ghe } from "../sources/ghe.ts";
import { loadPrFiles, loadPrView, type PrFile, type Thread } from "../sources/prview.ts";
import { logAction } from "./deploys.ts";

type RawPr = { state: string; head: { sha: string }; user: { login: string } };
type RawComment = { id: number; in_reply_to_id?: number | null };

/**
 * Whose review it is: an agent's draft goes on someone else's PR only; my own may be a Comment on
 * mine; Auto review's reviewer (#326) posts a Comment on an auto PR, which my account opened.
 */
export type By = "agent" | "me" | "auto";

export type Checked<T> = { ok: true; draft: T; notes: string[] } | { ok: false; message: string };

/** The reviewed commit and the PR's head, as the same commit: the store may hold a short sha. */
const sameCommit = (head: string, reviewed: string) => !!reviewed && (head === reviewed || (reviewed.length >= 7 && head.startsWith(reviewed)));

async function openAt(ghe: Ghe, repo: string, n: number, reviewed: string, by: By = "agent"): Promise<{ ok: true; pr: RawPr } | { ok: false; message: string }> {
  const pr = await ghe.rest<RawPr>(`/repos/${repo}/pulls/${n}`);
  if (pr.state !== "open") return { ok: false, message: `${repo}#${n} isn't open any more: nothing posted.` };
  if (!sameCommit(pr.head.sha, reviewed))
    return {
      ok: false,
      message: by === "me" ? `${repo}#${n} has new commits since you started this review (${reviewed.slice(0, 7)} → ${pr.head.sha.slice(0, 7)}): move it to the new commit on the Files tab, then post.` : `${repo}#${n} has new commits since the agent read it (${reviewed.slice(0, 7)} → ${pr.head.sha.slice(0, 7)}): review it again, then post.`,
    };
  return { ok: true, pr };
}

/** The review as it would go: comments that can't sit on a line moved into the summary. */
export async function checkReview(ghe: Ghe, repo: string, n: number, o: { reviewed: string; me: string; draft: ReviewDraft; by?: By; verdict?: Verdict }): Promise<Checked<ReviewDraft> & { commit?: string }> {
  try {
    const by = o.by ?? "agent";
    const at = await openAt(ghe, repo, n, o.reviewed, by);
    if (!at.ok) return at;
    // A member's write (hosted Team) is theirs: "your own PR" means the PRs they opened.
    const me = currentActor() ? (await ghe.rest<{ login?: string }>("/user"))?.login ?? "" : o.me;
    if (me && at.pr.user.login.toLowerCase() === me.toLowerCase()) {
      if (by === "agent") return { ok: false, message: `${repo}#${n} is your own PR: an agent's review goes on someone else's.` };
      if ((by === "auto" || o.verdict) && o.verdict !== "comment") return { ok: false, message: `${repo}#${n} is your own PR: GHE takes only a Comment on it, not ${o.verdict ? VERDICT_LABEL[o.verdict] : "no verdict"}.` };
    }
    const { inline, outside } = placeComments(o.draft.comments, await loadPrFiles(ghe, repo, n));
    const notes = outside.length ? [`${outside.length === 1 ? "One comment isn't" : `${outside.length} comments aren't`} on a line of the diff, so ${outside.length === 1 ? "it goes" : "they go"} at the end of the summary.`] : [];
    return { ok: true, draft: { kind: "review", summary: withOutside(o.draft.summary, outside), comments: inline }, notes, commit: at.pr.head.sha };
  } catch (e) {
    return { ok: false, message: `Couldn't check ${repo}#${n}: ${String((e as Error).message ?? e)}` };
  }
}

/** The diff a review was of, for the draft page: its files and open threads, or the commit it's moved on to. Reads only. */
export async function reviewedDiff(ghe: Ghe, repo: string, n: number, reviewed: string): Promise<{ files: PrFile[]; threads: Thread[] } | { moved: string }> {
  const pr = await ghe.rest<RawPr>(`/repos/${repo}/pulls/${n}`);
  if (!sameCommit(pr.head.sha, reviewed)) return { moved: pr.head.sha };
  // Threads are a nicety: the diff shows without them.
  const [files, view] = await Promise.all([loadPrFiles(ghe, repo, n), loadPrView(ghe, repo, n).catch(() => undefined)]);
  return { files, threads: (view?.threads ?? []).filter((t) => !t.resolved && !t.outdated) };
}

/** The PR's line comments (a few pages), for where each reply goes. */
async function lineComments(ghe: Ghe, repo: string, n: number): Promise<RawComment[]> {
  const out: RawComment[] = [];
  for (let page = 1; page <= 5; page++) {
    const got = await ghe.rest<RawComment[]>(`/repos/${repo}/pulls/${n}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(got)) break;
    for (const c of got) if (typeof c?.id === "number") out.push({ id: c.id, in_reply_to_id: typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null });
    if (got.length < 100) break;
  }
  return out;
}

/** The replies as they would go: each to its thread's first comment; one to a comment not on this PR is left out. */
export async function checkReplies(ghe: Ghe, repo: string, n: number, o: { reviewed: string; draft: TriageDraft }): Promise<Checked<TriageDraft>> {
  try {
    const at = await openAt(ghe, repo, n, o.reviewed);
    if (!at.ok) return at;
    const { replies, unknown } = replyTargets(o.draft.replies, await lineComments(ghe, repo, n));
    const notes = unknown.length ? [`${unknown.length === 1 ? "One reply answers a comment" : `${unknown.length} replies answer comments`} that ${unknown.length === 1 ? "isn't" : "aren't"} on this PR: left out.`] : [];
    return { ok: true, draft: { kind: "triage", replies, comment: o.draft.comment }, notes };
  } catch (e) {
    return { ok: false, message: `Couldn't check ${repo}#${n}: ${String((e as Error).message ?? e)}` };
  }
}

/** `id`: the review's, when one posted. */
export type Posted = { ok: boolean; message: string; url?: string; what?: string; partial?: boolean; id?: number };

/** `kind`: what the actions log calls it (default pr.review; Auto review's is autoreview.review). */
export async function postReview(ghe: Ghe, db: D1, repo: string, n: number, o: { reviewed: string; me: string; draft: ReviewDraft; verdict: Verdict; by?: By; kind?: string }): Promise<Posted> {
  const target = `${repo}#${n}`;
  const checked = await checkReview(ghe, repo, n, o);
  if (!checked.ok) return { ok: false, message: checked.message };
  const what = draftCounts(checked.draft, o.verdict);
  try {
    const r = await ghe.rest<{ html_url?: string; id?: number }>(`/repos/${repo}/pulls/${n}/reviews`, { method: "POST", body: reviewRequest(checked.draft, o.verdict, checked.commit!) });
    await logAction(db, { kind: o.kind ?? "pr.review", target, detail: what, ok: true });
    return { ok: true, message: `Posted the review on ${target} (${what}).`, url: typeof r?.html_url === "string" ? r.html_url : undefined, what, ...(Number.isInteger(r?.id) ? { id: r.id } : {}) };
  } catch (e) {
    const error = String((e as Error).message ?? e);
    await logAction(db, { kind: o.kind ?? "pr.review", target, detail: what, ok: false, error });
    return { ok: false, message: `Couldn't post the review on ${target}: ${error}` };
  }
}

/** Replies one by one; one that fails doesn't stop the rest, and the message says which. `kind`: what the actions log calls it (default pr.replies). */
export async function postReplies(ghe: Ghe, db: D1, repo: string, n: number, o: { reviewed: string; draft: TriageDraft; kind?: string }): Promise<Posted> {
  const target = `${repo}#${n}`;
  const checked = await checkReplies(ghe, repo, n, o);
  if (!checked.ok) return { ok: false, message: checked.message };
  const d = checked.draft;
  const failed: string[] = [];
  let sent = 0;
  for (const r of d.replies) {
    try {
      await ghe.rest(`/repos/${repo}/pulls/${n}/comments/${r.commentId}/replies`, { method: "POST", body: { body: r.body } });
      sent++;
    } catch (e) {
      failed.push(`to ${r.commentId}: ${String((e as Error).message ?? e)}`);
    }
  }
  let general = false;
  if (d.comment) {
    try {
      await ghe.rest(`/repos/${repo}/issues/${n}/comments`, { method: "POST", body: { body: d.comment } });
      general = true;
    } catch (e) {
      failed.push(`the comment: ${String((e as Error).message ?? e)}`);
    }
  }
  const what = draftCounts({ kind: "triage", replies: d.replies.slice(0, sent), comment: general ? d.comment : "" }) || "nothing";
  await logAction(db, { kind: o.kind ?? "pr.replies", target, detail: what, ok: !failed.length, error: failed.slice(0, 5).join("; ") || undefined });
  if (!failed.length) return { ok: true, message: `Posted ${what} on ${target}.`, what };
  return { ok: sent > 0 || general, partial: true, message: `Posted ${what} on ${target}; ${failed.length} failed, first ${failed[0]}`, what };
}
