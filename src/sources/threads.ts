/**
 * One issue or PR in full, and a search over the owners' repos (#262): for Bino's lookups and the
 * agents' tools (the tracker pack), never for pages. The caller has checked the repo is an owner's.
 */
import type { Ghe } from "./ghe.ts";

export type Thread = {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  body: string;
  /** The latest five, oldest first. */
  comments: { author: string; at: string; body: string }[];
  /** A PR's: draft, review decision, size, branch, and its latest reviews. */
  pr?: { draft: boolean; review: string; additions: number; deletions: number; files: number; branch: string; reviews: { author: string; state: string; body: string }[] };
};
export type ThreadHit = { kind: "issue" | "pr"; repo: string; number: number; title: string; state: string; author: string };

const REPO = /^([\w.-]+)\/([\w.-]+)$/;
const s = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
type Who = { login?: string } | null | undefined;
type RawComment = { author?: Who; body?: string; createdAt?: string };

export async function loadThread(ghe: Ghe, repo: string, n: number): Promise<Thread | undefined> {
  const m = REPO.exec(repo);
  if (!m || !Number.isInteger(n) || n < 1) return undefined;
  const common = "title state body author { login } labels(first: 10) { nodes { name } } assignees(first: 5) { nodes { login } } comments(last: 5) { nodes { author { login } body createdAt } }";
  const q = `query { repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) { issueOrPullRequest(number: ${n}) { __typename
    ... on Issue { ${common} }
    ... on PullRequest { ${common} isDraft reviewDecision additions deletions changedFiles headRefName reviews(last: 5) { nodes { author { login } state body } } }
  } } }`;
  type Raw = { __typename?: string; title?: string; state?: string; body?: string; author?: Who; labels?: { nodes?: { name?: string }[] }; assignees?: { nodes?: Who[] }; comments?: { nodes?: RawComment[] }; isDraft?: boolean; reviewDecision?: string | null; additions?: number; deletions?: number; changedFiles?: number; headRefName?: string; reviews?: { nodes?: { author?: Who; state?: string; body?: string }[] } };
  const r = await ghe.graphql<{ repository?: { issueOrPullRequest?: Raw | null } | null }>(q).catch((e: Error) => {
    if (/Could not resolve|NOT_FOUND/i.test(String(e?.message))) return { repository: null };
    throw e;
  });
  const t = r.repository?.issueOrPullRequest;
  if (!t?.__typename) return undefined;
  const isPr = t.__typename === "PullRequest";
  return {
    kind: isPr ? "pr" : "issue",
    repo,
    number: n,
    title: s(t.title, 300),
    state: s(t.state, 20),
    author: s(t.author?.login, 60),
    labels: (t.labels?.nodes ?? []).map((l) => s(l.name, 60)).filter(Boolean),
    assignees: (t.assignees?.nodes ?? []).map((a) => s(a?.login, 60)).filter(Boolean),
    body: s(t.body, 20_000),
    comments: (t.comments?.nodes ?? []).map((c) => ({ author: s(c.author?.login, 60), at: s(c.createdAt, 30), body: s(c.body, 5000) })),
    ...(isPr
      ? {
          pr: {
            draft: t.isDraft === true,
            review: s(t.reviewDecision ?? "", 40),
            additions: Number(t.additions) || 0,
            deletions: Number(t.deletions) || 0,
            files: Number(t.changedFiles) || 0,
            branch: s(t.headRefName, 120),
            reviews: (t.reviews?.nodes ?? []).map((v) => ({ author: s(v.author?.login, 60), state: s(v.state, 30), body: s(v.body, 5000) })),
          },
        }
      : {}),
  };
}

/** Issues and PRs in the owners' accounts matching words, newest first; qualifiers in the words are taken apart. */
export async function searchThreads(ghe: Ghe, owners: string[], words: string): Promise<ThreadHit[]> {
  const terms = words.replace(/[":\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const who = owners.filter((o) => /^[\w.-]+$/.test(o)).map((o) => `user:${o}`);
  if (!terms || !who.length) return [];
  const q = `query { search(query: ${JSON.stringify(`${terms} ${who.join(" ")} sort:updated-desc`)}, type: ISSUE, first: 15) { nodes { __typename
    ... on Issue { number title state author { login } repository { nameWithOwner } }
    ... on PullRequest { number title state author { login } repository { nameWithOwner } }
  } } }`;
  type Raw = { __typename?: string; number?: number; title?: string; state?: string; author?: Who; repository?: { nameWithOwner?: string } };
  const r = await ghe.graphql<{ search?: { nodes?: Raw[] } }>(q);
  return (r.search?.nodes ?? []).flatMap((x): ThreadHit[] =>
    x.__typename && x.number && x.repository?.nameWithOwner ? [{ kind: x.__typename === "PullRequest" ? "pr" : "issue", repo: s(x.repository.nameWithOwner, 120), number: x.number, title: s(x.title, 200), state: s(x.state, 20), author: s(x.author?.login, 60) }] : [],
  );
}
