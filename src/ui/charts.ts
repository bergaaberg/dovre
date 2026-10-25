/**
 * The geometry behind the SVG charts (charts.tsx): scales, ticks, paths and
 * the heat steps. Server-rendered, no script: hover is a native <title> per
 * mark and a CSS crosshair per day, and every chart has a table beside it.
 */

/** The plot box inside a chart's viewBox. */
export type Plot = { width: number; height: number; left: number; right: number; top: number; bottom: number };

export const plotWidth = (p: Plot) => p.width - p.left - p.right;
export const plotHeight = (p: Plot) => p.height - p.top - p.bottom;

/** The smallest 1, 2 or 5 × 10ⁿ at or above `v`; 1 for nothing, so an empty chart still has an axis. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Gridlines: the baseline, the middle when it's a whole number, the top. */
export function ticks(max: number): number[] {
  const half = max / 2;
  return Number.isInteger(half) && half > 0 ? [0, half, max] : [0, max];
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The x of day `i` of `n` on a line chart: first and last on the edges, one alone in the middle. */
export function xAt(i: number, n: number, p: Plot): number {
  const w = plotWidth(p);
  return round(p.left + (n <= 1 ? w / 2 : (i * w) / (n - 1)));
}

export function yAt(v: number, max: number, p: Plot): number {
  return round(p.top + plotHeight(p) * (1 - Math.min(v, max) / max));
}

export function linePoints(values: number[], max: number, p: Plot): string {
  return values.map((v, i) => `${xAt(i, values.length, p)},${yAt(v, max, p)}`).join(" ");
}

/** A column's band on a bar chart: `n` equal bands, the bar at most 24 wide and centred, a 2 px gap kept. */
export function band(i: number, n: number, p: Plot): { x: number; width: number; slot: number; slotX: number } {
  const slot = plotWidth(p) / Math.max(1, n);
  const width = Math.max(1, Math.min(24, slot - 2));
  const slotX = p.left + i * slot;
  return { x: round(slotX + (slot - width) / 2), width: round(width), slot: round(slot), slotX: round(slotX) };
}

/** A bar from the baseline up, its data end rounded (4 px, less on a thin bar), its base square. */
export function barPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return "";
  const r = Math.min(4, width / 2, height);
  return [
    `M${x},${round(y + height)}`,
    `V${round(y + r)}`,
    `Q${x},${y} ${round(x + r)},${y}`,
    `H${round(x + width - r)}`,
    `Q${round(x + width)},${y} ${round(x + width)},${round(y + r)}`,
    `V${round(y + height)}`,
    "Z",
  ].join(" ");
}

/** A heatmap cell's step, 0 (none) to 6, linear in the value. */
export function heatLevel(v: number, max: number): number {
  if (!(v > 0) || !(max > 0)) return 0;
  return Math.min(6, 1 + Math.floor((v / max) * 5.999));
}

/** «2026-10-07» → «7 Oct». */
export function shortDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Which days get an axis label: the first, the last, and about four between. */
export function labelledDays(n: number): Set<number> {
  if (n <= 0) return new Set();
  const step = Math.max(1, Math.round((n - 1) / 5));
  const out = new Set<number>([0, n - 1]);
  for (let i = step; i < n - step / 2; i += step) out.add(i);
  return out;
}

export type SankeyFlow = { from: string; to: string; value: number };
export type SankeyNode = { key: string; total: number; y: number; height: number; color: string };
export type SankeyLink = { from: string; to: string; value: number; path: string; color: string };

// Categorical slots in order (style.ts): a ramp step would read as "more", not "another".
const SANKEY_PALETTE = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];

/**
 * Computes a two-column Sankey layout inside an 800-wide SVG viewBox.
 * Left nodes and right nodes are stacked proportionally to their flow totals,
 * with smooth cubic Bézier ribbons connecting each (from, to) pair.
 */
export function sankeyLayout(
  flows: SankeyFlow[],
  opts: { width?: number; padX?: number; nodeW?: number; gap?: number } = {},
): { width: number; height: number; leftX: number; rightX: number; nodeW: number; left: SankeyNode[]; right: SankeyNode[]; links: SankeyLink[] } {
  const active = flows.filter((f) => f.value > 0);
  const width = opts.width ?? 800;
  const padX = opts.padX ?? 195;
  const nodeW = opts.nodeW ?? 10;
  const gap = opts.gap ?? 10;
  const leftX = padX;
  const rightX = width - padX - nodeW;

  const leftTotals = new Map<string, number>();
  const rightTotals = new Map<string, number>();
  for (const f of active) {
    leftTotals.set(f.from, (leftTotals.get(f.from) ?? 0) + f.value);
    rightTotals.set(f.to, (rightTotals.get(f.to) ?? 0) + f.value);
  }
  const leftEntries = [...leftTotals.entries()].sort((a, b) => b[1] - a[1]);
  const rightEntries = [...rightTotals.entries()].sort((a, b) => b[1] - a[1]);
  const totalFlow = leftEntries.reduce((s, [, v]) => s + v, 0);
  const maxRows = Math.max(leftEntries.length, rightEntries.length, 1);
  const plotH = Math.max(160, maxRows * 30);
  const height = plotH + 16;
  const availH = plotH - Math.max(0, maxRows - 1) * gap;

  const placeNodes = (entries: [string, number][], colors: Map<string, string>): SankeyNode[] => {
    const rawH = entries.map(([, v]) => (totalFlow > 0 ? Math.max(6, (v / totalFlow) * availH) : 6));
    const sumH = rawH.reduce((a, b) => a + b, 0) + Math.max(0, entries.length - 1) * gap;
    const scale = sumH > plotH && sumH > 0 ? (plotH - Math.max(0, entries.length - 1) * gap) / rawH.reduce((a, b) => a + b, 0) : 1;
    let y = 8 + Math.max(0, (plotH - (rawH.reduce((a, b) => a + b * scale, 0) + Math.max(0, entries.length - 1) * gap)) / 2);
    return entries.map(([key, total], idx) => {
      const h = round(Math.max(4, (rawH[idx] ?? 6) * scale));
      const node: SankeyNode = { key, total, y: round(y), height: h, color: colors.get(key) ?? SANKEY_PALETTE[idx % SANKEY_PALETTE.length]! };
      y += h + gap;
      return node;
    });
  };

  const colorMap = new Map<string, string>();
  leftEntries.forEach(([k], i) => colorMap.set(k, SANKEY_PALETTE[i % SANKEY_PALETTE.length]!));
  const left = placeNodes(leftEntries, colorMap);
  const right = placeNodes(rightEntries, colorMap);

  const leftByKey = new Map(left.map((n) => [n.key, { ...n, offset: 0 }]));
  const rightByKey = new Map(right.map((n) => [n.key, { ...n, offset: 0 }]));
  const x0 = leftX + nodeW;
  const x1 = rightX;
  const mx = round((x0 + x1) / 2);

  const sortedFlows = [...active].sort((a, b) => {
    const la = leftByKey.get(a.from)?.y ?? 0;
    const lb = leftByKey.get(b.from)?.y ?? 0;
    if (la !== lb) return la - lb;
    return (rightByKey.get(a.to)?.y ?? 0) - (rightByKey.get(b.to)?.y ?? 0);
  });

  const links: SankeyLink[] = sortedFlows.map((f) => {
    const ln = leftByKey.get(f.from)!;
    const rn = rightByKey.get(f.to)!;
    const h0 = ln.total > 0 ? (f.value / ln.total) * ln.height : 2;
    const h1 = rn.total > 0 ? (f.value / rn.total) * rn.height : 2;
    const y0 = round(ln.y + ln.offset);
    const y1 = round(rn.y + rn.offset);
    const y0b = round(y0 + Math.max(1.5, h0));
    const y1b = round(y1 + Math.max(1.5, h1));
    ln.offset += h0;
    rn.offset += h1;
    const path = `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1b} C${mx},${y1b} ${mx},${y0b} ${x0},${y0b} Z`;
    return { from: f.from, to: f.to, value: f.value, path, color: ln.color };
  });

  return { width, height, leftX, rightX, nodeW, left, right, links };
}

