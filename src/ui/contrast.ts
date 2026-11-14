/**
 * WCAG 2.2 AA for a palette (#524): text tokens 4.5:1 on every surface (1.4.3), a control's edge
 * and a chart's marks 3:1 (1.4.11). test/contrast.test.ts runs it over core's schemes as the
 * stylesheet has them; a pack's theme is run through it before it's offered (src/ui/themes.ts).
 */
import type { Tokens } from "./themes.ts";

/** A token's colour as #rrggbb, through var() aliases; undefined for anything else (color-mix, rgb). */
export const colourOf = (t: Tokens, name: string): string | undefined => {
  const v = t[name];
  if (!v) return undefined;
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (alias) return alias[1] === name ? undefined : colourOf(t, alias[1]!);
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

export const SURFACES = ["--bg", "--surface", "--surface-2", "--hover"];
const TEXT = ["--ink", "--ink-2", "--ink-3", "--accent", "--ok", "--warn", "--bad"];
/** Edges and marks that carry meaning, each on what it's drawn on: a control's boundary on any surface,
 *  chart series on a card's --surface (as the dataviz validator checks them), the horizon's ridge line on its sky. */
const GRAPHIC: [string, string[]][] = [["--control", SURFACES], ["--c1", ["--surface"]], ["--c2", ["--surface"]], ["--ridge-edge", ["--bg", "--sky"]]];

/** Each of `names` that falls under `min`:1 on one of `on`, in words. */
export function contrastFails(t: Tokens, names: string[], min: number, label: string, on = SURFACES): string[] {
  const fails: string[] = [];
  for (const name of names) {
    const fg = colourOf(t, name);
    if (!fg) { fails.push(`${label} ${name}: not a #rrggbb colour`); continue; }
    for (const s of on) {
      const bg = colourOf(t, s);
      if (!bg) { fails.push(`${label} ${s}: not a #rrggbb colour`); continue; }
      const r = ratio(fg, bg);
      if (r < min) fails.push(`${label} ${name} on ${s}: ${r.toFixed(2)}:1 (needs ${min})`);
    }
  }
  return fails;
}

/** What a whole palette fails: its text, then its edges and marks. */
export const paletteFails = (t: Tokens, label: string): string[] => [...contrastFails(t, TEXT, 4.5, label), ...GRAPHIC.flatMap(([g, on]) => contrastFails(t, [g], 3, label, on))];
/** What an accent's colour fails as text on this palette's surfaces. */
export const accentFails = (t: Tokens, c: string, label: string): string[] => contrastFails({ ...t, "--accent": c }, ["--accent"], 4.5, label);
