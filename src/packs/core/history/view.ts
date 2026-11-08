/**
 * The forge's weeks as /stats panels (PackStat): mine (merged, reviews given, how long PRs wait),
 * the org's (merged PRs, releases, how often main is red), and how old the open PRs are. The tiles
 * stay weekly ("this week", "4 weeks"); the charts go by the range I picked.
 */
import type { PackStat } from "../../types.ts";
import { dtf } from "../../../when.ts";
import { median, type History, weekly } from "./history.ts";
import type { HistoryView } from "./store.ts";

const DAY = 86400e3;
const fmtDay = (key: string, o: Intl.DateTimeFormatOptions) => dtf("en-GB", { timeZone: "UTC", ...o }).format(Date.parse(`${key}T12:00:00Z`));
const dayTip = (key: string) => fmtDay(key, { weekday: "short", day: "numeric", month: "short" });
const weekTip = (key: string, label: string) => `${label} · ${fmtDay(key, { day: "numeric", month: "short" })} – ${fmtDay(new Date(Date.parse(key) + 6 * DAY).toISOString().slice(0, 10), { day: "numeric", month: "short" })}`;

/** What to say while there's nothing to draw: gathering, the forge's error, or press Gather again. */
export function emptyOf(v: HistoryView, forge: string): string {
  if (v.gathering) return `Gathering the weeks from ${forge}. This takes about half a minute; the page fills in by itself.`;
  if (v.historyError) return `${forge} didn't answer: ${v.historyError}`.slice(0, 200);
  return `Nothing from ${forge} yet. Press Gather again; it takes about half a minute.`;
}

export function historyStats(v: HistoryView, o: { now: number; weeks: number; days?: number; forge: string; /** Dovre's PR list answers here (the prs pack is on): a PR opens in its viewer, else on the forge. */ viewer?: boolean }): PackStat[] {
  const { now, days, forge } = o;
  const h = v.history;
  const empty = emptyOf(v, forge);
  if (!h) {
    const tiles: PackStat[] = [
      { id: "merged-week", title: "Merged, this week", value: undefined, empty },
      { id: "reviews-week", title: "Reviews given, this week", value: undefined, empty },
      { id: "review-wait", title: "Wait for a first review", unit: "hours", value: undefined, empty },
      { id: "main-red", title: "Main red", unit: "percent", value: undefined, empty },
    ];
    const panels: PackStat[] = ["you-weekly", "org-merged", "releases", "main-red-weekly", "waits"].map((id) => ({ id, title: TITLES[id]!, labels: [], series: [], empty }));
    return [...tiles, ...panels, { id: "open-age", title: "Open PRs by age", bars: [], empty }];
  }
  // A longer range than the kept history reaches says so until the gather brings it.
  const short = days ? ((h.days ?? 0) < days ? "; by day once the gather ends" : "") : (h.weeks ?? 12) < o.weeks ? `; ${h.weeks ?? 12} weeks until the gather for ${o.weeks} ends` : "";
  const failed = (v.historyError ? "; the last gather failed" : v.gathering ? "; gathering again" : "") + short;
  const w = weekly(h, now);
  const n = w.weeks.length;
  const c = days ? weekly(h, now, days) : w;
  const k = days ? c.weeks.length : Math.max(1, Math.min(o.weeks, n));
  const last = <T,>(a: T[]) => a.slice(-k);
  const tips = last(c.weeks.map((x) => (days ? dayTip(x.key) : weekTip(x.key, x.label))));
  const labels = last(c.weeks.map((x) => (days ? fmtDay(x.key, { day: "numeric", month: "short" }) : x.label)));
  const per = days ? "day" : "week";
  const last4 = h.mine.filter((p) => p.mergedAt && now - Date.parse(p.mergedAt) < 28 * DAY);
  const toReview = median(last4.filter((p) => p.firstReviewAt).map((p) => (Date.parse(p.firstReviewAt!) - Date.parse(p.readyAt ?? p.createdAt)) / 3600e3));
  const red4 = w.red.slice(-4).filter((r) => r);
  const redPct = red4.length ? (red4.reduce((a, r) => a + r!.bad, 0) / red4.reduce((a, r) => a + r!.of, 0)) * 100 : undefined;
  const waits = last(c.waits);
  return [
    { id: "merged-week", title: "Merged, this week", value: w.mergedMine[n - 1], note: `${w.mergedMine[n - 2]} in ${w.weeks[n - 2]!.label}`, trend: w.mergedMine },
    { id: "reviews-week", title: "Reviews given, this week", value: w.reviewsGiven[n - 1], note: `${w.reviewsGiven[n - 2]} in ${w.weeks[n - 2]!.label}`, trend: w.reviewsGiven },
    { id: "review-wait", title: "Wait for a first review", unit: "hours", value: toReview, note: "median, your PRs merged in 4 weeks", empty: "None of your PRs merged in 4 weeks had a review." },
    { id: "main-red", title: "Main red", unit: "percent", value: redPct, note: "of commits on main, 4 weeks", trend: w.red.map((r) => r?.pct), empty: "No commits on main with checks in 4 weeks." },
    { id: "you-weekly", title: `You, per ${per}`, meta: `from ${forge}${failed}`, labels, tips, partialLast: true, series: [{ name: "Merged", values: last(c.mergedMine) }, { name: "Reviews given", values: last(c.reviewsGiven) }] },
    { id: "org-merged", title: `The org, merged PRs per ${per}`, meta: `from ${forge}${failed}`, labels, tips, partialLast: true, series: [{ name: "Merged", values: last(c.orgMerged) }] },
    { id: "releases", title: `The org, releases per ${per}`, meta: `top ${h.repos} repos`, labels, tips, partialLast: true, series: [{ name: "Releases", values: last(c.releases) }] },
    { id: "main-red-weekly", title: `Main red, per ${per}`, meta: "commits whose checks failed", chart: "lines", unit: "percent", labels, tips, series: [{ name: "Red", values: last(c.red.map((r) => r?.pct)) }] },
    { id: "waits", title: "Your PRs, waiting", meta: `median, by ${per} merged`, chart: "lines", unit: "hours", labels, tips, series: [{ name: "To first review", values: waits.map((x) => x.review) }, { name: "To merge", values: waits.map((x) => x.merge) }] },
    openAge(h, now, o.viewer ?? true),
  ];
}

const TITLES: Record<string, string> = { "you-weekly": "You, per week", "org-merged": "The org, merged PRs per week", releases: "The org, releases per week", "main-red-weekly": "Main red, per week", waits: "Your PRs, waiting" };

function openAge(h: History, now: number, viewer: boolean): PackStat {
  const ages = h.open
    .map((p) => ({ p, days: (now - Date.parse(p.createdAt)) / DAY }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 20);
  return {
    id: "open-age",
    title: "Open PRs by age",
    meta: `${h.open.filter((p) => p.mine).length} yours · ${h.open.filter((p) => !p.mine).length} asking you`,
    unit: "days",
    empty: "No open PRs of yours or asking you.",
    bars: ages.map(({ p, days }) => ({
      label: `${p.repo.split("/")[1]}#${p.number}`,
      sub: p.title,
      href: viewer ? `/prs/${p.repo}/${p.number}` : p.url,
      value: days,
      warn: days >= 14,
      note: [p.mine ? "" : "asks you", p.draft ? "draft" : "", days >= 14 ? "over 2 weeks" : ""].filter(Boolean).join(" · ") || undefined,
    })),
  };
}
