/** The numbers and charts packs build on (src/ui/kit.ts Stat…Gauge, src/ui/charts.view.ts): they draw, and hostile labels stay inert. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ColumnChart, FunnelDiagram, HBars, Heatmap, LineChart, StackedBar } from "../src/ui/charts.view.ts";
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
