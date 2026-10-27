/** The numbers and charts packs build on (src/ui/kit.ts Stat…Gauge, src/ui/charts.view.ts): they draw, and hostile labels stay inert. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAR_W, ColumnChart, DAY_LABEL_W, FunnelDiagram, fitLabel, HBars, Heatmap, LineChart, StackedBar } from "../src/ui/charts.view.ts";
import { STYLE } from "../src/ui/style.ts";
import { Delta, Gauge, Post, Pulse, Spark, Stat, Stats } from "../src/ui/kit.ts";
import { H, assertInert } from "./helpers.ts";

const days = ["2026-10-20", "2026-10-21", "2026-10-22"];

test("Stat, Delta, Spark, Pulse, Gauge draw and keep text inert", () => {
  const out = String(
    Stats([
      Stat({ label: H, value: 12, delta: Delta({ value: 3, good: "up" }), viz: Spark({ values: [1, 2, null, 4], label: H }), tone: "bad", href: "/x" }),
      Stat({ label: "Errors", value: H, viz: Pulse({ requests: [10, 20, 30], errors: [0, 1, 3], labels: [H, "b", "c"], label: H }) }),
      Gauge({ value: 3, max: 10, title: H }),
    ]),
  );
  assert.match(out, /class="stat bad"/);
  assert.match(out, /svg/);
  assertInert("numbers", out);
});

test("charts draw and keep labels inert", () => {
  const out = [
    LineChart({ days, series: [{ label: H, values: [1, 2, 3], color: "s1" }], title: H }),
    ColumnChart({ days, values: [1, 5, 2], title: H, unit: H }),
    Heatmap({ days, rows: [{ label: H, total: 3, perDay: [1, 1, 1] }], title: H }),
    HBars({ rows: [{ label: H, value: 4, note: H }], empty: H }),
    FunnelDiagram({ steps: [{ label: H, value: 10 }, { label: "b", value: 4 }], title: H }),
    StackedBar({ parts: [{ label: H, value: 2 }, { label: "b", value: 1 }], label: H }),
  ].map(String).join("\n");
  assert.ok((out.match(/<svg/g) ?? []).length >= 3);
  assertInert("charts", out);
});

test("Post: one click, a plain form; hostile fields and label stay inert", () => {
  const out = String(Post({ action: "/signals/mute", fields: { id: H }, label: H }));
  assert.match(out, /^<form class="post" method="post" action="\/signals\/mute">/);
  assert.doesNotMatch(out, /<details/);
  assertInert("post", out);
});

test("day labels never touch: the first hangs right, the last left, the rest are centred", () => {
  const fortnight = Array.from({ length: 14 }, (_, i) => `2026-10-${String(13 + i).padStart(2, "0")}`);
  const month = Array.from({ length: 30 }, (_, i) => `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`);
  for (const [name, out] of [
    ["half column, 14 days", String(ColumnChart({ days: fortnight, values: fortnight.map(() => 1), title: "t", unit: "u", half: true }))],
    ["column, 30 days", String(ColumnChart({ days: month, values: month.map(() => 1), title: "t", unit: "u" }))],
    ["line, 30 days", String(LineChart({ days: month, series: [{ label: "a", values: month.map(() => 1), color: "s1" }], title: "t" }))],
  ] as const) {
    for (const svg of out.split("</svg>").slice(0, -1)) {
      const labels = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="(start|middle|end)">\d+ \w+<\/text>/g)].map((m) => {
        const x = Number(m[1]);
        const [l, r] = m[2] === "start" ? [0, 1] : m[2] === "end" ? [1, 0] : [0.5, 0.5];
        return { from: x - l * DAY_LABEL_W, to: x + r * DAY_LABEL_W };
      });
      assert.ok(labels.length >= 2, `${name}: first and last at least`);
      for (let i = 1; i < labels.length; i++) assert.ok(labels[i]!.from >= labels[i - 1]!.to - 1e-6, `${name}: label ${i} clears the one before`);
    }
  }
});

test("fitLabel keeps a label's end and its length", () => {
  assert.equal(fitLabel("/oversikt", 20), "/oversikt");
  assert.equal(fitLabel("/oversikt/innstillinger", 15), "…/innstillinger");
  assert.equal([...fitLabel("/oversikt/innstillinger", 15)].length, 15);
});

test("Heatmap on a phone: labels above their rows fit the drawing, the full label in <title>, hostile ones inert", () => {
  const long = `/oversikt/${"innstillinger/".repeat(6)}${H}`;
  const out = String(Heatmap({ days, rows: [{ label: long, total: 2, perDay: [1, 0, 1] }, { label: "/x", total: 0, perDay: [0, 0, 0] }], title: "t" }));
  const narrow = out.slice(out.indexOf('<svg class="narrow"'), out.indexOf("</svg>", out.indexOf('<svg class="narrow"')));
  const width = Number(/viewBox="0 0 (\d+)/.exec(narrow)?.[1]);
  for (const m of narrow.matchAll(/<text x="0" y="[\d.]+">([^<]*)<title>/g)) {
    const shown = m[1]!.replace(/&[a-z#0-9]+;/g, "x");
    assert.ok([...shown].length * CHAR_W <= width, `label "${m[1]}" fits ${width}`);
  }
  assert.match(narrow, /<text x="0" y="[\d.]+">…/);
  assertInert("heatmap", out);
});

test("day table leaves out days where every column is 0, and counts them", () => {
  const out = String(LineChart({ days, series: [{ label: "a", values: [0, 3, 0], color: "s1" }, { label: "b", values: [0, 1, 0], color: "s2" }], title: "t" }));
  const body = out.slice(out.indexOf("<tbody>"), out.indexOf("</tbody>"));
  assert.equal((body.match(/<tr>/g) ?? []).length, 1);
  assert.match(out, /2 days with nothing left out\./);
  assert.match(out, /<details><summary>Table/);
  assert.match(out, /<div class="table-wrap"><table class="data days">/);
});

test("charts on a phone: the narrow drawing replaces the wide one, and text is themed", () => {
  assert.match(STYLE, /@media \(max-width: 40rem\) \{ \.viz svg\.wide \{ display: none; \} \.viz svg\.narrow \{ display: block; \} \}/);
  assert.match(STYLE, /\.viz svg text \{ fill: var\(--text-2\)/);
  assert.match(STYLE, /\.viz \.line \{ fill: none;/);
  assert.match(STYLE, /\.table-wrap \{ overflow-x: auto; \}/);
});
