/** Page speed (#294): every page's time by route, as the server and the browser measured it, kept in D1 and shown on Settings. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { byRoute, createSpeed, quantile, routeOk } from "../src/speed.ts";
import { speedPanels } from "../src/pages/speed.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const HOUR = 3600_000;

test("speed: loads counted by side and route an hour at a time, in steps; kept in D1 and added to what isn't yet", async () => {
  let t = 10 * HOUR + 5;
  const s = createSpeed(() => t);
  const db = openDb();
  s.record("server", "/prs", 40);
  s.record("server", "/prs", 300);
  s.record("page", "/prs", 9000);
  s.record("page", "/prs", -1);
  s.record("page", "/prs", NaN);
  await s.flush(db.DB);
  s.record("server", "/prs", 1500);
  const v = await s.view(db.DB);
  const prs = byRoute(v.rows, 0).get("/prs")!;
  assert.deepEqual([prs.server!.n, prs.server!.ms, prs.server!.b], [3, 1840, [1, 0, 1, 0, 1, 0, 0]]);
  assert.deepEqual([prs.page!.n, prs.page!.b], [1, [0, 0, 0, 0, 0, 0, 1]], "a time that isn't one isn't counted");
  await s.flush(db.DB);
  t += 31_000;
  await s.flush(db.DB);
  const again = byRoute((await s.view(db.DB)).rows, 0).get("/prs")!;
  assert.equal(again.server!.n, 3, "flushed rows add up in D1, nothing twice");
  assert.equal(byRoute(v.rows, 11 * HOUR).size, 0, "an hour before isn't in a window that starts later");
});

test("speed: quantiles are a bucket's upper edge, undefined past the last", () => {
  assert.equal(quantile([], 0.5), undefined);
  assert.equal(quantile([0, 0, 0, 0, 0, 0, 0], 0.5), undefined);
  assert.equal(quantile([5, 4, 1, 0, 0, 0, 0], 0.5), 100);
  assert.equal(quantile([5, 4, 1, 0, 0, 0, 0], 0.95), 500);
  assert.equal(quantile([1, 0, 0, 0, 0, 0, 9], 0.95), undefined);
  assert.equal(routeOk("/prs/:owner/:repo/:n"), true);
  assert.equal(routeOk("/*"), true);
  assert.equal(routeOk(`/x"<script>`), false);
  assert.equal(routeOk("prs"), false);
});

test("speed: a page says its time, the gather it waited on and its route in Server-Timing, and the page sends it back", async () => {
  const { get, app } = signedIn(snapshot());
  const res = await get("/prs");
  assert.equal(res.status, 200);
  const st = res.headers.get("server-timing") ?? "";
  assert.match(st, /app;dur=\d+/);
  assert.match(st, /route;desc="\/prs"/);
  const asset = await get("/healthz");
  assert.equal(asset.headers.get("server-timing"), null, "only pages");

  const beacon = (body: unknown) => app.request("http://localhost/perf", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await beacon({ path: "/prs", route: "/prs", type: "navigate", total: 640 })).status, 204);
  await beacon({ path: "/prs", route: "/prs", type: "back_forward", total: 5 });
  await beacon({ path: "/prs", route: `/prs"><script>x</script>`, type: "navigate", total: 5 });
  await beacon({ path: "/prs", route: "/prs", type: "navigate", total: "fast" });
  const page = await (await get("/settings/speed")).text();
  assert.match(page, /<code>\/prs<\/code>/);
  assert.match(page, /1 load · half under 1 s · server under 100 ms/, "one page load counted: the back/forward one, the hostile route and the non-number weren't");
  assertInert("settings/speed", page);
});

test("speed: Settings → Page speed with nothing counted, and with a hostile route kept as text", () => {
  const empty = String(speedPanels({ rows: [], now: 10 * HOUR }));
  assert.match(empty, /No pages counted/);
  assert.match(empty, /none counted yet/);
  const out = String(
    speedPanels({
      rows: [
        { hour: 10 * HOUR, side: "page", route: `/x${H}`, n: 2, ms: 9000, b: [0, 0, 0, 0, 0, 1, 1] },
        { hour: 10 * HOUR, side: "page", route: "/fast", n: 4, ms: 200, b: [4, 0, 0, 0, 0, 0, 0] },
        { hour: 10 * HOUR, side: "server", route: "/fast", n: 4, ms: 80, b: [4, 0, 0, 0, 0, 0, 0] },
      ],
      now: 10 * HOUR + 60_000,
    }),
  );
  assertInert("speedPanels", out);
  assert.ok(out.indexOf("/x") < out.indexOf("/fast"), "slowest first");
  assert.match(out, /pill bad[^>]*>95% over 4 s/);
});
