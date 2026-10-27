/**
 * One pull request, read for its own page (src/pages/viewer.ts): what it is, its checks, reviews
 * and review threads, a short timeline, and its files with their patches. Read-only. Cached by
 * the page (memoize): a PR seen before draws at once and is read again in the background.
 */
import type { Ghe } from "./ghe.ts";
import { checkState } from "./ghe.ts";

export type ThreadComment = { author: string; body: string; at: string; url: string };
/** `id`: GHE's node id (to resolve it); `firstId`: its first comment's id (replies go to it). Empty when not known. */
export type Thread = { path: string; line: number | null; side: "LEFT" | "RIGHT"; resolved: boolean; outdated: boolean; comments: ThreadComment[]; id?: string; firstId?: number };
export type ReviewItem = { author: string; state: string; body: string; at: string; url: string };
export type TimelineItem = { at: string; what: "commit" | "force-push" | "review-requested" | "ready" | "draft" | "merged" | "closed" | "reopened"; who: string; detail: string };

export type PrView = {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  author: string;
  base: string;
  head: string;
  headSha: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  createdAt: string;
  updatedAt: string;
  runs: { name: string; state: "ok" | "bad" | "pending" | "skipped"; url: string | null }[];
  reviews: ReviewItem[];
  requested: string[];
  threads: Thread[];
  timeline: TimelineItem[];
};

export type PrFile = { path: string; previous?: string; status: string; additions: number; deletions: number; patch?: string; sha: string };

/** A GraphQL node id, as GHE gives a review thread's ("PRRT_kwDO…"). */
export const THREAD_ID = /^[A-Za-z0-9_=-]{4,120}$/;
const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const query = (owner: string, name: string, n: number) => `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${n}){
  number title url state isDraft mergeable baseRefName headRefName headRefOid author{login} body additions deletions changedFiles
  createdAt updatedAt reviewDecision labels(first:20){nodes{name}}
  reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
  reviews(last:50){nodes{author{login} state body submittedAt url}}
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine diffSide comments(first:30){nodes{databaseId author{login} body createdAt url}}}}
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:60){nodes{
    ... on CheckRun{name conclusion status detailsUrl}
    ... on StatusContext{context state targetUrl}}}}}}}
  timelineItems(last:40,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,REVIEW_REQUESTED_EVENT,READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,MERGED_EVENT,CLOSED_EVENT,REOPENED_EVENT]){nodes{
    __typename
    ... on PullRequestCommit{commit{oid messageHeadline committedDate author{user{login} name}}}
    ... on HeadRefForcePushedEvent{createdAt actor{login}}
    ... on ReviewRequestedEvent{createdAt actor{login} requestedReviewer{... on User{login} ... on Team{name}}}
    ... on ReadyForReviewEvent{createdAt actor{login}}
    ... on ConvertToDraftEvent{createdAt actor{login}}
    ... on MergedEvent{createdAt actor{login}}
    ... on ClosedEvent{createdAt actor{login}}
    ... on ReopenedEvent{createdAt actor{login}}}}
}}}`;

/** The GraphQL answer, normalised; anything off-shape becomes empty, never an error page. */
export function normalizePrView(repo: string, raw: unknown): PrView | null {
  const p = (raw as { repository?: { pullRequest?: Record<string, any> } })?.repository?.pullRequest;
  if (!p || typeof p.number !== "number") return null;
  const who = (a: any) => str(a?.login ?? a?.name ?? "ghost", 100) || "ghost";
  const contexts: any[] = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const order = { bad: 0, pending: 1, ok: 2, skipped: 3 } as const;
  const runs = contexts
    .map((c) => ({ name: str(c?.name ?? c?.context, 200), state: checkState(c ?? {}), url: str(c?.detailsUrl ?? c?.targetUrl, 2000) || null }))
    .filter((r) => r.name)
    .sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  const timeline: TimelineItem[] = [];
  for (const t of (p.timelineItems?.nodes ?? []) as any[]) {
    const at = str(t?.createdAt ?? t?.commit?.committedDate, 40);
    switch (t?.__typename) {
      case "PullRequestCommit":
        timeline.push({ at, what: "commit", who: who(t.commit?.author?.user ?? { name: t.commit?.author?.name }), detail: `${str(t.commit?.oid, 7)} ${str(t.commit?.messageHeadline, 300)}` });
        break;
      case "HeadRefForcePushedEvent":
        timeline.push({ at, what: "force-push", who: who(t.actor), detail: "" });
        break;
      case "ReviewRequestedEvent":
        timeline.push({ at, what: "review-requested", who: who(t.actor), detail: who(t.requestedReviewer) });
        break;
      case "ReadyForReviewEvent":
        timeline.push({ at, what: "ready", who: who(t.actor), detail: "" });
        break;
      case "ConvertToDraftEvent":
        timeline.push({ at, what: "draft", who: who(t.actor), detail: "" });
        break;
      case "MergedEvent":
        timeline.push({ at, what: "merged", who: who(t.actor), detail: "" });
        break;
      case "ClosedEvent":
        timeline.push({ at, what: "closed", who: who(t.actor), detail: "" });
        break;
      case "ReopenedEvent":
        timeline.push({ at, what: "reopened", who: who(t.actor), detail: "" });
        break;
    }
  }
  const state = p.state === "MERGED" || p.state === "CLOSED" ? p.state : "OPEN";
  const mergeable = p.mergeable === "MERGEABLE" || p.mergeable === "CONFLICTING" ? p.mergeable : "UNKNOWN";
  const decision = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(p.reviewDecision) ? p.reviewDecision : null;
  return {
    repo,
    number: p.number,
    title: str(p.title, 500),
    url: str(p.url, 2000),
    state,
    draft: p.isDraft === true,
    mergeable,
    author: who(p.author),
    base: str(p.baseRefName, 300),
    head: str(p.headRefName, 300),
    headSha: str(p.headRefOid, 64),
    body: str(p.body),
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changedFiles),
    labels: ((p.labels?.nodes ?? []) as any[]).map((l) => str(l?.name, 100)).filter(Boolean),
    reviewDecision: decision,
    createdAt: str(p.createdAt, 40),
    updatedAt: str(p.updatedAt, 40),
    runs,
    reviews: ((p.reviews?.nodes ?? []) as any[]).map((r) => ({ author: who(r?.author), state: str(r?.state, 40), body: str(r?.body, 60_000), at: str(r?.submittedAt, 40), url: str(r?.url, 2000) })),
    requested: ((p.reviewRequests?.nodes ?? []) as any[]).map((r) => who(r?.requestedReviewer)).filter((x) => x !== "ghost"),
    threads: ((p.reviewThreads?.nodes ?? []) as any[]).map((t) => ({
      path: str(t?.path, 1000),
      line: typeof t?.line === "number" ? t.line : typeof t?.originalLine === "number" ? t.originalLine : null,
      side: t?.diffSide === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const),
      resolved: t?.isResolved === true,
      outdated: t?.isOutdated === true,
      comments: ((t?.comments?.nodes ?? []) as any[]).map((c) => ({ author: who(c?.author), body: str(c?.body, 60_000), at: str(c?.createdAt, 40), url: str(c?.url, 2000) })),
      ...(THREAD_ID.test(str(t?.id, 200)) ? { id: str(t?.id, 200) } : {}),
      ...(Number.isSafeInteger(t?.comments?.nodes?.[0]?.databaseId) && t.comments.nodes[0].databaseId > 0 ? { firstId: t.comments.nodes[0].databaseId as number } : {}),
    })),
    timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)),
  };
}

export async function loadPrView(ghe: Ghe, repo: string, n: number): Promise<PrView> {
  const [owner, name] = repo.split("/");
  const q = query(owner!, name!, n);
  const view = normalizePrView(repo, await ghe.graphql(q));
  if (!view) throw new Error(`${repo}#${n} isn't a pull request (or isn't visible)`);
  return view;
}

/** At most this many files; GHE pages them 100 at a time and stops at 3000 anyway. */
export const MAX_FILES = 300;

export async function loadPrFiles(ghe: Ghe, repo: string, n: number): Promise<PrFile[]> {
  const out: PrFile[] = [];
  for (let page = 1; out.length < MAX_FILES; page++) {
    const got = await ghe.rest<any[]>(`/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
    if (!Array.isArray(got)) break;
    for (const f of got)
      out.push({
        path: str(f?.filename, 1000),
        previous: str(f?.previous_filename, 1000) || undefined,
        status: str(f?.status, 20),
        additions: num(f?.additions),
        deletions: num(f?.deletions),
        patch: typeof f?.patch === "string" ? f.patch : undefined,
        sha: str(f?.sha, 64),
      });
    if (got.length < 100) break;
  }
  return out.slice(0, MAX_FILES);
}
