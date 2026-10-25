/**
 * Stats: the last twelve weeks in numbers and charts. Mine (merged, reviews given, how long PRs
 * wait), the org's (merged PRs, releases, how often main is red), agent spend per day from this
 * machine's transcripts, and how old the open PRs are. Drawn from what src/stats/stats.ts has
 * kept; the page fills in by itself when a gather ends.
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type History, median, weekly } from "../stats/history.ts";
import type { StatsView } from "../stats/stats.ts";
import type { SpendDay } from "../stats/spend.ts";
import { columns, compact, hbars, lines, sparkline } from "../ui/chart.ts";
import { type Child, Empty, Notice, PageHeader, Panel } from "../ui/kit.ts";
import { Ago, safeUrl } from "./parts.ts";

const DAY = 86400e3;
const money = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
const moneyAxis = (n: number) => `$${compact(n)}`;
const hrs = (h: number) => (h < 1 ? "<1 h" : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);
const pct = (n: number) => `${Math.round(n)}%`;
/** Hours on an axis: steps of whole days past two days, of hours below. */
function hourAxis(values: number[]) {
  const max = Math.max(...values, 1);
  const step = max > 48 ? 24 * Math.ceil(max / 24 / 4) : max > 12 ? 12 : max > 4 ? 4 : 1;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return { ticks, axisFmt: (h: number) => (h === 0 ? "0" : h % 24 === 0 ? `${h / 24} d` : `${h} h`) };
}
const fmtDay = (key: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(Date.parse(`${key}T12:00:00Z`));
const weekTip = (key: string, label: string) => `${label} · ${fmtDay(key, { day: "numeric", month: "short" })} – ${fmtDay(new Date(Date.parse(key) + 6 * DAY).toISOString().slice(0, 10), { day: "numeric", month: "short" })}`;

/** A headline number: what it is, the value, what to hold it against, a trend. */
function tile(label: string, value: string, note: Child, trend?: (number | undefined)[]) {
  return html`<div class="kpi"><p class="kpi-l">${label}</p><p class="kpi-v">${value}</p><p class="kpi-n">${note}</p>${trend ? sparkline(trend) : ""}</div>`;
}

function spendTiles(spend?: SpendDay[]) {
  if (!spend?.length) return tile("Agent spend, 7 days", "–", "Reading transcripts…");
  const total = (d: SpendDay) => d.claude + d.omp;
  const last7 = spend.slice(-7).reduce((a, d) => a + total(d), 0);
  const prev7 = spend.slice(-14, -7).reduce((a, d) => a + total(d), 0);
  return tile("Agent spend, 7 days", money(last7), `${money(prev7)} the 7 days before`, spend.slice(-30).map(total));
}

function body(v: StatsView, now: number, open: History["open"]) {
  const h = v.history;
  const kpis: Child[] = [];
  const charts: Child[] = [];
  if (h) {
    const w = weekly(h, now);
    const n = w.weeks.length;
    const tips = w.weeks.map((x) => weekTip(x.key, x.label));
    const labels = w.weeks.map((x) => x.label);
    const last4 = h.mine.filter((p) => p.mergedAt && now - Date.parse(p.mergedAt) < 28 * DAY);
    const toReview = median(last4.filter((p) => p.firstReviewAt).map((p) => (Date.parse(p.firstReviewAt!) - Date.parse(p.readyAt ?? p.createdAt)) / 3600e3));
    const red4 = w.red.slice(-4).filter((r) => r);
    const redPct = red4.length ? (red4.reduce((a, r) => a + r!.bad, 0) / red4.reduce((a, r) => a + r!.of, 0)) * 100 : undefined;
    kpis.push(
      tile("Merged, this week", String(w.mergedMine[n - 1]), `${w.mergedMine[n - 2]} in ${w.weeks[n - 2]!.label}`, w.mergedMine),
      tile("Reviews given, this week", String(w.reviewsGiven[n - 1]), `${w.reviewsGiven[n - 2]} in ${w.weeks[n - 2]!.label}`, w.reviewsGiven),
      spendTiles(v.spend),
      tile("Wait for a first review", toReview === undefined ? "–" : hrs(toReview), "median, your PRs merged in 4 weeks"),
      tile("Main red", redPct === undefined ? "–" : pct(redPct), "of commits on main, 4 weeks", w.red.map((r) => r?.pct)),
    );
    charts.push(
      Panel({ title: "You, per week", children: columns({ title: "Your merged PRs and reviews given per week", labels, tips, fmt: compact, partialLast: true, series: [{ name: "Merged", tone: "c1", values: w.mergedMine }, { name: "Reviews given", tone: "c2", values: w.reviewsGiven }] }) }),
      spendPanel(v.spend),
      Panel({ title: "The org, merged PRs per week", children: columns({ title: "Merged pull requests in the org per week", labels, tips, fmt: compact, partialLast: true, series: [{ name: "Merged", tone: "c1", values: w.orgMerged }] }) }),
      Panel({ title: "The org, releases per week", meta: `${h.repos} most active repos`, children: columns({ title: "Releases per week", labels, tips, fmt: compact, partialLast: true, series: [{ name: "Releases", tone: "c1", values: w.releases }] }) }),
      Panel({ title: "Main red, per week", meta: "commits whose checks failed", children: lines({ title: "Share of commits on main with failing checks, per week", labels, tips, fmt: pct, yMax: 100, series: [{ name: "Red", tone: "c1", values: w.red.map((r) => r?.pct) }] }) }),
      Panel({ title: "Your PRs, waiting", meta: "median, by week merged", children: lines({ title: "Median hours from ready to first review and to merge", labels, tips, fmt: hrs, ...hourAxis(w.waits.flatMap((x) => [x.review ?? 0, x.merge ?? 0])), series: [{ name: "To first review", tone: "c1", values: w.waits.map((x) => x.review) }, { name: "To merge", tone: "c2", values: w.waits.map((x) => x.merge) }] }) }),
    );
  } else if (!v.spend) kpis.push(spendTiles(v.spend));
  const ages = open
    .map((p) => ({ p, days: (now - Date.parse(p.createdAt)) / DAY }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 20);
  const agePanel = ages.length
    ? Panel({
        title: "Open PRs by age",
        meta: `${open.filter((p) => p.mine).length} yours · ${open.filter((p) => !p.mine).length} asking you`,
        children: hbars(
          ages.map(({ p, days }) => ({
            label: html`<a href="${safeUrl(`/prs/${p.repo}/${p.number}`)}">${p.repo.split("/")[1]}#${p.number}</a> <span class="t2">${p.title}</span>`,
            value: days,
            tone: days >= 14 ? "warn" : "c1",
            note: [p.mine ? "" : "asks you", p.draft ? "draft" : "", days >= 14 ? "over 2 weeks" : ""].filter(Boolean).join(" · ") || undefined,
          })),
          (d) => (d < 1 ? "<1 d" : `${Math.round(d)} d`),
        ),
      })
    : "";
  return html`${v.historyError ? Notice({ tone: "bad", children: html`<strong>GHE didn't answer.</strong> ${v.historyError}${h ? html` <span class="t2">Showing what was gathered ${Ago(h.at)}.</span>` : ""}` }) : ""}
${!h && v.gathering ? Notice({ children: "Gathering twelve weeks from GHE. This takes about half a minute; the page fills in by itself." }) : ""}
${kpis.length ? html`<div class="kpis">${kpis}</div>` : ""}
<div class="stats-grid">${charts}${agePanel}</div>
${!h && !v.gathering && !v.historyError ? Empty({ title: "Nothing gathered yet" }) : ""}`;
}

function spendPanel(spend?: SpendDay[]) {
  if (!spend?.length) return Panel({ title: "Agent spend per day", children: Empty({ title: "Reading transcripts…" }) });
  const days = spend.slice(-30);
  return Panel({
    title: "Agent spend per day",
    meta: "omp at list price",
    children: columns({
      title: "Agent spend per day, Claude Code and omp",
      labels: days.map((d) => fmtDay(d.day, { day: "numeric", month: "short" })),
      tips: days.map((d) => `${fmtDay(d.day, { weekday: "short", day: "numeric", month: "short" })} · ${d.sessions} ${d.sessions === 1 ? "session" : "sessions"}`),
      fmt: money,
      axisFmt: moneyAxis,
      every: 7,
      stacked: true,
      partialLast: true,
      series: [{ name: "Claude Code", tone: "c1", values: days.map((d) => d.claude) }, { name: "omp", tone: "c2", values: days.map((d) => d.omp) }],
    }),
  });
}

export function statsPage(frame: Frame, v: StatsView, o: { now?: number } = {}) {
  const now = o.now ?? Date.now();
  const h = v.history;
  const sub = h ? html`Last 12 weeks. From GHE ${Ago(h.at)}${v.gathering ? " · gathering again" : ""}; spend from this machine's transcripts.` : "Last 12 weeks.";
  const refresh = html`<form method="post" action="/stats/refresh"><button type="submit" class="ghost" data-busy="Gathering"${v.gathering ? html` disabled` : ""}>Gather again</button></form>`;
  return shell({
    title: "Stats · Dovre",
    frame,
    current: "/stats",
    body: html`${PageHeader({ title: "Stats", sub, actions: refresh })}<div data-live id="stats">${body(v, now, h?.open ?? [])}</div>`,
    head: html`<meta name="u-topics" content="stats">`,
  });
}
