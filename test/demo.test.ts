/** The public demo (src/demo/): made-up data, no sign-in, nothing it can change or reach. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoWorker } from "../src/demo/worker.ts";
import { DEMO_HOST, demoHistory } from "../src/demo/fixtures.ts";
import { weekOf, weeksOf } from "../src/stats/history.ts";
import { H, assertInert } from "./helpers.ts";

const at = (path: string, init?: RequestInit) => new Request(`https://demo.dovre.dev${path}`, init);

test("demo: every hosted page draws over the made-up data, with the bar saying so, and isn't indexed", async () => {
  const w = createDemoWorker();
  for (const path of ["/", "/prs", "/deploys", "/agents", "/agents/s/d0e0a001-0000-4000-8000-000000000002", "/packs", "/settings", "/stats", "/avatar", "/todo"]) {
    const res = await w.fetch(at(path));
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    const page = await res.text();
    assert.match(page, /This is a demo\./, path);
  }
  const today = await (await w.fetch(at("/"))).text();
  assert.match(today, /Retry card payments once/);
  assert.match(today, new RegExp(DEMO_HOST.replace(/\./g, "\\.")));
});

test("demo: every write is refused before the app, and the bridge isn't there", async () => {
  const w = createDemoWorker();
  for (const [method, path] of [["POST", "/agents/new"], ["POST", "/deploys/approve"], ["PUT", "/settings"], ["DELETE", "/todo/1"], ["POST", "/bino/ask"]] as const) {
    const res = await w.fetch(at(path, { method, headers: { origin: "https://demo.dovre.dev" } }));
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(await res.text(), /read-only/);
  }
  assert.equal((await w.fetch(at("/bridge", { headers: { upgrade: "websocket" } }))).status, 404);
});

test("demo: it reads no bindings, so a token or Access set on it changes nothing and never shows", async () => {
  const w = createDemoWorker();
  const bindings = { GITHUB_TOKEN: "ghp_should_never_show", IS_HOSTED: "0", CF_ACCESS_TEAM: "t", CF_ACCESS_AUD: "a", ALLOWED_EMAILS: "x@y.z" } as Record<string, unknown>;
  const res = await w.fetch(at("/settings"), bindings);
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes("ghp_should_never_show"));
});

test("demo: hostile input stays inert", async () => {
  const w = createDemoWorker();
  for (const path of [`/search?q=${encodeURIComponent(H)}`, `/prs?repo=${encodeURIComponent(H)}`, `/agents/s/${encodeURIComponent(H)}`, `/elsewhere/${encodeURIComponent(H)}`]) {
    const res = await w.fetch(at(path));
    assertInert(path, await res.text());
  }
});

test("demo: every link across demo pages stays inside demo or goes to dovre.dev, with no href='#'", async () => {
  const w = createDemoWorker();
  const pages = [
    "/",
    "/prs",
    "/deploys",
    "/agents",
    "/packs",
    "/settings",
    "/stats",
    "/avatar",
    "/todo",
    "/prs/northwind/checkout/412",
    "/agents/s/d0e0a001-0000-4000-8000-000000000002",
    "/search?q=catalog",
    "/elsewhere/northwind/catalog/pull/88",
  ];
  for (const path of pages) {
    const res = await w.fetch(at(path));
    assert.ok(res.status === 200 || res.status === 502, `${path} status ${res.status}`);
    const html = await res.text();
    const hrefMatches = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)];
    assert.ok(hrefMatches.length > 0, `${path} should have links`);
    for (const match of hrefMatches) {
      const href = match[1];
      assert.notEqual(href, "#", `Page ${path} rendered href="#"`);
      const isRelative = href.startsWith("/");
      const isDovreDev = href.startsWith("https://dovre.dev/");
      assert.ok(
        isRelative || isDovreDev,
        `Page ${path} has external link that leaves demo: "${href}" (expected relative /... or https://dovre.dev/...)`,
      );
    }
  }
});

test("demo: elsewhere splash page says where it would have gone, links back, and keeps hostile input inert", async () => {
  const w = createDemoWorker();
  const res = await w.fetch(at("/elsewhere/northwind/catalog/pull/88", { headers: { referer: "https://demo.dovre.dev/prs" } }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /On your own Dovre this opens <strong>northwind\/catalog#88<\/strong> on GitHub\./);
  assert.match(text, /href="\/prs"/);
  assert.match(text, /href="https:\/\/dovre\.dev\/docs\/"/);

  // A referer path that a browser would read as another host goes back to Today instead.
  const sly = await w.fetch(at("/elsewhere/northwind/catalog/pull/88", { headers: { referer: "https://demo.dovre.dev//evil.example/x" } }));
  const slyText = await sly.text();
  assert.match(slyText, /<a href="\/">Back to the demo<\/a>/);
  assert.doesNotMatch(slyText, /evil\.example/);

  for (const hostile of ["<script>alert(1)</script>", "javascript:alert(1)"]) {
    const r = await w.fetch(at(`/elsewhere/${encodeURIComponent(hostile)}`));
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(!body.includes("<script>alert(1)</script>"), `unescaped script in ${hostile}`);
    assert.ok(!body.includes('href="javascript:alert(1)"'), `javascript: href in ${hostile}`);
    assertInert(`elsewhere ${hostile}`, body);
  }
});

test("demo: /stats renders history charts and spend from fixtures, without gathering or reading notices", async () => {
  const w = createDemoWorker();
  const res = await w.fetch(at("/stats"));
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.doesNotMatch(page, /Gathering twelve weeks/i);
  assert.doesNotMatch(page, /Reading transcripts/i);
  assert.doesNotMatch(page, /GHE/);
  assert.match(page, /Agent spend, 7 days/);
  assert.match(page, /The org, merged PRs per week/);
  assert.match(page, /Open PRs by age/);
  assert.match(page, /<p class="kpi-l">Agent spend, 7 days<\/p><p class="kpi-v">\$[0-9]+/);
  assert.match(page, /<p class="kpi-l">Merged, this week<\/p><p class="kpi-v">1<\/p>/);
});

test("demo: this week's merged PR stays in this week, even just after midnight on a Monday", () => {
  for (const iso of ["2026-10-25T23:30:00Z", "2026-10-22T12:00:00Z"]) { // Monday 00:30 in Oslo (CET); a Thursday
    const now = Date.parse(iso);
    const h = demoHistory(now);
    const weeks = weeksOf(now);
    const thisWeek = h.mine.filter((p) => p.mergedAt && weekOf(p.mergedAt, weeks) === weeks.at(-1));
    assert.equal(thisWeek.length, 1, iso);
    for (const p of h.mine) assert.ok(Date.parse(p.mergedAt!) <= now, `${p.title} merged in the future`);
  }
});
