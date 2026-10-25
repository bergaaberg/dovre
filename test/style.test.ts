/**
 * The stylesheet and the views agree (PLAN D11): every class a view writes is styled somewhere —
 * src/ui/style.ts, the one stylesheet (the charts' rules too), or a core pack's own. A class nobody styles is a typo or a
 * page inventing its own look; add it to the kit instead.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { STYLE } from "../src/ui/style.ts";
import { AVATAR_CSS, AVATAR_PAGE_CSS } from "../src/packs/core/avatar/style.ts";

/** Dovre's own packs' stylesheets (`styles`), served beside the core's: the avatar's. */
const PACKS = AVATAR_PAGE_CSS + AVATAR_CSS;

/** Classes that carry meaning without a style of their own (a hook for a parent rule, or for script). */
const UNSTYLED = new Set<string>([]);

/** The views' sources: a pack's tests (its test/ folder) aren't views. */
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : files(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

test("every class a view uses is in a stylesheet", () => {
  const css = STYLE + PACKS;
  const missing = new Map<string, string>();
  for (const file of files("src")) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/class="([^"]*)"/g)) {
      // Only the literal parts: "${…}" is decided at run time (and usually a tone, checked below).
      for (const name of m[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean)) {
        if (UNSTYLED.has(name) || !/^[a-z][a-z0-9-]*$/.test(name)) continue;
        if (!new RegExp(`\\.${name}(?![a-z0-9-])`).test(css)) missing.set(name, file);
      }
    }
  }
  assert.deepEqual([...missing].map(([name, file]) => `${name} (${file})`), []);
});

test("every tone has its colours", () => {
  for (const tone of ["ok", "warn", "bad", "accent"]) {
    assert.match(STYLE, new RegExp(`\\.pill\\.${tone}\\b`), `pill ${tone}`);
    assert.match(STYLE, new RegExp(`\\.dot\\.${tone}\\b`), `dot ${tone}`);
  }
  for (const tone of ["ok", "warn", "bad"]) assert.match(STYLE, new RegExp(`\\.notice\\.${tone}\\b`), `notice ${tone}`);
});

test("the stylesheet parses: braces balance and no rule is cut in half", () => {
  let depth = 0;
  for (const ch of (STYLE + PACKS).replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    assert.ok(depth >= 0, "a } closes nothing");
  }
  assert.equal(depth, 0, "every { is closed");
  // A selector glued to an at-rule ("ul.list > @media …") is what a half-deleted rule leaves behind.
  assert.doesNotMatch(STYLE, /[>+~,]\s*@/);
});
