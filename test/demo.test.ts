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
  for (const path of ["/", "/prs", "/deploys", "/agents", "/agents/s/d0e0a001-0000-4000-8000-000000000002", "/packs", "/settings", "/stats", "/avatar", "/todo", "/bino"]) {
    const res = await w.fetch(at(path));
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    const page = await res.text();
    assert.match(page, /This is a demo\./, path);
  }
  const today = await (await w.fetch(at("/"))).text();
  assert.match(today, /Retry card payments once/);
  assert.match(today, new RegExp(DEMO_HOST.replace(/\./g, "\\.")));
  assert.match(today, /<h1 id="greet">Good (morning|afternoon|evening|night),/);
  assert.doesNotMatch(today, /<h1 id="greet">God (morgen|dag|kveld|natt),/);
});

test("demo: every write is refused before the app, and the bridge isn't there", async () => {
  const w = createDemoWorker();
  for (const [method, path] of [
    ["POST", "/agents/new"],
    ["POST", "/deploys/approve"],
    ["PUT", "/settings"],
    ["DELETE", "/todo/1"],
    ["POST", "/bino/ask"],
    ["POST", "/settings/layout"],
    ["POST", "/bino/c/d0e0b001-0000-4000-8000-000000000001/plan/0"],
    ["POST", "/bino/c/d0e0b001-0000-4000-8000-000000000001/act/0/0"],
    ["POST", "/bino/memory/m1/forget"],
  ] as const) {
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
    "/bino",
    "/bino/c/d0e0b001-0000-4000-8000-000000000001",
    "/bino/dock",
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

test("demo: phone-width bottom tab bar shows with Bino in the middle, and the More sheet works", async () => {
  const w = createDemoWorker();
  for (const path of ["/", "/prs", "/deploys", "/agents"]) {
    const res = await w.fetch(at(path));
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /class="tabbar gap-32"/, `${path} has tabbar gap-32`);
    assert.match(html, /<span class="tab-gap" aria-hidden="true"><\/span>/, `${path} has middle gap for Bino`);
    assert.match(html, /id="bdock-btn"[^>]*data-av-box/, `${path} has Bino dock button with avatar`);
    assert.match(html, /data-av="dock"/, `${path} has avatar dock face`);
    assert.match(html, /id="tab-more"[^>]*aria-controls="side-sheet"/, `${path} has More button pointing to side sheet`);
    assert.match(html, /id="side-sheet"/, `${path} has More sheet`);
  }
});

/** One visitor: keeps the demo's visitor cookie across requests, like a browser. */
function visitor(w: ReturnType<typeof createDemoWorker>) {
  let cookie = "";
  const go = async (path: string, init: RequestInit = {}) => {
    const res = await w.fetch(at(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } }));
    const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-demo_v="));
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  const ask = (path: string, text: string) => go(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ text }).toString() });
  const page = async (path: string) => (await go(path)).text();
  return { go, ask, page, cookie: () => cookie };
}

test("demo: /bino and /bino/dock render, Bino POST is allowed with scripted answers, and hostile input is inert", async () => {
  const v = visitor(createDemoWorker());

  const binoHtml = await v.page("/bino");
  assert.match(v.cookie(), /^__Host-demo_v=[0-9a-f-]{36}$/, "a visitor cookie is set");
  assert.match(binoHtml, /What&#39;s red this morning\?/);
  assert.match(binoHtml, /Summarise my PRs/);
  assert.match(binoHtml, /The demo remembers nothing\./);

  const dockHtml = await v.page("/bino/dock");
  assert.match(dockHtml, /What&#39;s red/);
  assert.match(dockHtml, /Summarise my PRs/);

  const redRes = await v.ask("/bino/new", "what's red?");
  assert.equal(redRes.status, 303);
  const redLoc = redRes.headers.get("location")!;
  assert.match(redLoc, /^\/bino\/c\/[0-9a-f-]{36}$/);
  const redPage = await v.page(redLoc);
  assert.match(redPage, /what&#39;s red\?/);
  assert.match(redPage, /northwind\/catalog/);
  assert.match(redPage, /feat\/image-cache/);

  const firstRes = await v.ask("/bino/new", "what should I do first?");
  assert.equal(firstRes.status, 303);
  assert.match(await v.page(firstRes.headers.get("location")!), /Review open PRs/);

  const sayRes = await v.ask("/bino/c/d0e0b001-0000-4000-8000-000000000001/say", "summarise my PRs");
  assert.equal(sayRes.status, 303);
  const sayPage = await v.page("/bino/c/d0e0b001-0000-4000-8000-000000000001");
  assert.match(sayPage, /summarise my PRs/);
  assert.match(sayPage, /412/);
  assert.match(sayPage, /88/);

  const otherRes = await v.ask("/bino/new", "tell me about quantum computing");
  assert.equal(otherRes.status, 303);
  assert.match(await v.page(otherRes.headers.get("location")!), /In the demo I only know a few things/);

  const hostileRes = await v.ask("/bino/new", H);
  assert.equal(hostileRes.status, 303);
  assertInert("bino new message hostile", await v.page(hostileRes.headers.get("location")!));
});

test("demo: each visitor's Bino is their own: nobody sees what another typed", async () => {
  const w = createDemoWorker();
  const a = visitor(w);
  const b = visitor(w);
  const res = await a.ask("/bino/new", "a secret only A typed");
  const loc = res.headers.get("location")!;
  assert.match(await a.page("/bino"), /a secret only A typed/);
  const bList = await b.page("/bino");
  assert.notEqual(a.cookie(), b.cookie());
  assert.doesNotMatch(bList, /a secret only A typed/, "B's list");
  assert.match(bList, /Summarise my PRs/, "B still gets the seeded conversations");
  assert.doesNotMatch(await b.page(loc), /a secret only A typed/, "B opening A's conversation");
  assert.doesNotMatch(await (await w.fetch(at("/bino"))).text(), /a secret only A typed/, "no cookie at all");
  // B's say into A's conversation doesn't reach it.
  await b.ask(`${loc}/say`, "B was here");
  assert.doesNotMatch(await a.page(loc), /B was here/);
  // A forged cookie is a new visitor, not someone else's.
  assert.doesNotMatch(await (await w.fetch(at("/bino", { headers: { cookie: "__Host-demo_v=not-an-id" } }))).text(), /a secret only A typed/);
});

test("demo: what Bino keeps is capped: conversations, messages in one, and their length", async () => {
  const v = visitor(createDemoWorker());
  for (let i = 0; i < 8; i++) assert.equal((await v.ask("/bino/new", `Question ${i + 1}`)).status, 303);
  const list = await v.page("/bino");
  assert.equal(new Set([...list.matchAll(/href="\/bino\/c\/([0-9a-f-]{36})"/g)].map((m) => m[1])).size, 5, "at most 5 conversations");
  assert.doesNotMatch(list, /d0e0b001-0000-4000-8000-000000000001/, "oldest dropped");
  assert.match(list, /Question 8/);

  const loc = (await v.ask("/bino/new", "x".repeat(2000))).headers.get("location")!;
  const page = await v.page(loc);
  assert.ok(page.includes("x".repeat(500)) && !page.includes("x".repeat(501)), "a message is cut to 500 characters");
  for (let i = 0; i < 10; i++) await v.ask(`${loc}/say`, `more ${i}`);
  const full = await v.page(loc);
  assert.match(full, /more 4/);
  assert.doesNotMatch(full, /more 5/, "at most 12 messages in one conversation");
});
