/**
 * Today, arranged (#94): a proposal applied to what Layout can arrange now. Named cards first in
 * their column, the rest after in their order; ids not here and second mentions don't count; a
 * part left out stays as it is; Undo's Placement is read back strictly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Arrangement, arranged, arrangementFields, columnsOf, holds, phoneOf, placementFrom, placementOf, statsShown, withPlacement } from "../src/arrange.ts";
import { actOf } from "../src/packs/core/assistant/bino/acts.ts";

const now: Arrangement = {
  pages: [{ href: "/issues", title: "Issues" }, { href: "/stats", title: "Stats" }, { href: "/linear", title: "Linear" }, { href: "/sentry", title: "Sentry" }],
  tabs: ["/issues"],
  cards: [
    { id: "ship", label: "What ships", col: "left", order: 20 },
    { id: "actions", label: "What Dovre did", col: "left", order: 40 },
    { id: "prs", label: "Pull requests", col: "right", order: 10 },
    { id: "linear-mine", label: "Linear", col: "right", order: 200 },
    { id: "sentry-new", label: "Sentry", col: "right", order: 200 },
  ],
  stats: [
    { id: "history:merged-week", label: "Merged", from: "History", show: true, order: 10 },
    { id: "agents:spend-7d", label: "Spend", from: "Agents", show: false, order: 20 },
    { id: "linear:cycle", label: "Cycle", from: "Linear", show: true, order: 30 },
  ],
};

test("named cards go first in their column, in the order named; the rest keep their column after; unknown ids and second mentions don't count", () => {
  const a = arranged(now, { left: ["linear-mine", "nope", "prs"], right: ["sentry-new", "prs"], off: ["actions", "linear-mine"] });
  assert.deepEqual(columnsOf(a), { left: ["Linear", "Pull requests", "What ships"], right: ["Sentry"], off: ["What Dovre did"] });
  assert.deepEqual(a.tabs, now.tabs, "the tabs aren't touched");
  assert.deepEqual(a.stats, now.stats, "nor the stats");
  // Only one column named: the other keeps its cards in their order.
  assert.deepEqual(columnsOf(arranged(now, { left: ["sentry-new"] })), { left: ["Sentry", "What ships", "What Dovre did"], right: ["Pull requests", "Linear"], off: [] });
});

test("the phone's tabs: pages here only, three at most; none usable leaves them; stats named go first and are shown", () => {
  assert.deepEqual(phoneOf(arranged(now, { phone: ["/linear", "/nope", "/sentry", "/linear", "/stats", "/issues"] })), ["Today", "Linear", "Sentry", "Stats"]);
  assert.deepEqual(arranged(now, { phone: ["/nope"] }).tabs, ["/issues"]);
  const s = arranged(now, { stats: ["linear:cycle", "agents:spend-7d", "nope:x"] });
  assert.deepEqual(statsShown(s), ["Cycle", "Spend", "Merged"]);
  assert.deepEqual(arranged(now, { stats: ["nope:x"] }).stats, now.stats);
});

test("a Placement holds only what the proposal touches, puts back what it was, and is read back strictly", () => {
  const p = { phone: ["/linear"], left: ["prs"] };
  const to = placementOf(arranged(now, p), p);
  assert.deepEqual(Object.keys(to).sort(), ["cards", "tabs"]);
  assert.equal(holds(now, to), false);
  const after = withPlacement(now, to);
  assert.equal(holds(after, to), true);
  const was = placementOf(now, to);
  assert.deepEqual(withPlacement(after, was), now, "Undo puts it back as it was");
  assert.equal(holds(now, placementOf(now, p)), true, "nothing to change: it holds already");

  assert.deepEqual(placementFrom(JSON.stringify(was)), was);
  assert.equal(placementFrom("not json"), undefined);
  assert.equal(placementFrom("[]"), undefined);
  assert.deepEqual(placementFrom(JSON.stringify({ cards: { prs: { col: "middle", order: 1 }, ship: { col: "left", order: 5 } }, stats: { x: { show: "yes", order: 1 } } })), { cards: { ship: { col: "left", order: 5 } }, stats: {} });
});

test("its fields are Layout's form: three tabs, a column and an order per card, shown and an order per stat", () => {
  const f = arrangementFields(now);
  assert.deepEqual(f.slice(0, 3), [["tab1", "/issues"], ["tab2", ""], ["tab3", ""]]);
  assert.deepEqual(f.filter(([k]) => k.endsWith(":prs")), [["col:prs", "right"], ["order:prs", "10"]]);
  assert.deepEqual(f.filter(([k]) => k.endsWith("spend-7d")), [["stat:agents:spend-7d", "off"], ["statorder:agents:spend-7d", "20"]]);
});

test("Bino's layout block is checked id by id; one with nothing usable isn't a card", () => {
  assert.deepEqual(actOf({ kind: "layout", left: ["prs", "PRS", "<b>", "prs", 3], phone: ["/linear", "//evil.example", "https://x", "/a", "/b", "/c"], stats: ["linear:cycle", "a:b:c"] }), { kind: "layout", left: ["prs"], phone: ["/linear", "/a", "/b"], stats: ["linear:cycle"] });
  assert.equal(actOf({ kind: "layout", left: ["<script>"], phone: "nope" }), null);
  assert.equal(actOf({ kind: "layout" }), null);
});
