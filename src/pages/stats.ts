/**
 * Stats: the packs' numbers and charts over the range I picked (4, 12 or 26 weeks, or 14 or 28
 * days), as Settings → Layout places them. Core draws; what's drawn is each pack's `stats`
 * (PackStat, checked in statsFrom): the forge's weeks are the history pack's, agent spend the
 * agents pack's. The page fills in by itself when a pack publishes "stats".
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type Layout, placeStats } from "../layout.ts";
import type { StatOut } from "../packs/registry.ts";
import type { StatUnit } from "../packs/types.ts";
import { columns, compact, hbars, lines } from "../ui/chart.ts";
import { type Child, Empty, PageHeader, Panel } from "../ui/kit.ts";
import { sparkline } from "../ui/chart.ts";
import { safeUrl } from "./parts.ts";

/** How far back the weekly charts reach unless Settings says otherwise. */
export const WEEKS = 12;

const money = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
const hrs = (h: number) => (h < 1 ? "<1 h" : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`);
const pct = (n: number) => `${Math.round(n)}%`;
const UNIT_FMT: Record<StatUnit, (n: number) => string> = { count: compact, money, hours: hrs, days: (d) => (d < 1 ? "<1 d" : `${Math.round(d)} d`), percent: pct };

/** Hours on an axis: steps of whole days past two days, of hours below. */
function hourAxis(values: number[]) {
  const max = Math.max(...values, 1);
  const step = max > 48 ? 24 * Math.ceil(max / 24 / 4) : max > 12 ? 12 : max > 4 ? 4 : 1;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return { ticks, axisFmt: (h: number) => (h === 0 ? "0" : h % 24 === 0 ? `${h / 24} d` : `${h} h`) };
}
/** The axis's numbers for a unit, where they read better shorter or rounder. */
function axisOf(unit: StatUnit, values: (number | undefined)[]) {
  if (unit === "money") return { axisFmt: (n: number) => `$${compact(n)}` };
  if (unit === "hours") return hourAxis(values.filter((v): v is number => v !== undefined));
  return {};
}

/** A headline number: what it is, the value, what to hold it against, a trend. */
function tile(label: string, value: string, note: Child, trend?: (number | undefined)[]) {
  return html`<div class="kpi"><p class="kpi-l">${label}</p><p class="kpi-v">${value}</p><p class="kpi-n">${note}</p>${trend ? sparkline(trend) : ""}</div>`;
}

/**
 * One thing /stats can show: a headline number (`tile`) or a panel, from a pack's `stats`.
 * Settings → Layout shows, hides and orders them by `id` (`<pack>:<id>`).
 */
type StatOffer = { id: string; label: string; from: string; tile?: boolean; draw: () => Child };

function packOffer(st: StatOut): StatOffer {
  const fmt = UNIT_FMT[st.unit];
  const label = `${st.title} (${st.packName})`;
  const empty = () => Empty({ title: st.empty ?? `Nothing from ${st.packName} yet.` });
  if (st.kind === "tile")
    return { id: st.id, label, from: st.packName, tile: true, draw: () => tile(st.title, st.value === undefined ? "–" : fmt(st.value), st.value === undefined ? (st.empty ?? `Nothing from ${st.packName} yet.`) : (st.note ?? ""), st.trend) };
  if (st.kind === "bars")
    return {
      id: st.id,
      label,
      from: st.packName,
      draw: () =>
        Panel({
          title: st.title,
          meta: st.meta ?? st.packName,
          children: st.bars.length
            ? hbars(
                st.bars.map((b) => ({
                  label: html`${b.href ? html`<a href="${safeUrl(b.href)}">${b.label}</a>` : b.label}${b.sub ? html` <span class="t2">${b.sub}</span>` : ""}`,
                  value: b.value,
                  tone: b.warn ? "warn" : "c1",
                  note: b.note,
                })),
                fmt,
              )
            : empty(),
        }),
    };
  const blank = !st.labels.length || st.series.every((x) => x.values.every((v) => v === undefined));
  const every = st.labels.length > 16 ? 7 : 1;
  return {
    id: st.id,
    label,
    from: st.packName,
    draw: () =>
      Panel({
        title: st.title,
        meta: st.meta ?? st.packName,
        children: blank
          ? empty()
          : (st.chart === "lines" ? lines : columns)({
              title: st.title,
              labels: st.labels,
              tips: st.tips,
              fmt,
              every,
              partialLast: st.partialLast,
              ...axisOf(st.unit, st.series.flatMap((x) => x.values)),
              ...(st.chart === "lines" && st.unit === "percent" ? { yMax: 100 } : {}),
              ...(st.chart !== "lines" && st.stacked ? { stacked: true } : {}),
              series: st.series.map((x, i) => ({ name: x.name, tone: i ? "c2" : "c1", values: x.values })),
            }),
      }),
  };
}

/** Everything /stats can show here: each pack's, in the packs' order. */
export function statOffers(packs: StatOut[]): StatOffer[] {
  return packs.map(packOffer);
}

function body(offers: StatOffer[], placed: StatOffer[]) {
  const drawn = placed.map((o) => ({ o, out: o.draw() })).filter(({ out }) => out !== "");
  const kpis = drawn.filter(({ o }) => o.tile).map(({ out }) => out);
  const charts = drawn.filter(({ o }) => !o.tile).map(({ out }) => out);
  return html`${kpis.length ? html`<div class="kpis">${kpis}</div>` : ""}
${charts.length ? html`<div class="stats-grid">${charts}</div>` : ""}
${!offers.length ? Empty({ title: "Nothing to show here yet", children: html`Stats come from packs that keep numbers. <a href="/packs">Packs</a> lists what's on.` }) : !placed.length ? Empty({ title: "Every panel is hidden", children: html`Choose what Stats shows on <a href="/settings/layout#stats">Settings → Layout</a>.` }) : ""}`;
}

export function statsPage(frame: Frame, o: { /** Packs' panels (statsFrom). */ packs?: StatOut[]; /** Settings → Layout's choices. */ layout?: Pick<Layout, "stats" | "statsWeeks" | "statsDays">; /** Some pack here reads again when asked: offer Gather again. */ gather?: boolean } = {}) {
  const weeks = o.layout?.statsWeeks ?? WEEKS;
  const days = o.layout?.statsDays;
  const offers = statOffers(o.packs ?? []);
  const placed = placeStats(offers, o.layout?.stats);
  const range = days ? `Last ${days} days` : `Last ${weeks} weeks`;
  const sub = html`${range}. <a href="/settings/layout#stats">Choose what's here</a>.`;
  const refresh = o.gather ? html`<form method="post" action="/stats/refresh"><button type="submit" class="ghost" data-busy="Gathering">Gather again</button></form>` : "";
  return shell({
    title: "Stats · Dovre",
    frame,
    current: "/stats",
    body: html`${PageHeader({ title: "Stats", sub, actions: refresh })}<div data-live id="stats">${body(offers, placed)}</div>`,
    head: html`<meta name="u-topics" content="stats">`,
  });
}
