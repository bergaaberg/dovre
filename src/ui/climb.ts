/**
 * The climb's scene (#417): the splash's ridge (src/ui/splash.ts), climbed. Each step of the
 * first-run page sinks the ridges and brings on dawn, and each pack picked plants a flag on the
 * ridgeline. Pages are whole loads, so a step's scene starts where the step before it left off
 * (`cl-from-<step>`) and moves to its own (`cl-at-<step>`). Built from numbers and escaped names
 * only; all motion stops under prefers-reduced-motion.
 */
import { html } from "hono/html";

/** The climb's steps, in order, and how far up each is (0 the foot, 1 the summit). */
export const STEPS = ["welcome", "role", "machine", "q0", "q1", "packs", "summit"] as const;
export type Step = (typeof STEPS)[number];
const P: Record<Step, number> = { welcome: 0, role: 0.17, machine: 0.33, q0: 0.5, q1: 0.67, packs: 0.83, summit: 1 };

/** The far ridge's edge: the same line as the splash's. */
const EDGE: [number, number][] = [[0, 560], [120, 470], [210, 520], [330, 400], [430, 480], [520, 430], [640, 330], [760, 450], [860, 410], [980, 480], [1080, 380], [1180, 450], [1280, 420]];
const EDGE_D = `M${EDGE.map(([x, y]) => `${x} ${y}`).join(" L")}`;
const SEGS = EDGE.slice(1).map(([x, y], i) => ({ x0: EDGE[i]![0], y0: EDGE[i]![1], x, y, len: Math.hypot(x - EDGE[i]![0], y - EDGE[i]![1]) }));
const LENGTH = SEGS.reduce((n, s) => n + s.len, 0);

/** The point a fraction of the way along the edge. */
export function along(f: number): { x: number; y: number } {
  let left = Math.max(0, Math.min(1, f)) * LENGTH;
  for (const s of SEGS) {
    if (left <= s.len) {
      const k = s.len ? left / s.len : 0;
      return { x: Math.round(s.x0 + (s.x - s.x0) * k), y: Math.round(s.y0 + (s.y - s.y0) * k) };
    }
    left -= s.len;
  }
  return { x: EDGE.at(-1)![0], y: EDGE.at(-1)![1] };
}

/** Where the n-th flag stands: spread along the ridge by the golden ratio, so they never bunch. */
export const flagAt = (n: number) => along(0.04 + ((0.5 + n * 0.618034) % 1) * 0.92);

export type Flag = { name: string; /** Planted on this step (it springs up). */ fresh?: boolean; /** Waits for something (the laptop): a hollow flag. */ wait?: boolean; /** The one this page is about (a pack's setup): the others dim. */ focus?: boolean };

/** The same stars on every draw: a small seeded source. */
const STARS = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280), seed / 233280);
  return Array.from({ length: 60 }, () => ({ x: Math.round(rnd() * 1280), y: Math.round(rnd() * 380), r: (0.5 + rnd() * 1.2).toFixed(1), d: Math.floor(rnd() * 3) }));
})();

/** The scene at `step`, coming from `from` (the step before it; none on the first). */
export function climbArt(step: Step, flags: Flag[], from?: Step) {
  const cls = `cl-art cl-at-${step}${from && from !== step ? ` cl-from-${from}` : ""}${step === "summit" ? " cl-summit" : ""}${flags.some((f) => f.focus) ? " cl-dim" : ""}`;
  const planted = flags.slice(0, 40).map((f, i) => {
    const { x, y } = flagAt(i);
    const kind = `cl-flag${f.fresh ? " cl-fresh" : ""}${f.wait ? " cl-wait" : ""}${f.focus ? " cl-focus" : ""}`;
    return html`<g class="${kind}"><g class="cl-pole"><line x1="${x}" y1="${y}" x2="${x}" y2="${y - 34}"/><polygon points="${x},${y - 34} ${x + 18},${y - 28.5} ${x},${y - 23}"/></g><text x="${x + 4}" y="${y - 42}">${f.name}</text></g>`;
  });
  return html`<svg class="${cls}" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<defs><linearGradient id="cl-dawn-g" x1="0" y1="0" x2="0" y2="1"><stop class="cl-dawn-a" offset="0"/><stop class="cl-dawn-b" offset=".55"/><stop class="cl-dawn-c" offset=".9"/></linearGradient></defs>
<rect class="sp-sky" width="1280" height="800"/>
<rect class="cl-dawn" width="1280" height="800"/>
<g class="cl-stars">${STARS.map((s) => html`<circle class="${`sp-star sp-d${s.d}`}" cx="${s.x}" cy="${s.y}" r="${s.r}"/>`)}</g>
<circle class="cl-sun" cx="1010" cy="250" r="32"/>
<g class="cl-far"><path class="sp-far" d="${EDGE_D} L1280 1100 L0 1100 Z"/><path class="sp-line" d="${EDGE_D}"/><path class="sp-snow" d="M612 357 L640 330 L668 357 L654 352 L640 362 L627 351 Z"/><path class="sp-snow" d="M1056 404 L1080 380 L1102 401 L1090 398 L1080 407 L1069 397 Z"/>${planted}</g>
<g class="cl-near"><path class="sp-near" d="M0 640 L90 600 L200 650 L320 560 L450 640 L560 590 L700 680 L820 600 L940 650 L1060 580 L1170 640 L1280 610 L1280 1200 L0 1200 Z"/></g>
<g class="cl-fore"><path class="sp-fore" d="M0 720 L140 690 L300 730 L470 680 L640 735 L800 690 L980 730 L1130 700 L1280 725 L1280 1200 L0 1200 Z"/></g>
</svg>`;
}

const AT = STEPS.map((s) => `.cl-at-${s} { --cl-p: ${P[s]}; }`).join("\n");
const FROM = STEPS.map((s) => `@keyframes cl-from-${s} { from { --cl-p: ${P[s]}; } }\n.cl-from-${s} { animation: cl-from-${s} 1.6s cubic-bezier(.2,.7,.2,1) both; }`).join("\n");
const M = ':root:not([data-motion="always"])';

/** The climb's rules, on the app's tokens and the splash's (in the one stylesheet). */
export const CLIMB_CSS = String.raw`
/* ── The climb (src/ui/climb.ts, src/pages/welcome.ts) ── */
@property --cl-p { syntax: "<number>"; inherits: true; initial-value: 0; }
${AT}
${FROM}
.cl-dawn { fill: url(#cl-dawn-g); opacity: var(--cl-p); }
.cl-dawn-a { stop-color: var(--sky); }
.cl-dawn-b { stop-color: color-mix(in oklab, var(--sky) 55%, #9b6f7e); }
.cl-dawn-c { stop-color: color-mix(in oklab, var(--sun) 30%, #e59c76); }
.cl-stars { opacity: calc(1 - var(--cl-p) * .9); }
.cl-sun { fill: color-mix(in oklab, var(--sun) 35%, #f4b47f); transform: translateY(calc((1 - var(--cl-p)) * 330px)); }
.cl-far { transform: translateY(calc(var(--cl-p) * 250px)); }
.cl-near { transform: translateY(calc(var(--cl-p) * 300px)); }
.cl-fore { transform: translateY(calc(var(--cl-p) * 340px)); }
.cl-flag line { stroke: var(--snow); stroke-width: 1.4; }
.cl-flag polygon { fill: var(--accent); }
.cl-flag.cl-wait polygon { fill: none; stroke: var(--sun); stroke-width: 1.4; }
.cl-flag text { fill: var(--ink); font: 13px var(--climb-font); opacity: 0; paint-order: stroke; stroke: var(--sky); stroke-width: 3px; }
.cl-fresh .cl-pole { animation: cl-plant .7s cubic-bezier(.3,1.6,.5,1) .5s both; transform-box: fill-box; transform-origin: 50% 100%; }
.cl-fresh text { animation: cl-say 2.8s ease .8s both; }
.cl-summit .cl-flag polygon { fill: color-mix(in oklab, var(--sun) 35%, #f4b47f); }
.cl-summit .cl-flag text { opacity: 1; animation: none; }
.cl-dim .cl-flag { opacity: .45; }
.cl-dim .cl-flag:not(.cl-focus) text { display: none; }
.cl-dim .cl-flag.cl-focus { opacity: 1; }
.cl-dim .cl-flag.cl-focus polygon { fill: var(--accent); }
/* The one label on a setup page stands on the dawn, which is warm in every theme: dark ink, no halo. */
.cl-dim .cl-flag.cl-focus text { fill: #1d1a22; stroke: none; font-weight: 600; }
@keyframes cl-plant { from { transform: scaleY(0); } }
@keyframes cl-say { 0% { opacity: 0; } 15%, 75% { opacity: 1; } 100% { opacity: 0; } }

.climb-page { --climb-font: var(--sans); margin: 0; min-height: 100vh; background: var(--sky); background-image: none; color: var(--ink); font: 15px/1.5 var(--climb-font); }
.climb-scene { position: fixed; inset: 0; z-index: 0; }
.climb-scene .cl-art { width: 100%; height: 100%; display: block; }
.climb { position: relative; z-index: 1; min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; justify-items: center; padding: max(9vh, 48px) max(16px, env(safe-area-inset-right, 0px)) 34vh max(16px, env(safe-area-inset-left, 0px)); box-sizing: border-box; }
.climb-col, .climb-col * { box-sizing: border-box; }
.climb-col { width: 100%; max-width: 640px; display: grid; gap: 22px; min-width: 0; animation: cl-rise .6s cubic-bezier(.2,.7,.2,1) both; }
@keyframes cl-rise { from { opacity: 0; transform: translateY(14px); } }
.climb-col form { display: grid; gap: 22px; margin: 0; }
.climb-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--ink-3); font-size: 13px; }
.climb-mark { display: flex; gap: 8px; align-items: center; color: var(--ink-2); letter-spacing: .02em; }
.climb-mark svg { width: 26px; height: 20px; }
.climb-alt { font-variant-numeric: tabular-nums; letter-spacing: .04em; }
.climb-eyebrow { color: var(--accent); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
.climb h1 { font: 200 clamp(64px, 13vw, 128px)/.95 var(--climb-font); letter-spacing: -.035em; margin: 0; }
.climb h2 { font: 300 clamp(30px, 5.2vw, 48px)/1.08 var(--climb-font); letter-spacing: -.02em; margin: 0; text-wrap: balance; }
.climb h3 { margin: 0; font-size: 14px; font-weight: 600; }
.climb p { margin: 0; }
.climb-lede { font-size: clamp(17px, 2.2vw, 20px); color: var(--ink-2); max-width: 34ch; text-wrap: pretty; }
.climb-small { color: var(--ink-3); font-size: 13px; }
.climb-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.climb-row form { display: contents; }
.climb-go { appearance: none; border: 0; cursor: pointer; background: var(--accent); color: var(--bg); font: 600 15px/1 var(--climb-font); padding: 14px 24px; border-radius: 999px; display: inline-flex; gap: 10px; align-items: center; text-decoration: none; transition: transform .15s; }
.climb-go:hover { transform: translateY(-1px); }
.climb-link { appearance: none; background: none; border: 0; color: var(--ink-3); cursor: pointer; padding: 8px 4px; font: inherit; text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 4px; }
.climb-link:hover { color: var(--ink); }
.climb-go:disabled { opacity: .45; cursor: not-allowed; transform: none; }
/* A pack's setup (#444): the ground closes the page under the step, never behind it, and scrolls with it. */
.su-page { position: relative; }
.su-page .climb-scene { position: absolute; inset: auto 0 0 0; height: 440px; overflow: hidden; -webkit-mask-image: linear-gradient(transparent, #000 30%); mask-image: linear-gradient(transparent, #000 30%); }
.su-page .climb-scene .cl-art { position: absolute; inset: auto 0 0 0; height: 820px; }
.su-page .climb { padding-bottom: 300px; }
/* The pack's body is kit parts; on the climb they take the climb's look. */
.su-body .t2 { color: var(--ink-2); font-size: 15px; }
.su-body .check-rows > legend { color: var(--ink-3); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; padding-bottom: 10px; }
.su-body .check-row { grid-template-columns: 22px minmax(0, 1fr); align-items: center; gap: 14px; padding: 14px 4px; border-top: 0; border-bottom: 1px solid var(--line-2); }
.su-body .check-rows > legend + .check-row, .su-body .check-rows > .check-row:first-child { border-top: 1px solid var(--line-2); }
.su-body .check-row b { font-size: 19px; font-weight: 300; }
.su-body .check-row input { appearance: none; width: 20px; height: 20px; border: 1.5px solid var(--ink-3); border-radius: 6px; display: grid; place-content: center; cursor: pointer; }
.su-body .check-row input::before { content: ""; width: 10px; height: 6px; border: solid var(--bg); border-width: 0 0 2px 2px; transform: rotate(-45deg) translate(1px, -1px); opacity: 0; }
.su-body .check-row input:checked { background: var(--accent); border-color: var(--accent); }
.su-body .check-row input:checked::before { opacity: 1; }
.su-body .check-row input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.su-body .check-row:has(input:checked) b { color: var(--accent); }
.su-body ul.list { border-top: 1px solid var(--line-2); }
.su-body ul.list > li { border-top: 0; border-bottom: 1px solid var(--line-2); }
.su-body .item { align-items: center; padding: 12px 4px; }
.su-body .item:has(> .lead:empty) { grid-template-columns: minmax(0, 1fr) auto; }
.su-body .item > .lead:empty { display: none; }
.su-body .item .title > strong { font-size: 17px; font-weight: 400; }
.su-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--ink-3); font-size: 13px; }
.su-head .climb-link { padding: 0; }
.su-body { display: grid; gap: 14px; min-width: 0; }
.su-foot { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; }
/* A step's own main button where Next goes (#441): Confirm's summary, or its one-click button, look like Next. */
.su-go { position: relative; }
.su-go > form > button, .su-go details.confirm > summary { appearance: none; border: 0; cursor: pointer; background: var(--accent); color: var(--bg); font: 600 15px/1 var(--climb-font); padding: 14px 24px; border-radius: 999px; }
.su-go details.confirm[open] > summary { color: var(--bg); opacity: .8; }
.su-go details.confirm .confirm-body { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 3; width: min(22rem, calc(100vw - 32px)); margin: 0; box-shadow: var(--shadow); background: var(--surface); }
.su-dots { display: flex; gap: 8px; }
.su-dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--line-2); }
.su-dots i.su-past { background: color-mix(in oklab, var(--accent) 50%, var(--line-2)); }
.su-dots i.su-on { background: var(--accent); }
.su-note { color: var(--warn); font-size: 13px; }
.climb-opts { display: grid; border: 0; border-top: 1px solid var(--line-2); margin: 0; padding: 0; min-width: 0; }
.climb-opt { position: relative; border-bottom: 1px solid var(--line-2); cursor: pointer; padding: 14px 4px; display: grid; grid-template-columns: 28px 1fr auto; gap: 14px; align-items: baseline; transition: padding .2s; }
.climb-opt:hover { padding-left: 10px; }
.climb-opt input { position: absolute; opacity: 0; pointer-events: none; }
.climb-opt:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.climb-k { color: var(--ink-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.climb-l { font-size: clamp(19px, 2.6vw, 24px); font-weight: 300; }
.climb-s { color: var(--ink-3); font-size: 13px; }
.climb-opt:has(input:checked) .climb-l, .climb-opt:has(input:checked) .climb-k { color: var(--accent); }
button.climb-opt { appearance: none; background: none; border: 0; border-bottom: 1px solid var(--line-2); color: inherit; font: inherit; text-align: left; width: 100%; }
button.climb-opt.on .climb-l, button.climb-opt.on .climb-k { color: var(--accent); }
@media (max-width: 520px) { .climb-opt { grid-template-columns: 22px 1fr; } .climb-s { grid-column: 2; } }
.climb-inline { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; color: var(--ink-2); font-size: 14px; border: 0; margin: 0; padding: 0; }
.climb-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.climb-chip { position: relative; cursor: pointer; border: 1px solid var(--line-2); background: color-mix(in oklab, var(--surface) 70%, transparent); padding: 7px 14px; border-radius: 999px; font-size: 14px; }
.climb-chip input { position: absolute; opacity: 0; pointer-events: none; }
.climb-chip:has(input:checked) { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.climb-chip:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.climb input.climb-in { background: none; border: 0; border-bottom: 1px solid var(--ink-3); border-radius: 0; box-shadow: none; height: auto; padding: 4px 2px; min-width: 0; width: 240px; max-width: 100%; color: var(--ink); font: inherit; }
.climb input.climb-in:focus { outline: none; border-color: var(--accent); }
.climb input.climb-in:disabled { opacity: .7; }
.climb-scan { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.climb-scan li { display: grid; grid-template-columns: 1fr auto; gap: 12px; font-size: 15px; }
.climb-scan code, .climb-cmd code { font-family: var(--mono); font-size: 13px; color: var(--ink-2); }
.climb-scan li > span:last-child { color: var(--accent); text-align: right; }
.climb-cmd { display: flex; gap: 10px; align-items: center; background: color-mix(in oklab, var(--surface) 70%, transparent); border: 1px solid var(--line-2); border-radius: 12px; padding: 10px 14px; overflow-x: auto; }
.climb-cmd code { white-space: nowrap; font-size: 14px; color: var(--ink); }
.climb-listen { display: flex; gap: 10px; align-items: center; color: var(--ink-2); font-size: 14px; }
.climb-beacon { width: 9px; height: 9px; border-radius: 50%; background: var(--sun); animation: cl-ping 1.8s ease-out infinite; }
.climb-beacon.on { background: var(--accent); animation: none; }
@keyframes cl-ping { 0% { box-shadow: 0 0 0 0 var(--sun); } 70%, 100% { box-shadow: 0 0 0 10px transparent; } }
.climb-kit { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; border: 0; margin: 0; padding: 0; min-width: 0; }
.climb-tile { position: relative; cursor: pointer; border: 1px solid var(--line-2); background: color-mix(in oklab, var(--surface) 84%, transparent); border-radius: 14px; padding: 12px 14px; display: grid; gap: 3px; min-width: 0; }
.climb-tile input { position: absolute; opacity: 0; pointer-events: none; }
.climb-tile b { font-weight: 600; font-size: 14px; display: flex; gap: 8px; align-items: center; }
.climb-tile b::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--ink-3); flex: none; }
.climb-tile small { color: var(--ink-3); font-size: 12px; line-height: 1.35; }
.climb-tile:has(input:checked) { border-color: var(--accent); }
.climb-tile:has(input:checked) b::before { background: var(--accent); border-color: var(--accent); }
.climb-tile:has(input:disabled) { cursor: default; opacity: .5; }
.climb-tile:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.climb-why { color: var(--accent); font-size: 11px; letter-spacing: .02em; }
.climb-tile .climb-no { color: var(--ink-3); font-size: 11px; }
.climb-more > summary { cursor: pointer; color: var(--ink-3); font-size: 13px; }
.climb-more[open] > summary { margin-bottom: 10px; }
.climb-card { display: grid; gap: 12px; padding: 16px; border-radius: 14px; background: color-mix(in oklab, var(--surface) 84%, transparent); border: 1px solid var(--line-2); }
.climb-later { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; font-size: 14px; color: var(--ink-2); }
.climb-later b { color: var(--ink); font-weight: 600; }
.climb-later a { color: var(--accent); }
@media (prefers-reduced-motion: reduce) {
  ${M} .cl-art, ${M} .cl-art *, ${M} .climb-col, ${M} .climb-beacon { animation: none; }
  ${M} .cl-art .sp-line { stroke-dashoffset: 0; }
  ${M} .cl-fresh text { opacity: 0; }
}
`;
