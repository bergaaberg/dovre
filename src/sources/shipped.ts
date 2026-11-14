/**
 * What shipped in the owners' repos since a day (Forge.shipped, pack API 2.6): the PRs merged, the
 * releases published and the tags with no release. A paged search per week and one query per owner.
 * Titles, names, times and links only.
 */
import { ownerQuery, ownersOf, owns } from "../owners.ts";
import type { ForgeShipped } from "../forge/types.ts";
import type { Ghe } from "./ghe.ts";

const q = (s: string) => JSON.stringify(s);
type Node = Record<string, any>;

/** Pages of 100 merged PRs read of a week, at most: as far as GitHub's search goes. */
const PR_PAGES = 10;
/** Weeks asked at once. */
const AT_ONCE = 4;
/** The most merged PRs given, the newest. */
export const MAX_SHIPPED_PRS = 3000;
const DAY = 24 * 3600_000;
const WEEK = 7 * DAY;
/** Repos read per owner (the last pushed first), and the releases and tags read of each. */
const REPOS = 100;
const RELEASES = 20;
const TAGS = 100;

const str = (v: unknown, max = 255) => (typeof v === "string" ? v.slice(0, max) : "");
const nodes = (x: any): Node[] => (Array.isArray(x?.nodes) ? x.nodes.filter((n: unknown) => n && typeof n === "object") : []);
/** A time as the forge wrote it (a tagger's has its own offset), in UTC; "" when it isn't one. */
const utc = (v: unknown): string => {
  const t = typeof v === "string" && v.length <= 40 ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().replace(".000Z", "Z") : "";
};
/** A UTC time on or after the day. */
const sinceDay = (at: string, since: string) => !!at && at.slice(0, 10) >= since;
const newest = <T>(list: T[], at: (x: T) => string) => list.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));

export async function loadShipped(ghe: Ghe, owners: string, since: string, now: number = Date.now()): Promise<ForgeShipped> {
  const scope = ownerQuery(owners);
  if (!scope) return { prs: [], releases: [], tags: [] };
  const [merged, repos] = await Promise.all([mergedSince(ghe, owners, since, now), reposShipped(ghe, owners)]);
  return shippedOf(merged, repos, { owners, since, host: ghe.host });
}

/**
 * The search gives a thousand at most, so it's asked a week at a time (a busy month passes that),
 * the weeks side by side: a page takes about a second.
 */
async function mergedSince(ghe: Ghe, owners: string, since: string, now: number): Promise<{ nodes: Node[]; more: boolean }> {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const windows: string[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); Number.isFinite(t) && t <= now && windows.length < 20; t += WEEK) windows.push(t + WEEK > now ? `>=${day(t)}` : `${day(t)}..${day(t + WEEK - DAY)}`);
  const got: { nodes: Node[]; more: boolean }[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < windows.length; i = next++) got[i] = await mergedIn(ghe, `${ownerQuery(owners)} is:pr is:merged merged:${windows[i]} sort:updated-desc`);
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, windows.length) }, worker));
  return { nodes: got.flatMap((g) => g.nodes), more: got.some((g) => g.more) };
}

async function mergedIn(ghe: Ghe, query: string): Promise<{ nodes: Node[]; more: boolean }> {
  const out: Node[] = [];
  let after: string | undefined;
  let count = 0;
  for (let page = 0; page < PR_PAGES; page++) {
    const d = await ghe.graphql<Node>(`{ shipped: search(type: ISSUE, first: 100, query: ${q(query)}${after ? `, after: ${q(after)}` : ""}) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number title url mergedAt author { login } repository { nameWithOwner } } } } }`);
    const got = Array.isArray(d.shipped?.nodes) ? d.shipped.nodes : [];
    count += got.length;
    out.push(...nodes(d.shipped));
    const all = Number(d.shipped?.issueCount) || 0;
    if (d.shipped?.pageInfo?.hasNextPage !== true || typeof d.shipped.pageInfo.endCursor !== "string") return { nodes: out, more: all > count };
    after = d.shipped.pageInfo.endCursor;
  }
  return { nodes: out, more: true };
}

// repositoryOwner, not organization: an owner may be a user. One alias per owner.
const reposShipped = (ghe: Ghe, owners: string): Promise<Node> =>
  ghe.graphql<Node>(`{
${ownersOf(owners).map((owner, i) => `  shipped${i}: repositoryOwner(login: ${q(owner)}) { repositories(first: ${REPOS}, isArchived: false, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner
    releases(first: ${RELEASES}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName name url publishedAt createdAt isDraft isPrerelease } }
    refs(refPrefix: "refs/tags/", first: ${TAGS}, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name target { ... on Commit { committedDate } ... on Tag { tagger { date } target { ... on Commit { committedDate } } } } } } } } }`).join("\n")}
}`);

/** GitHub's answers, read narrowly: anything missing, odd or outside the owners is left out. */
export function shippedOf(merged: { nodes: Node[]; more?: boolean }, repos: Node, o: { owners: string; since: string; host: string }): ForgeShipped {
  const mine = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo) && owns(o.owners, repo.split("/")[0]!);
  const prs = merged.nodes.flatMap((p) => {
    const repo = str(p.repository?.nameWithOwner);
    const mergedAt = utc(p.mergedAt);
    if (!mine(repo) || !Number.isSafeInteger(p.number) || p.number < 1 || !sinceDay(mergedAt, o.since)) return [];
    return [{ repo, number: p.number as number, title: str(p.title, 300), url: str(p.url, 500), mergedAt, author: str(p.author?.login, 100) }];
  });
  const releases: ForgeShipped["releases"] = [];
  const tags: ForgeShipped["tags"] = [];
  for (const r of Object.values(repos ?? {}).flatMap((owner: any) => nodes(owner?.repositories))) {
    const repo = str(r.nameWithOwner);
    if (!mine(repo)) continue;
    const released = new Set<string>();
    for (const x of nodes(r.releases)) {
      const tag = str(x.tagName);
      if (!tag) continue;
      // A draft's tag isn't a tag yet; any other release speaks for its tag, in the window or not.
      if (x.isDraft) continue;
      released.add(tag);
      const at = utc(x.publishedAt) || utc(x.createdAt);
      if (sinceDay(at, o.since)) releases.push({ repo, tag, name: str(x.name, 300) || tag, url: str(x.url, 500), at, ...(x.isPrerelease ? { pre: true as const } : {}) });
    }
    for (const t of nodes(r.refs)) {
      const tag = str(t.name);
      const at = utc(t.target?.tagger?.date) || utc(t.target?.target?.committedDate) || utc(t.target?.committedDate);
      if (!tag || released.has(tag) || !sinceDay(at, o.since)) continue;
      tags.push({ repo, tag, url: `https://${o.host}/${repo}/releases/tag/${tag.split("/").map(encodeURIComponent).join("/")}`, at });
    }
  }
  return { prs: newest(prs, (p) => p.mergedAt).slice(0, MAX_SHIPPED_PRS), ...(merged.more || prs.length > MAX_SHIPPED_PRS ? { more: true as const } : {}), releases: newest(releases, (r) => r.at), tags: newest(tags, (t) => t.at) };
}
