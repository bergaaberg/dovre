/**
 * Stacked pull requests: a PR whose base is another open PR's head branch, not the repo's default
 * branch. Pure: from PRs (open ones, and the recently merged or closed ones their bases point at)
 * to stacks ordered bottom → top, each PR's place in its stack, what it waits on, and what's wrong:
 * a base PR that merged while this one still targets its branch ("retarget onto main"), a base
 * branch that's gone, a base that matches no PR at all. The bottom of a stack merges first.
 */

export type StackPr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** The branch it merges into, and the one it's from. */
  base: string;
  head: string;
  defaultBranch: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  /** When it merged or closed (ISO), for the ones that did. */
  closedAt: string | null;
  /** Whether the base branch still exists. */
  baseExists: boolean;
  review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: "ok" | "bad" | "pending" | "none";
  /** GHE's mergeStateStatus: CLEAN, BEHIND, BLOCKED, DIRTY (conflicts), UNSTABLE, DRAFT, UNKNOWN… */
  mergeState: string | null;
};

export type Problem =
  | { kind: "base-merged"; pr: number; base: number; onto: string }
  | { kind: "base-closed"; pr: number; base: number }
  | { kind: "base-deleted"; pr: number; branch: string }
  | { kind: "base-unknown"; pr: number; branch: string }
  | { kind: "conflicts"; pr: number };

/** Why a PR can't merge yet because of the one below it. */
export type Wait = { on: number; why: "draft" | "changes" | "red" | "unreviewed" | "open" };

export type StackNode = {
  pr: StackPr;
  /** 0: the stack's main line. A PR with two PRs built on it sends the second (and on) one lane right. */
  lane: number;
  /** Its place in merge order, "2 of 3". */
  position: number;
  /** The open PR below it, if any. */
  below?: number;
  waits?: Wait;
};

export type Stack = {
  repo: string;
  defaultBranch: string;
  /** Bottom first: the order they merge in. */
  nodes: StackNode[];
  problems: Problem[];
  /** At a glance. */
  approved: number;
  red: number;
  /** The bottom PR, when it can merge now (approved, green, not a draft, no conflicts, on the default branch). */
  ready?: number;
  /** When anything in it last changed. */
  updatedAt?: string;
};

const keyOf = (repo: string, n: number) => `${repo}#${n}`;

/** Branches meant to be merged into for a long time: a PR into one isn't stacked on anything. */
export const longLived = (branch: string) => /^(main|master|develop|dev|staging|test|release|hotfix)([/-].*)?$/i.test(branch);

/** The reason a PR blocks the one above it, worst first; null when it only has to merge. */
function blocker(p: StackPr): Wait["why"] {
  if (p.draft) return "draft";
  if (p.review === "CHANGES_REQUESTED") return "changes";
  if (p.checks === "bad") return "red";
  if (p.review !== "APPROVED") return "unreviewed";
  return "open";
}

const canMerge = (p: StackPr) => p.state === "OPEN" && !p.draft && p.review === "APPROVED" && p.checks !== "bad" && p.checks !== "pending" && p.base === p.defaultBranch && p.mergeState !== "DIRTY" && p.mergeState !== "BLOCKED";

/**
 * Stacks from `prs`: open PRs plus the merged/closed ones their bases may point at. A stack is
 * two or more open PRs chained by branch, or one open PR whose base needs attention (a base PR
 * that merged or closed, a base branch that's gone, or a base that's neither the default branch
 * nor any PR's head). `since`: merged/closed PRs older than this (ISO) don't count.
 */
export function stacksOf(prs: StackPr[], opts: { since?: string } = {}): Stack[] {
  const open = prs.filter((p) => p.state === "OPEN");
  const gone = prs.filter((p) => p.state !== "OPEN" && (!opts.since || (p.closedAt ?? "") >= opts.since));
  const openByHead = new Map<string, StackPr>();
  for (const p of open) openByHead.set(`${p.repo}\n${p.head}`, p);
  const goneByHead = new Map<string, StackPr>();
  // The newest merged/closed PR from a branch is the one that matters.
  for (const p of [...gone].sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""))) goneByHead.set(`${p.repo}\n${p.head}`, p);

  const parent = new Map<string, StackPr>();
  const children = new Map<string, StackPr[]>();
  for (const p of open) {
    if (p.base === p.defaultBranch) continue;
    const up = openByHead.get(`${p.repo}\n${p.base}`);
    if (!up || up === p) continue;
    parent.set(keyOf(p.repo, p.number), up);
    const k = keyOf(up.repo, up.number);
    children.set(k, [...(children.get(k) ?? []), p]);
  }

  const problemsOf = (p: StackPr): Problem[] => {
    const out: Problem[] = [];
    if (p.mergeState === "DIRTY") out.push({ kind: "conflicts", pr: p.number });
    if (p.base === p.defaultBranch || parent.has(keyOf(p.repo, p.number))) return out;
    const was = goneByHead.get(`${p.repo}\n${p.base}`);
    if (!was && longLived(p.base)) return out;
    if (was?.state === "MERGED") out.push({ kind: "base-merged", pr: p.number, base: was.number, onto: p.defaultBranch });
    else if (was?.state === "CLOSED") out.push({ kind: "base-closed", pr: p.number, base: was.number });
    else if (!p.baseExists) out.push({ kind: "base-deleted", pr: p.number, branch: p.base });
    else out.push({ kind: "base-unknown", pr: p.number, branch: p.base });
    return out;
  };

  const seen = new Set<string>();
  const stacks: Stack[] = [];
  const roots = open.filter((p) => !parent.has(keyOf(p.repo, p.number))).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  for (const root of roots) {
    const nodes: StackNode[] = [];
    // Bottom first, depth-first: a branch is merged up to its top before the next one starts.
    const walk = (p: StackPr, lane: number) => {
      const k = keyOf(p.repo, p.number);
      if (seen.has(k)) return;
      seen.add(k);
      const below = parent.get(k);
      nodes.push({ pr: p, lane, position: 0, below: below?.number, waits: below ? { on: below.number, why: blocker(below) } : undefined });
      (children.get(k) ?? []).sort((a, b) => a.number - b.number).forEach((c, i) => walk(c, i === 0 ? lane : lane + 1));
    };
    walk(root, 0);
    const problems = nodes.flatMap((n) => problemsOf(n.pr));
    if (nodes.length < 2 && !problems.some((x) => x.kind !== "conflicts")) continue;
    nodes.forEach((n, i) => (n.position = i + 1));
    stacks.push({
      repo: root.repo,
      defaultBranch: root.defaultBranch,
      nodes,
      problems,
      approved: nodes.filter((n) => n.pr.review === "APPROVED").length,
      red: nodes.filter((n) => n.pr.checks === "bad").length,
      ready: canMerge(root) ? root.number : undefined,
    });
  }
  // Problems first, then the biggest.
  return stacks.sort((a, b) => Number(b.problems.length > 0) - Number(a.problems.length > 0) || b.nodes.length - a.nodes.length || a.repo.localeCompare(b.repo));
}

/** "waits on #839 (not reviewed)", for a PR's line. */
export function waitText(w: Wait): string {
  const why = { draft: "a draft", changes: "changes requested", red: "checks failing", unreviewed: "not approved yet", open: "to merge" }[w.why];
  return w.why === "open" ? `waits on #${w.on} to merge` : `waits on #${w.on} (${why})`;
}

/** One line per problem, for the top of a stack. */
export function problemText(p: Problem): string {
  switch (p.kind) {
    case "base-merged":
      return `#${p.base} merged, but #${p.pr} still targets its branch: retarget #${p.pr} onto ${p.onto}.`;
    case "base-closed":
      return `#${p.base} was closed without merging; #${p.pr} still targets its branch.`;
    case "base-deleted":
      return `#${p.pr} targets ${p.branch}, which no longer exists.`;
    case "base-unknown":
      return `#${p.pr} targets ${p.branch}, which is neither the default branch nor any open PR's branch.`;
    case "conflicts":
      return `#${p.pr} has conflicts with its base.`;
  }
}
