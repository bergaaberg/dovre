/**
 * The PR list's views, filters and sorts (dovre#157): pure, from the query string. The page keeps
 * the last choice in a cookie, so each viewer comes back to their own.
 */
import { prNeeds, type Pr } from "../sources/ghe.ts";

export const VIEWS = {
  all: "All",
  needs: "Needs me",
  threads: "Open threads",
  review: "Review requested",
  failing: "CI failing",
  ready: "Approved",
} as const;
export type View = keyof typeof VIEWS;

export const SORTS = { attention: "Needs me first", updated: "Last updated", oldest: "Waiting longest", repo: "Repo", size: "Size" } as const;
export type Sort = keyof typeof SORTS;

export const STATES = { draft: "Draft", ready: "Ready for review", approved: "Approved", changes: "Changes requested" } as const;
export type State = keyof typeof STATES;

export const CIS = { failing: "Failing", pending: "Running", passing: "Passing", none: "No checks" } as const;
export type Ci = keyof typeof CIS;

export type PrQuery = { view: View; sort: Sort; repo?: string; author?: string; state?: State; ci?: Ci };
/** Where the last choice is kept, and the query keys that make a choice. */
export const PRS_COOKIE = "dovre_prs";
export const PRS_KEYS = ["view", "sort", "repo", "author", "state", "ci"] as const;

export const DEFAULT_QUERY: PrQuery = { view: "all", sort: "attention" };

const pick = <T extends string>(set: Record<T, string>, v: string | undefined | null): T | undefined => (v && Object.hasOwn(set, v) ? (v as T) : undefined);
/** Repo and author names as GitHub allows them; anything else is dropped. */
const name = (v: string | undefined | null, re: RegExp) => (v && v.length <= 140 && re.test(v) ? v : undefined);

export function parsePrQuery(q: URLSearchParams): PrQuery {
  const out: PrQuery = { view: pick(VIEWS, q.get("view")) ?? "all", sort: pick(SORTS, q.get("sort")) ?? "attention" };
  const repo = name(q.get("repo"), /^[\w.-]+\/[\w.-]+$/);
  const author = name(q.get("author"), /^[\w-]+(\[bot\])?$/);
  const state = pick(STATES, q.get("state"));
  const ci = pick(CIS, q.get("ci"));
  if (repo) out.repo = repo;
  if (author) out.author = author;
  if (state) out.state = state;
  if (ci) out.ci = ci;
  return out;
}

/** The query as a string, defaults left out ("" when it's all defaults). */
export function prQueryString(q: PrQuery): string {
  const p = new URLSearchParams();
  if (q.view !== "all") p.set("view", q.view);
  if (q.sort !== "attention") p.set("sort", q.sort);
  for (const k of ["repo", "author", "state", "ci"] as const) if (q[k]) p.set(k, q[k]!);
  return p.toString();
}

export const prHref = (q: PrQuery) => {
  const s = prQueryString(q);
  return s ? `/prs?${s}` : "/prs";
};

const failing = (p: Pr) => p.checks === "FAILURE" || p.checks === "ERROR";
const ciOf = (p: Pr): Ci => (failing(p) ? "failing" : p.checks === "PENDING" || p.checks === "EXPECTED" ? "pending" : p.checks === "SUCCESS" ? "passing" : "none");
const stateOf = (p: Pr): State => (p.draft ? "draft" : p.review === "CHANGES_REQUESTED" ? "changes" : p.review === "APPROVED" ? "approved" : "ready");

/** Which of the two lists a view looks at, and what it keeps. */
const VIEW_TEST: Record<View, { mine: ((p: Pr) => boolean) | null; review: ((p: Pr) => boolean) | null }> = {
  all: { mine: () => true, review: () => true },
  needs: { mine: (p) => prNeeds(p).length > 0, review: () => true },
  threads: { mine: (p) => p.openThreads > 0, review: (p) => p.openThreads > 0 },
  review: { mine: null, review: () => true },
  failing: { mine: failing, review: null },
  ready: { mine: (p) => p.review === "APPROVED" && !p.draft, review: null },
};

/** Mine first where I'm needed: red, changes asked, threads, ready to merge; then the freshest. */
const weight = (p: Pr) => (failing(p) ? 0 : p.review === "CHANGES_REQUESTED" ? 1 : p.openThreads ? 2 : prNeeds(p)[0]?.startsWith("approved") ? 3 : p.draft ? 5 : 4);
const newest = (a: Pr, b: Pr) => b.updatedAt.localeCompare(a.updatedAt);
/** Mine first where I'm needed (the home card's order too). */
export const prOrder = (prs: Pr[]): Pr[] => [...prs].sort((a, b) => weight(a) - weight(b) || newest(a, b));
const SORT_BY: Record<Sort, (a: Pr, b: Pr) => number> = {
  attention: (a, b) => weight(a) - weight(b) || newest(a, b),
  updated: newest,
  oldest: (a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt),
  repo: (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number,
  size: (a, b) => b.additions + b.deletions - (a.additions + a.deletions) || newest(a, b),
};

const filters = (q: PrQuery) => (p: Pr) =>
  (!q.repo || p.repo.toLowerCase() === q.repo.toLowerCase()) &&
  (!q.author || p.author.toLowerCase() === q.author.toLowerCase()) &&
  (!q.state || stateOf(p) === q.state) &&
  (!q.ci || ciOf(p) === q.ci);

export type PrLists = { mine: Pr[] | null; review: Pr[] | null };

/** The two lists after the view, the filters and the sort. A list the view doesn't look at is null. */
export function applyPrQuery(prs: { mine: Pr[]; review: Pr[] }, q: PrQuery): PrLists {
  const t = VIEW_TEST[q.view];
  const keep = filters(q);
  const one = (list: Pr[], test: ((p: Pr) => boolean) | null) => (test ? list.filter((p) => test(p) && keep(p)).sort(SORT_BY[q.sort]) : null);
  return { mine: one(prs.mine, t.mine), review: one(prs.review, t.review) };
}

/** How many each quick view would show, with the filters as they are. */
export function viewCounts(prs: { mine: Pr[]; review: Pr[] }, q: PrQuery): Record<View, number> {
  const out = {} as Record<View, number>;
  for (const v of Object.keys(VIEWS) as View[]) {
    const l = applyPrQuery(prs, { ...q, view: v });
    out[v] = (l.mine?.length ?? 0) + (l.review?.length ?? 0);
  }
  return out;
}

/** The repos and authors on the lists, for the filter's choices. */
export function choicesOf(prs: { mine: Pr[]; review: Pr[] }): { repos: string[]; authors: string[] } {
  const all = [...prs.mine, ...prs.review];
  return { repos: [...new Set(all.map((p) => p.repo))].sort(), authors: [...new Set(all.map((p) => p.author))].sort() };
}
