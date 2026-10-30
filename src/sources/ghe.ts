import { type Calls, createCalls, graphqlSiteOf, NOT_MODIFIED, siteOf } from "../forge/calls.ts";
import { ownerQuery, ownersOf } from "../owners.ts";
/**
 * GitHub Enterprise (acme.ghe.com): my PRs, review requests, notifications, the org's movement and
 * the deploys waiting for me. Loaders talk HTTP; the transforms below them are pure and tested.
 */

export type Fetch = typeof fetch;
export type Ghe = {
  host: string;
  rest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  graphql<T>(query: string): Promise<T>;
  /** Every call it made, counted, and the quota GitHub said is left (src/forge/calls.ts). */
  calls?: Calls;
};

/**
 * Where a host's API is: github.com and GHE.com (`*.ghe.com`, data residency) on an `api.`
 * subdomain; GitHub Enterprise Server under `/api/v3` and `/api/graphql` on the host itself.
 */
export function apiEndpointsOf(host: string): { rest: string; graphql: string } {
  const clean = host.trim().toLowerCase().replace(/^api\./, "");
  if (clean === "github.com" || clean.endsWith(".ghe.com")) return { rest: `https://api.${clean}`, graphql: `https://api.${clean}/graphql` };
  return { rest: `https://${clean}/api/v3`, graphql: `https://${clean}/api/graphql` };
}

/** A token, or a function that gives the current one (a rotating token: it's asked before every call, so caching is its job). */
export type TokenSource = string | (() => Promise<string>);

/** Conditional GETs keep at most this many answers, each at most this big. */
const KEEP_PATHS = 300;
const KEEP_BYTES = 512 * 1024;

export function createGhe(opts: { host: string; token: TokenSource; fetchFn?: Fetch; calls?: Calls }): Ghe {
  const calls = opts.calls ?? createCalls();
  const endpoints = apiEndpointsOf(opts.host);
  const f = opts.fetchFn ?? fetch;
  const t = opts.token;
  const tokenOf = typeof t === "string" ? async () => t : t;
  // GitHub refuses a request without a User-Agent; Node's fetch sends one, a Worker's doesn't.
  /** GET answers by path, with what GitHub tags them by, for conditional requests (newest last). */
  const seen = new Map<string, { etag?: string; modified?: string; text: string }>();
  const keep = (path: string, text: string, h: Headers) => {
    const etag = h.get("etag") ?? undefined;
    const modified = h.get("last-modified") ?? undefined;
    seen.delete(path);
    if ((!etag && !modified) || text.length > KEEP_BYTES) return;
    seen.set(path, { etag, modified, text });
    for (const old of seen.keys()) {
      if (seen.size <= KEEP_PATHS) break;
      seen.delete(old);
    }
  };
  const headersOf = async () => ({ authorization: `Bearer ${await tokenOf()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "dovre" });
  return {
    host: opts.host,
    calls,
    async rest<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const method = (init.method ?? "GET").toUpperCase();
      const get = method === "GET" && !init.body;
      const kept = get ? seen.get(path) : undefined;
      const headers: Record<string, string> = await headersOf();
      if (kept?.etag) headers["if-none-match"] = kept.etag;
      else if (kept?.modified) headers["if-modified-since"] = kept.modified;
      const res = await f(endpoints.rest + path, {
        method,
        headers: init.body ? { ...headers, "content-type": "application/json" } : headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      // A 304 doesn't count against the quota: the body kept from last time is still the answer.
      if (res.status === 304 && kept) {
        calls.record(siteOf(method, path) + NOT_MODIFIED, res.headers);
        seen.delete(path);
        seen.set(path, kept);
        return JSON.parse(kept.text) as T;
      }
      calls.record(siteOf(method, path), res.headers);
      if (!res.ok) throw new Error(`GHE ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      if (res.status === 204) return null as T;
      const text = await res.text();
      if (get) keep(path, text, res.headers);
      return JSON.parse(text) as T;
    },
    async graphql<T>(query: string) {
      const headers = await headersOf();
      const res = await f(endpoints.graphql, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ query }) });
      calls.record(graphqlSiteOf(query), res.headers);
      const text = await res.text();
      let body: { data?: T; errors?: { message: string }[] };
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`GHE graphql: ${res.status} ${text.slice(0, 200)}`.trim());
      }
      if (!res.ok || body.errors?.length) throw new Error(`GHE graphql: ${res.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
      return body.data as T;
    },
  };
}

/** A client with no GitHub behind it: every call fails saying `why` (pages show it as failed, not empty). */
export function missingGhe(host: string, why: string): Ghe {
  const missing = () => Promise.reject(new Error(why));
  return { host, rest: missing, graphql: missing };
}

// ── PRs ───────────────────────────────────────────────────────────────────────

export type Checks = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | "NONE";
export type Pr = {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updatedAt: string;
  /** When it was opened (older sources leave it out: updatedAt stands in). */
  createdAt?: string;
  branch: string;
  author: string;
  review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: Checks;
  openThreads: number;
  body: string;
  additions: number;
  deletions: number;
  headSha: string;
  labels: string[];
  files: { path: string; additions: number; deletions: number }[];
  /** How many files it changes in all (`files` stops at 80); older sources leave it out. */
  changedFiles?: number;
  /** Each reviewer's latest say, and who's still asked. */
  reviews: { login: string; state: string }[];
  requested: string[];
  /** The last commit's checks, worst first. */
  runs: { name: string; state: "ok" | "bad" | "pending" | "skipped"; url: string | null }[];
};

const PR_FIELDS = `number title url isDraft updatedAt createdAt headRefName headRefOid author{login} repository{nameWithOwner}
  body additions deletions changedFiles labels(first:10){nodes{name}} files(first:80){nodes{path additions deletions}}
  latestReviews(first:10){nodes{author{login} state}}
  reviewRequests(first:10){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
  reviewDecision reviewThreads(first:80){nodes{isResolved}}
  commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:40){nodes{
    ... on CheckRun{name conclusion status detailsUrl}
    ... on StatusContext{context state targetUrl}}}}}}}`;

type RawCheck = { name?: string; conclusion?: string | null; status?: string; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null };

export function checkState(c: RawCheck): Pr["runs"][number]["state"] {
  const v = (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL"].includes(v)) return "ok";
  if (["SKIPPED", "CANCELLED", "STALE"].includes(v)) return "skipped";
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) return "bad";
  return "pending";
}
const RANK = { bad: 0, pending: 1, ok: 2, skipped: 3 } as const;

type PrNode = {
  number: number; title: string; url: string; isDraft: boolean; updatedAt: string; createdAt?: string; headRefName: string; headRefOid?: string;
  author: { login: string } | null; repository: { nameWithOwner: string }; reviewDecision: Pr["review"];
  body?: string; additions?: number; deletions?: number; changedFiles?: number; labels?: { nodes: { name: string }[] };
  files?: { nodes: { path: string; additions: number; deletions: number }[] } | null;
  latestReviews?: { nodes: { author: { login: string } | null; state: string }[] };
  reviewRequests?: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] };
  reviewThreads: { nodes: { isResolved: boolean }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: Checks; contexts?: { nodes: RawCheck[] } } | null } }[] };
};

export function normalizePr(p: PrNode): Pr {
  return {
    repo: p.repository.nameWithOwner,
    number: p.number,
    title: p.title,
    url: p.url,
    draft: p.isDraft,
    updatedAt: p.updatedAt,
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    branch: p.headRefName,
    author: p.author?.login ?? "ghost",
    review: p.reviewDecision,
    checks: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "NONE",
    openThreads: p.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    body: p.body ?? "",
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    headSha: p.headRefOid ?? "",
    labels: p.labels?.nodes.map((l) => l.name) ?? [],
    files: p.files?.nodes ?? [],
    ...(p.changedFiles !== undefined ? { changedFiles: p.changedFiles } : {}),
    reviews: (p.latestReviews?.nodes ?? []).map((r) => ({ login: r.author?.login ?? "ghost", state: r.state })),
    requested: (p.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name ?? "").filter(Boolean),
    runs: (p.commits.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [])
      .filter((c) => c.name || c.context)
      .map((c) => ({ name: (c.name ?? c.context)!, state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? null }))
      .sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name)),
  };
}

/** How many files a PR changes, or null when the source didn't say (an empty list may just be unfetched). */
export function fileCount(p: Pick<Pr, "files" | "changedFiles">): number | null {
  return p.changedFiles ?? (p.files.length ? p.files.length : null);
}

/** " in 4 files", or "" when the count isn't known. */
export function inFiles(p: Pick<Pr, "files" | "changedFiles">): string {
  const n = fileCount(p);
  return n === null ? "" : ` in ${n} ${n === 1 ? "file" : "files"}`;
}

/** What a PR of mine is waiting on, if anything I should do: the reasons, worst first. */
export function prNeeds(p: Pr): string[] {
  const why: string[] = [];
  if (p.checks === "FAILURE" || p.checks === "ERROR") why.push("checks failing");
  if (p.review === "CHANGES_REQUESTED") why.push("changes requested");
  if (p.openThreads) why.push(`${p.openThreads} unresolved ${p.openThreads === 1 ? "thread" : "threads"}`);
  if (!why.length && !p.draft && p.review === "APPROVED" && p.checks === "SUCCESS") why.push("approved and green: ready to merge");
  return why;
}

export async function loadPrs(ghe: Ghe, login: string, org: string): Promise<{ mine: Pr[]; review: Pr[] }> {
  const q = (s: string) => JSON.stringify(s);
  const d = await ghe.graphql<{ mine: { nodes: PrNode[] }; review: { nodes: PrNode[] } }>(`{
    mine: search(query:${q(`is:pr is:open author:${login} ${ownerQuery(org)} archived:false`)}, type:ISSUE, first:40){ nodes{ ... on PullRequest { ${PR_FIELDS} } } }
    review: search(query:${q(`is:pr is:open review-requested:${login} ${ownerQuery(org)} archived:false`)}, type:ISSUE, first:30){ nodes{ ... on PullRequest { ${PR_FIELDS} } } }
  }`);
  const byNewest = (a: Pr, b: Pr) => b.updatedAt.localeCompare(a.updatedAt);
  return { mine: d.mine.nodes.filter((n) => n.repository).map(normalizePr).sort(byNewest), review: d.review.nodes.filter((n) => n.repository).map(normalizePr).sort(byNewest) };
}

/** State and title of PRs by "owner/repo#n": for links agents left and events that only carry a number. */
export type PrRef = { state: "OPEN" | "CLOSED" | "MERGED"; title: string; url: string };
export const prKey = (repo: string, number: number) => `${repo}#${number}`;

export async function loadPrRefs(ghe: Ghe, keys: Iterable<string>): Promise<Map<string, PrRef>> {
  const list = [...new Set(keys)].map((k) => k.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)).filter((m): m is RegExpMatchArray => !!m);
  const out = new Map<string, PrRef>();
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const q = chunk.map(([, o, n, num], j) => `p${j}: repository(owner:${JSON.stringify(o)},name:${JSON.stringify(n)}){pullRequest(number:${Number(num)}){state title url}}`).join("\n");
    const d = await ghe.graphql<Record<string, { pullRequest: PrRef | null } | null>>(`{${q}}`).catch(() => ({}) as Record<string, null>);
    chunk.forEach(([key], j) => {
      const pr = d[`p${j}`]?.pullRequest;
      if (pr) out.set(key!, pr);
    });
  }
  return out;
}

export function prKeyOfUrl(url: string): string | undefined {
  const m = url.match(/\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  return m ? prKey(`${m[1]}/${m[2]}`, Number(m[3])) : undefined;
}

// ── Notifications ─────────────────────────────────────────────────────────────

export type Note = { id: string; reason: string; type: string; title: string; repo: string; updatedAt: string; url: string };

type RawNote = { id: string; reason: string; updated_at: string; subject: { type: string; title: string; url: string | null }; repository: { full_name: string } };

export function apiToHtml(host: string, url: string | null, repo: string): string {
  if (!url) return `https://${host}/${repo}/actions`;
  return url
    .replace(`https://api.${host}/repos/`, `https://${host}/`)
    .replace(`https://${host}/api/v3/repos/`, `https://${host}/`)
    .replace(/\/pulls\/(\d+)$/, "/pull/$1");
}

/** GitHub App user tokens and fine-grained PATs may not read /notifications: a 403 "not accessible by …". */
export const notesRefused = (e: unknown) => /\/notifications\S*: 403 .*not accessible/i.test(String((e as Error)?.message ?? e));

/**
 * What asks for me. From notifications when the token may read them; otherwise (#31) from a search
 * for what mentions me, updated in the last `days`, so mentions still reach Today. `searched` says
 * which it was.
 */
export async function loadNotes(ghe: Ghe, o: { now?: number; days?: number; searched?: (yes: boolean) => void } = {}): Promise<Note[]> {
  let raw: RawNote[];
  try {
    raw = await ghe.rest<RawNote[]>("/notifications?per_page=50");
  } catch (e) {
    if (!notesRefused(e)) throw e;
    o.searched?.(true);
    return searchNotes(ghe, o.now ?? Date.now(), o.days ?? 7);
  }
  o.searched?.(false);
  return raw.map((n) => ({
    id: n.id,
    reason: n.reason,
    type: n.subject.type,
    title: n.subject.title,
    repo: n.repository.full_name,
    updatedAt: n.updated_at,
    url: apiToHtml(ghe.host, n.subject.url, n.repository.full_name),
  }));
}

type Mentioned = { __typename?: string; id?: string; url?: string; title?: string; updatedAt?: string; repository?: { nameWithOwner: string } };

/** Issues and PRs mentioning me, updated since `days` ago, as mention notes (newest first). */
export async function searchNotes(ghe: Ghe, now: number, days: number): Promise<Note[]> {
  const since = new Date(now - days * 86400e3).toISOString().slice(0, 10);
  const q = `mentions:@me updated:>=${since} sort:updated-desc`;
  const fields = "id url title updatedAt repository { nameWithOwner }";
  const d = await ghe.graphql<{ s: { nodes: (Mentioned | null)[] } }>(`{ s: search(query:${JSON.stringify(q)}, type:ISSUE, first:30){ nodes{ __typename ... on Issue { ${fields} } ... on PullRequest { ${fields} } } } }`);
  return (d.s?.nodes ?? [])
    .filter((n): n is Required<Mentioned> => !!n?.id && !!n.url && !!n.repository && !!n.updatedAt)
    .map((n) => ({ id: `search:${n.id}`, reason: "mention", type: n.__typename === "PullRequest" ? "PullRequest" : "Issue", title: n.title ?? "", repo: n.repository.nameWithOwner, updatedAt: n.updatedAt, url: n.url }));
}

// ── The org's movement ────────────────────────────────────────────────────────

export type Move = { at: string; actor: string; bot: boolean; repo: string; type: string; verb: string; ref?: string; title?: string; url: string };

/** Accounts that act like bots without saying so in their login. */
const BOTS = new Set(["Copilot", "copilot", "github-actions", "dependabot"]);
export const isBot = (login: string) => /\[bot\]$/.test(login) || BOTS.has(login);

type RawEvent = { type: string; created_at: string; actor: { login: string }; repo: { name: string }; payload: Record<string, any> };

export function describeEvent(e: RawEvent, host: string): Move {
  const p = e.payload ?? {};
  const pr = p.pull_request, iss = p.issue;
  const repoUrl = `https://${host}/${e.repo.name}`;
  const base = { at: e.created_at, actor: e.actor.login, bot: isBot(e.actor.login), repo: e.repo.name, type: e.type };
  const prRef = pr?.number ? prKey(e.repo.name, pr.number) : undefined;
  const prUrl = pr?.number ? `${repoUrl}/pull/${pr.number}` : repoUrl;
  const branch = String(p.ref ?? "").replace(/^refs\/heads\//, "");
  switch (e.type) {
    case "PullRequestEvent":
      return { ...base, verb: p.action === "closed" && (pr?.merged || pr?.merged_at) ? "merged" : String(p.action ?? "updated"), ref: prRef, title: pr?.title, url: prUrl };
    case "PullRequestReviewEvent":
      return { ...base, verb: `reviewed (${String(p.review?.state ?? "").toLowerCase().replace("_", " ")})`, ref: prRef, title: pr?.title, url: p.review?.html_url ?? prUrl };
    case "PullRequestReviewCommentEvent":
      return { ...base, verb: "commented on", ref: prRef, title: pr?.title, url: p.comment?.html_url ?? prUrl };
    case "IssuesEvent":
      return { ...base, verb: `${p.action} issue`, title: iss ? `#${iss.number} ${iss.title}` : undefined, url: iss?.html_url ?? repoUrl };
    case "IssueCommentEvent": {
      const isPr = !!iss?.pull_request;
      return { ...base, verb: "commented on", ref: isPr ? prKey(e.repo.name, iss.number) : undefined, title: iss ? `${isPr ? "" : "issue "}#${iss.number} ${iss.title}` : undefined, url: p.comment?.html_url ?? repoUrl };
    }
    case "PushEvent":
      return { ...base, verb: `pushed ${p.size ?? p.commits?.length ?? ""} to`.replace("  ", " "), title: branch, url: `${repoUrl}/commits/${encodeURIComponent(branch)}` };
    case "CreateEvent":
      return { ...base, verb: `created ${p.ref_type}`, title: p.ref ?? undefined, url: repoUrl };
    case "DeleteEvent":
      return { ...base, verb: `deleted ${p.ref_type}`, title: p.ref ?? undefined, url: repoUrl };
    case "ReleaseEvent":
      return { ...base, verb: "released", title: p.release?.tag_name, url: p.release?.html_url ?? repoUrl };
    default:
      return { ...base, verb: e.type.replace(/Event$/, "").toLowerCase(), url: repoUrl };
  }
}

/**
 * The owners' events from the last `hours`, newest first (the API keeps 300 per feed at most). An
 * org's comes from its feed for me; my own account's from my events, kept to the repos I own.
 */
export async function loadMoves(ghe: Ghe, login: string, org: string, hours = 24, now = Date.now()): Promise<Move[]> {
  const since = now - hours * 3600e3;
  const out: Move[] = [];
  for (const owner of ownersOf(org)) {
    const self = owner.toLowerCase() === login.toLowerCase();
    const feed = self ? `/users/${login}/events` : `/users/${login}/events/orgs/${owner}`;
    for (let page = 1; page <= 3; page++) {
      const raw = await ghe.rest<RawEvent[]>(`${feed}?per_page=100&page=${page}`).catch(() => []);
      const mine = self ? raw.filter((e) => String(e.repo?.name ?? "").split("/")[0]?.toLowerCase() === owner.toLowerCase()) : raw;
      out.push(...mine.filter((e) => Date.parse(e.created_at) > since).map((e) => describeEvent(e, ghe.host)));
      if (raw.length < 100 || Date.parse(raw[raw.length - 1]!.created_at) <= since) break;
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Events per person, the busiest first. */
export function byPerson(moves: Move[]): { who: string; moves: Move[]; repos: string[] }[] {
  const m = new Map<string, Move[]>();
  for (const e of moves) m.set(e.actor, [...(m.get(e.actor) ?? []), e]);
  return [...m.entries()]
    .map(([who, list]) => ({ who, moves: list, repos: [...new Set(list.map((e) => e.repo))] }))
    .sort((a, b) => b.moves.length - a.moves.length || a.who.localeCompare(b.who));
}

// ── Deploys waiting for me ────────────────────────────────────────────────────

export type Run = { id: number; name: string; title: string; actor: string; createdAt: string; url: string; sha: string; headSha: string; branch: string };
/** `more`: the waiting list hit the page size, so there are at least this many superseded. */
export type Deploy = Run & { repo: string; envs: { id: number; name: string }[]; superseded: Run[]; more: boolean };

type RawRun = { id: number; name: string; display_title: string; actor: { login: string }; created_at: string; html_url: string; head_sha: string; head_branch: string };
type RawPending = { environment: { id: number; name: string }; current_user_can_approve: boolean };

/**
 * Waiting runs grouped by workflow: the newest is the one to decide, the rest are superseded.
 * A prod deploy that waits isn't rejected by the next one, so they pile up.
 */
export function newestWaiting(runs: Run[]): { top: Run; superseded: Run[] }[] {
  const by = new Map<string, Run[]>();
  for (const r of runs) by.set(r.name, [...(by.get(r.name) ?? []), r]);
  return [...by.values()].map((list) => {
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { top: sorted[0]!, superseded: sorted.slice(1) };
  });
}

const toRun = (r: RawRun): Run => ({ id: r.id, name: r.name, title: r.display_title, actor: r.actor.login, createdAt: r.created_at, url: r.html_url, sha: r.head_sha.slice(0, 7), headSha: r.head_sha, branch: r.head_branch });

/** Repos to look in: any a deploy notification named, plus `extra` (repos I deploy). */
export async function loadDeploys(ghe: Ghe, repos: string[]): Promise<Deploy[]> {
  const out: Deploy[] = [];
  await Promise.all(
    [...new Set(repos)].map(async (repo) => {
      const raw = (await ghe.rest<{ workflow_runs: RawRun[] }>(`/repos/${repo}/actions/runs?status=waiting&per_page=100`)).workflow_runs;
      const runs = raw.map(toRun);
      for (const { top, superseded } of newestWaiting(runs)) {
        const pending = await ghe.rest<RawPending[]>(`/repos/${repo}/actions/runs/${top.id}/pending_deployments`).catch(() => []);
        const mine = pending.filter((p) => p.current_user_can_approve).map((p) => p.environment);
        if (mine.length) out.push({ ...top, repo, envs: mine, superseded, more: raw.length >= 100 });
      }
    }),
  );
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Approve or reject a waiting run's environments. */
export async function reviewDeploy(ghe: Ghe, repo: string, runId: number, envIds: number[], state: "approved" | "rejected", comment: string) {
  await ghe.rest(`/repos/${repo}/actions/runs/${runId}/pending_deployments`, { method: "POST", body: { environment_ids: envIds, state, comment } });
}

/** Environments on a run I may decide on now (empty when it moved on). */
export async function pendingEnvs(ghe: Ghe, repo: string, runId: number): Promise<number[]> {
  const pending = await ghe.rest<RawPending[]>(`/repos/${repo}/actions/runs/${runId}/pending_deployments`);
  return pending.filter((p) => p.current_user_can_approve).map((p) => p.environment.id);
}

export async function viewerLogin(ghe: Ghe): Promise<string> {
  return (await ghe.rest<{ login: string }>("/user")).login;
}

export async function viewer(ghe: Ghe): Promise<{ login: string; name: string | null }> {
  const u = await ghe.rest<{ login: string; name: string | null }>("/user");
  return { login: u.login, name: u.name };
}

// ── Red branches ──────────────────────────────────────────────────────────────

export type RedBranch = { repo: string; branch: string; workflow: string; failures: number; since: string; url: string };

/** "Build, test and deploy 🚀 workflow run failed for main branch" → workflow and branch. */
export function failedRunOf(title: string): { workflow: string; branch: string } | null {
  const m = title.match(/^(.*?)\s+workflow run failed for (\S+) branch$/i);
  return m ? { workflow: m[1]!.trim(), branch: m[2]! } : null;
}

/** CI notifications grouped by repo, branch and workflow: the candidates for "this branch is red". */
/** Branches a red build matters on for everyone. A feature branch's red shows on its PR instead. */
const SHARED = /^(main|master|develop|dev|release\/.+|hotfix\/.+)$/;

export function failedRuns(notes: Note[]): Omit<RedBranch, "url">[] {
  const m = new Map<string, Omit<RedBranch, "url">>();
  for (const n of notes) {
    const f = n.reason === "ci_activity" ? failedRunOf(n.title) : null;
    if (!f || !SHARED.test(f.branch)) continue;
    const key = `${n.repo} ${f.branch} ${f.workflow}`;
    const hit = m.get(key);
    if (hit) {
      hit.failures++;
      if (n.updatedAt < hit.since) hit.since = n.updatedAt;
    } else m.set(key, { repo: n.repo, branch: f.branch, workflow: f.workflow, failures: 1, since: n.updatedAt });
  }
  return [...m.values()];
}

/**
 * Unread failure notifications outlive the failure, so each candidate is checked against the
 * branch's newest finished run of that workflow: red only if that one failed too.
 */
export async function loadRedBranches(ghe: Ghe, notes: Note[], repos: string[] = []): Promise<RedBranch[]> {
  const out: RedBranch[] = [];
  await Promise.all([
    ...failedRuns(notes).map(async (c) => {
      const runs = (await ghe.rest<{ workflow_runs: { name: string; conclusion: string | null; status: string; html_url: string }[] }>(`/repos/${c.repo}/actions/runs?branch=${encodeURIComponent(c.branch)}&status=completed&per_page=20`).catch(() => ({ workflow_runs: [] }))).workflow_runs;
      const last = runs.find((r) => r.name === c.workflow);
      if (last && last.conclusion === "failure") out.push({ ...c, url: last.html_url });
    }),
    ...[...new Set(repos)].slice(0, 8).map(async (repo) => out.push(...(await redFromRuns(ghe, repo)))),
  ]);
  return out.sort((a, b) => b.failures - a.failures);
}

type PushRun = { name: string; head_branch: string | null; conclusion: string | null; html_url: string; updated_at: string };

/**
 * Without notifications (#31): a repo's shared branches whose newest finished run of a workflow
 * failed, from its recent pushes. `failures` counts the failed runs in a row, newest first.
 */
export async function redFromRuns(ghe: Ghe, repo: string): Promise<RedBranch[]> {
  const runs = (await ghe.rest<{ workflow_runs: PushRun[] }>(`/repos/${repo}/actions/runs?event=push&status=completed&per_page=50`).catch(() => ({ workflow_runs: [] }))).workflow_runs;
  const by = new Map<string, PushRun[]>();
  for (const r of runs) {
    if (!r.head_branch || !SHARED.test(r.head_branch)) continue;
    const k = `${r.head_branch} ${r.name}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const out: RedBranch[] = [];
  for (const rs of by.values()) {
    const streak = rs.findIndex((r) => r.conclusion !== "failure");
    const row = streak === -1 ? rs : rs.slice(0, streak);
    if (!row.length) continue;
    out.push({ repo, branch: rs[0]!.head_branch!, workflow: rs[0]!.name, failures: row.length, since: row[row.length - 1]!.updated_at, url: rs[0]!.html_url });
  }
  return out;
}
