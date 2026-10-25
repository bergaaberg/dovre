/**
 * Stacked PRs from GHE: my open PRs and my review requests, then the chains they're in, walked
 * a few rounds in both directions (the PR a base branch belongs to, open or merged or closed, and
 * the open PRs built on a head branch), each round one GraphQL query. Cached with the kept
 * memoize (src/issues/templates.ts): answered at once, loaded again in the background.
 */
import { ownerQuery, owns } from "../owners.ts";
import type { StackPr } from "../home/stacks.ts";
import { type Kept, memoize } from "../issues/templates.ts";
import type { Ghe } from "./ghe.ts";

const FIELDS = `number title url isDraft state mergedAt closedAt updatedAt baseRefName headRefName baseRef{name} author{login}
  repository{nameWithOwner defaultBranchRef{name}} reviewDecision mergeStateStatus
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

type Node = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  baseRef: { name: string } | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string; defaultBranchRef: { name: string } | null } | null;
  reviewDecision: StackPr["review"];
  mergeStateStatus: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};

const CHECKS: Record<string, StackPr["checks"]> = { SUCCESS: "ok", FAILURE: "bad", ERROR: "bad", PENDING: "pending", EXPECTED: "pending" };

export function normalizeStackPr(n: Node): StackPr | null {
  if (!n?.repository || typeof n.number !== "number") return null;
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: String(n.title ?? ""),
    url: String(n.url ?? ""),
    author: n.author?.login ?? "ghost",
    base: String(n.baseRefName ?? ""),
    head: String(n.headRefName ?? ""),
    defaultBranch: n.repository.defaultBranchRef?.name ?? "main",
    state: n.state === "MERGED" || n.state === "CLOSED" ? n.state : "OPEN",
    draft: !!n.isDraft,
    closedAt: n.mergedAt ?? n.closedAt ?? null,
    baseExists: !!n.baseRef,
    review: n.reviewDecision ?? null,
    checks: rollup ? (CHECKS[rollup] ?? "none") : "none",
    mergeState: n.mergeStateStatus ?? null,
  };
}

const q = (s: string) => JSON.stringify(s);
const key = (p: StackPr) => `${p.repo}#${p.number}`;

/** Every PR in the stacks around my open PRs and my review requests (open, and merged/closed bases). */
export async function loadStackPrs(ghe: Ghe, login: string, org: string, rounds = 6): Promise<StackPr[]> {
  const first = await ghe.graphql<{ mine?: { nodes: Node[] }; review?: { nodes: Node[] } }>(`{
    mine: search(query:${q(`is:pr is:open author:${login} ${ownerQuery(org)} archived:false`)}, type:ISSUE, first:50){ nodes{ ... on PullRequest { ${FIELDS} } } }
    review: search(query:${q(`is:pr is:open review-requested:${login} ${ownerQuery(org)} archived:false`)}, type:ISSUE, first:30){ nodes{ ... on PullRequest { ${FIELDS} } } }
  }`);
  const all = new Map<string, StackPr>();
  const add = (nodes: Node[] | undefined) => {
    const fresh: StackPr[] = [];
    for (const n of nodes ?? []) {
      const p = normalizeStackPr(n);
      // Only the owners' repos: a stack never leads outside them.
      if (!p || !owns(org, p.repo.split("/")[0]!) || all.has(key(p))) continue;
      all.set(key(p), p);
      fresh.push(p);
    }
    return fresh;
  };
  let frontier = [...add(first.mine?.nodes), ...add(first.review?.nodes)];
  const askedUp = new Set<string>();
  const askedDown = new Set<string>();
  for (let round = 0; round < rounds && frontier.length; round++) {
    const parts: string[] = [];
    for (const p of frontier) {
      if (p.state !== "OPEN") continue;
      const [owner, name] = p.repo.split("/");
      const repo = `repository(owner:${q(owner!)},name:${q(name!)})`;
      // Below: the PR whose head is this one's base (unless it's the default branch, or known).
      const known = [...all.values()].some((x) => x.repo === p.repo && x.head === p.base && x.state === "OPEN");
      const up = `${p.repo}\n${p.base}`;
      if (p.base !== p.defaultBranch && !known && !askedUp.has(up)) {
        askedUp.add(up);
        parts.push(`u${parts.length}: ${repo}{pullRequests(headRefName:${q(p.base)}, first:5, states:[OPEN,MERGED,CLOSED], orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${FIELDS}}}}`);
      }
      // Above: open PRs built on this one's head.
      const down = `${p.repo}\n${p.head}`;
      if (!askedDown.has(down)) {
        askedDown.add(down);
        parts.push(`d${parts.length}: ${repo}{pullRequests(baseRefName:${q(p.head)}, first:10, states:[OPEN]){nodes{${FIELDS}}}}`);
      }
    }
    if (!parts.length) break;
    const next: StackPr[] = [];
    for (let i = 0; i < parts.length; i += 40) {
      const d = await ghe.graphql<Record<string, { pullRequests: { nodes: Node[] } } | null>>(`{${parts.slice(i, i + 40).join("\n")}}`);
      for (const v of Object.values(d ?? {})) next.push(...add(v?.pullRequests?.nodes));
    }
    frontier = next;
  }
  return [...all.values()];
}

/** The loader behind the kept cache: a known answer at once, loaded again after two minutes. */
export function createStacks(ghe: Ghe, org: string, opts: { kept?: Kept; ttlMs?: number; now?: () => number } = {}) {
  const cached = memoize({ ttlMs: opts.ttlMs ?? 2 * 60e3, kept: opts.kept, now: opts.now });
  return { load: (login: string, o?: { fresh?: boolean }) => cached(`stacks:${org}:${login}`, () => loadStackPrs(ghe, login, org), o) };
}
