/**
 * Views: `html` tagged templates from hono/html (Node can't run JSX). Every interpolated value
 * is escaped; arrays of `html` fragments join as markup; `raw()` only around constants. Links
 * built from data go through safeUrl() (src/pages/parts.ts). This file has the shell every
 * page sits in: the top bar, the page, the footer ridge.
 */
import { html } from "hono/html";
import type { IconName } from "./ui/icons.ts";
import { SPRITE } from "./ui/icons.ts";
import type { Html } from "./ui/kit.ts";
import { STYLE_PATH } from "./ui/style.ts";
import { SCRIPT_PATH } from "./ui/app.js.ts";
import type { AskView } from "./relay/asks.ts";
import type { DockView } from "./packs/registry.ts";
import { Confirm, icon } from "./ui/kit.ts";
import { currentTz } from "./when.ts";
import { isDefaultKeys, type KeyPrefs } from "./keys.ts";

/**
 * Folded or not, before the page draws (no flash): a tiny blocking script, since the page's policy
 * allows no inline script. It reads one localStorage key the main script writes.
 */
export const SIDE_PATH = "/assets/side.js";
export const SIDE_JS = `try{if(localStorage.getItem("u-side")==="slim")document.documentElement.classList.add("side-slim")}catch(e){}`;

export { html };
export type { Html };

/**
 * A page in the top bar. `count`: how many wait there (`hot`: they wait for you). `place`: a main
 * section (the default), under More, or a button on the right ("action"). `minor` is the old word
 * for More.
 */
export type NavItem = { href: string; title: string; icon?: IconName; group?: string; /** Its place within its group (lower first; unset: 50, in the order given). */ order?: number; count?: number; hot?: boolean; minor?: boolean; place?: "main" | "more" | "action"; /** A tab in the phone's bar at the foot (after Today, three at most, in nav order). */ tab?: boolean; /** Where among the tabs, when I've ordered them (src/layout.ts). */ tabAt?: number };
const placeOf = (p: NavItem) => p.place ?? (p.minor ? "more" : "main");
/** The menu's groups, in order (Today has none); any other group a pack names comes after these. */
export const NAV_GROUPS = ["", "Code", "Agents", "Plan", "Ops"];
const groupRank = (g: string) => (NAV_GROUPS.includes(g) ? NAV_GROUPS.indexOf(g) : NAV_GROUPS.length);

/** What every page knows: who's signed in, the sections (app.ts), when the data was gathered. */
/** The browser's bar in the page's colour (--sky): the picked theme's, else both, by the system's setting. */
/** Each theme's --sky (src/ui/style.ts; test/layout.test.ts holds them equal). */
export const SKY: Record<string, string> = { light: "#efe7db", dark: "#0e1922", birch: "#e6ebf0", polar: "#05080b", ember: "#1b140f" };
export function themeColor(theme?: string) {
  if (theme && Object.hasOwn(SKY, theme)) return html`<meta name="theme-color" content="${SKY[theme]}">`;
  return html`<meta name="theme-color" content="${SKY.light}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${SKY.dark}" media="(prefers-color-scheme: dark)">`;
}

export type Frame = { operator: string; nav: NavItem[]; syncedAt?: number; host?: string; /** What's shown is old and a gather is under way (a restart, a long sleep). */ syncing?: boolean; /** Questions waiting for my answer (src/relay/asks.ts). */ asks?: AskView[]; /** Bino can answer: its pane at the bottom right. */ bino?: boolean; /** The packs' docks after Bino's (src/packs/registry.ts docksFrom). */ docks?: DockView[]; /** What the Bino button looks like instead of the assistant icon (the packs' `bino.face` slot). */ face?: (o: { place: "dock" | "mini"; thinking?: boolean }) => Html | ""; /** The packs' bars for the top of the page (`banner`: an agent waiting for my OK on a tool). */ banners?: Html[]; /** Stylesheets beside the core's: the packs' (src/packs/). */ styles?: string[]; /** Scripts after the core's: the packs'. */ scripts?: string[]; /** The theme when picked, and the accent (Settings → Look); unset: the system's, fjord. */ look?: { theme?: string; accent?: string; /** Reading settings (#183): data-font, data-size, data-lh on <html>. */ font?: string; textSize?: string; lineHeight?: string; /** Bino's button: the assistant icon even when a pack draws a face (Settings → Look). */ binoIcon?: boolean; /** "always": animate even when the system asks for less motion (data-motion on <html>). */ motion?: "always"; /** The installed app sends links to other sites to the default browser (Settings → Layout, src/open-link.ts). */ links?: "default" }; tz?: string; greeting?: "en" | "no"; /** Pages listen on the hub's /live socket (hosted, H5) instead of /events. */ live?: "ws"; /** Settings → Keys (src/keys.ts); unset: the defaults. */ keys?: KeyPrefs };

/**
 * Bino's pane, docked at the bottom right of every page but Bino's own. Without script it's a link
 * to /bino; with it, it opens a panel holding /bino/dock in a frame (src/ui/app.js.ts), which keeps
 * its place while I move between pages.
 */
function binoDock(face: Html | ""): Html {
  // With a face (a pack's `bino.face`), the button is it; the pack's script may bring it to life.
  if (face) return html`<div class="tdock" id="bdock"><div class="tdock-panel" id="bdock-panel" hidden></div><a class="tdock-btn face-btn" id="bdock-btn" href="/bino" aria-controls="bdock-panel" aria-expanded="false" title="Bino (B)" aria-label="Bino">${face}</a></div>`;
  return html`<div class="tdock" id="bdock"><div class="tdock-panel" id="bdock-panel" hidden></div><a class="tdock-btn bino-btn" id="bdock-btn" href="/bino" aria-controls="bdock-panel" aria-expanded="false" title="Bino, your assistant (B)" aria-label="Bino">${icon("bino")}<span>Ask Bino</span></a></div>`;
}

/**
 * A pack's dock, the same way: a link to /<id>, a panel holding /<id>/dock with script. The page
 * script finds it by `data-dock` (src/ui/app.js.ts); its count is a live region of its own. With a
 * key (`data-dock-key`), that letter opens and closes it from any page.
 */
function packDock(d: DockView): Html {
  const id = `dock-${d.id}`;
  return html`<div class="tdock" id="${id}" data-dock="/${d.id}/dock" data-dock-title="${d.label}"${d.key ? html` data-dock-key="${d.key}"` : ""}><div class="tdock-panel" id="${id}-panel" hidden></div><a class="tdock-btn" id="${id}-btn" href="/${d.id}" aria-controls="${id}-panel" aria-expanded="false"${d.key ? html` title="${d.label} (${d.key})"` : ""}><span data-live id="${id}-n">${d.label}${d.count ? html`<b class="${d.hot ? "hot" : ""}"${d.title ? html` title="${d.title}"` : ""}>${d.hot ? "@ " : ""}${d.count}</b>` : ""}</span></a></div>`;
}

/** A page shown inside a dock (Bino's, a pack's): no top bar or footer, the same style and script. */
export function dockShell(opts: { title: string; body: Html | string; head?: Html | string; /** Stylesheets beside the core's (the packs'). */ styles?: string[]; /** Scripts after the core's (the packs'). */ scripts?: string[] }): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title}</title>
<link rel="stylesheet" href="${STYLE_PATH}">
${(opts.styles ?? []).map((h) => html`<link rel="stylesheet" href="${h}">`)}
<script type="module" src="${SCRIPT_PATH}"></script>
${(opts.scripts ?? []).map((h) => html`<script type="module" src="${h}"></script>`)}
${opts.head ?? ""}
</head>
<body class="dock-page">
${opts.body}
</body>
</html>`;
}

const within = (href: string, path: string) => path === href || (href !== "/" && path.startsWith(`${href.replace(/\/new$/, "")}/`)) || (href !== "/" && path === href.replace(/\/new$/, ""));

/** The docks at the bottom right: Bino, then the packs'; none on its own pages. */
function docksOf(frame: Frame, current: string): Html | "" {
  const bino = frame.bino && !within("/bino", current);
  const packs = (frame.docks ?? []).filter((d) => !within(`/${d.id}`, current));
  return bino || packs.length ? html`<div class="docks">${bino ? binoDock(frame.look?.binoIcon ? "" : (frame.face?.({ place: "dock" }) ?? "")) : ""}${packs.map(packDock)}</div>` : "";
}

const hm = (at: number, tz = currentTz()) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);

/** The mountain mark: a ridge, a summit cairn, the sun (src/ui/splash.ts). */
export { MARK } from "./ui/splash.ts";
import { MARK } from "./ui/splash.ts";

const SEARCH_ICON = html`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/></svg>`;


/**
 * An MCP server asking for my OK (a database tool before it opens production), on every page,
 * above everything else. The safe answer is one click; anything else takes a second. Empty, it's
 * still there so a live update can fill it.
 */
/**
 * Questions from one server with the same choices, two or more at once (a database tool asking to open several
 * production databases): answered together, the safe choice first, the rest behind a second click.
 */
export function groupsOf(asks: AskView[]): { groups: AskView[][]; rest: AskView[] } {
  const by = new Map<string, AskView[]>();
  for (const q of asks) {
    if (!q.choices.length) continue;
    const key = [q.server, q.field, ...q.choices.map((c) => c.value)].join("\u0000");
    by.set(key, [...(by.get(key) ?? []), q]);
  }
  const groups = [...by.values()].filter((g) => g.length > 1);
  const grouped = new Set(groups.flat().map((q) => q.id));
  return { groups, rest: asks.filter((q) => !grouped.has(q.id)) };
}

const choiceLabel = (v: string) => (v === "false" ? "No" : v === "true" ? "Yes" : v[0]!.toUpperCase() + v.slice(1));

function askGroup(g: AskView[]): Html {
  const ids = g.map((q) => q.id).join(",");
  const server = g[0]!.server;
  return html`<section class="approval" data-key="askg-${g[0]!.id}" aria-labelledby="askg-${g[0]!.id}"><div class="approval-text"><h2 id="askg-${g[0]!.id}">${server} asks ${g.length} questions</h2><ul class="approval-list">${g.map((q) => html`<li>${q.message.split("\n")[0]}</li>`)}</ul></div><div class="approval-do">${g[0]!.choices
    .filter((c) => c.safe)
    .map((c) => html`<form method="post" action="/relay/asks/answer"><input type="hidden" name="ids" value="${ids}"><input type="hidden" name="choice" value="${c.value}"><button type="submit" class="primary">${choiceLabel(c.value)} all</button></form>`)}${g[0]!.choices
    .filter((c) => !c.safe)
    .map((c) => Confirm({ kind: "relay.answer", action: "/relay/asks/answer", fields: { ids, choice: c.value }, label: `${choiceLabel(c.value)} all ${g.length}`, question: html`Answer <strong>${c.value}</strong> to all ${g.length} of ${server}'s questions? Each applies as it says above.`, danger: true }))}<form method="post" action="/relay/asks/answer"><input type="hidden" name="ids" value="${ids}"><input type="hidden" name="decline" value="1"><button type="submit" class="ghost">Decline all</button></form></div></section>`;
}

/** The bar at the top of every page: what the packs ask (an agent's tool, `banner`), then the relay's questions. */
function approvals(all: AskView[], banners: Html[] = []): Html {
  const { groups, rest: asks } = groupsOf(all);
  return html`<div data-live id="approvals">${banners}${groups.map(askGroup)}${asks.map(
    (q) => html`<section class="approval" data-key="ask-${q.id}" aria-labelledby="ask-${q.id}"><div class="approval-text"><h2 id="ask-${q.id}">${q.server} asks for your OK</h2><p class="approval-q">${q.message}</p></div><div class="approval-do">${q.choices
      .filter((c) => c.safe)
      .map((c) => html`<form method="post" action="/relay/ask/${q.id}/answer"><input type="hidden" name="choice" value="${c.value}"><button type="submit" class="primary">${c.value === "false" ? "No" : c.value[0]!.toUpperCase() + c.value.slice(1)}</button></form>`)}${q.choices
      .filter((c) => !c.safe)
      .map((c) => Confirm({ kind: "relay.answer", action: `/relay/ask/${q.id}/answer`, fields: { choice: c.value }, label: c.value === "true" ? "Yes" : c.value[0]!.toUpperCase() + c.value.slice(1), question: html`Answer <strong>${c.value}</strong> to ${q.server}? It applies as the server says above.`, danger: true }))}<form method="post" action="/relay/ask/${q.id}/answer"><input type="hidden" name="decline" value="1"><button type="submit" class="ghost">Decline</button></form></div></section>`,
  )}</div>`;
}

/**
 * On the phone, a bar at the foot instead of the menu behind a button: Today,
 * the tabs the nav marks (three at most), and More, which opens the full menu. A tab is one tap and
 * the bar says where I am. No marked tabs, no bar: the header's menu button stays.
 */
export function tabsOf(nav: NavItem[]): NavItem[] {
  const today = nav.find((p) => p.href === "/");
  const marked = nav.filter((p) => p.tab && p.href !== "/");
  const ordered = marked.map((p, i) => ({ p, k: (p.tabAt ?? 100) * 1000 + i })).sort((a, b) => a.k - b.k).map((x) => x.p);
  const tabs = [...(today ? [today] : []), ...ordered.slice(0, 3)];
  return tabs.length < 2 ? [] : tabs;
}

/** `gap`: Bino's button sits in the middle of the bar (style.ts moves it there), so the tabs leave it room. */
function tabBar(nav: NavItem[], here: NavItem | undefined, gap = false): Html | "" {
  const tabs = tabsOf(nav);
  if (!tabs.length) return "";
  const inMore = !!here && !tabs.includes(here);
  const tab = (p: NavItem) =>
    html`<a href="${p.href}"${p === here ? html` aria-current="page"` : ""}><span class="tab-ico">${icon(p.icon ?? "home")}${p.count ? html`<b class="${p.hot ? "hot" : ""}">${p.count > 99 ? "99+" : p.count}</b>` : ""}</span><span class="tab-lbl">${p.title}</span></a>`;
  // The middle of the bar, More counted; with an odd count the extra one goes left of the gap.
  const mid = Math.ceil((tabs.length + 1) / 2);
  const items = tabs.map(tab);
  if (gap) items.splice(mid, 0, html`<span class="tab-gap" aria-hidden="true"></span>`);
  // The two sides share the bar evenly around the gap (style.ts: gap-21, gap-22, gap-32), so the gap is the middle.
  const cls = gap ? `tabbar gap-${mid}${tabs.length + 1 - mid}` : "tabbar";
  return html`<nav class="${cls}" aria-label="Tabs"><div data-live id="tabs">${items}</div><button type="button" id="tab-more" class="${inMore ? "on" : ""}" aria-controls="side-sheet" aria-expanded="false"><span class="tab-ico">${icon("menu")}</span><span class="tab-lbl">More</span></button></nav>`;
}

export function shell(opts: { title: string; frame: Frame; current?: string; body: Html | string; head?: Html | string; read?: boolean }): Html {
  const { title, frame, current = "/", body, head = "" } = opts;
  // The current page: the longest href it's within (so /prs/stacks is Pull requests, /issues/new New work).
  const here = frame.nav.filter((p) => within(p.href, current)).sort((a, b) => b.href.length - a.href.length)[0];
  // A tab in the phone's bar is left out of the More sheet (the bar already holds it).
  const tabs = new Set(tabsOf(frame.nav));
  const link = (p: NavItem) =>
    html`<a href="${p.href}" title="${p.title}"${tabs.has(p) ? html` class="is-tab"` : ""}${p === here ? html` aria-current="page"` : ""}>${p.icon ? icon(p.icon) : ""}<span class="lbl">${p.title}</span>${p.count ? html`<b class="${p.hot ? "hot" : ""}">${p.count}</b>` : ""}</a>`;
  // The side menu's groups, in the order they first appear; "You" goes to the foot.
  const groups: [string, NavItem[]][] = [];
  for (const p of frame.nav.filter((x) => placeOf(x) !== "action" && x.group !== "You")) {
    const g = p.group ?? "";
    const at = groups.find(([name]) => name === g);
    if (at) at[1].push(p);
    else groups.push([g, [p]]);
  }
  // The core's groups in their order, a pack's own group after them; a pack's items take their place in their group (both sorts are stable).
  groups.sort((a, b) => groupRank(a[0]) - groupRank(b[0]));
  for (const [, items] of groups) items.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const you = frame.nav.filter((p) => p.group === "You");
  return html`<!doctype html>
<html lang="en"${frame.look?.theme ? html` data-theme="${frame.look.theme}"` : ""}${frame.look?.accent ? html` data-accent="${frame.look.accent}"` : ""}${frame.look?.font ? html` data-font="${frame.look.font}"` : ""}${frame.look?.textSize ? html` data-size="${frame.look.textSize}"` : ""}${frame.look?.lineHeight ? html` data-lh="${frame.look.lineHeight}"` : ""}${frame.look?.motion ? html` data-motion="${frame.look.motion}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="${STYLE_PATH}">
${(frame.styles ?? []).map((href) => html`<link rel="stylesheet" href="${href}">`)}
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
${themeColor(frame.look?.theme)}
<meta name="u-tz" content="${frame.tz ?? currentTz()}">${frame.keys && !isDefaultKeys(frame.keys) ? html`
<meta name="u-keys" content="${JSON.stringify(frame.keys)}">` : ""}${frame.live ? html`
<meta name="u-live" content="${frame.live}">` : ""}${frame.look?.links ? html`
<meta name="u-links" content="${frame.look.links}">` : ""}
<script src="${SIDE_PATH}"></script>
<script type="module" src="${SCRIPT_PATH}"></script>
${(frame.scripts ?? []).map((h) => html`<script type="module" src="${h}"></script>`)}
${head}
</head>
<body>
${SPRITE}
<div class="shell">
<nav class="side" id="side" aria-label="Sections">
<div class="side-top"><a class="brand" href="/" aria-label="Dovre, Today">${MARK}<span>Dovre</span></a><button type="button" class="side-menu" id="side-menu" aria-controls="side-nav" aria-expanded="false" title="Menu">${icon("menu")}</button></div>
<a class="search-btn" id="search-btn" href="/search" aria-keyshortcuts="Control+K" title="Search (Ctrl K)">${SEARCH_ICON}<span class="lbl">Search</span><kbd>Ctrl K</kbd></a>
<div class="side-sheet" id="side-sheet">
<div class="side-nav" id="side-nav"><div data-live id="nav">${groups.map(([g, items]) => html`<div class="${`side-g${items.every((p) => tabs.has(p)) ? " all-tabs" : ""}`}">${g ? html`<p class="side-h">${g}</p>` : ""}${items.map(link)}</div>`)}</div></div>
<div class="side-foot">
<form method="post" action="/refresh" id="refresh"><button type="submit" class="side-sync" title="Refresh: gather everything now">${icon("refresh")}<span class="lbl"><span class="live-dot" id="live-dot" aria-hidden="true"></span><span id="synced">${frame.syncing ? "Syncing…" : frame.syncedAt ? `Synced ${hm(frame.syncedAt, frame.tz)}` : "Not synced yet"}</span></span></button></form>
${you.map(link)}
<button type="button" class="side-fold" id="side-fold" aria-pressed="false" title="Fold the menu">${icon("fold")}<span class="lbl">Fold</span></button>
</div>
</div>
</nav>
<div class="wrap">
${approvals(frame.asks ?? [], frame.banners ?? [])}
<main class="page">
${body}
</main>
<footer class="foot">
<svg viewBox="0 0 1400 56" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M0 55 90 30 140 42 230 12 300 36 360 26 450 48 540 20 600 31 690 6 760 34 830 24 910 44 990 16 1050 30 1130 22 1210 46 1290 28 1400 50"/><path d="M0 55 60 46 160 52 260 40 380 50 470 38 600 52 720 42 860 52 980 40 1100 50 1240 42 1400 54" opacity=".6"/></svg>
<p><span>Dovre · <kbd>?</kbd> for keys</span><span>${frame.host ?? "GHE"} as ${frame.operator}</span></p>
</footer>
</div>
</div>
${tabBar(frame.nav, here, !!frame.bino && !within("/bino", current))}
${docksOf(frame, current)}
</body>
</html>`;
}
