/**
 * What I did on GitHub (Forge.work, Forge.merged): two search counts (PRs merged, PRs reviewed), the
 * contribution calendar, up to 300 of my commits (repo and time) and the biggest languages of the
 * repos I commit to most. Numbers, times, repo and language names only.
 */
import { ownerQuery } from "../owners.ts";
import type { ForgeWork } from "../forge/types.ts";
import type { Ghe } from "./ghe.ts";

const q = (s: string) => JSON.stringify(s);

async function searchCount(ghe: Ghe, query: string): Promise<number> {
  const d = await ghe.graphql<{ s: { issueCount: number } }>(`{ s: search(type: ISSUE, first: 0, query: ${q(query)}) { issueCount } }`);
  return Number(d.s?.issueCount) || 0;
}

export async function loadWork(ghe: Ghe, login: string, owners: string, since: string): Promise<ForgeWork> {
  const [merged, reviewed] = await Promise.all([
    searchCount(ghe, `${ownerQuery(owners)} is:pr author:${login} is:merged merged:>=${since}`),
    searchCount(ghe, `${ownerQuery(owners)} is:pr reviewed-by:${login} -author:${login} updated:>=${since}`),
  ]);
  const cal = await ghe.graphql<any>(`{ user(login: ${q(login)}) { contributionsCollection { contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`);
  const days = (cal?.user?.contributionsCollection?.contributionCalendar?.weeks ?? []).flatMap((w: any) => (Array.isArray(w?.contributionDays) ? w.contributionDays : [])).filter((d: any) => typeof d?.date === "string").map((d: any) => ({ date: d.date as string, count: Number(d.contributionCount) || 0 }));
  const commits: ForgeWork["commits"] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await ghe.rest<any>(`/search/commits?q=${encodeURIComponent(`author:${login} ${ownerQuery(owners)} committer-date:>=${since}`)}&sort=committer-date&order=desc&per_page=100&page=${page}`);
    const items = Array.isArray(r?.items) ? r.items : [];
    for (const it of items) if (typeof it?.repository?.full_name === "string" && typeof it?.commit?.author?.date === "string") commits.push({ repo: it.repository.full_name, date: it.commit.author.date });
    if (items.length < 100) break;
  }
  const top = [...new Set(commits.map((c) => c.repo))].slice(0, 6).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  const languages: Record<string, string[]> = {};
  if (top.length) {
    const d = await ghe.graphql<any>(`{ ${top.map((r, i) => `r${i}: repository(owner: ${q(r.split("/")[0]!)}, name: ${q(r.split("/")[1]!)}) { languages(first: 3, orderBy: { field: SIZE, direction: DESC }) { nodes { name } } }`).join("\n")} }`);
    top.forEach((r, i) => (languages[r] = (d?.[`r${i}`]?.languages?.nodes ?? []).map((n: any) => n?.name).filter((n: unknown): n is string => typeof n === "string")));
  }
  return { merged, reviewed, days, commits, languages };
}

export const loadMerged = (ghe: Ghe, login: string, owners: string, since: string): Promise<number> => searchCount(ghe, `${ownerQuery(owners)} is:pr author:${login} is:merged merged:>=${since}`);
