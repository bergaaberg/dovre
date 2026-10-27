/**
 * Server-rendered SVG charts (charts.ts has the geometry), ops's charts.tsx as
 * `html`. One axis each, thin marks, one blue for a single series and the
 * categorical slots (--s1…--s5 in style.ts, validated in both modes) for more.
 * No script: a native <title> on every mark and a CSS crosshair per day are
 * the hover layer, and every chart has its table. `half`: drawn for a
 * half-width panel, so its text stays readable instead of shrinking with it.
 */
import { count, percent } from "../format.ts";
import { type Html, html } from "./kit.ts";
import { band, barPath, heatLevel, labelledDays, linePoints, niceMax, type Plot, plotHeight, plotWidth, type SankeyFlow, sankeyLayout, shortDay, ticks, xAt, yAt } from "./charts.ts";
import type { Child } from "./kit.ts";

export type Series = { label: string; values: number[]; color: "s1" | "s2" | "s3" };

const LINE_PLOT: Plot = { width: 800, height: 220, left: 40, right: 56, top: 12, bottom: 24 };
const COLUMN_PLOT: Plot = { width: 800, height: 160, left: 40, right: 16, top: 12, bottom: 24 };
const LINE_HALF: Plot = { width: 440, height: 180, left: 34, right: 40, top: 12, bottom: 24 };
const COLUMN_HALF: Plot = { width: 440, height: 150, left: 34, right: 10, top: 14, bottom: 24 };

/** Gridlines with their values on the left. */
function Grid({ p, max, format = count }: { p: Plot; max: number; format?: (n: number) => string }): Html {
  return html`${ticks(max).map(
    (t) =>
      html`<line class="${t === 0 ? "base" : "grid"}" x1="${p.left}" x2="${p.width - p.right}" y1="${yAt(t, max, p)}" y2="${yAt(t, max, p)}"></line><text x="${p.left - 6}" y="${yAt(t, max, p) + 4}" text-anchor="end">${format(t)}</text>`,
  )}`;
}

/** A day label's width plus a gap, in drawing units ("26 Oct" in the page's monospace is about 55). */
export const DAY_LABEL_W = 64;

/** Day labels under the plot, at `x(i)`: the first, the last and a few between. */
function DayLabels({ p, days, x }: { p: Plot; days: string[]; x: (i: number) => number }): Html {
  // The first label hangs right of its point and the last left of it; the rest are centred. A label
  // between is kept only when it clears both neighbours by those extents (a narrow drawing keeps fewer).
  const last = days.length - 1;
  const picked = [...labelledDays(days.length)].sort((a, b) => a - b);
  const shown = new Set<number>();
  let prev = { x: -Infinity, right: 0 };
  for (const i of picked) {
    const ends = i === 0 || i === last;
    if (ends || (x(i) - prev.x >= DAY_LABEL_W * (prev.right + 0.5) && x(last) - x(i) >= DAY_LABEL_W * 1.5)) {
      shown.add(i);
      prev = { x: x(i), right: i === 0 ? 1 : 0.5 };
    }
  }
  return html`${days.map((d, i) =>
    shown.has(i)
      ? html`<text x="${x(i)}" y="${p.height - 6}" text-anchor="${i === 0 ? "start" : i === last ? "end" : "middle"}">${shortDay(d)}</text>`
      : "",
  )}`;
}

export function Legend({ series }: { series: Series[] }): Html | "" {
  if (series.length < 2) return "";
  return html`<div class="legend">${series.map((s) => html`<span><span class="key" style="${`background: var(--${s.color})`}"></span>${s.label}</span>`)}</div>`;
}

/**
 * The table beside a chart: every value the chart shows, newest day first. Folded (it's for screen
 * readers and exact numbers), in a scroll box so a wide one never widens the page, and days where
 * every column is 0 are left out and counted instead.
 */
function DayTable({ days, columns, format = count }: { days: string[]; columns: { label: string; values: number[] }[]; format?: (n: number) => string }): Html {
  const order = days.map((_, i) => days.length - 1 - i);
  const kept = order.filter((i) => columns.some((c) => (c.values[i] ?? 0) !== 0));
  const left = order.length - kept.length;
  const note = left ? html`<p class="table-note">${left === 1 ? "1 day" : `${left} days`} with nothing left out.</p>` : "";
  return html`<details><summary>Table</summary><div class="table-wrap"><table class="data days"><thead><tr><th>Day</th>${columns.map((c) => html`<th class="num">${c.label}</th>`)}</tr></thead><tbody>${kept.map(
    (i) => html`<tr><td>${shortDay(days[i] ?? "")}</td>${columns.map((c) => html`<td class="num">${format(c.values[i] ?? 0)}</td>`)}</tr>`,
  )}</tbody></table></div>${note}</details>`;
}

/**
 * Up to three series over the days, one axis. The last value is labelled at
 * each line's end unless it would sit on another's label; the legend and the
 * per-day readout (hover a day) carry it then.
 */
export function LineChart({ days, series, title, half }: { days: string[]; series: Series[]; title: string; half?: boolean }): Html {
  const draw = (narrow: boolean) => {
    const p = narrow ? LINE_HALF : LINE_PLOT;
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    const slot = plotWidth(p) / Math.max(1, days.length - 1);
    const placed: number[] = [];
    const lines = series.map((s) => html`<polyline class="line" points="${linePoints(s.values, max, p)}" style="${`stroke: var(--${s.color})`}"></polyline>`);
    const ends = series.map((s) => {
      const last = s.values.length - 1;
      const v = s.values[last] ?? 0;
      const y = yAt(v, max, p);
      const free = placed.every((q) => Math.abs(q - y) >= 12);
      if (free) placed.push(y);
      return html`<circle class="dot" cx="${xAt(last, s.values.length, p)}" cy="${y}" r="4" style="${`fill: var(--${s.color})`}"></circle>${
        free ? html`<text class="end" x="${xAt(last, s.values.length, p) + 8}" y="${y + 4}">${count(v)}</text>` : ""
      }`;
    });
    const cols = days.map((d, i) => {
      const x = xAt(i, days.length, p);
      const readout = `${shortDay(d)} · ${series.map((s) => `${s.label} ${count(s.values[i] ?? 0)}`).join(" · ")}`;
      return html`<g class="col"><line class="cross" x1="${x}" x2="${x}" y1="${p.top}" y2="${p.top + plotHeight(p)}"></line><rect class="hit" x="${x - slot / 2}" y="${p.top}" width="${slot}" height="${plotHeight(p)}"><title>${readout}</title></rect></g>`;
    });
    return Svg({ p, title, narrow, solo: !!half, children: html`${Grid({ p, max })}${DayLabels({ p, days, x: (i) => xAt(i, days.length, p) })}${lines}${ends}${cols}` });
  };
  return html`<figure class="viz">${Legend({ series })}${half ? draw(true) : html`${draw(false)}${draw(true)}`}${DayTable({ days, columns: series })}</figure>`;
}

/** The chart's <svg>: the wide drawing, or the narrow one (hidden from the reader's tools beside a wide one). */
function Svg({ p, title, narrow, solo, children }: { p: Plot; title: string; narrow: boolean; solo: boolean; children: Html }): Html {
  if (solo) return html`<svg viewBox="${`0 0 ${p.width} ${p.height}`}" role="img" aria-label="${title}">${children}</svg>`;
  return narrow
    ? html`<svg class="narrow" viewBox="${`0 0 ${p.width} ${p.height}`}" aria-hidden="true">${children}</svg>`
    : html`<svg class="wide" viewBox="${`0 0 ${p.width} ${p.height}`}" role="img" aria-label="${title}">${children}</svg>`;
}

/** One series as columns per day; the tallest is labelled, the rest are in the readout and the table. */
export function ColumnChart({ days, values, title, unit, half, format = count, limit }: { days: string[]; values: number[]; title: string; unit: string; half?: boolean; format?: (n: number) => string; limit?: { value: number; label: string } }): Html {
  const draw = (narrow: boolean) => {
    const p = narrow ? COLUMN_HALF : COLUMN_PLOT;
    const max = niceMax(Math.max(0, limit?.value ?? 0, ...values));
    const top = values.indexOf(Math.max(...values));
    const centre = (i: number) => {
      const b = band(i, days.length, p);
      return b.x + b.width / 2;
    };
    const columns = values.map((v, i) => {
      const b = band(i, days.length, p);
      const y = yAt(v, max, p);
      return html`<g><path class="bar" d="${barPath(b.x, y, b.width, p.top + plotHeight(p) - y)}" style="fill: var(--s1)"></path>${
        i === top && v > 0 ? html`<text class="end" x="${b.x + b.width / 2}" y="${y - 4}" text-anchor="middle">${format(v)}</text>` : ""
      }<rect class="hit" x="${b.slotX}" y="${p.top}" width="${b.slot}" height="${plotHeight(p)}"><title>${`${shortDay(days[i] ?? "")} · ${format(v)} ${unit}`}</title></rect></g>`;
    });
    // A limit (a cap) is a threshold, so it's the one dashed line: over it is what the cap is for.
    const cap = limit
      ? html`<line class="limit" x1="${p.left}" x2="${p.width - p.right}" y1="${yAt(limit.value, max, p)}" y2="${yAt(limit.value, max, p)}"></line><text class="limit-label" x="${p.width - p.right}" y="${yAt(limit.value, max, p) - 4}" text-anchor="end">${limit.label}</text>`
      : "";
    return Svg({ p, title, narrow, solo: !!half, children: html`${Grid({ p, max, format })}${DayLabels({ p, days, x: centre })}${columns}${cap}` });
  };
  return html`<figure class="viz">${half ? draw(true) : html`${draw(false)}${draw(true)}`}${DayTable({ days, columns: [{ label: unit, values }], format })}</figure>`;
}

/** A chart label's width per character, in drawing units (11px text in the page's monospace). */
export const CHAR_W = 6.8;

/** `text` cut to `chars` characters, keeping its end: a path's last part says the most ("…/innstillinger"). */
export function fitLabel(text: string, chars: number): string {
  const all = [...text];
  return all.length <= chars ? text : `…${all.slice(all.length - Math.max(1, chars - 1)).join("")}`;
}

/**
 * Rows × days, one blue from light (few) to dark (many); the row's total at the end. The wide drawing
 * puts labels left of their row, shortened from the left to fit; the narrow one (a phone) puts each
 * label above its row across the whole width. The full label is in each label's <title>.
 */
export function Heatmap({ days, rows, title }: { days: string[]; rows: { label: string; total: number; perDay: number[] }[]; title: string }): Html {
  const max = Math.max(0, ...rows.flatMap((r) => r.perDay));
  const draw = (narrow: boolean) => {
    const width = narrow ? 360 : 800;
    const labelW = narrow ? 0 : 150;
    const totalW = narrow ? 36 : 48;
    const cellH = narrow ? 14 : 18;
    const labelH = narrow ? 15 : 0;
    const gap = narrow ? 1 : 2;
    const rowH = labelH + cellH + (narrow ? 7 : gap);
    const cellW = (width - labelW - totalW) / Math.max(1, days.length);
    const height = rows.length * rowH + 22;
    const p: Plot = { width, height, left: labelW, right: totalW, top: 0, bottom: 0 };
    const room = narrow ? width - totalW : labelW - 8;
    const lines = rows.map((r, j) => {
      const y = j * rowH;
      const cy = y + labelH;
      const cells = r.perDay.map((v, i) => {
        const level = heatLevel(v, max);
        return html`<rect class="${level ? "cell" : "cell zero"}" x="${labelW + i * cellW}" y="${cy}" width="${Math.max(1, cellW - gap)}" height="${cellH}" rx="2"${
          level ? html` style="${`fill: var(--h${level})`}"` : ""
        }><title>${`${r.label} · ${shortDay(days[i] ?? "")} · ${count(v)}`}</title></rect>`;
      });
      const label = narrow
        ? html`<text x="0" y="${y + 11}">${fitLabel(r.label, Math.floor(room / CHAR_W))}<title>${r.label}</title></text>`
        : html`<text x="${labelW - 8}" y="${cy + cellH - 5}" text-anchor="end">${fitLabel(r.label, Math.floor(room / CHAR_W))}<title>${r.label}</title></text>`;
      return html`<g>${label}${cells}<text class="end" x="${width - 4}" y="${cy + cellH - (narrow ? 3 : 5)}" text-anchor="end">${count(r.total)}</text></g>`;
    });
    return Svg({ p, title, narrow, solo: false, children: html`${lines}${DayLabels({ p, days, x: (i) => labelW + i * cellW + cellW / 2 })}` });
  };
  const swatches = [1, 2, 3, 4, 5, 6].map((l) => html`<span class="swatch" style="${`background: var(--h${l})`}"></span>`);
  return html`<figure class="viz">${draw(false)}${draw(true)}<div class="legend"><span>fewer ${swatches} more · most in a day ${count(max)}</span></div>${DayTable({ days, columns: rows.map((r) => ({ label: r.label, values: r.perDay })) })}</figure>`;
}

/** Horizontal bars for ranked categories, one blue, the value at the end (and in the row, so nothing is colour alone). */
export function HBars({ rows, empty }: { rows: { label: Child; value: number; note?: string }[]; empty: string }): Html {
  if (!rows.length || rows.every((r) => r.value === 0)) return html`<p class="t2">${empty}</p>`;
  const max = Math.max(...rows.map((r) => r.value));
  return html`<div class="viz"><ul class="hbars">${rows.map(
    (r) =>
      html`<li${r.note !== undefined ? html` title="${r.note}"` : ""}><span>${r.label}</span><span class="track"><span class="fill" style="${`width: ${max > 0 ? Math.max(0.5, (r.value / max) * 100) : 0}%`}"></span></span><span class="num">${count(r.value)}${
        r.note ? html`<span class="t2"> · ${r.note}</span>` : ""
      }</span></li>`,
  )}</ul></div>`;
}

/**
 * A server-rendered SVG Sankey diagram for flow between two columns (e.g. entry group → next group).
 * Hovering any ribbon highlights it and shows the exact flow count via native <title>.
 */
export function SankeyChart({
  flows,
  title,
  leftTitle = "From",
  rightTitle = "To",
  empty = "No flows in the window.",
}: {
  flows: SankeyFlow[];
  title: string;
  leftTitle?: string;
  rightTitle?: string;
  empty?: string;
}): Html {
  const active = flows.filter((f) => f.value > 0);
  if (!active.length) return html`<p class="t2">${empty}</p>`;
  const s = sankeyLayout(active);
  const topY = 14;
  const shiftY = 18;
  const totalH = s.height + shiftY;
  const ribbons = s.links.map(
    (l) =>
      html`<path class="sankey-link" d="${l.path}" transform="${`translate(0,${shiftY})`}" style="${`fill: ${l.color}`}"><title>${`${l.from} → ${l.to} · ${count(l.value)}`}</title></path>`,
  );
  const leftNodes = s.left.map((n) => {
    const midY = n.y + shiftY + n.height / 2 + 4;
    return html`<g><rect class="sankey-node" x="${s.leftX}" y="${n.y + shiftY}" width="${s.nodeW}" height="${n.height}" style="${`fill: ${n.color}`}"><title>${`${n.key} · ${count(n.total)}`}</title></rect><text x="${
      s.leftX - 8
    }" y="${midY}" text-anchor="end"><tspan class="end">${n.key}</tspan> <tspan>${count(n.total)}</tspan></text></g>`;
  });
  const rightNodes = s.right.map((n) => {
    const midY = n.y + shiftY + n.height / 2 + 4;
    return html`<g><rect class="sankey-node" x="${s.rightX}" y="${n.y + shiftY}" width="${s.nodeW}" height="${n.height}" style="${`fill: ${n.color}`}"><title>${`${n.key} · ${count(n.total)}`}</title></rect><text x="${
      s.rightX + s.nodeW + 8
    }" y="${midY}" text-anchor="start"><tspan class="end">${n.key}</tspan> <tspan>${count(n.total)}</tspan></text></g>`;
  });
  // Wide only: on the phone its labels would be unreadably small, and the caller lists the same flows under it.
  return html`<figure class="viz wide-only"><svg viewBox="${`0 0 ${s.width} ${totalH}`}" role="img" aria-label="${title}"><text x="${s.leftX - 8}" y="${topY}" text-anchor="end">${leftTitle}</text><text x="${
    s.rightX + s.nodeW + 8
  }" y="${topY}" text-anchor="start">${rightTitle}</text>${ribbons}${leftNodes}${rightNodes}</svg></figure>`;
}

/** `apart`: this step isn't a subset of the one above (it counts something else), so no drop-off is drawn. */
export type FunnelStep = { label: string; value: number; note?: string; color?: "s1" | "s2" | "s3"; apart?: boolean };

/**
 * A funnel, as HTML so it reflows on the phone: each step a bar on one scale (the biggest step),
 * its count and share beside it. Where a step is a subset of the one above, the bar keeps a
 * faint ghost of the step above, so what dropped off shows; a step marked `apart` (or bigger than
 * the one above) gets no ghost, so the picture claims no flow that isn't there.
 * `half` is accepted for symmetry with the SVG charts; HTML needs no second drawing.
 */
export function FunnelDiagram({ steps, title, empty = "Nothing in the window yet." }: { steps: FunnelStep[]; title: string; empty?: string; half?: boolean }): Html {
  if (!steps.length || steps.every((s) => s.value === 0)) return html`<p class="t2">${empty}</p>`;
  const max = Math.max(1, ...steps.map((s) => s.value));
  const pct = (v: number) => (v > 0 ? Math.max(0.8, Math.round((v / max) * 1000) / 10) : 0);
  const rows = steps.map((step, i) => {
    const prev = i > 0 ? steps[i - 1]! : null;
    const ghost = prev && !step.apart && step.value <= prev.value && prev.value > 0 ? pct(prev.value) : 0;
    const note = step.note ?? (i === 0 ? "100 %" : percent(step.value, steps[0]?.value ?? max));
    const lost = ghost && prev ? ` · ${count(prev.value - step.value)} dropped from the step above` : "";
    return html`<li title="${`${step.label}: ${count(step.value)}${note ? ` (${note})` : ""}${lost}`}"><span class="f-label">${step.label}</span><span class="f-track">${
      ghost ? html`<span class="f-ghost" style="${`width: ${ghost}%`}"></span>` : ""
    }<span class="${`f-bar${step.color && step.color !== "s1" ? ` ${step.color}` : ""}`}" style="${`width: ${pct(step.value)}%`}"></span></span><span class="f-num"><strong>${count(step.value)}</strong>${note ? html` <span class="t2">${note}</span>` : ""}</span></li>`;
  });
  return html`<figure class="viz"><ol class="funnel" aria-label="${title}">${rows}</ol></figure>`;
}

export type Slot = "s1" | "s2" | "s3" | "s4" | "s5";
const SLOTS: Slot[] = ["s1", "s2", "s3", "s4", "s5"];

/**
 * Part of a whole as one horizontal bar with its legend (values in the legend, so nothing is
 * colour alone). A part's colour follows its place in `parts`, zeros included, so a part that
 * drops to nothing doesn't repaint the others. `tone` overrides it when the parts *are* states
 * (ok / warn / bad), or ordered outcomes (h4 → h2 → muted: the blue ramp, darkest the best).
 * At most five parts: fold the rest into "Other" before calling.
 */
export function StackedBar({ parts, label }: { parts: { label: string; value: number; display?: string; tone?: Slot | "h2" | "h4" | "muted" | "ok" | "warn" | "bad" }[]; label: string }): Html | "" {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return "";
  const colored = parts.map((p, i) => ({ ...p, color: p.tone === "muted" ? "var(--border-2)" : `var(--${p.tone ?? SLOTS[i % SLOTS.length]})` })).filter((p) => p.value > 0);
  return html`<div class="stack-wrap" role="img" aria-label="${label}">
<div class="stack-bar">${colored.map(
    (p) => html`<span class="stack-seg" style="${`flex-grow: ${p.value}; background: ${p.color}`}" title="${`${p.label}: ${p.display ?? count(p.value)} (${percent(p.value, total)})`}"></span>`,
  )}</div>
<div class="legend">${colored.map((p) => html`<span><span class="swatch" style="${`background: ${p.color}`}"></span> ${p.label} <strong>${p.display ?? count(p.value)}</strong>${p.display === percent(p.value, total) ? "" : html` <span class="t3">${percent(p.value, total)}</span>`}</span>`)}</div>
</div>`;
}

/**
 * Loss against gain for one row, from a shared centre: `left` (a loss: unsubscribes) grows left
 * in slot 2, `right` (a gain) grows right in slot 1, both on the same `max`, so rows compare.
 * Polarity, not status: the net beside it carries the red when it's a loss.
 */
export function Diverging({ left, right, max, title }: { left: number; right: number; max: number; title: string }): Html {
  const w = (v: number) => (max > 0 && v > 0 ? Math.max(2, Math.round((v / max) * 1000) / 10) : 0);
  return html`<div class="div-bar" role="img" aria-label="${title}" title="${title}"><span class="div-neg"><span style="${`width: ${w(left)}%`}"></span></span><span class="div-mid"></span><span class="div-pos"><span style="${`width: ${w(right)}%`}"></span></span></div>`;
}
/** The key for a page of Diverging rows: which side is which. */
Diverging.Key = ({ left, right }: { left: string; right: string }): Html =>
  html`<span class="legend div-key"><span><span class="swatch div-l"></span> ← ${left}</span><span>${right} → <span class="swatch div-r"></span></span></span>`;
