/**
 * Review threads on a PR (dovre#106): a reply, and resolving or reopening one. Each re-checks the
 * thread on GHE first (it's on this PR, and not already as asked), then writes, and logs either
 * way: what and where, never the text.
 */
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";
import { THREAD_ID } from "../sources/prview.ts";
import { logAction } from "./deploys.ts";

export type Done = { ok: boolean; message: string };

type Node = { node?: { isResolved?: boolean; pullRequest?: { number?: number; repository?: { nameWithOwner?: string } }; comments?: { nodes?: { databaseId?: number }[] } } | null };

/** The thread as GHE has it now, if it's one of this PR's. */
async function threadOf(ghe: Ghe, repo: string, n: number, id: string) {
  if (!THREAD_ID.test(id)) return undefined;
  const got = await ghe.graphql<Node>(`{node(id:${JSON.stringify(id)}){... on PullRequestReviewThread{isResolved pullRequest{number repository{nameWithOwner}} comments(first:1){nodes{databaseId}}}}}`);
  const t = got?.node;
  if (!t || t.pullRequest?.number !== n || t.pullRequest?.repository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase()) return undefined;
  const first = t.comments?.nodes?.[0]?.databaseId;
  return { resolved: t.isResolved === true, first: typeof first === "number" && Number.isSafeInteger(first) && first > 0 ? first : undefined };
}

export async function replyToThread(ghe: Ghe, db: D1, repo: string, n: number, o: { thread: string; body: string }): Promise<Done> {
  const target = `${repo}#${n}`;
  let t: Awaited<ReturnType<typeof threadOf>>;
  try {
    t = await threadOf(ghe, repo, n, o.thread);
  } catch (e) {
    return { ok: false, message: `Couldn't check the thread on ${target}: ${String((e as Error).message ?? e)}` };
  }
  if (!t?.first) return { ok: false, message: `That thread isn't on ${target}: nothing posted.` };
  try {
    await ghe.rest(`/repos/${repo}/pulls/${n}/comments/${t.first}/replies`, { method: "POST", body: { body: o.body } });
    await logAction(db, { kind: "pr.thread-reply", target, detail: `a reply to ${t.first}`, ok: true });
    return { ok: true, message: `Replied on ${target}.` };
  } catch (e) {
    const error = String((e as Error).message ?? e);
    await logAction(db, { kind: "pr.thread-reply", target, detail: `a reply to ${t.first}`, ok: false, error });
    return { ok: false, message: `Couldn't reply on ${target}: ${error}` };
  }
}

export async function resolveThread(ghe: Ghe, db: D1, repo: string, n: number, o: { thread: string; resolve: boolean }): Promise<Done> {
  const target = `${repo}#${n}`;
  const kind = o.resolve ? "pr.thread-resolve" : "pr.thread-reopen";
  let t: Awaited<ReturnType<typeof threadOf>>;
  try {
    t = await threadOf(ghe, repo, n, o.thread);
  } catch (e) {
    return { ok: false, message: `Couldn't check the thread on ${target}: ${String((e as Error).message ?? e)}` };
  }
  if (!t) return { ok: false, message: `That thread isn't on ${target}: nothing changed.` };
  if (t.resolved === o.resolve) return { ok: true, message: `That thread was ${o.resolve ? "resolved" : "open"} already.` };
  try {
    const m = o.resolve ? "resolveReviewThread" : "unresolveReviewThread";
    await ghe.graphql(`mutation{${m}(input:{threadId:${JSON.stringify(o.thread)}}){thread{isResolved}}}`);
    await logAction(db, { kind, target, detail: "a thread", ok: true });
    return { ok: true, message: o.resolve ? `Resolved the thread on ${target}.` : `Reopened the thread on ${target}.` };
  } catch (e) {
    const error = String((e as Error).message ?? e);
    await logAction(db, { kind, target, detail: "a thread", ok: false, error });
    return { ok: false, message: `Couldn't ${o.resolve ? "resolve" : "reopen"} the thread on ${target}: ${error}` };
  }
}
