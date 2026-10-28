/** The keys, Vimium's way: the page script parses, every key is in the help, and hint labels are unique and even. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HINT_LABELS_JS, SCRIPT } from "../src/ui/app.js.ts";
import { STYLE } from "../src/ui/style.ts";

test("the page script parses", () => {
  assert.doesNotThrow(() => new Function(SCRIPT));
});

test("the keys dialog lists every key", () => {
  for (const key of ["f", "F", "g g", "G", "H / L", "j / k", "d / u", "r", "y y", "g i", "g c", "] / [", "J / K", "o", "/", "?", "Esc"]) assert.ok(SCRIPT.includes(`["${key}", `), `the help lists ${key}`);
  for (const group of ["Hints", "Moving", "Going to", "This page"]) assert.ok(SCRIPT.includes(`["${group}", [`), group);
  assert.ok(!SCRIPT.includes(`["g i", "New work"]`), "g i is Vimium's focus-input now; New work moved to g c");
});

test("hint labels: one each, all the same length, the shortest that fits, only Vimium's letters", () => {
  const hintLabels = new Function(`${HINT_LABELS_JS}; return hintLabels;`)() as (n: number, chars: string) => string[];
  const chars = "sadfjklewcmpgh";
  for (const [n, len] of [[1, 1], [14, 1], [15, 2], [196, 2], [200, 3]] as const) {
    const labels = hintLabels(n, chars);
    assert.equal(labels.length, n);
    assert.equal(new Set(labels).size, n, `${n}: unique`);
    assert.ok(labels.every((l) => l.length === len), `${n}: all ${len} long`);
    assert.ok(labels.every((l) => [...l].every((c) => chars.includes(c))), `${n}: only hint letters`);
    // No label is the start of another, so typing one never stops at the wrong target.
    assert.ok(labels.every((a) => labels.every((b) => a === b || !b.startsWith(a))), `${n}: none a prefix of another`);
  }
  // The first letter varies fastest: 15 targets don't all start with the same key.
  assert.ok(new Set(hintLabels(15, chars).map((l) => l[0])).size > 1);
});

test("the hint overlay has its own colours in light and dark, and doesn't take the form kit's .hint", () => {
  assert.equal((STYLE.match(/--hint: #/g) ?? []).length, 5, "light, the system's dark, a picked dark, and the dark themes (polar, ember)");
  assert.match(STYLE, /\.key-hint \{/);
  assert.doesNotMatch(STYLE, /^\.hint \{/m, "the form kit's .hint stays a quiet help line");
});

test("Bino's keys (#85): Enter sends a chat box, ↑ brings back the last message, g b goes to Bino, and the help says so", () => {
  for (const key of ["Enter", "Shift Enter", "↑", "g b"]) assert.ok(SCRIPT.includes(`["${key}", `), `the help lists ${key}`);
  assert.ok(SCRIPT.includes(`["Bino", [`), "a Bino group");
  assert.match(SCRIPT, /b: "\/bino" \}/, "g b");
  assert.match(SCRIPT, /form\[data-chat\]/);
  assert.match(SCRIPT, /!e\.isComposing/, "an IME's Enter picks a word, it doesn't send");
  assert.match(SCRIPT, /u-chat-last/);
  assert.match(SCRIPT, /DOCK_KEYS\[e\.data\.key\] === from\.id \? dockOpen\(from, false, true\)/, "a dock's own key from inside it closes it");
});

test("the agents' keys (#244): . stops a turn and A allows, from a plain button only, and the help says so", () => {
  for (const key of [".", "A"]) assert.ok(SCRIPT.includes(`["${key}", `), `the help lists ${key}`);
  assert.match(SCRIPT, /querySelectorAll\("button\[data-hotkey\]"\)/);
  assert.match(SCRIPT, /"\.": "page", A: "page"/, "switched off with This page");
});
