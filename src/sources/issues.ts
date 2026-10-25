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
