/**
 * My open issues on GitHub (#37): assigned to me, mentioning me, opened by me, and triage (open,
 * unassigned and unlabelled) in chosen repos. One GraphQL query of search aliases: search works for
 * GitHub App user tokens, where the notifications API doesn't (#31). The transforms are pure and tested.
 */
import { ownerQuery, owns } from "../owners.ts";
import type { Ghe } from "./ghe.ts";

export type Issue = {
  /** "owner/repo". */
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  author: string;
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  milestone?: string;
  /** Its Issue Type ("Bug", "Feature"), where the forge has them. */
  type?: string;
  /** Sub-issues closed of all, when it has any. */
  subIssues?: { done: number; total: number };
  /** PRs that close it: `repo#n` and their state. */
  prs: { key: string; state: "OPEN" | "CLOSED" | "MERGED" }[];
};

export type IssueSets = { assigned: Issue[]; mentioned: Issue[]; authored: Issue[]; triage: Issue[] };
export const ISSUE_SETS = ["assigned", "mentioned", "authored", "triage"] as const satisfies readonly (keyof IssueSets)[];

const BASE = `number title url state createdAt updatedAt author{login} repository{nameWithOwner}
  labels(first:10){nodes{name}} assignees(first:5){nodes{login}} comments{totalCount} milestone{title}
  closedByPullRequestsReferences(first:5){nodes{number state repository{nameWithOwner}}}`;
/** Newer fields: older GitHub Enterprise Server doesn't have them, so the query is retried without. */
const NEWER = `issueType{name} subIssuesSummary{completed total}`;

export type IssueNode = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string } | null;
  labels?: { nodes: ({ name: string } | null)[] } | null;
  assignees?: { nodes: ({ login: string } | null)[] } | null;
  comments?: { totalCount: number } | null;
  milestone?: { title: string } | null;
  closedByPullRequestsReferences?: { nodes: ({ number: number; state: "OPEN" | "CLOSED" | "MERGED"; repository: { nameWithOwner: string } | null } | null)[] } | null;
  issueType?: { name: string } | null;
  subIssuesSummary?: { completed: number; total: number } | null;
};

const REPO = /^[\w.-]+\/[\w.-]+$/;

export function normalizeIssue(n: IssueNode): Issue {
  const sub = n.subIssuesSummary;
  return {
    repo: n.repository!.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    state: n.state,
    labels: (n.labels?.nodes ?? []).flatMap((l) => (l ? [l.name] : [])),
    author: n.author?.login ?? "ghost",
    assignees: (n.assignees?.nodes ?? []).flatMap((a) => (a ? [a.login] : [])),
    comments: n.comments?.totalCount ?? 0,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    ...(n.milestone ? { milestone: n.milestone.title } : {}),
    ...(n.issueType ? { type: n.issueType.name } : {}),
    ...(sub && sub.total > 0 ? { subIssues: { done: sub.completed, total: sub.total } } : {}),
    prs: (n.closedByPullRequestsReferences?.nodes ?? []).flatMap((p) => (p?.repository ? [{ key: `${p.repository.nameWithOwner}#${p.number}`, state: p.state }] : [])),
  };
}

/** The search queries, by set. `triage` is left out when no repo in it is the owners'. */
export function issueQueries(login: string, owners: string, triage: string[] = []): Partial<Record<keyof IssueSets, string>> {
  const scope = `${ownerQuery(owners)} archived:false`;
  const repos = [...new Set(triage.map((r) => r.trim()))].filter((r) => REPO.test(r) && owns(owners, r.split("/")[0]!));
  return {
    assigned: `is:issue is:open assignee:${login} ${scope}`,
    mentioned: `is:issue is:open mentions:${login} ${scope}`,
    authored: `is:issue is:open author:${login} ${scope}`,
    ...(repos.length ? { triage: `is:issue is:open no:assignee no:label ${repos.map((r) => `repo:${r}`).join(" ")} archived:false` } : {}),
  };
}

type Found = Partial<Record<keyof IssueSets, { nodes: (IssueNode | Record<string, never> | null)[] }>>;

/** Keeps issues in the owners' repos only, newest first. */
export function issueSetsOf(d: Found, owners: string): IssueSets {
  const set = (k: keyof IssueSets) =>
    (d[k]?.nodes ?? [])
      .filter((n): n is IssueNode => !!n && "repository" in n && !!n.repository && owns(owners, n.repository.nameWithOwner.split("/")[0]!))
      .map(normalizeIssue)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { assigned: set("assigned"), mentioned: set("mentioned"), authored: set("authored"), triage: set("triage") };
}

export async function loadIssues(ghe: Ghe, login: string, owners: string, opts: { triage?: string[] } = {}): Promise<IssueSets> {
  const queries = issueQueries(login, owners, opts.triage);
  const query = (fields: string) =>
    `{\n${Object.entries(queries)
      .map(([k, q]) => `  ${k}: search(query:${JSON.stringify(q)}, type:ISSUE, first:${k === "triage" ? 30 : 50}){ nodes{ ... on Issue { ${fields} } } }`)
      .join("\n")}\n}`;
  const d = await ghe.graphql<Found>(query(`${BASE} ${NEWER}`)).catch((e: Error) => {
    if (/issueType|subIssuesSummary/.test(String(e?.message))) return ghe.graphql<Found>(query(BASE));
    throw e;
  });
  return issueSetsOf(d, owners);
}

// ── One issue, and what I may do to it (#40) ──────────────────────────────────

/** A write to one issue. Callers check the repo is the owners' and re-read the issue first. */
export type IssueAct =
  | { kind: "assign"; repo: string; number: number; login: string }
  | { kind: "close"; repo: string; number: number; reason: "completed" | "not_planned" }
  | { kind: "reopen"; repo: string; number: number }
  | { kind: "comment"; repo: string; number: number; body: string };

type RestIssue = {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  assignees: { login: string }[] | null;
  comments: number;
  milestone: { title: string } | null;
  pull_request?: unknown;
};

export function restIssue(repo: string, r: RestIssue): Issue {
  return {
    repo,
    number: r.number,
    title: r.title,
    url: r.html_url,
    state: r.state === "closed" ? "CLOSED" : "OPEN",
    labels: r.labels.flatMap((l) => (typeof l === "string" ? [l] : l.name ? [l.name] : [])),
    author: r.user?.login ?? "ghost",
    assignees: (r.assignees ?? []).map((a) => a.login),
    comments: r.comments,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.milestone ? { milestone: r.milestone.title } : {}),
    prs: [],
  };
}

const path = (repo: string, n: number) => {
  if (!REPO.test(repo) || repo.split("/").some((p) => p === "." || p === "..") || !Number.isInteger(n) || n < 1) throw new Error(`not an issue: ${repo}#${n}`);
  return `/repos/${repo}/issues/${n}`;
};

/** The issue as it is now; undefined when there's none (or it's a PR). */
export async function loadIssue(ghe: Ghe, repo: string, n: number): Promise<Issue | undefined> {
  const r = await ghe.rest<RestIssue>(path(repo, n)).catch((e: Error) => {
    if (/: (404|410)\b/.test(String(e?.message))) return undefined;
    throw e;
  });
  return r && !r.pull_request ? restIssue(repo, r) : undefined;
}

export async function actOnIssue(ghe: Ghe, a: IssueAct): Promise<void> {
  const p = path(a.repo, a.number);
  if (a.kind === "assign") await ghe.rest(`${p}/assignees`, { method: "POST", body: { assignees: [a.login] } });
  else if (a.kind === "close") await ghe.rest(p, { method: "PATCH", body: { state: "closed", state_reason: a.reason } });
  else if (a.kind === "reopen") await ghe.rest(p, { method: "PATCH", body: { state: "open" } });
  else await ghe.rest(`${p}/comments`, { method: "POST", body: { body: a.body } });
}
