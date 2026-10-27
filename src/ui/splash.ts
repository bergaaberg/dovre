/**
 * The splash (WP-A23, the user's pick of the onboarding prototype, 2026-10-23): the ridge at night
 * (by day in light mode), its edge drawing itself, the moon rising, the stars. The first screen of
 * the first-run page (src/pages/welcome.ts) and the backdrop of the launcher's starting page
 * (src/pwa.ts). Built from constants and numbers only; colours come from the tokens, so it follows
 * the light. All motion stops under prefers-reduced-motion.
 */
import { html, raw } from "hono/html";

/** The mountain mark: a ridge, a summit cairn, the sun. */
export const MARK = html`<svg viewBox="0 0 30 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M1 21 10.5 6.5 15.5 13.5 19.5 8.5 29 21"/><path d="M8 10.3 10.5 6.5 12.6 9.6 11 10.6 9.6 9.5Z" stroke-width="1.1"/><circle cx="23.5" cy="4" r="2.4"/></svg>`;

const EDGE = "M0 560 L120 470 L210 520 L330 400 L430 480 L520 430 L640 330 L760 450 L860 410 L980 480 L1080 380 L1180 450 L1280 420";

/** The same stars on every draw: a small seeded source. */
function stars(): string {
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280), seed / 233280);
  const out: string[] = [];
  for (let i = 0; i < 46; i++) {
    const x = Math.round(rnd() * 1280);
    const y = Math.round(rnd() * 380);
    const r = (0.6 + rnd() * 1.1).toFixed(1);
    const d = (rnd() * 4).toFixed(1);
    const cls = `sp-star sp-d${Math.round(Number(d))}`;
    out.push(`<circle class="${cls}" cx="${x}" cy="${y}" r="${r}"/>`);
  }
  return out.join("");
}

/** The scene, filling its box from the bottom (the ridge stays put; the sky gives way). */
export const RIDGE_ART = html`<svg class="splash-art" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<rect class="sp-sky" width="1280" height="800"/>
${raw(stars())}
<circle class="sp-sun" cx="1010" cy="250" r="30"/>
<path class="sp-far" d="${EDGE} L1280 800 L0 800 Z"/>
<path class="sp-line" d="${EDGE}"/>
<path class="sp-snow" d="M612 357 L640 330 L668 357 L654 352 L640 362 L627 351 Z"/>
<path class="sp-snow" d="M1056 404 L1080 380 L1102 401 L1090 398 L1080 407 L1069 397 Z"/>
<path class="sp-near" d="M0 640 L90 600 L200 650 L320 560 L450 640 L560 590 L700 680 L820 600 L940 650 L1060 580 L1170 640 L1280 610 L1280 800 L0 800 Z"/>
<path class="sp-fore" d="M0 720 L140 690 L300 730 L470 680 L640 735 L800 690 L980 730 L1130 700 L1280 725 L1280 800 L0 800 Z"/>
</svg>`;

/** The splash's rules, on the app's tokens: in the one stylesheet, and inline in the starting page. */
export const SPLASH_CSS = String.raw`
/* ── The splash (src/ui/splash.ts) ── */
.splash-page { margin: 0; min-height: 100vh; overflow: hidden; background: var(--bg); background-image: none; }
.splash { position: fixed; inset: 0; overflow: hidden; }
.splash-art { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.sp-sky { fill: var(--sky); }
.sp-star { fill: var(--star); animation: sp-twinkle 4s ease-in-out infinite alternate; }
.sp-d1 { animation-delay: 1s; } .sp-d2 { animation-delay: 2s; } .sp-d3 { animation-delay: 3s; } .sp-d4 { animation-delay: 4s; }
.sp-sun { fill: none; stroke: var(--sun); stroke-width: 2; animation: sp-rise 2.6s ease-out .4s both; }
.sp-far { fill: var(--ridge-far); }
.sp-near { fill: var(--ridge-near); }
.sp-fore { fill: var(--surface); }
.sp-snow { fill: var(--snow); }
.sp-line { fill: none; stroke: var(--ridge-edge); stroke-width: 1.5; stroke-linejoin: round; stroke-dasharray: 1800; stroke-dashoffset: 1800; animation: sp-draw 2.2s ease-out .2s forwards; }
.splash-text { position: absolute; left: clamp(24px, 9vw, 120px); right: 24px; top: 14vh; max-width: 620px; display: flex; flex-direction: column; gap: 20px; }
.splash-brand { display: flex; align-items: center; gap: 18px; color: var(--accent); }
.splash-brand svg { width: 66px; height: 48px; flex: none; }
.splash-text h1 { margin: 0; color: var(--ink); font: 700 clamp(40px, 6vw, 64px)/1 var(--display); letter-spacing: -.02em; }
.splash-lede { margin: 0; font-size: clamp(16px, 1.6vw, 20px); color: var(--ink-2); }
.splash-go { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-top: 18px; }
.splash-go .btn { min-height: 48px; padding: 0 26px; font-size: 16px; text-decoration: none; }
.splash-note { color: var(--ink-3); font-size: var(--fs-s); }
.splash-foot { position: absolute; left: clamp(24px, 9vw, 120px); bottom: 28px; margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.splash-pic { position: absolute; right: clamp(16px, 8vw, 140px); bottom: 6vh; width: clamp(160px, 24vw, 300px); height: auto; animation: sp-fade .9s ease-out .8s both; }
.splash-fade { animation: sp-fade .9s ease-out 1.2s both; }
.splash-fade-2 { animation: sp-fade .9s ease-out 1.7s both; }
@keyframes sp-draw { to { stroke-dashoffset: 0; } }
@keyframes sp-rise { from { transform: translateY(70px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes sp-fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes sp-twinkle { from { opacity: .35; } to { opacity: .9; } }
/* By day there are no stars. */
@media (prefers-color-scheme: light) { .sp-star { display: none; } }
@media (prefers-reduced-motion: reduce) {
  .sp-star, .sp-sun, .sp-line, .splash-fade, .splash-fade-2, .splash-pic { animation: none; }
  .sp-line { stroke-dashoffset: 0; }
}
`;
