/**
 * Charts drawn on the server as SVG, from numbers: columns (grouped or stacked), lines, a
 * sparkline, and horizontal bars. Built with `html` like every view, so every label is escaped.
 * The look follows the dataviz method: thin marks (columns at most 24 wide, 4px rounded at the
 * data end, square at the base; 2px lines; 8px end dots with a 2px surface ring), a 2px surface
 * gap between touching fills, hairline solid grid, text in ink (never the series colour), a legend
 * for two or more series, a few direct labels. Each x is one hover/focus target (`data-tip`, read
 * by the page's script with textContent) with a crosshair on lines; every chart has a table.
 * Colours: --c1 and --c2 in src/ui/style.ts, checked with the dataviz validator for both themes.
 */
import { html } from "hono/html";
import type { Child, Html } from "./kit.ts";

export type Tone = "c1" | "c2" | "warn";
export type Series = { name: string; tone: Tone; values: (number | undefined)[] };
type Frame = { labels: string[]; tips: string[]; fmt: (n: number) => string; /** The axis's numbers, when they read better shorter ($1K) or rounder (1 d). */ axisFmt?: (n: number) => string; /** The axis's ticks, when the data's unit has round steps of its own (24 h). */ ticks?: number[]; w?: number; h?: number; title: string; /** The last x is still going (this week so far): drawn lighter. */ partialLast?: boolean; /** Show every nth x label. */ every?: number };

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** A round top for the axis, and its ticks (0 and three more). `whole`: counts, so no step under 1 (no "0.5 releases"). */
export function niceTicks(max: number, whole = false): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = whole ? Math.max(1, max / 3) : max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw && (!whole || Number.isInteger(s)))!;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const wholeOnly = (series: Series[]) => series.every((s) => s.values.every((v) => v === undefined || Number.isInteger(v)));

/** 1,234 → 1.2K; whole numbers stay whole. */
export const compact = (n: number) => (Math.abs(n) >= 1000 ? `${f1(n / 1000)}K` : Number.isInteger(n) ? String(n) : f1(n));

/** A column whose top corners are rounded (4px), its base square. */
function colPath(x: number, y: number, w: number, base: number) {
  const h = base - y;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${f1(x)},${f1(base)}V${f1(y + r)}Q${f1(x)},${f1(y)} ${f1(x + r)},${f1(y)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y)} ${f1(x + w)},${f1(y + r)}V${f1(base)}Z`;
}

function axes(o: Frame, ticks: number[], geo: { left: number; right: number; top: number; base: number; y: (v: number) => number; xAt: (i: number) => number }) {
  const every = o.every ?? 1;
  return html`<g class="vgrid">${ticks.map((t) => html`<line x1="${geo.left}" x2="${geo.right}" y1="${f1(geo.y(t))}" y2="${f1(geo.y(t))}"></line>`)}</g><g class="vticks">${ticks.map(
    (t) => html`<text x="${geo.left - 6}" y="${f1(geo.y(t) + 4)}" text-anchor="end">${(o.axisFmt ?? o.fmt)(t)}</text>`,
  )}</g><g class="vxl">${o.labels.map((l, i) => ((o.labels.length - 1 - i) % every === 0 ? html`<text x="${f1(geo.xAt(i))}" y="${geo.base + 16}" text-anchor="middle">${l}</text>` : ""))}</g>`;
}

const legend = (series: Series[], kind: "rect" | "line") =>
  series.length > 1 ? html`<ul class="vlegend">${series.map((s) => html`<li><span class="vkey ${kind} ${s.tone}" aria-hidden="true"></span>${s.name}</li>`)}</ul>` : "";

/** Every value as a table, for reading without hovering (and for screen readers). */
function table(o: Frame, series: Series[]): Html {
  return html`<details class="vtable"><summary>Table</summary><div class="sheet"><table class="data"><thead><tr><th scope="col"></th>${series.map((s) => html`<th scope="col">${s.name}</th>`)}</tr></thead><tbody>${o.tips.map(
    (tip, i) => html`<tr><th scope="row">${tip}</th>${series.map((s) => html`<td>${s.values[i] === undefined ? "–" : o.fmt(s.values[i]!)}</td>`)}</tr>`,
  )}</tbody></table></div></details>`;
}

const tipOf = (o: Frame, series: Series[], i: number) => [series.map((s) => `${s.values[i] === undefined ? "–" : o.fmt(s.values[i]!)} ${s.name}`).join("\n"), o.tips[i]].join("\n");

/** Columns per x: side by side, or stacked (a 2px gap between segments). */
export function columns(o: Frame & { series: Series[]; stacked?: boolean }): Html {
  const W = o.w ?? 520;
  const H = o.h ?? 190;
  const left = 40, right = W - 6, top = 14, base = H - 24;
  const n = o.labels.length;
  const totals = o.labels.map((_, i) => (o.stacked ? o.series.reduce((a, s) => a + (s.values[i] ?? 0), 0) : Math.max(0, ...o.series.map((s) => s.values[i] ?? 0))));
  const ticks = o.ticks ?? niceTicks(Math.max(...totals, 0), wholeOnly(o.series));
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => base - (v / yMax) * (base - top);
  const slot = (right - left) / n;
  const xAt = (i: number) => left + slot * (i + 0.5);
  const groups = o.stacked ? 1 : o.series.length;
  const bw = Math.min(24, (slot * 0.7 - (groups - 1) * 2) / groups);
  const last = n - 1;
  const cols = o.labels.map((_, i) => {
    let acc = 0;
    const marks = o.series.map((s, k) => {
      const v = s.values[i];
      if (!v) return "";
      if (o.stacked) {
        const y0 = y(acc), y1 = y(acc + v);
        acc += v;
        // A 2px surface gap under every segment above the first; only the top one is rounded.
        const topSeg = o.series.slice(k + 1).every((t) => !t.values[i]);
        const x = xAt(i) - bw / 2;
        const lo = k && y0 - y1 > 3 ? y0 - 2 : y0;
        return topSeg ? html`<path class="vb ${s.tone}" d="${colPath(x, y1, bw, lo)}"></path>` : html`<rect class="vb ${s.tone}" x="${f1(x)}" y="${f1(y1)}" width="${f1(bw)}" height="${f1(Math.max(0, lo - y1))}"></rect>`;
      }
      const x = xAt(i) - (groups * bw + (groups - 1) * 2) / 2 + k * (bw + 2);
      return html`<path class="vb ${s.tone}" d="${colPath(x, y(v), bw, base)}"></path>`;
    });
    const target = o.partialLast && i === last ? "vt part" : "vt";
    return html`<g class="${target}" tabindex="0" data-tip="${tipOf(o, o.series, i)}"><rect class="vh" x="${f1(left + slot * i)}" y="${top}" width="${f1(slot)}" height="${base - top}"></rect>${marks}</g>`;
  });
  // One direct label: the newest total, at its top.
  const lastV = totals[last]!;
  const label = lastV > 0 ? html`<text class="vdl" x="${f1(xAt(last))}" y="${f1(y(lastV) - 6)}" text-anchor="middle">${o.fmt(lastV)}</text>` : "";
  return html`<figure class="viz">${legend(o.series, "rect")}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.title}">${axes(o, ticks, { left, right, top, base, y, xAt })}<line class="vbase" x1="${left}" x2="${right}" y1="${base}" y2="${base}"></line>${cols}${label}</svg>${table(o, o.series)}</figure>`;
}

/** Lines over x, gaps where a value is missing; a crosshair and every series' value at each x. */
export function lines(o: Frame & { series: Series[]; yMax?: number }): Html {
  const W = o.w ?? 520;
  const H = o.h ?? 190;
  const left = 40, right = W - 40, top = 14, base = H - 24;
  const n = o.labels.length;
  const all = o.series.flatMap((s) => s.values.filter((v): v is number => v !== undefined));
  const ticks = o.ticks ?? niceTicks(o.yMax ?? Math.max(...all, 0), wholeOnly(o.series));
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => base - (Math.min(v, yMax) / yMax) * (base - top);
  const slot = (right - left) / Math.max(1, n - 1);
  const xAt = (i: number) => left + slot * i;
  const paths = o.series.map((s) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === undefined) return void (pen = false);
      d += `${pen ? "L" : "M"}${f1(xAt(i))},${f1(y(v))}`;
      pen = true;
    });
    const lastI = s.values.reduce((a: number, v, i) => (v === undefined ? a : i), -1);
    const end = lastI >= 0 ? html`<circle class="vd ${s.tone}" cx="${f1(xAt(lastI))}" cy="${f1(y(s.values[lastI]!))}" r="4"></circle><text class="vdl" x="${f1(xAt(lastI) + 8)}" y="${f1(y(s.values[lastI]!) + 4)}">${o.fmt(s.values[lastI]!)}</text>` : "";
    return html`<path class="vl ${s.tone}" d="${d}"></path>${end}`;
  });
  const hits = o.labels.map(
    (_, i) => html`<g class="vt" tabindex="0" data-tip="${tipOf(o, o.series, i)}"><rect class="vh" x="${f1(xAt(i) - slot / 2)}" y="${top}" width="${f1(slot)}" height="${base - top}"></rect><line class="vx" x1="${f1(xAt(i))}" x2="${f1(xAt(i))}" y1="${top}" y2="${base}"></line></g>`,
  );
  return html`<figure class="viz">${legend(o.series, "line")}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.title}">${axes(o, ticks, { left, right, top, base, y, xAt })}<line class="vbase" x1="${left}" x2="${right}" y1="${base}" y2="${base}"></line>${hits}${paths}</svg>${table(o, o.series)}</figure>`;
}

/** A small trend beside a number: ink, with the newest point in the series colour. */
export function sparkline(values: (number | undefined)[], tone: Tone = "c1"): Html {
  const vs = values.map((v) => v ?? 0);
  const max = Math.max(...vs, 1);
  const W = 96, H = 26;
  const x = (i: number) => 3 + ((W - 6) * i) / Math.max(1, vs.length - 1);
  const y = (v: number) => H - 3 - (v / max) * (H - 6);
  const d = vs.map((v, i) => `${i ? "L" : "M"}${f1(x(i))},${f1(y(v))}`).join("");
  return html`<svg class="vspark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"></path><circle class="vd ${tone}" cx="${f1(x(vs.length - 1))}" cy="${f1(y(vs[vs.length - 1]!))}" r="3"></circle></svg>`;
}

/** One bar per row, longest first, each with its label and value; a tone per row (status, when it means one). */
export function hbars(rows: { label: Child; value: number; tone: Tone; note?: string }[], fmt: (n: number) => string): Html {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return html`<ul class="vhbars">${rows.map(
    (r) =>
      html`<li><span class="hb-l">${r.label}</span><svg class="hb-b" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="vb ${r.tone}" x="0" y="1" width="${f1(Math.max(0.8, (r.value / max) * 100))}" height="8"></rect></svg><span class="hb-v">${fmt(r.value)}${r.note ? html` <span class="t3">${r.note}</span>` : ""}</span></li>`,
  )}</ul>`;
}
