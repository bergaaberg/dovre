/**
 * The one stylesheet: the morning view (design direction C, 2026-10-22). Snow, granite and fjord
 * by day; night in the mountains by dark. Served as /assets/app.<hash>.css.
 * Order: tokens → base → shell → briefing and horizon → cards and rows → the kit's classes
 * (pages built from src/ui/kit.ts) → page parts. Colour means status: ok, warn, bad. The accent
 * (fjord) is for links, your own things, the sun and agents.
 */
import { ISSUES_CSS } from "../issues/style.ts";
import { SPLASH_CSS } from "./splash.ts";

/** Numbers and charts (src/ui/kit.ts Stat…Gauge, src/ui/charts.view.ts). */
const CHARTS_CSS = String.raw`
.viz svg.wide { display: block; } .viz.wide-only { display: block; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem; margin: 0 0 1.1rem; }
.stat { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 0.75rem 0.95rem; text-decoration: none; box-shadow: var(--shadow); min-width: 0; transition: border-color 0.15s ease, transform 0.15s ease; }
a.stat:hover { border-color: var(--accent-line); background: color-mix(in srgb, var(--accent-soft) 22%, var(--surface)); }
.stat .label { color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; }
.stat .value { font-size: 1.6rem; font-weight: 650; letter-spacing: -0.025em; line-height: 1.25; margin-top: 0.15rem; }
.stat .foot { color: var(--text-2); font-size: var(--fs-sm); display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; margin-top: 0.15rem; }
.stat .stat-viz { margin-top: 0.45rem; }
.stat.bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); background: color-mix(in srgb, var(--bad-soft) 28%, var(--surface)); } .stat.bad .value { color: var(--bad); }
.stat.warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); background: color-mix(in srgb, var(--warn-soft) 28%, var(--surface)); } .stat.warn .value { color: var(--warn); }
.stat.ok { border-color: color-mix(in srgb, var(--ok) 35%, var(--border)); } .stat.ok .value { color: var(--ok); }
.stat.accent { border-color: var(--accent-line); } .stat.accent .value { color: var(--accent); }
.delta { font-size: var(--fs-sm); font-weight: 600; letter-spacing: 0; color: var(--text-2); white-space: nowrap; vertical-align: 0.2em; }
.delta.ok { color: var(--ok); } .delta.bad { color: var(--bad); }
.stat .value { font-variant-numeric: proportional-nums; }
svg.sparkline { display: block; width: 100%; height: 28px; overflow: visible; }
svg.sparkline .spark-line { fill: none; stroke: var(--text-2); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
svg.sparkline .spark-area { fill: var(--text-2); opacity: 0.08; }
svg.sparkline.accent .spark-line { stroke: var(--accent); } svg.sparkline.accent .spark-area { fill: var(--accent); }
svg.sparkline.ok .spark-line { stroke: var(--ok); } svg.sparkline.ok .spark-area { fill: var(--ok); }
svg.sparkline.warn .spark-line { stroke: var(--warn); } svg.sparkline.warn .spark-area { fill: var(--warn); }
svg.sparkline.bad .spark-line { stroke: var(--bad); } svg.sparkline.bad .spark-area { fill: var(--bad); }
svg.pulse { display: block; width: 100%; height: 28px; }
svg.pulse .pulse-hit { fill: transparent; }
svg.pulse .pulse-bar { fill: color-mix(in srgb, var(--text-3) 55%, transparent); }
svg.pulse .pulse-col.none .pulse-bar { fill: var(--border); }
svg.pulse .pulse-col.warn .pulse-bar { fill: var(--warn); }
svg.pulse .pulse-col.bad .pulse-bar { fill: var(--bad); }
svg.pulse .pulse-col:hover .pulse-bar { fill: var(--text); }
svg.pulse .pulse-mark rect { fill: var(--accent); }
.gauge { position: relative; display: block; height: 6px; width: 100%; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.gauge-fill { display: block; height: 100%; background: var(--s1); border-radius: 999px; }
.gauge.accent .gauge-fill { background: var(--accent); }
.gauge.ok .gauge-fill { background: var(--ok); }
.gauge.warn .gauge-fill { background: var(--warn); }
.gauge.bad .gauge-fill { background: var(--bad); }
.gauge-mark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text); opacity: 0.65; }
/* A bare item has no lead: the text takes the room, the end keeps its words whole (at most half the row). On the phone the end goes under the text. */
.item.bare { grid-template-columns: minmax(0, 1fr) auto; }
.item.bare > .end { text-align: right; color: var(--text-2); font-size: var(--fs-sm); max-width: 50%; justify-self: end; overflow-wrap: break-word; padding-top: 0.1rem; }
@media (max-width: 40rem) {
  .item.bare { grid-template-columns: minmax(0, 1fr); }
  .item.bare > .end { max-width: none; justify-self: start; text-align: left; padding-top: 0.25rem; }
}
.item.bare > .main > form, .item.bare > .end > form { margin: 0; }
.panel-head svg.sparkline, .panel-head .meta svg.sparkline { display: inline-block; width: 120px; height: 24px; vertical-align: middle; }
td.pulse-cell svg.pulse { height: 22px; }
.health-card svg.pulse { height: 26px; }
.item .line svg.pulse { height: 18px; margin-top: 0.35rem; }
/* Issues (src/packs/core/issues/): labels are neutral pills; the trail holds linked PRs, sub-issue progress and stale. */
.issue-ref { font: 600 var(--fs-xs)/1.4 var(--mono); color: var(--text-2); white-space: nowrap; }
.issue-labels { display: inline-flex; flex-wrap: wrap; gap: .25rem; vertical-align: middle; margin-right: .35rem; }
.issue-trail { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .35rem; }
.issue-subs { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs); color: var(--text-2); }
.issue-subs .gauge { width: 3rem; }
.issue-acts { margin-top: .4rem; }
.issue-acts > summary { cursor: pointer; font-size: var(--fs-xs); color: var(--text-2); }
.issue-acts-body { display: flex; flex-wrap: wrap; align-items: flex-start; gap: .5rem; padding-top: .5rem; }
.issue-comment { display: flex; flex-wrap: wrap; gap: .4rem; flex: 1 1 18rem; margin: 0; }
.issue-comment textarea { flex: 1 1 14rem; min-height: 2.4rem; }
.issue-comment-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 1rem; padding: .75rem 1rem; border-left: 3px solid var(--line); background: var(--surface-2); }
.viz svg.narrow { display: none; }
.viz svg text.end { fill: var(--text); font-size: 12px; font-weight: 500; }
.viz .base { stroke: var(--axis); stroke-width: 1; }
.viz .limit { stroke: var(--warn); stroke-width: 1.25; stroke-dasharray: 4 3; }
.viz svg text.limit-label { fill: var(--warn); font-weight: 600; }
.viz .cross { stroke: var(--text-2); stroke-width: 1; stroke-dasharray: 3 3; visibility: hidden; }
.viz .col:hover .cross, .viz .col.picked .cross { visibility: visible; }
.viz rect.cell.picked { stroke: var(--text); stroke-width: 1.5; }
.viz .hit { fill: transparent; }
.viz .bar:hover, .viz .cell:hover { opacity: 0.78; }
.viz .zero { fill: var(--surface-2); }
.viz .sankey-link { fill-opacity: 0.28; transition: fill-opacity 0.15s ease; }
.viz .sankey-link:hover { fill-opacity: 0.62; }
.viz .sankey-node { rx: 3px; }
ol.funnel { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
ol.funnel > li { display: grid; grid-template-columns: minmax(7rem, 14rem) minmax(0, 1fr) minmax(6.5rem, auto); gap: 0.75rem; align-items: center; }
ol.funnel .f-label { font-weight: 500; text-align: right; overflow-wrap: anywhere; }
ol.funnel .f-track { position: relative; display: block; height: 20px; background: var(--surface-2); border-radius: var(--r-sm); overflow: hidden; }
ol.funnel .f-ghost, ol.funnel .f-bar { position: absolute; left: 0; top: 0; bottom: 0; border-radius: var(--r-sm); }
ol.funnel .f-ghost { background: color-mix(in srgb, var(--s1) 16%, transparent); }
ol.funnel .f-bar { background: var(--s1); }
ol.funnel .f-bar.s2 { background: var(--s2); } ol.funnel .f-bar.s3 { background: var(--s3); }
ol.funnel .f-num { white-space: nowrap; font-variant-numeric: tabular-nums; }
/* On the phone the label and number share a line and the bar runs full width under them: beside a long label it had no room left. */
@media (max-width: 40rem) {
  ol.funnel { gap: 0.8rem; }
  ol.funnel > li { grid-template-columns: minmax(0, 1fr) auto; gap: 0.3rem 0.75rem; }
  ol.funnel .f-label { text-align: left; }
  ol.funnel .f-track { grid-column: 1 / -1; grid-row: 2; height: 14px; }
}
.legend .key { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 0.35rem; }
.legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 1px; }
ul.hbars { list-style: none; padding: 0; margin: 0.5rem 0 1rem; }
ul.hbars li { display: grid; grid-template-columns: minmax(8rem, 15rem) 1fr auto; gap: 0.75rem; align-items: center; padding: 0.25rem 0; }
ul.hbars .track { display: block; height: 0.65rem; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
ul.hbars .fill { display: block; height: 100%; background: linear-gradient(90deg, var(--s1), color-mix(in srgb, var(--s1) 80%, var(--accent))); border-radius: 4px; min-width: 2px; }
ul.hbars .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stack-wrap { padding: 0.65rem 1rem; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--surface-2) 35%, var(--surface)); }
.panel-body:not(.flush) > .stack-wrap { padding: 0 0 0.65rem; margin-bottom: 0.65rem; background: transparent; }
.stack-bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--surface-2); gap: 2px; margin-bottom: 0.4rem; }
.stack-seg { display: block; height: 100%; min-width: 3px; flex: 0 1 0; }
.div-bar { display: grid; grid-template-columns: minmax(0, 1fr) 2px minmax(0, 1fr); align-items: center; height: 8px; margin-top: 0.35rem; max-width: 26rem; }
.div-bar > .div-neg, .div-bar > .div-pos { display: flex; height: 100%; background: var(--surface-2); }
.div-bar > .div-neg { justify-content: flex-end; border-radius: 999px 0 0 999px; }
.div-bar > .div-pos { border-radius: 0 999px 999px 0; }
.div-neg > span { display: block; height: 100%; background: var(--s2); border-radius: 999px 0 0 999px; }
.div-pos > span { display: block; height: 100%; background: var(--s1); border-radius: 0 999px 999px 0; }
.div-mid { height: 14px; background: var(--axis); }
.legend.div-key { margin: 0; font-size: var(--fs-sm); }
.swatch.div-l { background: var(--s2); } .swatch.div-r { background: var(--s1); }
`;

/** Night's tokens: under the system's dark, and under a picked dark. */
const DARK = String.raw`    /* night in the mountains: blue-black sky, moonlit snow */
    --bg: #0a1117; --sky: #0e1922; --surface: #111c25; --surface-2: #15222c; --hover: #1a2833;
    --ink: #e6ecf0; --ink-2: #b2bec7; --ink-3: #8c9aa5;
    --line: #1f2e39; --line-2: #2c3d4a;
    --accent: #84b9df; --accent-ink: #07131c; --accent-soft: #15293a; --accent-line: #2a4a63;
    --hint: #f4cc3f; --hint-ink: #1a1300; --hint-line: #8a6d00;
    --ok: #8cc37a; --ok-soft: #15261a;
    --warn: #e5b65c; --warn-soft: #2a2113;
    --bad: #f2828f; --bad-soft: #2f161c;
    --c1: #3987e5; --c2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181;
    --h1: #103b73; --h2: #184f95; --h3: #256abf; --h4: #3987e5; --h5: #6da7ec; --h6: #9ec5f4;
    --ridge-farthest: #101c26; --ridge-far: #172633; --ridge-near: #253a4a; --ridge-deep: #162533; --ridge-edge: #5a7a90;
    --snow: #c9d7e1; --night: #060d14; --star: #dce7ef; --flag-bot: #4f6576; --sun: #c9d7e1;
    --shadow: 0 1px 0 rgb(255 255 255 / .02) inset, 0 14px 40px -24px rgb(0 0 0 / .8);`;

/** An accent's four tokens: its own colour, the ink on it, and its soft fill and line mixed from the surface. */
const accent = (c: string, ink: string, surface: string, soft: number, line: number) =>
  `--accent: ${c}; --accent-ink: ${ink}; --accent-soft: color-mix(in srgb, ${c} ${soft}%, ${surface}); --accent-line: color-mix(in srgb, ${c} ${line}%, ${surface});`;
/** fjord is the default (the tokens above); these are the others. Values from the check in PLAN WP-N5. */
const ACCENT_LIGHT = { heather: accent("#6a4c9c", "#ffffff", "#fffdfa", 13, 32), glacier: accent("#0e6a8f", "#ffffff", "#fffdfa", 12, 30) };
const ACCENT_DARK = { heather: accent("#a99cf0", "#07131c", "#111c25", 16, 34), glacier: accent("#5fc0e8", "#07131c", "#111c25", 16, 34) };

export const STYLE = String.raw`
/* ── Type: Nordwand Mono everywhere (assets/fonts, SIL OFL 1.1; tywr/Nordwand-Mono 1.3.3) ── */
@font-face { font-family: "Nordwand Mono"; src: url("/assets/fonts/NordwandMono-Light.woff2") format("woff2"); font-weight: 300; font-style: normal; font-display: swap; }
@font-face { font-family: "Nordwand Mono"; src: url("/assets/fonts/NordwandMono-Regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "Nordwand Mono"; src: url("/assets/fonts/NordwandMono-Italic.woff2") format("woff2"); font-weight: 400; font-style: italic; font-display: swap; }
@font-face { font-family: "Nordwand Mono"; src: url("/assets/fonts/NordwandMono-Medium.woff2") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: "Nordwand Mono"; src: url("/assets/fonts/NordwandMono-SemiBold.woff2") format("woff2"); font-weight: 600; font-style: normal; font-display: swap; }
@font-face { font-family: "Nordwand Mono"; src: url("/assets/fonts/NordwandMono-Bold.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }

/* ── Tokens ─────────────────────────────────────────────────────────────── */
:root {
  /* The bottom inset, held still: Chrome on Android animates safe-area-inset-bottom as its toolbar
     shows and hides, which moved the tab bar while scrolling. Elsewhere the max isn't known: the plain inset. */
  --sab: env(safe-area-max-inset-bottom, env(safe-area-inset-bottom, 0px));
  color-scheme: light dark;
  --nordwand: "Nordwand Mono", "Cascadia Mono", Consolas, monospace;
  --serif: var(--nordwand);
  --serif-text: var(--nordwand);
  --sans: var(--nordwand);
  --display: var(--nordwand);
  --mono: var(--nordwand);
  --fs-xs: 12px; --fs-s: 13px; --fs-m: 15px; --fs-l: 18px; --fs-xl: 23px; --fs-hero: 50px;
  --r: 16px; --r-s: 9px;

  /* morning in the cabin: oat and cream, espresso ink, warm stone (PLAN WP-M2) */
  --bg: #f8f4ee; --sky: #efe7db; --surface: #fffdfa; --surface-2: #f8f3ed; --hover: #f1ebe2;
  --ink: #2a1d14; --ink-2: #54453a; --ink-3: #65564a;
  --line: #e9e1d5; --line-2: #d6cabb;
  --accent: #1d5c88; --accent-ink: #ffffff; --accent-soft: #e3edf5; --accent-line: #b9cfe0;
  /* the f / F hint letters: an overlay, not a status, so a colour of their own (Vimium's yellow) */
  --hint: #ffd84a; --hint-ink: #1f1700; --hint-line: #b8930c;
  --ok: #3d7230; --ok-soft: #e6efdf;
  --warn: #965800; --warn-soft: #faf0db;
  --bad: #ad1f3b; --bad-soft: #f9e3e7;
  /* Chart series (src/ui/chart.ts), checked with the dataviz validator on --surface: identity, not status. */
  --c1: #2a78d6; --c2: #eb6834;
  --ridge-farthest: #ebe2d5; --ridge-far: #d8cbb9; --ridge-near: #ab9883; --ridge-deep: #8c7864; --ridge-edge: #6e5c4b;
  --snow: #fffdfa; --night: #e3d8c8; --star: #fffdfa; --flag-bot: #ab9c8e; --sun: var(--accent);
  --shadow: 0 1px 2px rgb(42 29 20 / .05), 0 10px 30px -18px rgb(42 29 20 / .2);

  /* the kit's token aliases, on these values */
  --text: var(--ink); --text-2: var(--ink-2); --text-3: var(--ink-3); --border: var(--line); --border-2: var(--line-2);
  --fs-sm: var(--fs-s); --fs: 14px; --fs-md: var(--fs-m); --fs-lg: var(--fs-l); --r-lg: var(--r); --r-sm: 6px; --font: var(--sans);
  /* the charts' (src/ui/charts.view.ts): series are identity, not status */
  --s1: var(--c1); --s2: var(--c2); --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --grid: var(--line); --axis: var(--line-2);
  /* the blue ramp (heatmaps, ordered outcomes): h1 faintest, h6 strongest on this surface */
  --h1: #cde2fb; --h2: #9ec5f4; --h3: #6da7ec; --h4: #3987e5; --h5: #256abf; --h6: #184f95;
}
/* The accents (Settings → Layout), each checked against ok, warn and bad with the dataviz validator
   in both themes (colour blind and not) and for text contrast; green, amber and red stay status. */
:root[data-accent="heather"] { ${ACCENT_LIGHT.heather} }
:root[data-accent="glacier"] { ${ACCENT_LIGHT.glacier} }
/* Night: the system's dark unless I've picked light, or dark whatever the system says (Settings → Layout). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${DARK}
  }
  :root:not([data-theme="light"])[data-accent="heather"] { ${ACCENT_DARK.heather} }
  :root:not([data-theme="light"])[data-accent="glacier"] { ${ACCENT_DARK.glacier} }
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] {
  color-scheme: dark;
${DARK}
}
:root[data-theme="dark"][data-accent="heather"] { ${ACCENT_DARK.heather} }
:root[data-theme="dark"][data-accent="glacier"] { ${ACCENT_DARK.glacier} }

/* ── Base ───────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: var(--fs-m)/1.5 var(--sans); font-variant-numeric: tabular-nums;
  background-image: linear-gradient(180deg, var(--sky) 0, var(--bg) 560px); background-repeat: no-repeat; }
a { color: inherit; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
a:hover { color: var(--accent); text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
h1, h2, h3, h4, h5 { margin: 0; text-wrap: balance; }
p { margin: 0.5rem 0; }
code, kbd, .mono { font-family: var(--mono); font-size: 0.88em; }
code { background: var(--surface-2); border: 1px solid var(--line); padding: .1em .36em; border-radius: 5px; overflow-wrap: anywhere; }
pre code { border: 0; padding: 0; background: none; }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.25rem 0; }
:where(svg[aria-hidden="true"]) { width: 1.15em; height: 1.15em; flex: none; vertical-align: -0.2em; }
details > summary { cursor: pointer; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.t2 { color: var(--ink-2); } .t3 { color: var(--ink-3); } .sm { font-size: var(--fs-s); } .nowrap { white-space: nowrap; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }

/* ── Shell: the side menu, the page, the footer ridge ───────────────────── */
/* The side menu is quiet: no panel of its own, the morning sky runs behind it. Folded, icons only. */
.shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100vh; }
.side-slim .shell { grid-template-columns: 62px minmax(0, 1fr); }
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; scrollbar-width: thin; display: flex; flex-direction: column; padding: 20px 10px 14px 16px; font-size: var(--fs-s); color: var(--ink-2); border-right: 1px solid var(--line); }
.side-top { display: flex; align-items: center; justify-content: space-between; margin: 0 0 16px 4px; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--ink); }
.brand svg { width: 30px; height: 22px; color: var(--accent); flex: none; }
.brand span { font: 600 21px/1 var(--serif); letter-spacing: .01em; }
.side-menu { display: none; border: 0; background: none; padding: 6px; color: var(--ink-2); }
.side-menu svg { width: 20px; height: 20px; }
.side-nav { display: flex; flex-direction: column; }
.side-g { display: grid; gap: 1px; margin: 0 0 12px; }
.side-h { margin: 6px 0 3px 10px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.side a, .side-sync, .side-fold { display: flex; align-items: center; gap: 11px; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px; background: none; font: inherit; color: var(--ink-2); text-align: left; text-decoration: none; white-space: nowrap; cursor: pointer; }
.side a > svg, .side-sync > svg, .side-fold > svg { width: 17px; height: 17px; flex: none; color: var(--ink-3); }
.side a:hover, .side-sync:hover, .side-fold:hover { background: var(--hover); color: var(--ink); }
.side a[aria-current="page"] { background: var(--accent-soft); color: var(--ink); }
.side a[aria-current="page"] > svg { color: var(--accent); }
.side a b { margin-left: auto; font-weight: 600; font-size: var(--fs-xs); color: var(--ink-3); }
.side a b.hot { color: var(--warn); }
.side .brand { padding: 0; }
.side .brand > svg { width: 30px; height: 22px; color: var(--accent); }
.side-sync, .side-fold { justify-content: flex-start; }
.side .brand:hover { background: none; }
.side .search-btn { width: 100%; margin: 0 0 14px; }
.search-btn .lbl { flex: 1; text-align: left; }
.side-foot { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--line); display: grid; gap: 1px; }
.side-foot form { margin: 0; }
.side-sync .lbl { font-size: var(--fs-xs); color: var(--ink-3); }
.side-slim .side { padding: 20px 8px 14px; }
.side-slim .side .lbl, .side-slim .side-h, .side-slim .side a b, .side-slim .side .search-btn kbd, .side-slim .side .brand span { display: none; }
.side-slim .side a, .side-slim .side-sync, .side-slim .side-fold, .side-slim .side .search-btn { justify-content: center; padding: 8px 0; }
.side-slim .side-top { justify-content: center; margin-left: 0; }
.side-slim .side-fold > svg { transform: rotate(180deg); }
.wrap { max-width: 1400px; margin: 0 auto; padding: 0 44px; min-width: 0; width: 100%; }
@media (max-width: 1360px) { .wrap { padding: 0 32px; } }
@media (max-width: 900px) {
  /* Two rows, bar and page: on a short page the spare height goes to the page, never to the bar. */
  .shell, .side-slim .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .side, .side-slim .side { z-index: 40; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--line); background: var(--bg); }
  .side-top { margin: 0; flex: 1; } .side-menu { display: inline-grid; }
  .side .search-btn { width: auto; margin: 0; } .side .search-btn .lbl, .side .search-btn kbd { display: none; }
  .side-nav, .side-foot { display: none; width: 100%; } .side.open .side-nav { display: flex; } .side.open .side-foot { display: grid; }
  .side-fold { display: none; }
  .side-slim .side .lbl, .side-slim .side-h, .side-slim .side a b, .side-slim .side .brand span { display: revert; }
  .side-slim .side a, .side-slim .side-sync { justify-content: flex-start; padding: 6px 10px; }
}
@media (max-width: 720px) { .wrap { padding: 0 16px; } }
/* The phone's tab bar (src/html.ts tabBar): fixed at the foot; More opens the menu in the header, which then scrolls on its own. */
.tabbar { display: none; }
.side-sheet { display: contents; }
@media (max-width: 900px) {
  body:has(.tabbar) .side-menu { display: none; }
  body:not(:has(.tabbar)) .side.open { max-height: 100dvh; overflow-y: auto; }
  /* More: the rest of the menu as a sheet above the bar, the page dimmed behind it; a tap outside closes it (app.js). */
  body:has(.tabbar) .side-sheet { display: none; }
  body:has(.tabbar) .side.open .side-sheet { display: block; position: fixed; left: 0; right: 0; bottom: calc(58px + var(--sab)); z-index: 1; max-height: calc(100dvh - 140px); overflow-y: auto; overscroll-behavior: contain; padding: 14px 16px 10px; background: var(--surface); border-top: 1px solid var(--line-2); border-radius: 16px 16px 0 0; box-shadow: 0 -16px 40px -16px rgb(0 0 0 / .5); }
  body:has(.tabbar) .side.open::before { content: ""; position: fixed; inset: 0; z-index: 0; background: rgb(0 0 0 / .45); }
  body:has(.tabbar) .side-sheet .is-tab, body:has(.tabbar) .side-sheet .all-tabs { display: none; }
  body:has(.tabbar):has(.side.open) { overflow: hidden; }
  .tabbar { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); position: fixed; left: 0; right: 0; bottom: 0; z-index: 45; background: var(--bg); border-top: 1px solid var(--line); padding: 0 env(safe-area-inset-right) var(--sab) env(safe-area-inset-left); }
  #tabs { display: contents; }
  .tabbar a, .tabbar button { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-width: 0; height: 58px; padding: 0 4px; border: 0; border-radius: 0; background: none; font: 500 11px/1 var(--sans); color: var(--ink-3); text-decoration: none; cursor: pointer; }
  .tabbar .tab-ico { position: relative; display: inline-flex; }
  .tabbar .tab-ico svg { width: 22px; height: 22px; }
  .tabbar .tab-lbl { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabbar a[aria-current="page"], .tabbar button.on, .tabbar button[aria-expanded="true"] { color: var(--ink); font-weight: 600; }
  .tabbar a[aria-current="page"] svg, .tabbar button.on svg, .tabbar button[aria-expanded="true"] svg { color: var(--accent); }
  .tabbar b { position: absolute; top: -6px; left: 14px; min-width: 18px; padding: 2px 5px; border: 2px solid var(--bg); border-radius: 999px; background: var(--ink-2); color: var(--bg); font: 600 10px/1 var(--sans); text-align: center; font-variant-numeric: tabular-nums; }
  .tabbar b.hot { background: var(--warn); }
  body:has(.tabbar) .wrap { padding-bottom: calc(66px + var(--sab)); }
  body:has(.tabbar) .docks { bottom: calc(70px + var(--sab)); }
  /* Bino's button in the middle of the bar (the tab-gap holds its place): round, raised above the bar's
     edge, a ring of the page's colour around it so it reads as set into the bar. */
  .tab-gap { display: block; }
  .tabbar.gap-21 { grid-template-columns: 1fr 1fr 76px 2fr; }
  .tabbar.gap-22 { grid-template-columns: 1fr 1fr 76px 1fr 1fr; }
  .tabbar.gap-32 { grid-template-columns: 2fr 2fr 2fr 76px 3fr 3fr; }
  body:has(.tab-gap) #bdock-btn { position: fixed; left: calc(50% - 31px); bottom: calc(10px + var(--sab)); z-index: 1; width: 62px; height: 62px; padding: 0; justify-content: center; border-width: 1.5px; border-radius: 50%; background: radial-gradient(circle at 50% 30%, var(--surface-2), var(--surface) 70%); box-shadow: 0 0 0 5px var(--bg), 0 0 0 6px var(--line), 0 10px 24px -10px var(--accent); transition: transform .15s ease-out; }
  body:has(.tab-gap) #bdock-btn:active { transform: scale(.94); }
  body:has(.tab-gap) .av-say { position: fixed; left: 50%; right: auto; bottom: calc(86px + var(--sab)); max-width: calc(100vw - 32px); transform: translateX(-50%); }
  body:has(.tab-gap) .av-say::after { right: calc(50% - 5px); }
  body:has(.side.open) #bdock-btn, body:has(.side.open) .av-say { display: none; }
}
.tdock.open > .av-say { display: none; }
a.ava { text-decoration: none; }/* Search (Ctrl K): the button in the top bar, and the palette it opens (src/ui/app.js.ts) */
.search-btn { display: inline-flex; align-items: center; gap: 8px; padding: 5px 7px 5px 10px; border: 1px solid var(--line-2); border-radius: var(--r-s); background: var(--surface); color: var(--ink-3); text-decoration: none; }
.search-btn:hover { border-color: var(--accent-line); color: var(--ink-2); }
.search-btn svg { width: 15px; height: 15px; }
.search-btn kbd { font-size: 11px; }
dialog.palette { width: min(680px, calc(100vw - 32px)); max-height: 76vh; margin: 11vh auto auto; padding: 0; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); color: var(--ink); box-shadow: 0 24px 70px -12px rgb(0 0 0 / .55); overflow: hidden; }
dialog.palette[open] { display: flex; flex-direction: column; }
dialog.palette::backdrop { background: rgb(6 13 20 / .45); }
.pal-in { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--line); color: var(--ink-3); margin: 0; }
.pal-in svg { width: 17px; height: 17px; flex: none; }
dialog.palette .pal-in input { flex: 1; min-width: 0; width: auto; border: 0; border-radius: 0; background: none; color: var(--ink); font: 16px/1 var(--mono); padding: 16px 0; margin: 0; outline: none; box-shadow: none; }
dialog.palette .pal-in input::-webkit-search-cancel-button { display: none; }
.pal-list { overflow: auto; padding: 4px 0 8px; min-height: 0; }
.pal-grp { margin: 0; padding: 10px 16px 4px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.pal-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 16px; font-size: var(--fs-s); text-decoration: none; color: var(--ink); }
.pal-row:hover, .pal-row[aria-selected="true"] { background: var(--accent-soft); color: var(--ink); }
.pal-ic { color: var(--ink-3); text-align: center; white-space: nowrap; }
.pal-row[aria-selected="true"] .pal-ic { color: var(--accent); }
.pal-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal-t mark { background: none; color: var(--accent); font-weight: 700; }
.pal-s { color: var(--ink-3); font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 22rem; }
.pal-empty { margin: 0; padding: 26px 16px; text-align: center; color: var(--ink-3); font-size: var(--fs-s); }
.pal-foot { display: flex; gap: 16px; flex-wrap: wrap; padding: 8px 14px; border-top: 1px solid var(--line); color: var(--ink-3); font-size: var(--fs-xs); }
.panel .pal-list { padding: 0; }
@media (max-width: 760px) { .search-btn span, .search-btn kbd { display: none; } .pal-s { display: none; } }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); display: inline-block; margin-right: 6px; vertical-align: 1px; }
.live-dot.on { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.ava { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line-2); display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); font: 600 12px/1 var(--sans); letter-spacing: .03em; }
main.page { padding: 26px 0 0; min-width: 0; }
.foot { margin-top: 44px; color: var(--line-2); }
.foot svg { display: block; width: 100%; height: 56px; }
.foot p { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-size: var(--fs-xs); color: var(--ink-3); margin: 6px 0 26px; }

/* ── Briefing and horizon (home) ────────────────────────────────────────── */
.brief { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 24px 44px; padding: 4px 0 0; }
.brief > div { max-width: 66ch; }
.brief .av-hero { grid-column: 2; grid-row: 1; justify-self: start; }
.brief .glance { grid-column: 1 / -1; }
.eyebrow { font: 600 var(--fs-xs)/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 14px; white-space: nowrap; }
.brief h1 { font: 400 var(--fs-hero)/1.02 var(--serif); letter-spacing: -.012em; margin: 0 0 12px; }
.lede { font: 400 19px/1.5 var(--serif-text); color: var(--ink-2); margin: 0; max-width: 66ch; }
.lede a { color: var(--ink); text-decoration-thickness: 1px; }
.lede code { font-size: .78em; vertical-align: .08em; background: transparent; }
.lede a.bad { text-decoration-color: var(--bad); } .lede a.warn { text-decoration-color: var(--warn); }
.glance { display: flex; flex-wrap: wrap; gap: 30px; margin: 0 0 4px; padding: 0; }
.glance div { display: flex; flex-direction: column-reverse; gap: 3px; }
.glance dt { font: 600 11px/1.2 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.glance dd { margin: 0; font: 600 30px/1 var(--display); letter-spacing: -.01em; }
.horizon { margin-top: 20px; }
.hz-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 2px; }
.hz-head h2 { font: 600 var(--fs-xs)/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: var(--fs-xs); color: var(--ink-3); margin: 0; padding: 0; list-style: none; }
.legend svg { width: 12px; height: 12px; vertical-align: -2px; margin-right: 5px; }
.lg-mine { stroke: var(--accent); fill: var(--accent); } .lg-team { stroke: var(--ink-2); fill: var(--ink-2); } .lg-rel { fill: var(--ink-2); }
.lg-wait { fill: none; stroke: var(--warn); stroke-width: 1.6; } .lg-mark { fill: var(--accent); fill-opacity: .3; stroke: var(--accent); }
.hz-wrap { overflow-x: auto; }
.hz { display: block; width: 100%; min-width: 760px; height: auto; overflow: visible; }
.hz-nstop { stop-color: var(--night); }
.hz-stars { fill: var(--star); opacity: .85; }
.hz-farthest { fill: var(--ridge-farthest); } .hz-far { fill: var(--ridge-far); } .hz-near { fill: url(#hz-near-g); }
.hz-ng1 { stop-color: var(--ridge-near); } .hz-ng2 { stop-color: var(--ridge-deep); }
.hz-snow { fill: var(--snow); opacity: .95; } .hz-snow-far { opacity: .7; }
.hz-edge { fill: none; stroke: var(--ridge-edge); stroke-width: 1.2; stroke-linejoin: round; }
.hz-base, .hz-laneline { stroke: var(--line-2); stroke-width: 1; } .hz-laneline { stroke-dasharray: 1 4; }
.hz-tick { stroke: var(--line-2); }
.hz-axis { font: 500 11px var(--sans); fill: var(--ink-3); } .hz-axis.day { font-weight: 700; fill: var(--ink-2); } .hz-axis.now { fill: var(--accent); font-weight: 700; }
.hz-now { stroke: var(--accent); stroke-width: 1; stroke-dasharray: 2 3; }
.hz-lane { font: 600 10px var(--sans); letter-spacing: .1em; text-transform: uppercase; fill: var(--ink-3); paint-order: stroke; stroke: var(--bg); stroke-width: 5px; stroke-linejoin: round; }
.hz-sky { font: italic 11px var(--serif-text); fill: var(--ink-3); }
.hz-flag line { stroke: var(--ink-2); stroke-width: 1.1; } .hz-flag path { fill: var(--ink-2); }
.hz-flag.mine line { stroke: var(--accent); } .hz-flag.mine path { fill: var(--accent); }
.hz-flag.bot line { stroke: var(--flag-bot); } .hz-flag.bot path { fill: var(--flag-bot); }
.hz-rel { fill: var(--ink-2); } .hz-wait { fill: var(--bg); stroke: var(--warn); stroke-width: 1.6; }
.hz-mark { fill: var(--accent); fill-opacity: .28; stroke: var(--accent); stroke-width: 1; } .hz-mark.live { fill-opacity: 1; }
.hz-sun circle { fill: none; stroke: var(--accent); stroke-width: 1.4; } .hz-sun line { stroke: var(--accent); stroke-width: 1.4; stroke-linecap: round; }
.hz-peak line { stroke: var(--ink-3); stroke-width: .8; stroke-dasharray: 1.5 2.5; }
.hz-peak .t { font: 600 10.5px var(--mono); fill: var(--ink-3); } .hz-peak .d { font: 400 13px var(--serif-text); fill: var(--ink-2); }

/* ── Cards and rows ─────────────────────────────────────────────────────── */
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; margin: 22px 0 0; align-items: start; grid-auto-flow: row dense; }
/* Today: two columns of cards beside the live log, docked at the right. An open row opens in its own
   column: spanning both would move the right column below the whole left one, out of sight. */
.today-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); gap: 22px; margin: 22px 0 0; align-items: start; }
.today-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; align-items: start; min-width: 0; }
.today-col { display: grid; gap: 22px; align-content: start; min-width: 0; }
.stat-row { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 8px; font-size: var(--fs-xs); }
/* What's moving: newest at the top, new ones slide in; it scrolls on its own and stays in view. */
.feed { position: sticky; top: 14px; display: flex; flex-direction: column; max-height: calc(100vh - 28px); padding-bottom: 6px; }
.feed .card-h { flex: none; }
.feed-list { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0 -22px; padding: 0 22px; scrollbar-width: thin; }
.fe { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; padding: 7px 0; border-top: 1px solid var(--line); font-size: var(--fs-s); }
.fe time { font: 12px/1.55 var(--mono); color: var(--ink-3); }
.fe-b { min-width: 0; }
.fe-l { margin: 0; line-height: 1.4; overflow-wrap: anywhere; color: var(--ink-2); }
.fe-l .st { margin-right: 6px; vertical-align: 1px; }
.fe-l strong { color: var(--ink); font-weight: 600; }
.fe-l a { color: var(--ink); }
.fe-m { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
.fe.mine { opacity: .72; }
.fe.fresh { animation: fe-in .7s ease-out; }
/* Motion (WP-S5, app.js motion()): what a live swap brings in, takes away, counts up and settles. Short, and never in the way of reading. */
.fresh:not(.fe) { animation: enter .34s cubic-bezier(.2, .7, .3, 1) both; }
@keyframes enter { from { opacity: 0; transform: translateY(6px); } }
.leaving { animation: leave .18s ease-in both; pointer-events: none; }
@keyframes leave { to { opacity: 0; transform: translateY(-4px); } }
.bump { animation: bump .45s cubic-bezier(.3, 1.6, .5, 1); }
@keyframes bump { 40% { transform: scale(1.35); } }
.settled > .bubble { animation: settle 1.4s ease-out; border-radius: 6px; }
@keyframes settle { from { background: var(--accent-soft); box-shadow: 0 0 0 6px var(--accent-soft); } to { background: transparent; box-shadow: 0 0 0 6px transparent; } }
@keyframes fe-in { from { opacity: 0; transform: translateY(-8px); background: var(--accent-soft); } to { opacity: 1; transform: none; background: transparent; } }
@media (prefers-reduced-motion: reduce) { .fe.fresh { animation: none; } }
body:has(.docks) .feed { max-height: calc(100vh - 84px); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); padding: 18px 22px 10px; min-width: 0; }
/* An opened row gets the whole width, where it is: no jump to the top. */
.card:has(.row > details[open]) { grid-column: 1 / -1; }
/* The meta goes under the title when both don't fit, rather than squeezing it onto three lines. */
.card-h { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 12px; padding-bottom: 10px; }
.card-h h2 { font: 400 var(--fs-xl)/1.1 var(--serif); letter-spacing: -.005em; }
.card-h p { margin: 0; font-size: var(--fs-s); color: var(--ink-3); white-space: nowrap; }
.card-h a { font-size: var(--fs-s); color: var(--ink-2); white-space: nowrap; }
.rows { list-style: none; margin: 0; padding: 0; }
.row { border-top: 1px solid var(--line); position: relative; }
.row > details > summary, .row > .row-link { display: block; padding: 12px 30px 12px 0; text-decoration: none; color: inherit; list-style: none; border-radius: 8px; }
.row > details > summary::-webkit-details-marker { display: none; }
.row.has-quick > details > summary { padding-right: 118px; }
.row > details > summary:hover .row-t, .row > .row-link:hover .row-t { color: var(--accent); }
.row-k { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font: 600 var(--fs-s)/1.3 var(--sans); color: var(--ink-2); }
.row-t { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--fs-m); line-height: 1.38; margin-top: 2px; color: var(--ink); overflow-wrap: anywhere; }
.row-x { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--fs-s); color: var(--ink-2); margin-top: 3px; overflow-wrap: anywhere; }
.row-m { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--fs-xs); color: var(--ink-3); margin-top: 6px; }
.sha { font: 400 11px var(--mono); color: var(--ink-3); }
/* Stacked PRs (/prs/stacks): a chain, bottom first; a branch steps right. */
ol.stack { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; border-left: 2px solid var(--line-2); }
.stack-pr { display: flex; gap: 12px; align-items: flex-start; padding: 9px 12px; }
.stack-pr + .stack-pr { border-top: 1px solid var(--line); }
.stack-pr.lane-0 { margin-left: 0; } .stack-pr.lane-1 { margin-left: 22px; } .stack-pr.lane-2 { margin-left: 44px; } .stack-pr.lane-3 { margin-left: 66px; }
.stack-pos { flex: none; min-width: 34px; font: 600 12px/20px var(--mono); color: var(--ink-3); }
.stack-main { display: grid; gap: 3px; min-width: 0; }
.stack-title a { color: var(--ink); text-decoration: none; } .stack-title a:hover { text-decoration: underline; }
.stack-line { font-size: var(--fs-s); color: var(--ink-3); overflow-wrap: anywhere; }
.stack-line code { font: 12px var(--mono); }
.stack-wait { color: var(--warn); }
.stack-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.stack-order { margin: 6px 0 0; font-size: var(--fs-s); }
.stack-red { color: var(--bad); }
/* Which AI harness an agent runs in: a quiet tag, not a status (solid Claude Code, dashed Copilot · omp, dotted Copilot CLI). */
.harness { display: inline-block; margin-left: 7px; padding: 0 7px; border: 1px solid var(--line-2); border-radius: 999px; font: 600 11px/17px var(--sans); color: var(--ink-2); white-space: nowrap; vertical-align: 1px; }
.harness.claude { border-style: solid; } .harness.omp { border-style: dashed; } .harness.copilot { border-style: dotted; }
.harness-m { font-weight: 400; color: var(--ink-3); }
.page-head .harness { margin: 0 4px 0 0; }
.chev { position: absolute; right: 4px; top: 16px; width: 8px; height: 8px; border-right: 1.5px solid var(--ink-3); border-bottom: 1.5px solid var(--ink-3); transform: rotate(45deg); transition: transform .15s; }
details[open] > summary .chev { transform: rotate(225deg); top: 20px; }
.quick { position: absolute; right: 26px; top: 10px; margin: 0; }
.row:has(> details[open]) .quick { display: none; }
.row > details[open] > summary { padding-bottom: 6px; }
.row:has(> details[open]) { border-top-color: var(--line-2); }
.st { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.st i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.st.ok { color: var(--ok); } .st.warn { color: var(--warn); } .st.bad { color: var(--bad); } .st.acc { color: var(--accent); } .st.mute { color: var(--ink-3); font-weight: 500; }
.breathe { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ink-3); }
.breathe.warn { background: var(--warn); box-shadow: 0 0 0 4px var(--warn-soft); }
.breathe.bad { background: var(--bad); box-shadow: 0 0 0 4px var(--bad-soft); }
.breathe.busy { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); animation: breathe 2.4s ease-in-out infinite; }
.breathe.idle { background: transparent; border: 1.5px solid var(--ink-3); }
@keyframes breathe { 50% { box-shadow: 0 0 0 7px transparent; } }
.sub-h { font: 600 11px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin: 14px 0 4px; padding-top: 12px; border-top: 1px solid var(--line); }
.cnt { font-weight: 500; letter-spacing: .04em; margin-left: 4px; }
.shipped { list-style: none; margin: 0 0 8px; padding: 0; font-size: var(--fs-s); }
.shipped li { display: grid; grid-template-columns: 46px auto minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 4px 0; }
.shipped time { font: 12px var(--mono); color: var(--ink-3); }
.shipped b { font-weight: 600; color: var(--ink-2); }
.shipped .tag { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); }
.card-f { border-top: 1px solid var(--line); padding: 11px 0 6px; font-size: var(--fs-s); color: var(--ink-3); display: flex; justify-content: space-between; gap: 10px; }
.card-f a { color: var(--ink-2); white-space: nowrap; }
.expand { padding: 4px 0 20px; display: grid; gap: 4px; min-width: 0; }
.expand > * { min-width: 0; }
.facts { margin: 0 0 14px; display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px 16px; font-size: var(--fs-s); }
.facts dt { font: 600 11px/1.6 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
.facts dd { margin: 0; color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.facts .quote { font: italic 15px/1.45 var(--serif-text); color: var(--ink); }
.wts { list-style: none; margin: 0; padding: 0; font-size: var(--fs-s); }
.wts li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 10px; padding: 7px 0; border-top: 1px solid var(--line); }
.wt-n { font: 12.5px var(--mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-b { grid-column: 1; color: var(--ink-3); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-t { grid-row: 1; grid-column: 2; font-size: var(--fs-xs); color: var(--ink-3); }
.setup { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 14px; align-items: start; background: var(--surface-2); border: 1px dashed var(--line-2); border-radius: 12px; padding: 14px; margin: 6px 0 10px; }
.setup svg { width: 30px; height: 22px; color: var(--ink-3); grid-row: span 2; margin-top: 2px; }
.setup p { margin: 0; font-size: var(--fs-s); color: var(--ink-2); }
.notes { font-size: var(--fs-s); color: var(--ink-2); margin: 0 0 8px; }
/* A pack's ingest tokens on Settings (src/packs/ingest.ts). */
.ingest { margin-top: 12px; }
/* Settings → Writes (src/pages/writes.ts). */
.writes fieldset { border: 0; padding: 0; margin: 0 0 10px; }
.writes legend { font-weight: 600; font-size: var(--fs-s); margin-bottom: 4px; }
.write-row { display: block; padding: 3px 0; }
/* Bulk writes (kit BulkBar, Pick). */
.bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.pick { margin: 0 8px 0 0; width: 16px; height: 16px; vertical-align: middle; }
.ingest h3 { font-size: var(--fs-s); margin: 0 0 6px; }
.ingest-new { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-top: 8px; }
code.secret { user-select: all; overflow-wrap: anywhere; }
/* An atlas panel's description line, and a component's rules note. */
.panel-note { padding: .75rem 1rem; margin: 0; color: var(--ink-2); font-size: var(--fs-s); }
.rule-note { margin-left: .5rem; opacity: .8; }

/* ── The kit, in the morning view's language ────────────────────────────── */
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 4px 0 18px; }
.page-head .titles { min-width: 0; }
.page-head h1 { font: 400 40px/1.05 var(--serif); letter-spacing: -.01em; }
.page-head .sub { font: 400 17px/1.5 var(--serif-text); color: var(--ink-2); margin: 8px 0 0; max-width: 70ch; }
.page-head .actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
.crumbs { font: 600 var(--fs-xs)/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 12px; display: flex; gap: .4rem; }
.crumbs a { text-decoration: none; } .crumbs .sep { color: var(--line-2); }
.toolbar { margin: -6px 0 16px; }
/* One row: tabs that don't fit scroll sideways (app.js brings the current one into view). The line
   under them is a shadow, so the scroll box doesn't clip the current tab's underline. */
.tabs { display: flex; gap: 22px; overflow-x: auto; scrollbar-width: none; box-shadow: inset 0 -1px var(--line); font-size: var(--fs-s); }
.tabs::-webkit-scrollbar { display: none; }
.tabs a { flex: none; white-space: nowrap; text-decoration: none; color: var(--ink-2); padding: 8px 0; border-bottom: 2px solid transparent; }
.tabs a[aria-current] { color: var(--ink); border-bottom-color: var(--accent); }
.tabs .n { color: var(--ink-3); font-weight: 600; margin-left: 4px; }
.tabs .sep { flex: none; width: 1px; background: var(--line); }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); padding: 18px 22px 10px; margin: 0 0 22px; min-width: 0; }
.panel-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: 10px; }
.panel-head h2 { font: 400 var(--fs-xl)/1.1 var(--serif); }
.panel-head .meta { font-size: var(--fs-s); color: var(--ink-3); }
.panel-head .actions { margin-left: auto; display: flex; gap: .5rem; font-size: var(--fs-s); }
.panel-body { min-width: 0; }
.panel-body.flush { margin: 0; }
.panel-foot { border-top: 1px solid var(--line); padding: 11px 0 6px; font-size: var(--fs-s); color: var(--ink-3); }
.pill { display: inline-flex; align-items: center; gap: .3rem; font: 600 var(--fs-xs)/1.5 var(--sans); padding: 0 .5rem; border-radius: 999px; background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); white-space: nowrap; }
.pill.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.pill.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.pill.bad { color: var(--bad); background: var(--bad-soft); border-color: transparent; }
.pill.accent { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.pills { display: inline-flex; flex-wrap: wrap; gap: .3rem; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); flex: none; vertical-align: .05em; }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.dot.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.dot.accent { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.notice { display: flex; gap: .7rem; align-items: flex-start; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2); margin: 0 0 16px; color: var(--ink-2); }
.notice > div { min-width: 0; } .notice p:first-child { margin-top: 0; } .notice p:last-child { margin-bottom: 0; }
.notice svg { width: 18px; height: 18px; color: var(--ink-3); margin-top: 2px; }
.notice.ok { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 30%, transparent); } .notice.ok svg { color: var(--ok); }
.notice.warn { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 40%, transparent); } .notice.warn svg { color: var(--warn); }
.notice.bad { background: var(--bad-soft); border-color: color-mix(in srgb, var(--bad) 35%, transparent); } .notice.bad svg { color: var(--bad); }
.notice.accent { background: var(--accent-soft); border-color: var(--accent-line); } .notice.accent svg { color: var(--accent); }
.empty { color: var(--ink-3); padding: 1.6rem 0 1.2rem; font: italic 15px/1.5 var(--serif-text); }
.empty strong { display: block; font: 400 18px/1.3 var(--serif); font-style: normal; color: var(--ink-2); margin-bottom: .15rem; }
ul.list { list-style: none; margin: 0; padding: 0; }
ul.list > li { border-top: 1px solid var(--line); }
.item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 0 .9rem; align-items: start; padding: 12px 0; text-decoration: none; color: inherit; }
a.item:hover .title { color: var(--accent); }
.item > .lead { padding-top: .25rem; display: flex; align-items: center; min-width: 8px; }
.item > .main { min-width: 0; display: block; }
.item .title { display: flex; flex-wrap: wrap; gap: .15rem .5rem; align-items: baseline; min-width: 0; font-size: var(--fs-m); overflow-wrap: anywhere; }
.item .title > strong, .item .title > .name { overflow-wrap: anywhere; min-width: 0; font-weight: 600; }
.item .title a { text-decoration: none; overflow-wrap: anywhere; min-width: 0; } .item .title a:hover { text-decoration: underline; }
.item .line { display: block; color: var(--ink-3); font-size: var(--fs-s); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--ink-2); font-size: var(--fs-s); margin-top: 3px; overflow-wrap: anywhere; }
.item > .trail { text-align: right; color: var(--ink-3); font-size: var(--fs-xs); white-space: nowrap; padding-top: .2rem; display: flex; flex-direction: column; align-items: flex-end; gap: .15rem; }
.item.quiet .title, .item.quiet .line { color: var(--ink-3); }
.item .more { display: flex; flex-direction: column; gap: .3rem; margin-top: .45rem; min-width: 0; }
.item .more .recap { font: italic 15px/1.45 var(--serif-text); color: var(--ink); border-left: 2px solid var(--accent-line); padding-left: .7rem; overflow-wrap: anywhere; }
.item .more .asked { font: var(--fs-xs)/1.5 var(--mono); color: var(--ink-3); overflow-wrap: anywhere; }
.item .more .links { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: var(--fs-s); }
.item .more .resume { font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.item .more .actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: flex-start; margin-top: .25rem; }
.item .more .actions form { margin: 0; }
.kind { font: 600 11px/1.3 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); min-width: 4.4rem; padding-top: .15rem; }
.kind.bad { color: var(--bad); } .kind.warn { color: var(--warn); } .kind.accent { color: var(--accent); } .kind.ok { color: var(--ok); } .kind.neutral { color: var(--ink-3); }
dl.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .45rem 1.2rem; margin: .25rem 0 .75rem; font-size: var(--fs-s); }
dl.kv dt { font: 600 11px/1.7 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
dl.kv dd { margin: 0; color: var(--ink-2); overflow-wrap: anywhere; min-width: 0; }
/* In a narrow card (Today's columns), long chips shorten and paths wrap instead of running out of it. */
dl.kv .pills { max-width: 100%; }
dl.kv .pill { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
dl.kv .area { white-space: normal; flex-wrap: wrap; overflow-wrap: anywhere; }
@media (max-width: 40rem) { dl.kv { grid-template-columns: minmax(0, 1fr); gap: .1rem; } dl.kv dd { margin-bottom: .6rem; } }
.table-wrap { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; font-size: var(--fs-s); }
table.data th { text-align: left; font: 600 11px/1.2 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding: .5rem .6rem; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
table.data td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
table.data tr:last-child td { border-bottom: 0; }
/* Tables that scroll inside the page, query results as monospace cells (a pack's: Data). */
.sheet { overflow: auto; max-height: 70vh; }
table.data.cells td { font: var(--fs-xs)/1.45 var(--mono); white-space: pre; max-width: 28rem; overflow: hidden; text-overflow: ellipsis; }
table.data.cells thead th { position: sticky; top: 0; background: var(--surface); }
form.query textarea { font-family: var(--mono); font-size: var(--fs-s); }
.sqlc { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; margin: 4px 0 0; padding: 4px; border: 1px solid var(--line-2); border-radius: var(--r-s); background: var(--surface); }
.sqlc[hidden] { display: none; }
.sqlc li { padding: 2px 8px; border-radius: var(--r-s); font: var(--fs-xs)/1.6 var(--mono); color: var(--ink-2); cursor: pointer; }
.sqlc li:hover { background: var(--hover); color: var(--ink); }
.sqlc li.on { background: var(--accent-soft); color: var(--accent); }
.sqlc .k { margin-left: 6px; color: var(--ink-3); }
form.find { display: flex; gap: .75rem; align-items: flex-end; margin: 0 0 22px; }
form.find .field { flex: 1; margin: 0; }
td.num, th.num, table.data .num { text-align: right; white-space: nowrap; }
pre.code, pre.output { font: var(--fs-xs)/1.55 var(--mono); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-s); padding: .7rem .9rem; margin: .5rem 0; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.docker-logs { margin: 0; border: 0; border-radius: 0; min-height: 12rem; max-height: 70vh; overflow-y: auto; }
.buttons { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
/* hidden means hidden: a display rule below (buttons are inline-flex) would otherwise beat the browser's own. */
[hidden] { display: none !important; }
button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: 600 var(--fs-s)/1 var(--sans); padding: 9px 14px; border-radius: var(--r-s);
  border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); cursor: pointer; text-decoration: none; white-space: nowrap; }
button:hover, .btn:hover { border-color: var(--accent); color: var(--accent); }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.primary:hover, .btn.primary:hover { filter: brightness(1.08); color: var(--accent-ink); }
button.danger, .btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
button.danger:hover, .btn.danger:hover { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); }
button.ghost, .btn.ghost { border-color: transparent; background: transparent; color: var(--ink-2); }
button.ghost:hover, .btn.ghost:hover { background: var(--hover); color: var(--ink); }
button.sm, .btn.sm { padding: 6px 11px; font-size: var(--fs-xs); }
button.copy { padding: 2px 7px; margin-left: .4rem; font-size: 11px; vertical-align: .1em; }
button svg, .btn svg { width: 15px; height: 15px; }
.field { display: flex; flex-direction: column; gap: .3rem; margin: 0 0 .9rem; }
.field > .label { font: 600 11px/1.2 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
.field > .hint { color: var(--ink-3); font-size: var(--fs-s); }
.field > fieldset { border: 0; padding: 0; margin: .2rem 0 0; min-width: 0; }
.field > fieldset > legend { padding: 0; font-size: var(--fs-s); color: var(--ink-2); }
.welcome-skip { margin-top: .6rem; }
.pane-set { border: 0; border-top: 1px solid var(--line); margin: 0; padding: .7rem 0 .2rem; min-width: 0; }
.pane-set > legend { float: left; width: 100%; padding: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 .6rem; }
.pane-set > legend + * { clear: left; }
.pane-what { margin: 0 0 .5rem 1.6rem; color: var(--ink-3); font-size: var(--fs-s); }
.pane-set > .fields { margin-left: 1.6rem; }
.pane-why { color: var(--warn); font-size: var(--fs-s); }
label.check { display: inline-flex; gap: .4rem; align-items: center; margin: .15rem 1.1rem .15rem 0; font-size: var(--fs-s); }
.fields { display: flex; flex-wrap: wrap; gap: 0 1rem; align-items: flex-end; }
.fields > .field { flex: 1 1 11rem; min-width: 0; }
/* Settings → Layout: a card, its column, its place. */
.layout-rows { display: grid; gap: .4rem; margin: 0 0 .9rem; }
.layout-row { display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem 4.5rem; gap: .6rem; align-items: center; }
.layout-row > span { overflow-wrap: anywhere; min-width: 0; }
input[type=text], input[type=search], input[type=email], input[type=number], input:not([type]), select, textarea {
  font: var(--fs-m)/1.4 var(--sans); color: var(--ink); background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--r-s); padding: 9px 12px; max-width: 100%; }
textarea { width: 100%; resize: vertical; }
input::placeholder, textarea::placeholder { color: var(--ink-3); }
input:focus, select:focus, textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); outline-offset: 0; border-color: var(--accent); }
form.post { display: inline-block; margin: 0; }
details.confirm { display: inline-block; margin: 0; }
details.confirm > summary { list-style: none; display: inline-flex; align-items: center; gap: 6px; font: 600 var(--fs-s)/1 var(--sans); padding: 9px 14px; border-radius: var(--r-s); border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); white-space: nowrap; }
details.confirm > summary::-webkit-details-marker { display: none; }
details.confirm > summary:hover, details.confirm[open] > summary { border-color: var(--accent); color: var(--accent); }
details.confirm .confirm-body { margin-top: .5rem; padding: .8rem .9rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); max-width: 30rem; }
details.confirm .confirm-body p { margin: 0 0 .6rem; color: var(--ink-2); font-size: var(--fs-s); }
.quick details.confirm > summary { padding: 6px 11px; font-size: var(--fs-xs); }
.quick details.confirm .confirm-body { position: absolute; right: 0; z-index: 3; width: 22rem; box-shadow: var(--shadow); background: var(--surface); }
.item > .trail details.confirm { position: relative; }
.item > .trail details.confirm .confirm-body { position: absolute; right: 0; z-index: 3; width: min(22rem, calc(100vw - 32px)); white-space: normal; text-align: left; font-size: var(--fs-s); box-shadow: var(--shadow); background: var(--surface); }
details.thread { margin: 0; }
details.thread > summary.item { list-style: none; }
details.thread > summary.item::-webkit-details-marker { display: none; }
details.thread > summary.item:hover .title { color: var(--accent); }
details.thread > .thread-body { padding: 4px 0 18px; }
dialog.keys { border: 1px solid var(--line-2); border-radius: var(--r); background: var(--surface); color: var(--ink); padding: 1rem 1.25rem; min-width: 16rem; box-shadow: var(--shadow); }
dialog.keys::backdrop { background: rgb(0 0 0 / .3); }
dialog.keys h2 { font: 400 var(--fs-l) var(--serif); margin: 0 0 .6rem; }
dialog.keys dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 0 0 .9rem; }
dialog.keys dd { margin: 0; color: var(--ink-2); }
dialog.keys { max-width: min(46rem, calc(100vw - 32px)); max-height: 86vh; overflow: auto; }
dialog.keys h3 { font: 600 var(--fs-xs)/1.3 var(--sans); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); margin: 0 0 .45rem; }
.key-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: .4rem 1.6rem; }
/* Long pages: stops to move between (J / K, ] / [), a rail at the right edge, the outline (o). */
[data-stop] { scroll-margin-top: 14px; }
[data-stop]:focus { outline: none; }
.dfile [data-stop] { scroll-margin-top: 60px; }
.landed { animation: landed 1.3s ease-out; }
@keyframes landed { from { outline: 2px solid var(--accent); outline-offset: 3px; } to { outline: 2px solid transparent; outline-offset: 3px; } }
.rail { position: fixed; z-index: 55; right: 10px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 2px; padding: 4px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--surface) 90%, transparent); box-shadow: var(--shadow); }
.rail[hidden] { display: none; }
.rail .rail-b { min-width: 32px; padding: 7px 4px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-2); font: 600 var(--fs-s)/1 var(--sans); }
.rail .rail-b:hover { background: var(--hover); color: var(--accent); }
.rail .rail-at { font-size: 10.5px; color: var(--ink-3); padding: 6px 2px; }
.rail .rail-end.new { background: var(--accent); color: var(--accent-ink); }
dialog.outline { position: fixed; inset: 50% 56px auto auto; transform: translateY(-50%); margin: 0; padding: 0; width: min(32rem, calc(100vw - 80px)); max-height: 72vh; overflow: auto; border: 1px solid var(--line-2); border-radius: var(--r); background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
dialog.outline::backdrop { background: rgb(0 0 0 / .18); }
.outline-box { padding: 6px 6px 8px; }
.outline-box h2 { margin: 0; padding: 6px 10px 6px; font: 600 var(--fs-xs)/1.3 var(--sans); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); }
.outline-box ol { list-style: none; margin: 0; padding: 0; }
.outline-box button { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: var(--r-s); background: transparent; color: var(--ink-2); font: var(--fs-s)/1.4 var(--sans); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.outline-box button:hover, .outline-box button:focus { background: var(--hover); color: var(--ink); outline: none; }
.outline-box button[aria-current] { color: var(--accent); font-weight: 600; }
@media (max-width: 560px) { .rail { right: 4px; } dialog.outline { inset: auto 8px 8px 8px; transform: none; width: auto; } }
/* f / F: a label at the top-left of everything clickable; typed letters dim as they match. */
.key-hints { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
.key-hint { position: absolute; padding: 0 3px; border: 1px solid var(--hint-line); border-radius: 3px; background: var(--hint); color: var(--hint-ink); font: 700 11px/1.35 var(--mono); letter-spacing: .03em; text-transform: uppercase; white-space: nowrap; box-shadow: 0 1px 3px rgb(0 0 0 / .35); }
.key-hint-typed { opacity: .4; }
.key-flash { position: fixed; z-index: 2147483000; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 7px 14px; border-radius: var(--r-s); background: var(--ink); color: var(--bg); font-size: var(--fs-s); box-shadow: var(--shadow); pointer-events: none; }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; }

/* ── Page parts: inline PRs, AI lines, changelogs ───────────────────────── */
.repo-tag { font: 600 var(--fs-xs)/1.5 var(--sans); color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; padding: 0 .45rem; white-space: nowrap; }
details.thread.pr > summary .lead { min-width: 6.5rem; }
.ai { margin: 0 0 14px; font: 400 var(--fs-l)/1.5 var(--serif-text); color: var(--ink); }
.ai .spark { display: inline-block; font: 600 10.5px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); padding: 5px 7px 4px; border-radius: 5px; margin-right: 10px; vertical-align: 3px; }
.ai.pending, .ai.failed { font: italic var(--fs-m)/1.5 var(--serif-text); color: var(--ink-3); }
.item .ai-clamp { color: var(--ink-2); -webkit-line-clamp: 1; font-style: italic; font-family: var(--serif-text); }
.area { display: inline-flex; gap: .35rem; margin-right: 1rem; white-space: nowrap; }
.description { border-top: 1px solid var(--line); margin-top: .75rem; padding-top: .5rem; max-width: 78ch; color: var(--ink-2); }
/* An agent's review of a PR, on its card: start one, running, the report (the agent's own text). */
.agent-review { border-top: 1px solid var(--line); margin-top: .75rem; padding-top: .6rem; }
.agent-review .buttons { margin-top: .4rem; }
.agent-review-h { margin: 0; color: var(--ink-2); font-size: var(--fs-s); }
.agent-review-h .spark { display: inline-block; font: 600 10.5px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); padding: 5px 7px 4px; border-radius: 5px; margin-right: 6px; }
.agent-report { margin-top: .5rem; }
.agent-report > summary { cursor: pointer; color: var(--ink-2); font-size: var(--fs-s); }
.agent-report-body { max-width: 82ch; margin-top: .4rem; padding: .6rem .9rem; border-left: 3px solid var(--accent-line); background: var(--surface-2); border-radius: 0 var(--r-s) var(--r-s) 0; }
.draft-h { margin: 1rem 0 .3rem; font: 600 11px/1.2 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
.draft-card { margin: .5rem 0; padding: .6rem .8rem; border: 1px solid var(--line); border-radius: var(--r-s); background: var(--surface-2); }
.draft-card textarea { width: 100%; margin-top: .35rem; }
.draft-card-h { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem; }
.draft-where { font-size: var(--fs-s); color: var(--ink-2); overflow-wrap: anywhere; }
.draft-text { max-width: 82ch; margin-top: .35rem; }
.agent-prompt { margin: 0 0 .3rem; white-space: pre-wrap; font: 12.5px/1.5 var(--mono); background: var(--surface-2); padding: .5rem .7rem; border-radius: var(--r-s); max-width: 82ch; }
.md h3.md-h, .md h4.md-h, .md h5.md-h { font: 600 11px/1.2 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); margin: 1rem 0 .4rem; }
.md p { margin: .35rem 0; overflow-wrap: anywhere; }
.md ul.md-list, .md ol.md-list { margin: .3rem 0; padding-left: 1.2rem; }
.md li { margin: 3px 0; } .md li.task { list-style: none; margin-left: -1.1rem; } .md li.task.done { color: var(--ink-3); }
.md .box { display: inline-block; width: 1rem; }
.md blockquote { margin: .4rem 0; padding-left: .75rem; border-left: 2px solid var(--line-2); color: var(--ink-3); }
.md table.data { margin: .5rem 0; }
.changelog { margin: 4px 0 6px; }
.changelog .ships { margin: 4px 0 12px; display: flex; flex-wrap: wrap; gap: .25rem .8rem; align-items: baseline; font: 400 15px var(--sans); color: var(--ink-3); }
.changelog .ships strong { font: 400 26px/1.25 var(--serif); color: var(--ink); width: 100%; }
h4.change-kind { font: 600 11px/1.2 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); margin: 16px 0 6px; }
ul.changes { list-style: none; margin: 0; padding: 0; columns: 2 22rem; column-gap: 28px; }
ul.changes > li { break-inside: avoid; display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 2px 8px; padding: 7px 0; border-top: 1px solid var(--line); font-size: var(--fs-s); }
ul.changes > li > :nth-child(n+3) { grid-column: 2; }
ul.changes .num { font: 12px/1.5 var(--mono); color: var(--accent); text-decoration: none; }
details.fold-deps { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 4px; }
details.fold-deps > summary { list-style: none; font: 600 11px/1.2 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); padding: 8px 0; }
details.fold-deps > summary::-webkit-details-marker { display: none; }
details.fold-deps > summary::before { content: "+"; display: inline-block; width: 14px; color: var(--accent); }
details.fold-deps[open] > summary::before { content: "−"; }
.ref-key { font: 600 11px var(--sans); color: var(--accent); }

/* ── Page parts: talking to an agent ────────────────────────────────────── */
/* ── An agent session as a chat: my messages in bubbles at the right, the agent's as plain text ── */
ol.chat { list-style: none; margin: 0; padding: 4px 0 8px; display: flex; flex-direction: column; gap: 6px; }
.turn-row { display: flex; flex-direction: column; gap: 2px; max-width: 78ch; min-width: 0; }
.turn-row .who { font: 500 var(--fs-xs)/1.2 var(--sans); color: var(--ink-3); letter-spacing: .02em; }
.turn-row .bubble { overflow-wrap: anywhere; color: var(--ink); min-width: 0; }
.turn-row .bubble > .md > :first-child { margin-top: 0; } .turn-row .bubble > .md > :last-child { margin-bottom: 0; }
.turn-row.first { margin-top: 10px; }
.turn-row.user { align-self: flex-end; align-items: flex-end; max-width: min(64ch, 86%); margin-top: 14px; }
.turn-row.user .bubble { background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 14px 14px 4px 14px; padding: 8px 13px; font-size: var(--fs-m); }
.turn-row.user .bubble pre { background: var(--surface); }
.turn-row.agent .bubble { font-size: var(--fs-m); }
.turn-row.live .who { color: var(--accent); display: flex; gap: 6px; align-items: center; }
.turn-row.tools { font-size: var(--fs-xs); color: var(--ink-3); }
.turn-row.tools summary { color: var(--ink-3); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 78ch; }
.turn-row.tools summary code { color: var(--ink-2); }
.turn-row.ask, .turn-row.meta { margin-top: 10px; }
ul.calls { list-style: none; margin: 6px 0 0; padding: 0 0 0 14px; display: grid; gap: 4px; font-size: var(--fs-xs); color: var(--ink-3); border-left: 1px solid var(--line-2); }
ul.calls > li { overflow-wrap: anywhere; }
/* The reply box: one field that grows, a send button; mode and model folded into a line */
form.chatbox { margin: 14px 0 0; max-width: 78ch; display: grid; gap: 6px; }
.chatbox-in { display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 14px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); }
.chatbox-in:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
form.chatbox textarea { flex: 1; min-width: 0; border: 0; background: none; box-shadow: none; outline: none; resize: none; padding: 7px 0; margin: 0; max-height: 50vh; font: var(--fs-m)/1.5 var(--mono); color: var(--ink); field-sizing: content; min-height: 2.3em; }
form.chatbox button.send { flex: none; width: 36px; height: 36px; padding: 0; border-radius: 10px; display: grid; place-items: center; }
form.chatbox button.send svg { width: 18px; height: 18px; transform: rotate(-90deg); }
.chatbox-opts { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; font-size: var(--fs-xs); color: var(--ink-3); padding: 0 4px; }
.chat-opts > summary { cursor: pointer; color: var(--ink-2); }
.chat-opts[open] { flex-basis: 100%; }
.chat-opts .fields { margin-top: 6px; }
form.chatbox button.danger { flex: none; align-self: center; }
.turn-row.user.queued .bubble { background: var(--surface); border-style: dashed; color: var(--ink-2); }
form.inline { display: inline; margin: 0; }
button.link { background: none; border: 0; padding: 0; min-height: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
button.link:hover { color: var(--ink); }
.turn-row.live .bubble::after { content: ""; display: inline-block; width: .5em; height: 1.05em; background: var(--accent); margin-left: 2px; vertical-align: -.16em; animation: blink 1.05s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* ── Small screens and motion ───────────────────────────────────────────── */
@media (max-width: 1180px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .today-main { grid-template-columns: minmax(0, 1fr); }
  .feed { position: static; max-height: 34rem; }
  .glance { gap: 20px; } .glance dd { font-size: 24px; }
}
@media (max-width: 860px) {
  .grid, .today-cols, .grid-2, .grid-3 { grid-template-columns: minmax(0, 1fr); }
  .brief { grid-template-columns: 1fr; gap: 20px; }
  .brief .av-hero { grid-column: auto; grid-row: auto; }
  .brief .glance { grid-column: auto; }
  .brief h1 { font-size: 38px; } .page-head h1 { font-size: 32px; }
  ul.changes { columns: 1; }
  .row.has-quick > details > summary { padding-right: 30px; } .quick { position: static; margin: -4px 0 10px; }
}
/* ── An agent's question (AskUserQuestion) with its choices, answerable on the session page ── */
.ask-card { border: 1px solid var(--accent-line); border-radius: var(--r); background: var(--accent-soft); padding: 12px 16px; display: grid; gap: 12px; }
.ask-q { border: 0; margin: 0; padding: 0; display: grid; gap: 6px; }
.ask-q legend { font-weight: 600; margin-bottom: 4px; padding: 0; }
.ask-h { display: inline-block; margin-right: 8px; padding: 0 7px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line-2); font-size: var(--fs-xs); font-weight: 600; color: var(--ink-2); }
.ask-o { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: var(--r-s); background: var(--surface); }
.ask-o input[type="radio"], .ask-o input[type="checkbox"] { margin-top: 3px; }
.ask-o.other { align-items: center; } .ask-o.other input[type="text"] { flex: 1; }
.ask-d { display: block; color: var(--ink-2); font-size: var(--fs-s); }
/* Calls a turn was refused, allowed together */
.ask-card.perm { border-color: var(--warn); background: var(--warn-soft); }
.ask-card.perm .ask-o > span { min-width: 0; flex: 1; }
.ask-card.perm pre.output { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
/* What Dovre wrote for me (allowed calls, a copy started) as a quiet line on my side */
.turn-row.meta.mine { align-self: flex-end; max-width: min(64ch, 86%); }
.turn-row.meta code { overflow-wrap: anywhere; }

/* ── An MCP server asking for my OK (the relay): above everything, on every page ── */
.approval { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin: 14px 0 0; padding: 14px 18px; border: 1px solid var(--warn); border-radius: var(--r); background: var(--warn-soft); }
.approval-text { flex: 1 1 26rem; min-width: 0; }
.approval h2 { margin: 0 0 6px; font: 600 var(--fs-m)/1.3 var(--sans); color: var(--warn); }
.approval-q { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); }
.approval-do { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
.approval-do form { margin: 0; }
.approval-list { margin: 0; padding-left: 1.2em; color: var(--ink); overflow-wrap: anywhere; }

/* ── My list (/todo, and its card on Today) ── */
.todo-add { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
.todo-add-more { flex-basis: 100%; }
.todo-add-more > summary { cursor: pointer; font-size: var(--fs-s); color: var(--ink-3); width: max-content; }
.todo-add-more[open] > summary { margin-bottom: 8px; }
.todo-add input { flex: 1; min-width: 0; }
.card .todo-add { margin: 12px 0 0; }
.todo-group { margin: 0 0 22px; }
.todo-group h2 { font: 600 var(--fs-s)/1.3 var(--sans); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); margin: 0 0 6px; }
.todo-list, .todo-sub { list-style: none; margin: 0; padding: 0; }
.todo-item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--line); }
.todo-sub .todo-item { border-top: 0; padding: 4px 0; }
.todo-sub { margin: 4px 0 2px; }
.todo-main { flex: 1; min-width: 0; }
.todo-title { margin: 0; overflow-wrap: anywhere; line-height: 1.4; }
.todo-item.done > .todo-main > .todo-title > span { color: var(--ink-3); text-decoration: line-through; }
.todo-item.waiting > .todo-main > .todo-title > span { color: var(--ink-2); }
.todo-tick-f { margin: 0; }
.todo-tick { width: 18px; height: 18px; min-height: 0; margin-top: 2px; padding: 0; border: 1.5px solid var(--line-2); border-radius: 5px; background: var(--surface); cursor: pointer; }
.todo-tick:hover, .todo-tick:focus-visible { border-color: var(--accent); }
.todo-tick.on { background: var(--ok); border-color: var(--ok); box-shadow: inset 0 0 0 3px var(--surface); }
.todo-count { font: 600 var(--fs-xs)/1 var(--sans); color: var(--ink-3); }
.todo-step { display: flex; gap: 6px; margin: 4px 0 0; max-width: 34rem; }
.todo-step input { flex: 1; min-width: 0; padding-top: 3px; padding-bottom: 3px; }
.todo-more { margin: 4px 0 0; }
.todo-more > summary { cursor: pointer; font-size: var(--fs-s); color: var(--ink-3); width: max-content; }
.todo-more[open] > summary { margin-bottom: 8px; }
.todo-notes { font-size: var(--fs-s); color: var(--ink-2); }
.todo-refs { font-size: var(--fs-s); margin: 4px 0 8px; }
.todo-form { max-width: 40rem; }
.todo-acts { display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; margin: 8px 0 4px; }
.todo-acts form { margin: 0; }
.todo-older > summary { cursor: pointer; color: var(--ink-3); margin: 4px 0 8px; }
a.ref { font-family: var(--mono); font-size: .92em; }

/* ── Bino, the assistant: a conversation, a plan card, what it remembers ── */
.bino-msgs { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 14px; }
.bino-msg { padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); max-width: 52rem; }
.bino-msg.you { background: var(--surface-2); margin-left: auto; }
.bino-msg.bino { border-color: var(--accent-line); }
.bino-who { margin: 0 0 4px; font: 600 var(--fs-s)/1.4 var(--sans); color: var(--ink-2); }
.bino-text > :first-child { margin-top: 0; } .bino-text > :last-child { margin-bottom: 0; }
.bino-thinking { display: flex; align-items: center; gap: 10px; margin: 14px 0 0; color: var(--ink-3); }
.bino-thinking .spinner { width: 16px; height: 16px; }
.mylist { display: flex; margin: 0 0 .8rem; }
#end { display: block; scroll-margin-bottom: 140px; }
/* Docks: Bino's and the packs' buttons at the bottom right of every page; open, a panel above one (a frame of its /…/dock page). */
.docks { position: fixed; right: 18px; bottom: 18px; z-index: 60; display: flex; align-items: flex-end; gap: 8px; pointer-events: none; }
.tdock { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; pointer-events: none; }
.tdock > * { pointer-events: auto; }
.tdock-btn { display: inline-flex; align-items: center; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); font: 600 var(--fs-s)/1.2 var(--sans); text-decoration: none; box-shadow: var(--shadow); }
.tdock-btn:hover, .tdock.open .tdock-btn { border-color: var(--accent); color: var(--accent); }
.tdock-btn b { margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: var(--fs-xs); }
.tdock-btn b.hot { background: var(--warn-soft); color: var(--warn); }
.tdock-panel { width: min(400px, calc(100vw - 36px)); height: min(620px, calc(100vh - 96px)); border: 1px solid var(--line-2); border-radius: var(--r); overflow: hidden; background: var(--bg); box-shadow: var(--shadow), 0 18px 50px -20px rgb(0 0 0 / .35); }
.tdock-panel[hidden] { display: none; }
.tdock-panel iframe { display: block; width: 100%; height: 100%; border: 0; }
body:has(.docks) .foot p { margin-bottom: 64px; }
@media (max-width: 560px) {
  .docks { right: 10px; bottom: 10px; }
  /* On the phone an open pane is a sheet over the whole page, tab bar too; its own header closes it.
     It fits what's visible, keyboard or not (interactive-widget=resizes-content in the viewport meta). */
  .tdock-panel { position: fixed; top: calc(8px + env(safe-area-inset-top)); left: 8px; right: 8px; bottom: calc(8px + var(--sab)); width: auto; height: auto; }
  .docks:has(.tdock.open) .tdock-btn { display: none; }
  body:has(.tdock.open) { overflow: hidden; }
}
@media (max-width: 900px) {
  /* Typing on the phone: the keyboard takes the foot, so the tab bar and the dock buttons step aside.
     Only while the keyboard is up (app.js sets html.kb): a box focused on open, keyboard down, hides nothing. */
  html.kb :is(.tabbar, .docks) { display: none; }
}
/* A page inside the dock: a bar, a scrolling body, the box to write in at the bottom. */
.dock-page { height: 100vh; display: flex; flex-direction: column; background: var(--bg); font-size: var(--fs-s); }
.dock-h { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
.dock-h h1 { flex: 1; min-width: 0; margin: 0; font: 600 var(--fs-m)/1.3 var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dock-l { padding: 4px 8px; border-radius: var(--r-s); font-size: var(--fs-xs); color: var(--ink-2); text-decoration: none; }
.dock-l:hover { background: var(--hover); }
.dock-i { padding: 2px 9px; border-radius: var(--r-s); font-size: var(--fs-m); line-height: 1.4; color: var(--ink-2); text-decoration: none; }
.dock-i:hover { background: var(--hover); color: var(--ink); }
.dock-b { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 12px; }
.dock-b #end { scroll-margin-bottom: 0; }
.dock-compose { flex: none; flex-direction: column; align-items: stretch; gap: 6px; margin: 0; padding: 8px 12px 10px; border-top: 1px solid var(--line); }
.todo-item.proposal { align-items: center; }
.todo-item.proposal .notes { margin: 2px 0 0; }
.bino-hub { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 360px); gap: 22px; align-items: start; }
.bino-side .panel { margin-bottom: 16px; }
.bino-thread { max-width: 52rem; }
.bino-compose { margin: 18px 0 0; background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--r); box-shadow: var(--shadow); }
.bino-main .bino-compose { margin: 0; }
.bino-compose:focus-within { border-color: var(--accent); }
.bino-compose textarea { display: block; border: 0; background: transparent; padding: 16px 18px 6px; font-size: var(--fs-m); line-height: 1.55; min-height: 7.5em; }
.bino-compose textarea:focus { outline: 0; }
.bino-compose-f { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 8px 10px 10px 18px; }
.bino-compose-f .hint { color: var(--ink-3); font-size: var(--fs-xs); margin-right: auto; }
.bino-compose.dock-compose { display: block; padding: 0; border-width: 1px 0 0; border-radius: 0; box-shadow: none; }
.dock-b > .bino-compose.dock-compose { margin: 10px 0 0; border-width: 1px; border-radius: var(--r); }
.bino-compose.dock-compose textarea { min-height: 4.5em; padding: 10px 12px 4px; font-size: var(--fs-s); }
.dock-b .bino-msgs { margin-top: 8px; }
.bino-starts { border-top: 1px solid var(--line); padding: 12px 18px 16px; }
.bino-starts-h { margin: 0 0 8px; font: 600 11px/1.2 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
.bino-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.bino-chip { font-weight: 500; border-radius: 999px; padding: 7px 13px; text-align: left; max-width: 100%; }
.bino-chip.todo { border-style: dashed; }
.bino-chip.todo .t3 { font-weight: 600; }
.bino-convs li + li { border-top: 1px solid var(--line); }
.bino-convs a { display: grid; gap: 2px; padding: 8px 0; text-decoration: none; }
.bino-conv-t { font-weight: 600; overflow-wrap: anywhere; }
.bino-convs a:hover .bino-conv-t { color: var(--accent); }
.bino-convs .t3 { font-size: var(--fs-xs); }
.bino-plan { margin: 12px 0 0; padding: 12px 14px; border: 1px dashed var(--accent-line); border-radius: var(--r-s); background: var(--accent-soft); }
.bino-plan.done { border-style: solid; }
.bino-plan-h { margin: 0 0 8px; font: 600 var(--fs-s)/1.4 var(--sans); color: var(--accent); }
.bino-steps { margin: 8px 0; padding-left: 1.4em; display: grid; gap: 6px; }
.bino-step { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; align-items: center; }
.bino-target { margin: 8px 0; border: 0; padding: 0; display: flex; gap: 14px; flex-wrap: wrap; }
.bino-convs, .bino-mems { list-style: none; margin: 0; padding: 0; display: grid; }
.bino-mems { gap: 8px; font-size: var(--fs-s); }
.bino-mems li { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
@media (max-width: 900px) { .bino-hub { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .bino-step { grid-template-columns: 1fr; } }

/* ── PR viewer, diff viewer, code explorer (src/pages/viewer.ts) ── */
.pr-meta { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.add { color: var(--ok); } .del { color: var(--bad); }
.pr-comments { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.pr-comment { border-left: 2px solid var(--line-2); padding: 2px 0 2px 12px; }
.pr-comment .description { border-top: 0; margin-top: 4px; padding-top: 0; }
.pr-who { font-size: var(--fs-s); color: var(--ink-2); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pr-thread { margin: 0 0 10px; border: 1px solid var(--line); border-radius: var(--r-s); background: var(--surface); }
.pr-thread > summary { cursor: pointer; padding: 6px 10px; font-size: var(--fs-s); color: var(--ink-2); }
.pr-thread > .pr-comments { padding: 4px 12px 10px; }
.pr-folded > summary { cursor: pointer; color: var(--ink-3); font-size: var(--fs-s); margin: 6px 0; }
.dfile-index ul { list-style: none; margin: 0 0 14px; padding: 0; columns: 2 20rem; font-size: var(--fs-s); }
.dfile-index li { break-inside: avoid; padding: 1px 0; }
.dfile { border: 1px solid var(--line); border-radius: var(--r-s); margin: 0 0 12px; background: var(--surface); }
.dfile > summary { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: center; padding: 8px 12px; cursor: pointer; position: sticky; top: 0; z-index: 1; background: var(--surface-2); border-radius: var(--r-s); }
.dfile-name { display: inline-flex; gap: 6px; align-items: center; min-width: 0; overflow-wrap: anywhere; }
.dfile-meta { display: inline-flex; gap: 10px; align-items: center; font-size: var(--fs-s); }
.viewed-label { display: inline-flex; gap: 4px; align-items: center; color: var(--ink-2); cursor: pointer; }
.viewed { margin: 0; }
.dfile-why { margin: 8px 12px; }
.dfile-threads { padding: 8px 12px 0; }
.diff-wrap { overflow-x: auto; }
.diff, .code-view { border-collapse: collapse; width: 100%; font: 12.5px/1.5 var(--mono); }
.diff td, .code-view td { padding: 0 8px; vertical-align: top; }
.diff .ln, .code-view .ln { width: 1%; min-width: 3.5em; text-align: right; color: var(--ink-3); user-select: none; white-space: nowrap; border-right: 1px solid var(--line); }
.code-view .ln a { color: inherit; text-decoration: none; }
.diff .code, .code-view .code { white-space: pre; }
.diff code, .code-view code { font: inherit; background: none; padding: 0; }
.d-sign { display: inline-block; width: 1.2em; color: var(--ink-3); user-select: none; }
.d-add { background: var(--ok-soft); } .d-del { background: var(--bad-soft); } .d-ctx { background: transparent; }
.d-hunk td { background: var(--accent-soft); color: var(--ink-2); padding-top: 2px; padding-bottom: 2px; }
.d-note td { font-style: italic; }
.d-threads td { padding: 8px 12px; background: var(--surface-2); white-space: normal; font-family: var(--sans); font-size: var(--fs-s); }
.code-view tr:target td { background: var(--warn-soft); }
.code-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.code-bar form { display: flex; gap: 6px; align-items: center; margin: 0; }
.code-ref input[type="text"] { width: 14rem; } .code-search input[type="search"] { min-width: 16rem; }
.code-crumbs { margin: 0 0 10px; font-size: var(--fs-s); color: var(--ink-3); overflow-wrap: anywhere; }

/* ── Terminals: a dark pane in either theme, as tall as the window allows ── */
:root { --term-bg: #0e1922; --term-ink: #e6ecf0; --term-sel: #2d4a60; }
.term-wrap { margin: 12px 0 8px; padding: 10px 12px; border-radius: var(--r); background: var(--term-bg); border: 1px solid var(--line-2); }
.term { height: calc(100vh - 290px); min-height: 320px; }
.term .xterm { height: 100%; }
.term-new .fields { align-items: flex-end; }
.resume-here { display: inline-block; margin: 0 0 0 8px; vertical-align: middle; }

/* ── Going somewhere: a bar along the top edge, a pressed button that's working, pages that cross-fade ── */
html.going::before { content: ""; position: fixed; z-index: 100; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent) no-repeat; background-size: 35% 100%; animation: going 1.1s ease-in-out infinite; pointer-events: none; }
@keyframes going { from { background-position: -40% 0; } to { background-position: 140% 0; } }
html.going, html.going a, html.going button { cursor: progress; }
button.busy { opacity: .8; }
button.busy::after { content: ""; display: inline-block; width: .75em; height: .75em; margin-left: .5em; vertical-align: -1px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.live-dot.sync { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); animation: breathe 1.2s ease-in-out infinite; }
.pending { display: grid; justify-items: center; gap: 4px; text-align: center; padding: 16vh 16px; }
.pending h1 { font: 400 var(--fs-xl)/1.2 var(--serif); margin: 14px 0 0; }
.pending p { margin: 0; max-width: 34rem; }
.spinner { width: 26px; height: 26px; border: 2px solid var(--line-2); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@view-transition { navigation: auto; }
.side { view-transition-name: side; } .foot { view-transition-name: foot; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 150ms; }
/* ── Stats and charts (src/pages/stats.ts, src/ui/chart.ts) ── */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin: 0 0 22px; }
.kpi { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 14px 16px 10px; display: grid; gap: 2px; align-content: start; }
.kpi-l { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.kpi-v { margin: 0; font: 600 30px/1.15 var(--sans); color: var(--ink); }
.kpi-n { margin: 0; font-size: var(--fs-xs); color: var(--ink-2); }
.stats-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; align-items: start; }
.stats-grid > .panel { margin: 0; }
.stats-grid > .panel:last-child:nth-child(odd) { grid-column: 1 / -1; }
.viz { margin: 0; display: grid; gap: 8px; min-width: 0; }
.viz svg { width: 100%; height: auto; display: block; overflow: visible; }
.vgrid line { stroke: var(--line); stroke-width: 1; }
.vbase { stroke: var(--line-2); stroke-width: 1; }
.vticks text, .vxl text { fill: var(--ink-3); font: 11px var(--mono); font-variant-numeric: tabular-nums; }
.vdl { fill: var(--ink-2); font: 600 11.5px var(--mono); }
.vb.c1, .vd.c1 { fill: var(--c1); } .vb.c2, .vd.c2 { fill: var(--c2); } .vb.warn { fill: var(--warn); }
.vl { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; } .vl.c1 { stroke: var(--c1); } .vl.c2 { stroke: var(--c2); }
.vd { stroke: var(--surface); stroke-width: 2; }
.vh { fill: transparent; }
.vt { outline: none; }
.vt:hover .vh, .vt:focus-visible .vh { fill: var(--hover); fill-opacity: .55; }
.vt:hover .vb, .vt:focus-visible .vb { filter: brightness(1.15); }
.vt.part .vb { fill-opacity: .5; }
.vx { stroke: var(--ink-3); stroke-width: 1; opacity: 0; }
.vt:hover .vx, .vt:focus-visible .vx { opacity: .7; }
.vlegend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--fs-xs); color: var(--ink-2); }
.vlegend li { display: flex; align-items: center; gap: 6px; }
.vkey { display: inline-block; flex: none; }
.vkey.rect { width: 10px; height: 10px; border-radius: 2px; } .vkey.line { width: 14px; height: 2px; border-radius: 1px; }
.vkey.c1 { background: var(--c1); } .vkey.c2 { background: var(--c2); }
.vtable > summary { font-size: var(--fs-xs); color: var(--ink-3); cursor: pointer; width: max-content; }
.vtable .sheet { margin-top: 6px; max-height: 320px; }
.vspark { width: 96px; height: 26px; margin-top: 4px; }
.vspark path { fill: none; stroke: var(--ink-3); stroke-width: 1.5; stroke-linejoin: round; }
.vhbars { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.vhbars li { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(60px, 1fr) minmax(70px, auto); gap: 12px; align-items: center; font-size: var(--fs-s); }
.hb-l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hb-b { width: 100%; height: 10px; display: block; }
.hb-v { font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; text-align: right; }
.vtip { position: fixed; z-index: 60; pointer-events: none; display: grid; gap: 1px; background: var(--surface); border: 1px solid var(--line-2); border-radius: 8px; padding: 6px 10px; font-size: var(--fs-xs); color: var(--ink-3); box-shadow: var(--shadow); max-width: 320px; }
.vtip[hidden] { display: none; }
.vtip strong { color: var(--ink); font-size: var(--fs-s); font-weight: 600; }
@media (max-width: 1000px) { .stats-grid { grid-template-columns: minmax(0, 1fr); } }
@media (forced-colors: active) { .vb, .vd { fill: CanvasText; } .vl { stroke: CanvasText; } .vkey { background: CanvasText; } }
@media (prefers-reduced-motion: reduce) {
  .fresh, .leaving, .bump, .settled > .bubble, .breathe, .turn-row.live .bubble::after, .live-dot.sync, .spinner, button.busy::after { animation: none; } .chev { transition: none; }
  html.going::before { animation: none; background: var(--accent); }
  @view-transition { navigation: none; }
}
` + CHARTS_CSS + ISSUES_CSS + SPLASH_CSS;

/** A short content hash, so the stylesheet's URL changes when it does and can be cached for good. */
export function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export const STYLE_PATH = `/assets/app.${hashOf(STYLE)}.css`;
