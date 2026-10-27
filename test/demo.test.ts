/** The public demo (src/demo/): made-up data, no sign-in, nothing it can change or reach. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoWorker } from "../src/demo/worker.ts";
import { DEMO_HOST, demoHistory, demoSnapshot } from "../src/demo/fixtures.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { html } from "hono/html";
import { weekOf, weeksOf } from "../src/stats/history.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const at = (path: string, init?: RequestInit) => new Request(`https://demo.dovre.dev${path}`, init);

test("demo: every hosted page draws over the made-up data, with the bar saying so, and isn't indexed", async () => {
  const w = createDemoWorker();
  for (const path of ["/", "/prs", "/deploys", "/agents", "/agents/s/d0e0a001-0000-4000-8000-000000000002", "/packs", "/settings", "/stats", "/todo", "/bino"]) {
    const res = await w.fetch(at(path));
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    const page = await res.text();
    assert.match(page, /This is a demo\./, path);
    assert.match(page, /<a href="https:\/\/dovre\.dev\/">← dovre\.dev<\/a>/, path);
  }
  const today = await (await w.fetch(at("/"))).text();
  assert.match(today, /Retry card payments once/);
  assert.match(today, new RegExp(DEMO_HOST.replace(/\./g, "\\.")));
  assert.match(today, /<h1 id="greet">Good (morning|afternoon|evening|night),/);
  assert.doesNotMatch(today, /<h1 id="greet">God (morgen|dag|kveld|natt),/);
  assert.match(today, /<a class="brand" href="\/"/);
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
    assert.match(await res.text(), /Read-only demo/);
  }
  assert.equal((await w.fetch(at("/bridge", { headers: { upgrade: "websocket" } }))).status, 404);
});

test("demo: a refused button explains itself inside the demo's page, with the way back", async () => {
  const w = createDemoWorker();
  const post = (path: string, referer?: string) => w.fetch(at(path, { method: "POST", headers: { origin: "https://demo.dovre.dev", ...(referer ? { referer } : {}) } }));
  for (const [path, why] of [
    ["/refresh", /nothing new to read/],
    ["/stats/refresh", /nothing new to read/],
    ["/deploys/approve", /second click to confirm/],
    ["/deploys/reject", /second click to confirm/],
    ["/todo/add", /Your list is saved/],
    ["/settings/layout/reset", /Settings are saved/],
    ["/settings/notify/test", /Settings are saved/],
    ["/agents/s/d0e0a001-0000-4000-8000-000000000002/reply", /ask Bino instead/],
    ["/somewhere/else", /buttons that would change something stop here/],
  ] as const) {
    const res = await post(path, "https://demo.dovre.dev/deploys?x=1");
    assert.equal(res.status, 403, path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    const page = await res.text();
    assert.match(page, why, path);
    assert.match(page, /This is a demo\./, path);
    assert.match(page, /<a href="\/deploys\?x=1">Back to the demo<\/a>/, path);
  }
  // Back only to a page of the demo's own.
  for (const ref of ["https://evil.example/x", "not a url", undefined]) {
    assert.match(await (await post("/todo/add", ref)).text(), /<a href="\/">Back to the demo<\/a>/, String(ref));
  }
  // Hostile query on the page itself stays inert.
  for (const hostile of ["<script>alert(1)</script>", "javascript:alert(1)", "//evil.example"]) {
    const page = await (await w.fetch(at(`/read-only?did=${encodeURIComponent(hostile)}&back=${encodeURIComponent(hostile)}`))).text();
    assertInert(page, hostile);
    assert.match(page, /<a href="\/">Back to the demo<\/a>/);
  }
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
    if (path !== "/bino/dock") {
      assert.ok(
        hrefMatches.some((m) => m[1] === "https://dovre.dev/"),
        `Page ${path} should have a link back to https://dovre.dev/`,
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
  assert.match(text, /href="https:\/\/dovre\.dev\/"/);
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
    assert.match(html, /id="bdock-btn"/, `${path} has the Bino dock button`);
    assert.match(html, /id="tab-more"[^>]*aria-controls="side-sheet"/, `${path} has More button pointing to side sheet`);
    assert.match(html, /id="side-sheet"/, `${path} has More sheet`);
  }
});

const ask = (w: ReturnType<typeof createDemoWorker>, path: string, text: string, extra: Record<string, string> = {}) =>
  w.fetch(at(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ text, ...extra }).toString() }));

test("demo: /bino and /bino/dock render, and asking Bino answers in the same response from its script", async () => {
  const w = createDemoWorker();
  const binoHtml = await (await w.fetch(at("/bino"))).text();
  assert.match(binoHtml, /What&#39;s red this morning\?/);
  assert.match(binoHtml, /Summarise my PRs/);
  assert.match(binoHtml, /The demo remembers nothing\./);
  const dockHtml = await (await w.fetch(at("/bino/dock"))).text();
  assert.match(dockHtml, /What&#39;s red/);

  const red = await ask(w, "/bino/new", "what's red?");
  assert.equal(red.status, 200, "the answer, not a redirect: the next request may land on another isolate");
  assert.equal(red.headers.get("x-robots-tag"), "noindex");
  const redPage = await red.text();
  assert.match(redPage, /what&#39;s red\?/);
  assert.match(redPage, /northwind\/catalog/);
  assert.match(redPage, /feat\/image-cache/);

  assert.match(await (await ask(w, "/bino/new", "what should I do first?")).text(), /Review open PRs/);
  assert.match(await (await ask(w, "/bino/new", "tell me about quantum computing")).text(), /In the demo I only know a few things/);

  // A follow-up in a seeded conversation answers there.
  const say = await ask(w, "/bino/c/d0e0b001-0000-4000-8000-000000000001/say", "summarise my PRs");
  assert.equal(say.status, 200);
  const sayPage = await say.text();
  assert.match(sayPage, /What&#39;s red this morning\?/, "the seeded conversation");
  assert.match(sayPage, /summarise my PRs/);
  assert.match(sayPage, /412/);

  // From the dock: the dock's conversation page.
  const dock = await ask(w, "/bino/new", "what's red?", { dock: "1" });
  assert.equal(dock.status, 200);
  assert.match(await dock.text(), /northwind\/catalog/);

  assertInert("bino new message hostile", await (await ask(w, "/bino/new", H)).text());
});

test("demo: Bino keeps nothing between requests, so nobody sees another visitor's question", async () => {
  const w = createDemoWorker();
  const mine = await (await ask(w, "/bino/new", "a secret only A typed")).text();
  const id = /\/bino\/c\/([0-9a-f-]{36})\/say/.exec(mine)?.[1];
  assert.ok(id, "the answer page has its say form");
  assert.doesNotMatch(await (await w.fetch(at("/bino"))).text(), /a secret only A typed/, "the list has only the seeded ones");
  assert.equal((await w.fetch(at(`/bino/c/${id}`))).status, 404);
  // A follow-up in your own conversation starts afresh with your question, answered.
  const next = await ask(w, `/bino/c/${id}/say`, "what's red?");
  assert.equal(next.status, 200);
  const nextPage = await next.text();
  assert.match(nextPage, /northwind\/catalog/);
  assert.doesNotMatch(nextPage, /a secret only A typed/);
  // What's asked is cut to 500 characters.
  const long = await (await ask(w, "/bino/new", "x".repeat(2000))).text();
  assert.ok(long.includes("x".repeat(500)) && !long.includes("x".repeat(501)));
});

test("real instances: brand logo still links to /", async () => {
  const { get } = signedIn(snapshot());
  const res = await get("/");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /<a class="brand" href="\/"/);
  assert.doesNotMatch(text, /This is a demo\./);
});

test("demo: createDemoWorker accepts custom fixtures, packs, allowWrite, and layout", async () => {
  const customPack: Pack = {
    manifest: {
      api: PACK_API,
      id: "kiosk",
      name: "Kiosk",
      description: "A test pack",
      domain: "work",
      paths: ["kiosk"],
    },
    today: () => [
      {
        id: "orders",
        column: "left",
        order: 10,
        render: html`<section class="card"><h2>Kiosk Orders</h2><p>3 tickets waiting</p></section>`,
      },
    ],
    routes(app, ctx) {
      app.get("/kiosk", (c) => ctx.page(c, { title: "Kiosk · Dovre", current: "/kiosk", body: html`<p>Kiosk Storefront</p>` }));
      app.post("/kiosk/refund", (c) => c.text("Refunded"));
    },
  };

  const w = createDemoWorker({
    version: "1.0.0",
    fixtures: {
      host: "demo-git.internal",
      org: "acme-corp",
      login: "alice",
      snapshot: (now) => ({ ...demoSnapshot(now), login: "alice" }),
    },
    packs: [customPack],
    allowWrite: (req) => req.method === "POST" && new URL(req.url).pathname === "/kiosk/refund",
    layout: { tabs: ["/kiosk", "/prs", "/agents"] },
  });

  // Custom fixtures & pack on Today
  const todayRes = await w.fetch(at("/"));
  assert.equal(todayRes.status, 200);
  const todayText = await todayRes.text();
  assert.match(todayText, /demo-git\.internal/);
  assert.match(todayText, /Kiosk Orders/);
  assert.match(todayText, /3 tickets waiting/);

  // Custom pack route
  const shopRes = await w.fetch(at("/kiosk"));
  assert.equal(shopRes.status, 200);
  const shopText = await shopRes.text();
  assert.match(shopText, /Kiosk Storefront/);
  assert.match(shopText, /This is a demo\./);

  // AllowWrite hook: permitted write returns 200
  const allowedRes = await w.fetch(at("/kiosk/refund", { method: "POST" }));
  assert.equal(allowedRes.status, 200);
  assert.equal(await allowedRes.text(), "Refunded");

  // AllowWrite hook: non-permitted write returns 403 read-only
  const deniedRes = await w.fetch(at("/kiosk/other", { method: "POST" }));
  assert.equal(deniedRes.status, 403);
  assert.match(await deniedRes.text(), /Read-only demo/);

  // Hostile input in custom pack stays inert
  for (const hostile of ["<script>alert(1)</script>", "javascript:alert(1)"]) {
    const r = await w.fetch(at(`/kiosk?q=${encodeURIComponent(hostile)}`));
    assert.equal(r.status, 200);
    assertInert(`custom pack ${hostile}`, await r.text());
  }
});

test("demo: a pack fed made-up data gets its settings, refreshes before the page, and adds Bino answers", async () => {
  let refreshed = 0;
  let seen = "";
  const ticker: Pack = {
    manifest: {
      api: PACK_API,
      id: "ticker",
      name: "Ticker",
      description: "A test pack that needs a key",
      domain: "work",
      everyMs: 60_000,
      settings: [{ key: "TICKER_KEY", label: "Key", secret: true, required: true }],
    },
    async refresh(ctx) {
      refreshed++;
      seen = ctx.env.TICKER_KEY ?? "";
    },
    glance: () => [{ label: "Ticks", value: refreshed }],
  };
  // Without its setting, the pack stays off, as on a real instance.
  const off = await (await createDemoWorker({ packs: [ticker] }).fetch(at("/packs"))).text();
  assert.match(off, /TICKER_KEY isn&#39;t set|TICKER_KEY isn't set/);

  const w = createDemoWorker({ packs: [ticker], settings: { TICKER_KEY: "demo" }, answers: [{ match: /ticks?/, answer: () => `Ticked ${refreshed} times.` }] });
  const today = await (await w.fetch(at("/"))).text();
  assert.equal(seen, "demo");
  assert.equal(refreshed, 1);
  assert.match(today, /Ticks/);
  await w.fetch(at("/prs"));
  assert.equal(refreshed, 1, "not again until it's due");
  const said = await (await w.fetch(at("/bino/new", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=how+many+ticks%3F" }))).text();
  assert.match(said, /Ticked 1 times\./);
  assert.match(await (await w.fetch(at("/bino/new", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=what%27s+red%3F" }))).text(), /northwind\/catalog/, "built-in answers still work");
});

test("demo: the External link page names another app's host when the path starts with it", async () => {
  const w = createDemoWorker();
  const text = await (await w.fetch(at("/elsewhere/linear.app/northwind/issue/NW-142"))).text();
  assert.match(text, /On your own Dovre this opens <strong>NW-142<\/strong> on linear\.app\./);
  assertInert("elsewhere host", await (await w.fetch(at(`/elsewhere/x.example/${encodeURIComponent(H)}`))).text());
});
