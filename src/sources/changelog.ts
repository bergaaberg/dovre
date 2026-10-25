/**
 * What a waiting deploy ships: every commit between the one live in the environment (its
 * newest successful deployment) and the run's commit, as PRs grouped by kind. Squash merges
 * carry their PR number as "(#123)" at the end of the subject.
 */
import type { Ghe } from "./ghe.ts";

export type ChangeKind = "feature" | "fix" | "deps" | "other";
export type Change = { kind: ChangeKind; pr?: number; title: string; author: string; sha: string; /** The commit message (capped), where the packs' kinds of reference are looked for when it's drawn. */ text: string };
export type Changelog = {
  repo: string;
  env: string;
  /** What's live now; null when no successful deployment to the environment was found. */
  prodSha: string | null;
  prodAt: string | null;
  head: string;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  changes: Change[];
  compareUrl: string;
};


export function classify(subject: string, author: string): ChangeKind {
  if (/\[bot\]$/.test(author) || /^(chore|build)\(deps(-dev)?\)/i.test(subject) || /^bump\s/i.test(subject)) return "deps";
  const type = subject.match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase();
  if (type === "feat" || type === "feature") return "feature";
  if (type === "fix" || type === "hotfix") return "fix";
  return "other";
}

export function parseCommit(c: { sha: string; author: { login: string } | null; commit: { message: string; author: { name: string } | null } }): Change {
  const subject = c.commit.message.split("\n")[0]!.trim();
  const pr = subject.match(/\(#(\d+)\)\s*$/)?.[1];
  const author = c.author?.login ?? c.commit.author?.name ?? "unknown";
  return { kind: classify(subject, author), pr: pr ? Number(pr) : undefined, title: subject.replace(/\s*\(#\d+\)\s*$/, ""), author, sha: c.sha.slice(0, 7), text: c.commit.message.slice(0, 1000) };
}

export const KIND_TITLE: Record<ChangeKind, string> = { feature: "Features", fix: "Fixes", other: "Other changes", deps: "Dependency bumps" };

export function groupChanges(changes: Change[]): { kind: ChangeKind; changes: Change[] }[] {
  return (["feature", "fix", "other", "deps"] as const).map((kind) => ({ kind, changes: changes.filter((c) => c.kind === kind) })).filter((g) => g.changes.length);
}

export async function liveSha(ghe: Ghe, repo: string, env: string): Promise<{ sha: string; at: string } | null> {
  const [owner, name] = repo.split("/");
  const d = await ghe.graphql<{ repository: { deployments: { nodes: { commitOid: string; createdAt: string; latestStatus: { state: string } | null }[] } } }>(
    `{ repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ deployments(environments:[${JSON.stringify(env)}], first:100, orderBy:{field:CREATED_AT,direction:DESC}){ nodes{ commitOid createdAt latestStatus{state} } } } }`,
  );
  const hit = d.repository.deployments.nodes.find((n) => n.latestStatus?.state === "SUCCESS" || n.latestStatus?.state === "INACTIVE");
  return hit ? { sha: hit.commitOid, at: hit.createdAt } : null;
}

type RawCompare = { total_commits: number; commits: Parameters<typeof parseCommit>[0][]; files?: { additions: number; deletions: number }[]; html_url: string };

const cache = new Map<string, Changelog>();

export async function loadChangelog(ghe: Ghe, repo: string, env: string, head: string): Promise<Changelog> {
  const live = await liveSha(ghe, repo, env);
  const base = { repo, env, prodSha: live?.sha ?? null, prodAt: live?.at ?? null, head };
  if (!live) return { ...base, commits: 0, files: 0, additions: 0, deletions: 0, changes: [], compareUrl: `https://${ghe.host}/${repo}/commits/${head}` };
  const key = `${repo}:${live.sha}..${head}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = await ghe.rest<RawCompare>(`/repos/${repo}/compare/${live.sha}...${head}`);
  const files = c.files ?? [];
  const log: Changelog = {
    ...base,
    commits: c.total_commits,
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changes: c.commits.map(parseCommit).reverse(),
    compareUrl: c.html_url,
  };
  cache.set(key, log);
  return log;
}
