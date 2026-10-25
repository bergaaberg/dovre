/**
 * The kit: what every page is built from (PLAN D11). Rendering only, all `html` — every value
 * interpolated is escaped; links built from data go through safeUrl() before they get here.
 * The classes are in src/ui/style.ts. A page composes these; it doesn't invent its own.
 */
import { html } from "hono/html";
import { type IconName, icon } from "./icons.ts";

export type Html = ReturnType<typeof html>;

/** What a slot may hold: markup, text (escaped), or nothing. */
export type Child = Html | string | number | null | undefined | false | Child[];

/** The four states a thing can be in. Colour means status, never decoration. */
export type Tone = "ok" | "warn" | "bad" | "accent" | "neutral";

const toneClass = (tone: Tone | undefined) => (tone && tone !== "neutral" ? ` ${tone}` : "");
const current = (on: boolean | undefined) => (on ? html` aria-current="page"` : "");

/** Where a page sits; a crumb without `href` is a heading, not a page. */
export type Crumb = { href?: string; label: string };

/**
 * The top of every page: where it sits (crumbs), what it is (title, one line under it),
 * what can be done here (actions), and its views (tabs, below).
 */
export function PageHeader(opts: { title: Child; sub?: Child; crumbs?: Crumb[]; actions?: Child; tabs?: Child }): Html {
  const crumbs = opts.crumbs?.length
    ? html`<nav class="crumbs" aria-label="Where this is">${opts.crumbs.map((c, i) => html`${i ? html`<span class="sep">/</span>` : ""}${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span>${c.label}</span>`}`)}</nav>`
    : "";
  return html`<header class="page-head">
<div class="titles">${crumbs}<h1>${opts.title}</h1>${opts.sub ? html`<p class="sub">${opts.sub}</p>` : ""}</div>
${opts.actions ? html`<div class="actions">${opts.actions}</div>` : ""}
</header>${opts.tabs ? html`<div class="toolbar">${opts.tabs}</div>` : ""}`;
}

export type Tab = { href: string; label: string; n?: number | string; current?: boolean } | "sep";

/** Views of one page (filters, windows): links, the current one marked. */
export function Tabs({ items, label }: { items: Tab[]; label: string }): Html {
  return html`<nav class="tabs" aria-label="${label}">${items.map((t) =>
    t === "sep" ? html`<span class="sep" aria-hidden="true"></span>` : html`<a href="${t.href}"${current(t.current)}>${t.label}${t.n !== undefined ? html`<span class="n">${t.n}</span>` : ""}</a>`,
  )}</nav>`;
}

/** A panel: a titled box. `flush`: the body is a list or table that runs to the edges. */
export function Panel(opts: { title?: Child; meta?: Child; actions?: Child; foot?: Child; flush?: boolean; id?: string; children: Child }): Html {
  const head =
    opts.title || opts.actions
      ? html`<div class="panel-head">${opts.title ? html`<h2>${opts.title}</h2>` : ""}${opts.meta ? html`<span class="meta">${opts.meta}</span>` : ""}${opts.actions ? html`<div class="actions">${opts.actions}</div>` : ""}</div>`
      : "";
  return html`<section class="panel"${opts.id ? html` id="${opts.id}"` : ""}>${head}<div class="panel-body${opts.flush ? " flush" : ""}">${opts.children}</div>${opts.foot ? html`<div class="panel-foot">${opts.foot}</div>` : ""}</section>`;
}

export const Grid2 = (children: Child) => html`<div class="grid-2">${children}</div>`;
export const Grid3 = (children: Child) => html`<div class="grid-3">${children}</div>`;

export const Pill = ({ tone, children, title }: { tone?: Tone; children: Child; title?: string }) =>
  html`<span class="pill${toneClass(tone)}"${title ? html` title="${title}"` : ""}>${children}</span>`;

export const Dot = ({ tone, label }: { tone?: Tone; label?: string }) =>
  html`<span class="dot${toneClass(tone)}"${label ? html` role="img" aria-label="${label}" title="${label}"` : html` aria-hidden="true"`}></span>`;

const NOTICE_ICON: Record<Tone, IconName> = { ok: "ok", warn: "alert", bad: "error", accent: "info", neutral: "info" };

/** Something the operator should read before going on. */
export const Notice = ({ tone = "neutral", children }: { tone?: Tone; children: Child }) =>
  html`<div class="notice${toneClass(tone)}" role="${tone === "bad" ? "alert" : "note"}">${icon(NOTICE_ICON[tone])}<div>${children}</div></div>`;

/** Nothing here: say so plainly, and what it means. */
export const Empty = ({ title, children }: { title: string; children?: Child }) => html`<div class="empty"><strong>${title}</strong>${children ?? ""}</div>`;

/** Links that leave the app open in a new tab, so the app's own window stays put (Dovre addition). */
export const isExternal = (href: string) => /^https?:\/\//i.test(href);
export const newTab = (href: string) => (isExternal(href) ? html` target="_blank" rel="noopener noreferrer"` : "");

/** One row of a list; the whole row is the link when there is one. `more`: unclamped lines under it (Dovre addition). */
export function Item(opts: { href?: string; lead?: Child; leadTone?: Tone; title: Child; line?: Child; clamp?: Child; more?: Child; trail?: Child; quiet?: boolean; id?: string }): Html {
  const cls = `item${opts.quiet ? " quiet" : ""}`;
  const inner = html`<span class="lead${toneClass(opts.leadTone)}">${opts.lead ?? ""}</span><span class="main"><span class="title">${opts.title}</span>${opts.line ? html`<span class="line">${opts.line}</span>` : ""}${
    opts.clamp ? html`<span class="clamp">${opts.clamp}</span>` : ""
  }${opts.more ? html`<span class="more">${opts.more}</span>` : ""}</span><span class="trail">${opts.trail ?? ""}</span>`;
  return opts.href
    ? html`<li${opts.id ? html` id="${opts.id}"` : ""}><a class="${cls}" href="${opts.href}"${newTab(opts.href)}>${inner}</a></li>`
    : html`<li${opts.id ? html` id="${opts.id}"` : ""}><div class="${cls}">${inner}</div></li>`;
}

export const List = (children: Child) => html`<ul class="list">${children}</ul>`;

export const KeyValues = (pairs: [Child, Child][]) => html`<dl class="kv">${pairs.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;

/**
 * A button that needs a second click, no script: the first opens what will happen, the
 * second posts. For anything that changes something for a customer or can't be undone.
 */
export function Confirm(opts: { action: string; fields?: Record<string, string>; label: string; question: Child; danger?: boolean }): Html {
  return html`<details class="confirm"><summary>${opts.label}…</summary><div class="confirm-body"><p>${opts.question}</p><form method="post" action="${opts.action}">${Object.entries(opts.fields ?? {}).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  )}<button type="submit"${opts.danger ? html` class="danger"` : ""}>${opts.label}</button></form></div></details>`;
}

/**
 * A button that posts at once, no second click: for what's easily undone or only runs a job
 * again (mark read, mute, re-run, rebuild). Anything that changes something for a customer or
 * can't be undone is a Confirm.
 */
export function Post(opts: { action: string; fields?: Record<string, string>; label: Child; danger?: boolean }): Html {
  return html`<form class="post" method="post" action="${opts.action}">${Object.entries(opts.fields ?? {}).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  )}<button type="submit"${opts.danger ? html` class="danger"` : ""}>${opts.label}</button></form>`;
}

export { icon };
/** The escaping template every view is built with (packs too). `raw` stays out of reach: core only, around constants. */
export { html };

/** A card on Today (a pack's too): heading, a short line beside it, the body, and links at its foot. */
export function Card(opts: { id: string; title: Child; meta?: Child; foot?: Child; children: Child }): Html {
  const h = `${opts.id}-h`;
  return html`<section class="card" id="${opts.id}" data-live aria-labelledby="${h}"><div class="card-h"><h2 id="${h}">${opts.title}</h2>${opts.meta ? html`<p>${opts.meta}</p>` : ""}</div>${opts.children}${opts.foot ? html`<div class="card-f">${opts.foot}</div>` : ""}</section>`;
}

// ── Numbers (for packs' pages) ──

/**
 * A number worth a glance. With `href` the whole stat is the link to what explains it.
 * `delta`: the change against the period before, beside the value (a `Delta`). `viz`: what the
 * number is part of over time (a `Spark` or `Pulse`) or against a real limit (a `Gauge`) —
 * never a bar for its own sake.
 */
export function Stat(opts: { label: string; value: Child; delta?: Child; foot?: Child; viz?: Child; tone?: Tone; href?: string }): Html {
  const inner = html`<div class="label">${opts.label}</div><div class="value">${opts.value}${opts.delta ? html` ${opts.delta}` : ""}</div>${opts.foot ? html`<div class="foot">${opts.foot}</div>` : ""}${opts.viz ? html`<div class="stat-viz">${opts.viz}</div>` : ""}`;
  return opts.href ? html`<a class="stat${toneClass(opts.tone)}" href="${opts.href}">${inner}</a>` : html`<div class="stat${toneClass(opts.tone)}">${inner}</div>`;
}

export const Stats = (children: Child) => html`<div class="stats">${children}</div>`;

/**
 * The change against the period before: ▲ / ▼ and the amount. `good`: which way is good
 * ("up" for signups, "down" for errors) — it colours the change, ok or bad; without it, or
 * with no change, it stays neutral. The sign is in the text, so it's never colour alone.
 */
export function Delta({ value, good, format = (n: number) => new Intl.NumberFormat("en-GB").format(n), title }: { value: number; good?: "up" | "down"; format?: (n: number) => string; title?: string }): Html {
  const tone = !good || value === 0 ? "" : (value > 0) === (good === "up") ? " ok" : " bad";
  const sign = value > 0 ? "▲" : value < 0 ? "▼" : "±";
  return html`<span class="delta${tone}"${title ? html` title="${title}"` : ""}>${sign} ${format(Math.abs(value))}</span>`;
}

/**
 * A trend in a line, no axis: oldest left, the area under it faint. `tone` when the trend is a
 * status (it rarely is); otherwise it's ink. Hover tells the range; the numbers are elsewhere.
 * A `null` is a day nobody knows: the line breaks there rather than dropping to zero.
 */
export function Spark({ values, label, tone, height = 28, format }: { values: (number | null)[]; label: string; tone?: Tone; height?: number; format?: (n: number) => string }): Html | "" {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return "";
  const max = Math.max(...known);
  const min = Math.min(0, ...known);
  const w = 100;
  // A flat line sits mid-box, unless it is flat at zero: then on the floor, where zero is.
  const y = (v: number) => Math.round((max === min ? (max === 0 ? height - 1 : height / 2) : height - 1 - ((v - min) / (max - min)) * (height - 2)) * 10) / 10;
  const x = (i: number) => Math.round(((i * w) / (values.length - 1)) * 10) / 10;
  // Runs of known values; a lone known day between gaps is a dot-sized run of one.
  const runs: { i: number; v: number }[][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1]!.i === i - 1) last.push({ i, v });
    else runs.push([{ i, v }]);
  });
  const fmt = format ?? ((n: number) => new Intl.NumberFormat("en-GB").format(n));
  const first = known[0]!;
  const end = known[known.length - 1]!;
  const marks = runs.map((run) => {
    const pts = (run.length === 1 ? [run[0]!, { i: run[0]!.i + 0.0001, v: run[0]!.v }] : run).map((p) => `${x(p.i)},${y(p.v)}`).join(" ");
    const a = x(run[0]!.i);
    const b = x(run[run.length - 1]!.i);
    return html`<polygon class="spark-area" points="${`${a},${height} ${pts} ${b},${height}`}"></polygon><polyline class="spark-line" points="${pts}" vector-effect="non-scaling-stroke"></polyline>`;
  });
  const gaps = values.length - known.length;
  return html`<svg class="sparkline${toneClass(tone)}" viewBox="${`0 0 ${w} ${height}`}" preserveAspectRatio="none" role="img" aria-label="${`${label}: ${fmt(first)} to ${fmt(end)}${gaps ? `, ${gaps} ${gaps === 1 ? "day" : "days"} unknown` : ""}`}"><title>${`${label}: ${fmt(first)} → ${fmt(end)} (low ${fmt(Math.min(...known))}, high ${fmt(max)})`}</title>${marks}</svg>`;
}

/**
 * A day hour by hour: a column per hour, its height the requests, grey. An hour whose errors
 * reach `warnRate` of its requests (and 2 errors) is amber, `badRate` (and 3) red — status, so
 * the colour is earned, and a stray error in a quiet hour stays grey. Each column's hover says
 * the hour and its numbers. `labels`: each column's hour ("14:00").
 * `mark`: something that happened at a point in the day (a deploy), as a fraction 0–1 along it,
 * drawn as a thin accent line so what came after it can be read against it.
 */
export function Pulse({ requests, errors, labels, label, warnRate = 0.002, badRate = 0.01, mark }: { requests: number[]; errors: number[]; labels: string[]; label: string; warnRate?: number; badRate?: number; mark?: { at: number; label: string } }): Html | "" {
  if (!requests.length) return "";
  const n = requests.length;
  const H = 32;
  const max = Math.max(1, ...requests);
  const fmt = (v: number) => new Intl.NumberFormat("en-GB").format(v);
  const cols = requests.map((r, i) => {
    const e = errors[i] ?? 0;
    const h = r > 0 ? Math.max(2, Math.round((r / max) * (H - 2) * 10) / 10) : 1;
    const cls = r === 0 && e === 0 ? " none" : e >= Math.max(3, r * badRate) ? " bad" : e >= Math.max(2, r * warnRate) ? " warn" : "";
    return html`<g class="${`pulse-col${cls}`}"><rect class="pulse-hit" x="${i * 10}" y="0" width="10" height="${H}"></rect><rect class="pulse-bar" x="${i * 10 + 1}" y="${H - h}" width="8" height="${h}"></rect><title>${`${labels[i] ?? ""} · ${fmt(r)} requests${e ? ` · ${fmt(e)} ${e === 1 ? "error" : "errors"}` : ""}`}</title></g>`;
  });
  const errs = errors.reduce((a, b) => a + b, 0);
  const markLine =
    mark && mark.at >= 0 && mark.at <= 1
      ? html`<g class="pulse-mark"><rect x="${Math.round(mark.at * n * 10 * 10) / 10 - 0.75}" y="0" width="1.5" height="${H}"></rect><title>${mark.label}</title></g>`
      : "";
  return html`<svg class="pulse" viewBox="${`0 0 ${n * 10} ${H}`}" preserveAspectRatio="none" role="img" aria-label="${`${label}: ${fmt(requests.reduce((a, b) => a + b, 0))} requests, ${fmt(errs)} errors, hour by hour${mark ? `; ${mark.label}` : ""}`}">${cols}${markLine}</svg>`;
}

/** A compact horizontal progress / capacity gauge. Colour means status when `tone` is given. */
export function Gauge(opts: { value: number; max: number; tone?: Tone; title?: string; marker?: number }): Html {
  const pct = opts.max > 0 ? Math.min(100, Math.max(opts.value > 0 ? 1.5 : 0, Math.round((opts.value / opts.max) * 1000) / 10)) : 0;
  const markPct = opts.marker && opts.max > 0 ? Math.min(100, Math.max(0, Math.round((opts.marker / opts.max) * 1000) / 10)) : null;
  return html`<span class="gauge${toneClass(opts.tone)}"${opts.title ? html` title="${opts.title}"` : ""}><span class="gauge-fill" style="${`width: ${pct}%`}"></span>${
    markPct !== null ? html`<span class="gauge-mark" style="${`left: ${markPct}%`}"></span>` : ""
  }</span>`;
}
