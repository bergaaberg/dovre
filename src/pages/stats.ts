/**
 * Stats: the last weeks (4, 12 or 26) in numbers and charts. Mine (merged, reviews given, how long PRs
 * wait), the org's (merged PRs, releases, how often main is red), agent spend per day from this
 * machine's transcripts, and how old the open PRs are. Drawn from what src/stats/stats.ts has
 * kept; the page fills in by itself when a gather ends.
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type History, median, WEEKS, weekly } from "../stats/history.ts";
import { type Layout, placeStats } from "../layout.ts";
import type { StatOut } from "../packs/registry.ts";
import type { StatUnit } from "../packs/types.ts";
import type { StatsView } from "../stats/stats.ts";
import type { SpendDay } from "../stats/spend.ts";
import { columns, compact, hbars, lines, sparkline } from "../ui/chart.ts";
import { type Child, Empty, Notice, PageHeader, Panel } from "../ui/kit.ts";
import { type ForgeView, GITHUB_VIEW } from "../forge/types.ts";
import { Ago, safeUrl } from "./parts.ts";
import { dtf } from "../when.ts";

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
const fmtDay = (key: string, o: Intl.DateTimeFormatOptions) => dtf("en-GB", { timeZone: "UTC", ...o }).format(Date.parse(`${key}T12:00:00Z`));
const dayTip = (key: string) => fmtDay(key, { weekday: "short", day: "numeric", month: "short" });
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

/**
 * One thing /stats can show: a headline number (`tile`) or a panel. Core offers the forge's
 * panels and agent spend; each pack's come from `Pack.stats`. Settings → Layout shows,
 * hides and orders them by `id`; `draw` gives "" when there's nothing to draw yet.
 */
export type StatOffer = { id: string; label: string; from: string; tile?: boolean; draw: () => Child };

const UNIT_FMT: Record<StatUnit, (n: number) => string> = { count: compact, money, hours: hrs, days: (d) => (d < 1 ? "<1 d" : `${Math.round(d)} d`), percent: pct };

function packOffer(st: StatOut): StatOffer {
  const fmt = UNIT_FMT[st.unit];
  const label = `${st.title} (${st.packName})`;
  if (st.kind === "tile")
    return { id: st.id, label, from: st.packName, tile: true, draw: () => tile(st.title, st.value === undefined ? "–" : fmt(st.value), st.value === undefined ? (st.empty ?? `Nothing from ${st.packName} yet.`) : (st.note ?? ""), st.trend) };
  const blank = !st.labels.length || st.series.every((x) => x.values.every((v) => v === undefined));
  return {
    id: st.id,
    label,
    from: st.packName,
    draw: () =>
      Panel({
        title: st.title,
        meta: st.meta ?? st.packName,
        children: blank
          ? Empty({ title: st.empty ?? `Nothing from ${st.packName} yet.` })
          : (st.chart === "lines" ? lines : columns)({
              title: st.title,
              labels: st.labels,
              tips: st.tips,
              fmt,
              every: st.labels.length > 16 ? 7 : 1,
              ...(st.chart === "lines" && st.unit === "percent" ? { yMax: 100 } : {}),
              ...(st.chart !== "lines" && st.stacked ? { stacked: true } : {}),
              series: st.series.map((x, i) => ({ name: x.name, tone: i ? "c2" : "c1", values: x.values })),
            }),
      }),
  };
}

/** Everything /stats can show here, in the code's order: the forge's (when it gathers stats), agent spend (when it's read here), then the packs'. */
export function statOffers(v: StatsView, o: { now: number; forge?: ForgeView; weeks?: number; /** By day over this many days, instead of weeks. */ days?: number; packs?: StatOut[]; github?: boolean }): StatOffer[] {
  const { now } = o;
  const forge = o.forge ?? GITHUB_VIEW;
  const h = v.history;
  const out: StatOffer[] = [];
  const github = o.github !== false;
  const spends = v.spends !== false;
  if (github) {
    // The tiles stay weekly ("this week", "4 weeks"); the charts go by the range I picked.
    const w = h ? weekly(h, now) : undefined;
    const n = w?.weeks.length ?? 0;
    const days = o.days;
    const c = h && days ? weekly(h, now, days) : w;
    const k = days ? (c?.weeks.length ?? 0) : Math.max(1, Math.min(o.weeks ?? WEEKS, n));
    const last = <T,>(a: T[]) => a.slice(-k);
    const tips = c ? last(c.weeks.map((x) => (days ? dayTip(x.key) : weekTip(x.key, x.label)))) : [];
    const labels = c ? last(c.weeks.map((x) => (days ? fmtDay(x.key, { day: "numeric", month: "short" }) : x.label))) : [];
    const every = days ? (k > 16 ? 7 : 2) : k > 16 ? 2 : 1;
    const per = days ? "day" : "week";
    const from = forge.name;
    const gh = (id: string, label: string, draw: (h: History, w: ReturnType<typeof weekly>, c: ReturnType<typeof weekly>) => Child, tileToo = false): StatOffer => ({ id, label, from, tile: tileToo, draw: () => (h && w && c ? draw(h, w, c) : "") });
    out.push(
      gh("merged-week", "Merged, this week", (_, w) => tile("Merged, this week", String(w.mergedMine[n - 1]), `${w.mergedMine[n - 2]} in ${w.weeks[n - 2]!.label}`, w.mergedMine), true),
      gh("reviews-week", "Reviews given, this week", (_, w) => tile("Reviews given, this week", String(w.reviewsGiven[n - 1]), `${w.reviewsGiven[n - 2]} in ${w.weeks[n - 2]!.label}`, w.reviewsGiven), true),
    );
    if (spends) out.push({ id: "spend-7d", label: "Agent spend, 7 days", from: "Agents", tile: true, draw: () => spendTiles(v.spend) });
    out.push(
      gh("review-wait", "Wait for a first review", (h) => {
        const last4 = h.mine.filter((p) => p.mergedAt && now - Date.parse(p.mergedAt) < 28 * DAY);
        const toReview = median(last4.filter((p) => p.firstReviewAt).map((p) => (Date.parse(p.firstReviewAt!) - Date.parse(p.readyAt ?? p.createdAt)) / 3600e3));
        return tile("Wait for a first review", toReview === undefined ? "–" : hrs(toReview), "median, your PRs merged in 4 weeks");
      }, true),
      gh("main-red", "Main red", (_, w) => {
        const red4 = w.red.slice(-4).filter((r) => r);
        const redPct = red4.length ? (red4.reduce((a, r) => a + r!.bad, 0) / red4.reduce((a, r) => a + r!.of, 0)) * 100 : undefined;
        return tile("Main red", redPct === undefined ? "–" : pct(redPct), "of commits on main, 4 weeks", w.red.map((r) => r?.pct));
      }, true),
      gh("you-weekly", "You, per week", (_, _w, c) => Panel({ title: `You, per ${per}`, children: columns({ title: `Your merged PRs and reviews given per ${per}`, labels, tips, every, fmt: compact, partialLast: true, series: [{ name: "Merged", tone: "c1", values: last(c.mergedMine) }, { name: "Reviews given", tone: "c2", values: last(c.reviewsGiven) }] }) })),
    );
    if (spends) out.push({ id: "spend-daily", label: "Agent spend per day", from: "Agents", draw: () => spendPanel(v.spend) });
    out.push(
      gh("org-merged", "The org, merged PRs per week", (_, _w, c) => Panel({ title: `The org, merged PRs per ${per}`, children: columns({ title: `Merged pull requests in the org per ${per}`, labels, tips, every, fmt: compact, partialLast: true, series: [{ name: "Merged", tone: "c1", values: last(c.orgMerged) }] }) })),
      gh("releases", "The org, releases per week", (h, _w, c) => Panel({ title: `The org, releases per ${per}`, meta: `${h.repos} most active repos`, children: columns({ title: `Releases per ${per}`, labels, tips, every, fmt: compact, partialLast: true, series: [{ name: "Releases", tone: "c1", values: last(c.releases) }] }) })),
      gh("main-red-weekly", "Main red, per week", (_, _w, c) => Panel({ title: `Main red, per ${per}`, meta: "commits whose checks failed", children: lines({ title: `Share of commits on main with failing checks, per ${per}`, labels, tips, every, fmt: pct, yMax: 100, series: [{ name: "Red", tone: "c1", values: last(c.red.map((r) => r?.pct)) }] }) })),
      gh("waits", "Your PRs, waiting", (_, _w, c) => {
        const waits = last(c.waits);
        return Panel({ title: "Your PRs, waiting", meta: `median, by ${per} merged`, children: lines({ title: "Median hours from ready to first review and to merge", labels, tips, every, fmt: hrs, ...hourAxis(waits.flatMap((x) => [x.review ?? 0, x.merge ?? 0])), series: [{ name: "To first review", tone: "c1", values: waits.map((x) => x.review) }, { name: "To merge", tone: "c2", values: waits.map((x) => x.merge) }] }) });
      }),
      gh("open-age", "Open PRs by age", (h) => agePanel(h.open, now)),
    );
  } else if (spends) {
    out.push({ id: "spend-7d", label: "Agent spend, 7 days", from: "Agents", tile: true, draw: () => spendTiles(v.spend) }, { id: "spend-daily", label: "Agent spend per day", from: "Agents", draw: () => spendPanel(v.spend) });
  }
  return out.concat((o.packs ?? []).map(packOffer));
}

function agePanel(open: History["open"], now: number): Child {
  const ages = open
    .map((p) => ({ p, days: (now - Date.parse(p.createdAt)) / DAY }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 20);
  return ages.length
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
}

function body(v: StatsView, offers: StatOffer[], placed: StatOffer[], forge: ForgeView, github: boolean) {
  const h = v.history;
  const drawn = placed.map((o) => ({ o, out: o.draw() })).filter(({ out }) => out !== "");
  const kpis = drawn.filter(({ o }) => o.tile).map(({ out }) => out);
  const charts = drawn.filter(({ o }) => !o.tile).map(({ out }) => out);
  const quiet = github && !h && !v.gathering && !v.historyError;
  return html`${github && v.historyError ? Notice({ tone: "bad", children: html`<strong>${forge.name} didn't answer.</strong> ${v.historyError}${h ? html` <span class="t2">Showing what was gathered ${Ago(h.at)}.</span>` : ""}` }) : ""}
${github && !h && v.gathering ? Notice({ children: `Gathering the weeks from ${forge.name}. This takes about half a minute; the page fills in by itself.` }) : ""}
${kpis.length ? html`<div class="kpis">${kpis}</div>` : ""}
${charts.length ? html`<div class="stats-grid">${charts}</div>` : ""}
${quiet ? Empty({ title: `Nothing from ${forge.name} yet`, children: html`Press <strong>Gather again</strong>; it takes about half a minute.` }) : ""}
${!offers.length ? Empty({ title: "Nothing to show here yet", children: html`Stats come from your forge (GitHub) and from packs that keep numbers. <a href="/packs">Packs</a> lists what's on.` }) : offers.length && !placed.length ? Empty({ title: "Every panel is hidden", children: html`Choose what Stats shows on <a href="/settings/layout#stats">Settings → Layout</a>.` }) : ""}`;
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

export function statsPage(frame: Frame, v: StatsView, o: { now?: number; forge?: ForgeView; /** Packs' panels (statsFrom). */ packs?: StatOut[]; /** Settings → Layout's choices. */ layout?: Pick<Layout, "stats" | "statsWeeks" | "statsDays">; /** The forge gathers stats (default yes). */ github?: boolean } = {}) {
  const now = o.now ?? Date.now();
  const forge = o.forge ?? GITHUB_VIEW;
  const github = o.github !== false;
  const weeks = o.layout?.statsWeeks ?? WEEKS;
  const days = o.layout?.statsDays;
  const h = v.history;
  const offers = statOffers(v, { now, forge, weeks, days, packs: o.packs, github });
  const placed = placeStats(offers, o.layout?.stats);
  const range = days ? `Last ${days} days` : `Last ${weeks} weeks`;
  // A longer range than the kept history reaches says so until the gather brings it.
  const reach = !github || !h ? "" : days ? ((h.days ?? 0) < days ? " (the org's merged PRs by day come with the gather)" : "") : (h.weeks ?? WEEKS) < weeks ? ` (${h.weeks ?? WEEKS} until the gather for ${weeks} ends)` : "";
  const sub = github && h ? html`${range}${reach}. From ${forge.name} ${Ago(h.at)}${v.gathering ? " · gathering again" : ""}${v.spends !== false ? "; spend from this machine's transcripts" : ""}. <a href="/settings/layout#stats">Choose what's here</a>.` : html`${range}. <a href="/settings/layout#stats">Choose what's here</a>.`;
  const refresh = github ? html`<form method="post" action="/stats/refresh"><button type="submit" class="ghost" data-busy="Gathering"${v.gathering ? html` disabled` : ""}>Gather again</button></form>` : "";
  return shell({
    title: "Stats · Dovre",
    frame,
    current: "/stats",
    body: html`${PageHeader({ title: "Stats", sub, actions: refresh })}<div data-live id="stats">${body(v, offers, placed, forge, github)}</div>`,
    head: html`<meta name="u-topics" content="stats">`,
  });
}
