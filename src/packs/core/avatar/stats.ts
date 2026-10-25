/**
 * The numbers an avatar is shaped by, from GHE, for one person over the last 12 weeks:
 * - PRs merged and PRs reviewed: two search counts.
 * - the commit streak: the contribution calendar (days in a row with a contribution, up to today
 *   or yesterday; weekends neither count nor break it).
 * - late commits and active repos: the commit search (up to 300 of mine, with their time and offset).
 * - languages: the biggest languages of the repos I commit to most.
 * And, every ten minutes, how many of my PRs merged in the last 24 hours (the party scene).
 * Gathered in the background, kept (the settings table, "avatar-stats") so a restart draws at once.
 * Numbers, times, repo and language names only.
 */
import type { D1 } from "../../../db.ts";
import { ownerQuery } from "../../../owners.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { type AvatarStats, statsOf } from "./model.ts";

const DAY = 86400e3;
const q = (s: string) => JSON.stringify(s);

export type Calendar = { date: string; count: number }[];

/** Days in a row with a contribution, back from today (or yesterday, when today has none yet). Weekends are skipped. */
export function streakOf(days: Calendar, today: string): number {
  const by = new Map(days.map((d) => [d.date, d.count]));
  const d = new Date(`${today}T12:00:00Z`);
  let n = 0;
  let first = true;
  for (let i = 0; i < 400; i++) {
    const key = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    const c = by.get(key);
    d.setUTCDate(d.getUTCDate() - 1);
    if (wd === 0 || wd === 6) {
      if (c) n++;
      continue;
    }
    if (c === undefined) break;
    if (c > 0) n++;
    else if (first) {
      first = false;
      continue;
    } else break;
    first = false;
  }
  return n;
}

/** The share of commits made from 20:00 to 06:00 in their own time zone, in percent. */
export function nightShareOf(dates: string[]): number {
  const hours = dates.map((s) => /T(\d{2}):/.exec(s)?.[1]).filter((h): h is string => !!h).map(Number);
  if (!hours.length) return 0;
  return Math.round((hours.filter((h) => h >= 20 || h < 6).length / hours.length) * 100);
}

export type AvatarFacts = { stats: AvatarStats; mergedToday: number; at: number; mergesAt: number; login: string };

/** GHE's answers → the numbers (pure). */
export function statsFrom(o: { prs: number; reviews: number; calendar: Calendar; commits: { repo: string; date: string }[]; languages: Map<string, string[]>; today: string }): AvatarStats {
  const byRepo = new Map<string, number>();
  for (const c of o.commits) byRepo.set(c.repo, (byRepo.get(c.repo) ?? 0) + 1);
  const ranked = [...byRepo].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const langs: string[] = [];
  for (const r of ranked) for (const l of o.languages.get(r) ?? []) if (!langs.includes(l) && langs.length < 4) langs.push(l);
  return statsOf({ prs: o.prs, reviews: o.reviews, repos: byRepo.size, streak: streakOf(o.calendar, o.today), night: nightShareOf(o.commits.map((c) => c.date)), langs });
}

async function searchCount(ghe: Ghe, query: string): Promise<number> {
  const d = await ghe.graphql<{ s: { issueCount: number } }>(`{ s: search(type: ISSUE, first: 0, query: ${q(query)}) { issueCount } }`);
  return Number(d.s?.issueCount) || 0;
}

export async function gatherAvatarStats(ghe: Ghe, org: string, login: string, now: number): Promise<AvatarStats> {
  const since = new Date(now - 84 * DAY).toISOString().slice(0, 10);
  const [prs, reviews] = await Promise.all([
    searchCount(ghe, `${ownerQuery(org)} is:pr author:${login} is:merged merged:>=${since}`),
    searchCount(ghe, `${ownerQuery(org)} is:pr reviewed-by:${login} -author:${login} updated:>=${since}`),
  ]);
  const cal = await ghe.graphql<any>(`{ user(login: ${q(login)}) { contributionsCollection { contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`);
  const calendar: Calendar = (cal?.user?.contributionsCollection?.contributionCalendar?.weeks ?? []).flatMap((w: any) => (Array.isArray(w?.contributionDays) ? w.contributionDays : [])).filter((d: any) => typeof d?.date === "string").map((d: any) => ({ date: d.date, count: Number(d.contributionCount) || 0 }));
  const commits: { repo: string; date: string }[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await ghe.rest<any>(`/search/commits?q=${encodeURIComponent(`author:${login} ${ownerQuery(org)} committer-date:>=${since}`)}&sort=committer-date&order=desc&per_page=100&page=${page}`);
    const items = Array.isArray(r?.items) ? r.items : [];
    for (const it of items) if (typeof it?.repository?.full_name === "string" && typeof it?.commit?.author?.date === "string") commits.push({ repo: it.repository.full_name, date: it.commit.author.date });
    if (items.length < 100) break;
  }
  const top = [...new Set(commits.map((c) => c.repo))].slice(0, 6).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  const languages = new Map<string, string[]>();
  if (top.length) {
    const d = await ghe.graphql<any>(`{ ${top.map((r, i) => `r${i}: repository(owner: ${q(r.split("/")[0]!)}, name: ${q(r.split("/")[1]!)}) { languages(first: 3, orderBy: { field: SIZE, direction: DESC }) { nodes { name } } }`).join("\n")} }`);
    top.forEach((r, i) => languages.set(r, (d?.[`r${i}`]?.languages?.nodes ?? []).map((n: any) => n?.name).filter((n: unknown): n is string => typeof n === "string")));
  }
  return statsFrom({ prs, reviews, calendar, commits, languages, today: new Date(now).toISOString().slice(0, 10) });
}

/** How many of my PRs merged in the last 24 hours. */
export function gatherMerges(ghe: Ghe, org: string, login: string, now: number): Promise<number> {
  return searchCount(ghe, `${ownerQuery(org)} is:pr author:${login} is:merged merged:>=${new Date(now - DAY).toISOString().slice(0, 19)}Z`);
}

export type AvatarData = {
  facts(): AvatarFacts | undefined;
  /** Reads what was kept. */
  load(db: D1): Promise<void>;
  /** Gathers what's due (or all of it), and keeps it; resolves when done, never rejects. */
  refresh(db: D1, force?: boolean): Promise<void>;
};

const EVERY = 6 * 3600e3;
const MERGES_EVERY = 10 * 60e3;
const KEY = "avatar-stats";

export function createAvatarData(o: { ghe: Ghe; org: string; login: () => string | undefined; now?: () => number; onChange?: () => void; gather?: typeof gatherAvatarStats; merges?: typeof gatherMerges; log?: (line: string) => void }): AvatarData {
  const now = o.now ?? Date.now;
  let facts: AvatarFacts | undefined;
  let running: Promise<void> | undefined;
  return {
    facts: () => facts,
    async load(db) {
      try {
        const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>();
        const v = row?.value ? JSON.parse(row.value) : undefined;
        if (v && typeof v.at === "number" && typeof v.login === "string") facts = { stats: statsOf(v.stats), mergedToday: Math.max(0, Number(v.mergedToday) || 0), at: v.at, mergesAt: Number(v.mergesAt) || 0, login: v.login };
      } catch {}
    },
    refresh(db, force = false) {
      const login = o.login();
      if (!login) return Promise.resolve();
      if (running) return running;
      const t = now();
      const stale = force || !facts || facts.login !== login || t - facts.at > EVERY;
      const mergesDue = stale || t - (facts?.mergesAt ?? 0) > MERGES_EVERY;
      if (!stale && !mergesDue) return Promise.resolve();
      running = (async () => {
        const stats = stale ? await (o.gather ?? gatherAvatarStats)(o.ghe, o.org, login, t) : facts!.stats;
        const mergedToday = await (o.merges ?? gatherMerges)(o.ghe, o.org, login, t);
        facts = { stats, mergedToday, at: stale ? t : facts!.at, mergesAt: t, login };
        await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(KEY, JSON.stringify(facts), new Date(t).toISOString()).run();
      })()
        .catch((e) => o.log?.(`avatar: couldn't gather (${String((e as Error)?.message ?? e).slice(0, 200)})`))
        .finally(() => {
          running = undefined;
          o.onChange?.();
        });
      return running;
    },
  };
}
