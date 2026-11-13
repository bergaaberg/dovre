/**
 * WCAG 2.2 AA in every scheme (#524): text tokens 4.5:1 on every surface (1.4.3), a control's edge
 * and a chart's marks 3:1 (1.4.11). The tokens are read from the stylesheet itself, each scheme laid
 * over light's as the cascade does, so a new theme or a changed value is checked without listing it here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STYLE } from "../src/ui/style.ts";

type Tokens = Map<string, string>;

/** The declarations of the first rule whose selector is exactly `selector`. */
const block = (selector: string): Tokens => {
  const at = STYLE.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no ${selector} rule`);
  let depth = 0, i = STYLE.indexOf("{", at), end = i;
  for (; end < STYLE.length; end++) {
    if (STYLE[end] === "{") depth++;
    else if (STYLE[end] === "}" && --depth === 0) break;
  }
  const out: Tokens = new Map();
  for (const m of STYLE.slice(i + 1, end).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
};

const light = block(":root");
const schemes: [string, Tokens][] = [["light", light], ...["dark", ...[...STYLE.matchAll(/:root\[data-theme="([a-z]+)"\] \{\n {2}color-scheme/g)].map((m) => m[1])].filter((n, i, a) => a.indexOf(n) === i).map((n): [string, Tokens] => [n, new Map([...light, ...block(`:root[data-theme="${n}"]`)])])];
const accents = [...new Set([...STYLE.matchAll(/\[data-accent="([a-z]+)"\]/g)].map((m) => m[1]))];

/** A token's colour as #rrggbb, through var() aliases; undefined for anything else (color-mix, rgb). */
const colour = (t: Tokens, name: string): string | undefined => {
  const v = t.get(name);
  if (!v) return undefined;
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (alias) return colour(t, alias[1]);
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["--bg", "--surface", "--surface-2", "--hover"];
const TEXT = ["--ink", "--ink-2", "--ink-3", "--accent", "--ok", "--warn", "--bad"];
/** Edges and marks that carry meaning, each on what it's drawn on: a control's boundary on any surface,
 *  chart series on a card's --surface (as the dataviz validator checks them), the horizon's ridge line on its sky. */
const GRAPHIC: [string, string[]][] = [["--control", SURFACES], ["--c1", ["--surface"]], ["--c2", ["--surface"]], ["--ridge-edge", ["--bg", "--sky"]]];

const check = (t: Tokens, names: string[], min: number, label: string, on = SURFACES) => {
  const fails: string[] = [];
  for (const name of names) {
    const fg = colour(t, name);
    if (!fg) { fails.push(`${label} ${name}: not a #rrggbb colour`); continue; }
    for (const s of on) {
      const bg = colour(t, s)!;
      const r = ratio(fg, bg);
      if (r < min) fails.push(`${label} ${name} on ${s}: ${r.toFixed(2)}:1 (needs ${min})`);
    }
  }
  return fails;
};

test("the schemes are all found", () => {
  assert.deepEqual(schemes.map(([n]) => n).slice(0, 2), ["light", "dark"]);
  assert.ok(schemes.length >= 5, schemes.map(([n]) => n).join(", "));
  assert.ok(accents.length >= 2);
});

test("text is 4.5:1 and controls and marks 3:1 on every surface, in every scheme", () => {
  const fails = schemes.flatMap(([n, t]) => [...check(t, TEXT, 4.5, n), ...GRAPHIC.flatMap(([g, on]) => check(t, [g], 3, n, on))]);
  assert.deepEqual(fails, []);
});

test("every accent is 4.5:1 on every surface, in every scheme", () => {
  const fails: string[] = [];
  for (const [n, t] of schemes) {
    for (const a of accents) {
      const own = STYLE.match(new RegExp(`--accent: (#[0-9a-f]{6}); --accent-ink: #[0-9a-f]{6}; --accent-soft: color-mix\\(in srgb, #[0-9a-f]{6} \\d+%, (#[0-9a-f]{6})\\)`, "g")) ?? [];
      // The accent's colour as set for this scheme: the rule mixed on this scheme's own surface.
      const rule = own.find((r) => r.endsWith(`${colour(t, "--surface")})`) && STYLE.includes(`[data-accent="${a}"] { ${r}`));
      assert.ok(rule, `${n}/${a}: no accent rule on this scheme's surface`);
      const c = /--accent: (#[0-9a-f]{6})/.exec(rule!)![1];
      fails.push(...check(new Map([...t, ["--accent", c]]), ["--accent"], 4.5, `${n}/${a}`));
    }
  }
  assert.deepEqual(fails, []);
});

test("controls take their edge from --control, not a divider's line", () => {
  for (const sel of [".choice {", "input[type=text]", ".todo-tick {", ".chatbox-in {", "\n.bino-compose { margin"]) {
    const at = STYLE.indexOf(sel);
    assert.ok(at >= 0, sel);
    const rule = STYLE.slice(at, STYLE.indexOf("}", at));
    assert.match(rule, /border: [\d.]+px solid var\(--control\)/, sel);
  }
});

test("no text is faded with opacity where it could fall under 4.5:1", () => {
  assert.doesNotMatch(STYLE, /\.fe\.mine \{ opacity/);
});
