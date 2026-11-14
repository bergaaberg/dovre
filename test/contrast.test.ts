/**
 * WCAG 2.2 AA in every scheme (#524): text tokens 4.5:1 on every surface (1.4.3), a control's edge
 * and a chart's marks 3:1 (1.4.11). The tokens are read from the stylesheet itself, each scheme laid
 * over light's as the cascade does, so a new theme or a changed value is checked without listing it here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STYLE } from "../src/ui/style.ts";
import { colourOf, contrastFails, paletteFails } from "../src/ui/contrast.ts";

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

const obj = (t: Tokens) => Object.fromEntries(t);
const colour = (t: Tokens, name: string) => colourOf(obj(t), name);
const check = (t: Tokens, names: string[], min: number, label: string) => contrastFails(obj(t), names, min, label);

test("the schemes are all found", () => {
  assert.deepEqual(schemes.map(([n]) => n).slice(0, 2), ["light", "dark"]);
  assert.ok(schemes.length >= 5, schemes.map(([n]) => n).join(", "));
  assert.ok(accents.length >= 2);
});

test("text is 4.5:1 and controls and marks 3:1 on every surface, in every scheme", () => {
  const fails = schemes.flatMap(([n, t]) => paletteFails(obj(t), n));
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
