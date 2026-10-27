/**
 * History for the Stats page, from GitHub in two GraphQL queries (each answers in one go):
 * - people: my PRs touched in the window (created, ready, first review by someone else, merged),
 *   the reviews I gave, my open PRs and the ones asking me (with their age), and the org's merged
 *   PRs per week (a count per week, by search).
 * - repos: the org's most recently pushed repos, their releases, and their main branch's commits
 *   with each commit's checks.
 * Then pure functions turn it into weeks. Only GitHub metadata (numbers, titles, times), as the
 * snapshot already holds.
 */
import { ownerQuery } from "../owners.ts";
import type { Ghe } from "../sources/ghe.ts";
import { osloDay } from "./spend.ts";
import { currentTz } from "../when.ts";

export const WEEKS = 12;
const DAY = 86400e3;

export type MyPr = { repo: string; number: number; title: string; url: string; createdAt: string; readyAt?: string; firstReviewAt?: string; mergedAt?: string; closedAt?: string; state: string; draft: boolean };
export type OpenPr = { repo: string; number: number; title: string; url: string; createdAt: string; draft: boolean; mine: boolean };
export type Commit = { repo: string; at: string; state?: string };
export type Release = { repo: string; at: string; tag: string };
export type History = {
  at: number;
  login: string;
  /** How many weeks were gathered (unset: an older file, 12). */
  weeks?: number;
  mine: MyPr[];
  reviewsGiven: string[];
  open: OpenPr[];
  orgMerged: { week: string; n: number }[];
  /** How many days the org's merged PRs were counted by day (unset: none). */
  days?: number;
  /** The org's merged PRs per day (YYYY-MM-DD), when Stats shows days. */
  orgMergedDays?: { day: string; n: number }[];
  releases: Release[];
  commits: Commit[];
  /** By repo: where its commits start when GitHub had more than one page of them; weeks before that don't count its commits. */
  commitsFrom?: Record<string, string>;
  repos: number;
};

/** Weeks that can be gathered: 12 always, 26 when Stats is set to show that many. */
export const GATHER_WEEKS = (shown?: number) => Math.max(WEEKS, Math.min(26, shown ?? WEEKS));
/** Days Stats can show (Settings → Look and layout). */
export const DAYS = [14, 28] as const;

/** A week: Monday (Oslo) as YYYY-MM-DD, its ISO number, and where it starts and ends. */
export type Week = { key: string; label: string; start: number; end: number };

/** The last `n` weeks, Monday to Monday in the instance timezone, oldest first; the last is this week (so far). */
export function weeksOf(now: number, n = WEEKS, tz = currentTz()): Week[] {
  const [y, m, d] = osloDay(now, tz).split("-").map(Number) as [number, number, number];
  const today = Date.UTC(y, m - 1, d);
  const dow = new Date(today).getUTCDay() || 7;
  const monday = today - (dow - 1) * DAY;
  const out: Week[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = monday - i * 7 * DAY;
    const key = new Date(s).toISOString().slice(0, 10);
    // ISO week number of that Monday.
    const t = new Date(s + 3 * DAY);
    const jan1 = Date.UTC(t.getUTCFullYear(), 0, 1);
    const wk = Math.ceil(((t.getTime() - jan1) / DAY + 1) / 7);
    out.push({ key, label: `w${wk}`, start: s, end: s + 7 * DAY });
  }
  return out;
}

/** The last `n` days in the instance timezone, oldest first, as periods like weeks: the last is today (so far). */
export function daysOf(now: number, n: number, tz = currentTz()): Week[] {
  const [y, m, d] = osloDay(now, tz).split("-").map(Number) as [number, number, number];
  const today = Date.UTC(y, m - 1, d);
  const out: Week[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = today - i * DAY;
    const key = new Date(s).toISOString().slice(0, 10);
    out.push({ key, label: String(new Date(s).getUTCDate()), start: s, end: s + DAY });
  }
  return out;
}

/** Which week (by its Monday) a time falls in, by its day in the instance timezone. */
export function weekOf(at: string | number, weeks: Week[], tz = currentTz()): Week | undefined {
  const [y, m, d] = osloDay(at, tz).split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  return weeks.find((w) => t >= w.start && t < w.end);
}

export const count = (times: (string | undefined)[], weeks: Week[]) => weeks.map((w) => times.filter((t) => t && weekOf(t, weeks) === w).length);

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3600e3;

/** Everything the page draws, per week, or per day for the last `days` days. */
export function weekly(h: History, now: number, days?: number) {
  const weeks = days ? daysOf(now, days) : weeksOf(now, h.weeks ?? WEEKS);
  const org = days ? (h.orgMergedDays ?? []).map((x) => ({ key: x.day, n: x.n })) : h.orgMerged.map((x) => ({ key: x.week, n: x.n }));
  // A repo with more commits than one page counts only in the weeks its page reaches.
  const from = Object.fromEntries(Object.entries(h.commitsFrom ?? {}).map(([r, t]) => [r, Date.parse(t)]));
  const merged = h.mine.filter((p) => p.mergedAt);
  const red = weeks.map((w) => {
    const checked = h.commits.filter((c) => c.state && weekOf(c.at, weeks) === w && !(from[c.repo]! > w.start));
    const bad = checked.filter((c) => c.state === "FAILURE" || c.state === "ERROR").length;
    return checked.length ? { pct: Math.round((bad / checked.length) * 100), bad, of: checked.length } : undefined;
  });
  const waits = weeks.map((w) => {
    const these = merged.filter((p) => weekOf(p.mergedAt!, weeks) === w);
    return {
      review: median(these.filter((p) => p.firstReviewAt).map((p) => hours(p.readyAt ?? p.createdAt, p.firstReviewAt!))),
      merge: median(these.map((p) => hours(p.readyAt ?? p.createdAt, p.mergedAt!))),
      n: these.length,
    };
  });
  return {
    weeks,
    mergedMine: count(merged.map((p) => p.mergedAt), weeks),
    reviewsGiven: count(h.reviewsGiven, weeks),
    orgMerged: weeks.map((w) => org.find((x) => x.key === w.key)?.n),
    releases: count(h.releases.map((r) => r.at), weeks),
    red,
    waits,
  };
}

// ── Gathering ──

const q = (s: string) => JSON.stringify(s);
type Node = Record<string, any>;

export async function gatherHistory(ghe: Ghe, org: string, login: string, now: number, n = WEEKS, nDays = 0): Promise<History> {
  const weeks = weeksOf(now, n);
  const days = nDays ? daysOf(now, nDays) : [];
  const since = new Date(weeks[0]!.start).toISOString().slice(0, 10);
  const counts = weeks
    .map((w, i) => `w${i}: search(type: ISSUE, first: 1, query: ${q(`${ownerQuery(org)} is:pr is:merged merged:${w.key}..${new Date(w.end - DAY).toISOString().slice(0, 10)}`)}) { issueCount }`)
    .join("\n");
  // By day only when Stats shows days: a search each.
  const dayCounts = days.map((d, i) => `d${i}: search(type: ISSUE, first: 1, query: ${q(`${ownerQuery(org)} is:pr is:merged merged:${d.key}`)}) { issueCount }`).join("\n");
  const pr = `... on PullRequest { number title url createdAt mergedAt closedAt state isDraft repository { nameWithOwner } }`;
  // Mine and the ones I reviewed can pass a hundred in a few weeks: page through them.
  const mine = await searchAll(ghe, `${ownerQuery(org)} is:pr author:${login} updated:>=${since}`, `... on PullRequest { number title url createdAt mergedAt closedAt state isDraft repository { nameWithOwner }
    reviews(first: 20) { nodes { submittedAt author { login } } }
    timelineItems(first: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } } }`);
  const reviewed = await searchAll(ghe, `${ownerQuery(org)} is:pr reviewed-by:${login} -author:${login} updated:>=${since}`, `... on PullRequest { reviews(first: 20, author: ${q(login)}) { nodes { submittedAt } } }`);
  const people = await ghe.graphql<Node>(`{
  open: search(type: ISSUE, first: 50, query: ${q(`${ownerQuery(org)} is:pr is:open author:${login}`)}) { nodes { ${pr} } }
  asked: search(type: ISSUE, first: 50, query: ${q(`${ownerQuery(org)} is:pr is:open review-requested:${login}`)}) { nodes { ${pr} } }
  ${counts}
  ${dayCounts}
}`);
  const repos = await ghe.graphql<Node>(`{
  organization(login: ${q(org)}) { repositories(first: 30, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner isArchived
    releases(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { createdAt tagName isPrerelease isDraft } }
    defaultBranchRef { target { ... on Commit { history(first: 100, since: ${q(new Date(weeks[0]!.start).toISOString())}) { pageInfo { hasNextPage } nodes { committedDate statusCheckRollup { state } } } } } } } } }
}`);
  return historyOf({ ...people, mine: { nodes: mine }, reviewed: { nodes: reviewed } }, repos, { login, weeks, days, now });
}

/** A search's nodes, page after page (at most `pages` of 100). */
async function searchAll(ghe: Ghe, query: string, fields: string, pages = 8): Promise<Node[]> {
  const out: Node[] = [];
  let after: string | undefined;
  for (let i = 0; i < pages; i++) {
    const d = await ghe.graphql<Node>(`{ s: search(type: ISSUE, first: 100, query: ${q(query)}${after ? `, after: ${q(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`);
    out.push(...(Array.isArray(d.s?.nodes) ? d.s.nodes : []));
    if (!d.s?.pageInfo?.hasNextPage || typeof d.s.pageInfo.endCursor !== "string") break;
    after = d.s.pageInfo.endCursor;
  }
  return out;
}

/** Copilot's own review and other bots don't count as someone looking at it. */
export const isBot = (login: unknown) => typeof login !== "string" || /\[bot\]$|^copilot|-bot$|^github-actions/i.test(login);

/** GitHub's answers, read narrowly: anything missing or odd is left out. */
export function historyOf(people: Node, repos: Node, o: { login: string; weeks: Week[]; /** The days counted by day, when asked. */ days?: Week[]; now: number }): History {
  const nodes = (x: any): Node[] => (Array.isArray(x?.nodes) ? x.nodes.filter((n: unknown) => n && typeof n === "object") : []);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const mine: MyPr[] = nodes(people.mine).filter((p) => typeof p.number === "number" && str(p.createdAt)).map((p) => {
    const others = nodes(p.reviews).filter((r) => r.author?.login !== o.login && !isBot(r.author?.login) && str(r.submittedAt)).map((r) => r.submittedAt as string).sort();
    return { repo: String(p.repository?.nameWithOwner ?? ""), number: p.number, title: String(p.title ?? ""), url: String(p.url ?? ""), createdAt: p.createdAt, readyAt: str(nodes(p.timelineItems)[0]?.createdAt), firstReviewAt: others[0], mergedAt: str(p.mergedAt), closedAt: str(p.closedAt), state: String(p.state ?? ""), draft: !!p.isDraft };
  });
  const reviewsGiven = nodes(people.reviewed).flatMap((p) => nodes(p.reviews).map((r) => str(r.submittedAt)).filter((t): t is string => !!t));
  const openOf = (x: any, isMine: boolean): OpenPr[] => nodes(x).filter((p) => typeof p.number === "number" && str(p.createdAt)).map((p) => ({ repo: String(p.repository?.nameWithOwner ?? ""), number: p.number, title: String(p.title ?? ""), url: String(p.url ?? ""), createdAt: p.createdAt, draft: !!p.isDraft, mine: isMine }));
  const orgMerged = o.weeks.flatMap((w, i) => (typeof people[`w${i}`]?.issueCount === "number" ? [{ week: w.key, n: people[`w${i}`].issueCount as number }] : []));
  const orgMergedDays = (o.days ?? []).flatMap((d, i) => (typeof people[`d${i}`]?.issueCount === "number" ? [{ day: d.key, n: people[`d${i}`].issueCount as number }] : []));
  const list = nodes(repos.organization?.repositories).filter((r) => !r.isArchived);
  const releases: Release[] = list.flatMap((r) => nodes(r.releases).filter((x) => !x.isDraft && !x.isPrerelease && str(x.createdAt)).map((x) => ({ repo: String(r.nameWithOwner), at: x.createdAt, tag: String(x.tagName ?? "") })));
  const commitsFrom: Record<string, string> = {};
  for (const r of list) {
    const hist = r.defaultBranchRef?.target?.history;
    const ats = nodes(hist).map((c) => str(c.committedDate)).filter((t): t is string => !!t).sort();
    if (hist?.pageInfo?.hasNextPage === true && ats[0]) commitsFrom[String(r.nameWithOwner)] = ats[0];
  }
  const commits: Commit[] = list.flatMap((r) => nodes(r.defaultBranchRef?.target?.history).filter((c) => str(c.committedDate)).map((c) => ({ repo: String(r.nameWithOwner), at: c.committedDate, state: str(c.statusCheckRollup?.state) })));
  return { at: o.now, login: o.login, weeks: o.weeks.length, mine, reviewsGiven, open: [...openOf(people.open, true), ...openOf(people.asked, false)], orgMerged, ...(o.days?.length ? { days: o.days.length, orgMergedDays } : {}), releases, commits, ...(Object.keys(commitsFrom).length ? { commitsFrom } : {}), repos: list.length };
}
