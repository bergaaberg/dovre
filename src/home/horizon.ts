/**
 * The horizon: the last 24 hours drawn as a mountain range (design C). Ridge height is activity
 * in the org (far ridge: everything, bots included; near ridge: people). Merges are flags on the
 * ridge (yours in the accent), releases and waiting prod deploys sit in the Shipped lane, and the
 * packs' lanes below it (the agents pack: sessions, sized by cost). Night in Oslo is a darker band with stars; the
 * busiest moments get names, like the panorama board at a viewpoint.
 *
 * Deterministic: the same snapshot draws the same ridge (seeded noise), so live refreshes don't
 * make the mountains dance. Only classes, no colours: theming stays in the stylesheet.
 */
import { html, raw } from "hono/html";
import type { Lane } from "../packs/types.ts";
import type { Deploy, Move } from "../sources/ghe.ts";
import type { Html } from "../ui/kit.ts";

import { currentTz } from "../when.ts";
export const W = 1320;
/** A lane's height; the picture grows by one per lane after the first. */
const LANE_H = 21;
const LABEL_Y = 30;
const BASE = 136;
const SHIP_Y = 156;
const AG_Y = 177;

const DAY = 86400e3;
const OSLO = { lat: 59.91, lon: 10.75 };

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hm = (at: number, tz = currentTz()) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);
const hourOf = (at: number, tz = currentTz()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));

/** A small seeded random source, so the ridge's rock texture is the same on every draw. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sunrise and sunset (ms, UTC) on the day containing `at`, from the NOAA sunrise equation. */
export function sunTimes(at: number, lat = OSLO.lat, lon = OSLO.lon): { rise: number; set: number } | null {
  const rad = Math.PI / 180;
  const jd = at / DAY + 2440587.5;
  const n = Math.round(jd - 2451545 - 0.0009 - -lon / 360);
  const jStar = n + 0.0009 - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (cosW < -1 || cosW > 1) return null; // midnight sun or polar night
  const w = Math.acos(cosW) / rad;
  const toMs = (j: number) => (j - 2440587.5) * DAY;
  return { rise: toMs(transit - w / 360), set: toMs(transit + w / 360) };
}

/** The night that overlaps the window [t0, now] most: from a sunset to the next sunrise. */
export function nightIn(t0: number, now: number): { from: number; to: number } | null {
  let best: { from: number; to: number; overlap: number } | null = null;
  for (let d = t0 - DAY; d <= now + DAY; d += DAY) {
    const a = sunTimes(d);
    const b = sunTimes(d + DAY);
    if (!a || !b) continue;
    const overlap = Math.min(b.rise, now) - Math.max(a.set, t0);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { from: a.set, to: b.rise, overlap };
  }
  return best && { from: best.from, to: best.to };
}

function smooth(v: number[], sigma: number): number[] {
  const r = Math.ceil(sigma * 3);
  return v.map((_, i) => {
    let s = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= v.length) continue;
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      s += v[j]! * w;
      ws += w;
    }
    return ws ? s / ws : 0;
  });
}

type Pt = [number, number];

function ridge(values: number[], amp: number, seed: number, floor: number, wiggle: number): Pt[] {
  const rand = rng(seed);
  const n = values.length;
  const vmax = Math.max(...values) || 1;
  const pts: Pt[] = [];
  values.forEach((v, i) => {
    const hill = floor + wiggle * (0.5 + 0.5 * Math.sin(i * 0.41 + seed)) + rand() * 1.2;
    const h = hill + amp * Math.sqrt(v / vmax);
    const x = ((i + 0.5) / n) * W;
    pts.push([x, BASE - h]);
    // a jagged vertex between bins, so slopes read as rock rather than data
    if (i < n - 1) pts.push([x + W / n / 2 + (rand() * 6 - 3), BASE - h - (rand() * 5.5 - 4)]);
  });
  return pts;
}

const pathOf = (pts: Pt[]) => `M0 ${BASE} L0 ${f1(pts[0]![1])} ${pts.map(([x, y]) => `L${f1(x)} ${f1(y)}`).join(" ")} L${W} ${f1(pts[pts.length - 1]![1])} L${W} ${BASE} Z`;

function yAt(pts: Pt[], x: number): number {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    if (x1 <= x && x <= x2) return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1 || 1);
  }
  return x < pts[0]![0] ? pts[0]![1] : pts[pts.length - 1]![1];
}

const weight = (m: Move) => (/labeled|unlabeled/.test(m.verb) ? 0.25 : 1);

/** The moments worth a name: the busiest stretches of people's work, at most `max`, spread apart. */
export function peaks(moves: Move[], t0: number, now: number, me: string, max = 4): { at: number; from: number; to: number; line: string }[] {
  const N = 48;
  const bin = (now - t0) / N;
  const people = new Array(N).fill(0);
  for (const m of moves) {
    const t = Date.parse(m.at);
    if (t < t0 || t > now || m.bot) continue;
    people[Math.min(N - 1, Math.floor((t - t0) / bin))] += weight(m);
  }
  const s = smooth(people, 1.2);
  const order = s.map((v, i) => [v, i] as const).filter(([v]) => v > 0.6).sort((a, b) => b[0] - a[0]);
  const picked: number[] = [];
  for (const [, i] of order) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p - i) >= 8)) picked.push(i);
  }
  return picked
    .sort((a, b) => a - b)
    .map((i) => {
      let a = i;
      let b = i;
      while (a > 0 && s[a - 1]! > s[i]! * 0.35) a--;
      while (b < N - 1 && s[b + 1]! > s[i]! * 0.35) b++;
      const from = t0 + a * bin;
      const to = Math.min(now, t0 + (b + 1) * bin);
      const inRange = moves.filter((m) => {
        const t = Date.parse(m.at);
        return t >= from && t <= to;
      });
      const count = (f: (m: Move) => boolean) => inRange.filter(f).length;
      const merged = count((m) => m.verb === "merged");
      const mineMerged = count((m) => m.verb === "merged" && m.actor === me);
      const released = count((m) => m.verb === "released");
      const opened = count((m) => m.verb === "opened" && m.type === "PullRequestEvent");
      const reviewed = count((m) => m.verb.startsWith("reviewed"));
      const bots = count((m) => m.bot);
      const parts = [
        bots > 2 * (inRange.length - bots) && bots >= 6 ? "Dependabot wave" : "",
        merged ? `${merged} merged${mineMerged ? ` (${mineMerged} yours)` : ""}` : "",
        released ? `${released} released` : "",
        opened ? `${opened} opened` : "",
        reviewed && !merged ? `${reviewed} reviews` : "",
      ].filter(Boolean);
      return { at: t0 + (i + 0.5) * bin, from, to, line: parts.slice(0, 3).join(" · ") || `${inRange.length} events` };
    });
}

export function horizon(opts: { moves: Move[]; deploys: Deploy[]; /** The packs' rows, three at most. */ lanes?: Lane[]; me: string; now: number; tz?: string }): Html {
  const { moves, deploys, me, now } = opts;
  const tz = opts.tz ?? currentTz();
  const lanes = (opts.lanes ?? []).slice(0, 3);
  const laneY = (i: number) => AG_Y + i * LANE_H;
  const lastY = lanes.length ? laneY(lanes.length - 1) : SHIP_Y;
  const AXIS_Y = lastY + 23;
  const H = AXIS_Y + 4;
  const t0 = now - DAY;
  const X = (t: number) => Math.max(0, Math.min(W, ((t - t0) / DAY) * W));
  const N = 64;
  const all = new Array(N).fill(0);
  const people = new Array(N).fill(0);
  for (const m of moves) {
    const t = Date.parse(m.at);
    if (t < t0 || t > now) continue;
    const i = Math.min(N - 1, Math.floor(((t - t0) / DAY) * N));
    all[i] += weight(m) * (m.bot ? 0.6 : 1);
    if (!m.bot) people[i] += weight(m);
  }
  const far = ridge(smooth(all, 2.2), 66, 3, 17, 10).map(([x, y]): Pt => [x + 5, y]);
  const near = ridge(smooth(people, 1.0), 84, 11, 5, 5);
  const farthest = ridge(smooth(all, 4.5), 58, 7, 34, 16).map(([x, y]): Pt => [x - 9, y]);
  const top = (x: number) => Math.min(yAt(near, x), yAt(far, x));

  const out: string[] = [];
  out.push(`<svg class="hz" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="hz-t hz-d"><title id="hz-t">Activity over the last 24 hours</title><desc id="hz-d">Ridge height is activity in the org. Flags are merges, diamonds releases and waiting deploys; the rows below are your apps' (dots by size, live ones at the right).</desc><defs>`);

  // Night: a band from sunset to sunrise, faded at both ends, with stars above the ridges.
  const night = nightIn(t0, now);
  if (night) {
    const xs = X(night.from);
    const xr = night.to >= now ? W + 80 : X(night.to);
    const tw = 36;
    out.push(`<linearGradient id="hz-night" gradientUnits="userSpaceOnUse" x1="0" x2="${W}" y1="0" y2="0">`);
    for (const [off, op] of [[xs - tw, 0], [xs + tw, 1], [xr - tw, 1], [xr + tw, 0]] as const) out.push(`<stop offset="${(off / W).toFixed(4)}" class="hz-nstop" style="stop-opacity:${op}"/>`);
    out.push(`</linearGradient>`);
  }
  out.push(`<linearGradient id="hz-near-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="hz-ng1"/><stop offset="1" class="hz-ng2"/></linearGradient>`);
  out.push(`<clipPath id="hz-clip-near"><path d="${pathOf(near)}"/></clipPath><clipPath id="hz-clip-far"><path d="${pathOf(far)}"/></clipPath></defs>`);
  if (night) {
    const xs = X(night.from);
    const xr = night.to >= now ? W : X(night.to);
    out.push(`<rect x="0" y="0" width="${W}" height="${BASE}" fill="url(#hz-night)"/>`);
    const r = rng(42);
    const stars: string[] = [];
    for (let k = 0; k < 46; k++) {
      const x = xs + 10 + r() * Math.max(0, xr - xs - 20);
      const y = 6 + r() * 86;
      const size = [0.7, 0.9, 1.2][Math.floor(r() * 3)]!;
      if (y < yAt(far, x) - 8) stars.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${size}"/>`);
    }
    out.push(`<g class="hz-stars">${stars.join("")}</g>`);
    if (night.from > t0) out.push(`<text class="hz-sky" x="${f1(xs + 6)}" y="${BASE - 6}">sunset ${hm(night.from)}</text>`);
    if (night.to < now) out.push(`<text class="hz-sky" x="${f1(xr - 6)}" y="${BASE - 6}" text-anchor="end">sunrise ${hm(night.to)}</text>`);
  }

  out.push(`<path class="hz-farthest" d="${pathOf(farthest)}"/><path class="hz-far" d="${pathOf(far)}"/>`);
  const snow = (base: number, a: number, b: number, c: number, d: number) => Array.from({ length: Math.floor(W / 6) + 1 }, (_, k) => W - k * 6).map((x) => `L${x} ${f1(base + a * Math.sin(x / b) + c * Math.sin(x / d))}`).join(" ");
  out.push(`<path class="hz-snow hz-snow-far" clip-path="url(#hz-clip-far)" d="M0 0 L${W} 0 ${snow(74, 5, 9, 3, 3.1)} Z"/>`);
  // The sun over the ridge an hour after it rose, when it has.
  if (night && night.to < now - 40 * 60e3) {
    const sx = Math.min(W - 24, X(night.to + 25 * 60e3));
    const sy = top(sx) - 9;
    const rays = [180, 210, 240, 270, 300, 330, 360].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `<line x1="${f1(sx + 12.5 * Math.cos(a))}" y1="${f1(sy + 12.5 * Math.sin(a))}" x2="${f1(sx + 16.5 * Math.cos(a))}" y2="${f1(sy + 16.5 * Math.sin(a))}"/>`;
    });
    out.push(`<g class="hz-sun"><circle cx="${f1(sx)}" cy="${f1(sy)}" r="9"/>${rays.join("")}</g>`);
  }
  out.push(`<path class="hz-near" d="${pathOf(near)}"/>`);
  out.push(`<path class="hz-snow" clip-path="url(#hz-clip-near)" d="M0 0 L${W} 0 ${snow(84, 4, 7, 2.5, 2.3)} Z"/>`);
  out.push(`<path class="hz-edge" d="M0 ${f1(near[0]![1])} ${near.map(([x, y]) => `L${f1(x)} ${f1(y)}`).join(" ")} L${W} ${f1(near[near.length - 1]![1])}"/>`);
  out.push(`<line class="hz-base" x1="0" x2="${W}" y1="${BASE}" y2="${BASE}"/>`);

  // Merges: flags planted on the near ridge.
  for (const m of moves) {
    if (m.verb !== "merged") continue;
    const t = Date.parse(m.at);
    if (t < t0 || t > now) continue;
    const x = X(t);
    const y = yAt(near, x);
    const cls = m.actor === me ? "hz-flag mine" : m.bot ? "hz-flag bot" : "hz-flag";
    out.push(`<g class="${cls}"><title>${esc(`${hm(t)} ${m.actor} merged ${m.ref ?? ""} ${m.title ?? ""}`.trim())}</title><line x1="${f1(x)}" x2="${f1(x)}" y1="${f1(y)}" y2="${f1(y - 13)}"/><path d="M${f1(x)} ${f1(y - 13)} l7 2.6 l-7 2.6 Z"/></g>`);
  }

  // Lanes: what shipped and what waits; then each pack's.
  out.push(`<line class="hz-laneline" x1="0" x2="${W}" y1="${SHIP_Y}" y2="${SHIP_Y}"/>`);
  lanes.forEach((_, i) => out.push(`<line class="hz-laneline" x1="0" x2="${W}" y1="${laneY(i)}" y2="${laneY(i)}"/>`));
  for (const m of moves) {
    if (m.verb !== "released") continue;
    const t = Date.parse(m.at);
    if (t < t0 || t > now) continue;
    out.push(`<path class="hz-rel" d="M${f1(X(t))} ${SHIP_Y - 5} l5 5 l-5 5 l-5 -5 Z"><title>${esc(`${hm(t)} ${m.repo.split("/").pop()} ${m.title ?? ""}`)}</title></path>`);
  }
  for (const d of deploys) {
    const t = Date.parse(d.createdAt);
    out.push(`<path class="hz-wait" d="M${f1(Math.max(70, X(t)))} ${SHIP_Y - 5} l5 5 l-5 5 l-5 -5 Z"><title>${esc(`${d.repo.split("/").pop()} waiting for ${d.envs.map((e) => e.name).join(", ")} since ${hm(t)}`)}</title></path>`);
  }
  lanes.forEach((lane, i) => {
    const y = laneY(i);
    let live = 0;
    for (const m of (lane.marks ?? []).slice(0, 200)) {
      const title = esc(String(m.title ?? "").slice(0, 200));
      const r = Math.max(2, Math.min(9, Number(m.size) || 3));
      if (m.live && live >= 20) continue;
      if (m.live) out.push(`<circle class="hz-mark live" cx="${W - 8 - live++ * 12}" cy="${y}" r="4"><title>${title}</title></circle>`);
      else if (Number.isFinite(m.at) && m.at >= t0 && m.at <= now) out.push(`<circle class="hz-mark" cx="${f1(Math.max(70, X(m.at)))}" cy="${y}" r="${f1(r)}"><title>${esc(`${hm(m.at)} `)}${title}</title></circle>`);
    }
    out.push(`<text class="hz-lane" x="0" y="${y + 3.5}">${esc(String(lane.label ?? "").slice(0, 16))}</text>`);
  });
  out.push(`<text class="hz-lane" x="0" y="${SHIP_Y + 3.5}">Shipped</text>`);

  // Hours along the bottom, every two; midnight shows the day.
  const firstHour = Math.ceil(t0 / 3600e3) * 3600e3;
  for (let t = firstHour; t < now; t += 3600e3) {
    const h = hourOf(t, tz);
    const x = X(t);
    if (h % 2 || x < 40 || x > W - 70) continue;
    const label = h === 0 ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric" }).format(t) : String(h).padStart(2, "0");
    out.push(`<line class="hz-tick" x1="${f1(x)}" x2="${f1(x)}" y1="${BASE}" y2="${BASE + 4}"/><text class="${h === 0 ? "hz-axis day" : "hz-axis"}" x="${f1(x)}" y="${AXIS_Y}" text-anchor="middle">${esc(label)}</text>`);
  }
  out.push(`<text class="hz-axis now" x="${W}" y="${AXIS_Y}" text-anchor="end">now ${hm(now, tz)}</text><line class="hz-now" x1="${W - 0.5}" x2="${W - 0.5}" y1="${LABEL_Y + 10}" y2="${lastY + 8}"/>`);

  // Peak names, spread so they don't collide.
  let lastRight = -Infinity;
  for (const p of peaks(moves, t0, now, me)) {
    const x = X(p.at);
    const title = `${hm(p.from)} – ${p.to >= now - 20 * 60e3 ? "now" : hm(p.to)}`;
    const width = Math.max(title.length * 6.5, p.line.length * 6.6);
    const anchor = x < width / 2 + 10 ? "start" : x > W - width / 2 - 84 ? "end" : "middle";
    const tx = anchor === "start" ? x - 6 : anchor === "end" ? Math.min(W - 84, x - 6) : x;
    const left = anchor === "start" ? x - 6 : anchor === "end" ? tx - width : x - width / 2;
    if (left < lastRight + 24) continue;
    lastRight = anchor === "end" ? tx : left + width;
    out.push(`<g class="hz-peak"><line x1="${f1(x)}" y1="${LABEL_Y + 8}" x2="${f1(x)}" y2="${f1(top(x) - 4)}"/><text x="${f1(tx)}" y="${LABEL_Y - 12}" text-anchor="${anchor}"><tspan class="t">${esc(title)}</tspan><tspan x="${f1(tx)}" dy="15" class="d">${esc(p.line)}</tspan></text></g>`);
  }
  out.push(`</svg>`);
  // Built from numbers and esc()'d text only, so it can go in raw.
  return html`<div class="hz-wrap">${raw(out.join(""))}</div>`;
}
