/** The public demo (src/demo/): made-up data, no sign-in, nothing it can change or reach. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoWorker } from "../src/demo/worker.ts";
import { DEMO_HOST, demoHistory } from "../src/demo/fixtures.ts";
import { northwindShopPack } from "../src/demo/shop/index.ts";
import { demoShopData, type ShopData } from "../src/demo/shop/data.ts";
import { weekOf, weeksOf } from "../src/stats/history.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const at = (path: string, init?: RequestInit) => new Request(`https://demo.dovre.dev${path}`, init);

test("demo: every hosted page draws over the made-up data, with the bar saying so, and isn't indexed", async () => {
  const w = createDemoWorker();
  for (const path of ["/", "/prs", "/deploys", "/agents", "/agents/s/d0e0a001-0000-4000-8000-000000000002", "/packs", "/settings", "/stats", "/avatar", "/todo", "/bino"]) {
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
    "/shop",
    "/shop/tickets/t-101",
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
    assert.match(html, /id="bdock-btn"[^>]*data-av-box/, `${path} has Bino dock button with avatar`);
    assert.match(html, /data-av="dock"/, `${path} has avatar dock face`);
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

test("demo: custom app pack (Northwind Shop) renders /shop, ticket details, nav, packs list, and today card", async () => {
  const w = createDemoWorker();

  // /shop page
  const shopRes = await w.fetch(at("/shop"));
  assert.equal(shopRes.status, 200);
  const shopHtml = await shopRes.text();
  assert.match(shopHtml, /Northwind Shop/);
  assert.match(shopHtml, /Storefront ops: metrics, support tickets &amp; actions/);
  assert.match(shopHtml, /Customers/);
  assert.match(shopHtml, /14,820/);
  assert.match(shopHtml, /Active in 7 days/);
  assert.match(shopHtml, /Orders today/);
  assert.match(shopHtml, /412/);
  assert.match(shopHtml, /Refunds this week/);
  assert.match(shopHtml, /Daily revenue/);
  assert.match(shopHtml, /Target/);
  assert.match(shopHtml, /Orders by state/);
  assert.match(shopHtml, /Sign-up → first-order funnel/);
  assert.match(shopHtml, /Support queue/);
  assert.match(shopHtml, /href="\/shop\/tickets\/t-101"/);

  // Ticket detail page
  const ticketRes = await w.fetch(at("/shop/tickets/t-101"));
  assert.equal(ticketRes.status, 200);
  const ticketHtml = await ticketRes.text();
  assert.match(ticketHtml, /Ticket #t-101/);
  assert.match(ticketHtml, /Payment failed on checkout for order #ORD-9821/);
  assert.match(ticketHtml, /Astrid Lind/);
  assert.match(ticketHtml, /astrid\.lind@example\.com/);
  assert.match(ticketHtml, /ORD-9821/);
  assert.match(ticketHtml, /\$149\.00/);
  assert.match(ticketHtml, /Resend receipt/);
  assert.match(ticketHtml, /Refund order/);
  assert.match(ticketHtml, /Unlock account/);
  assert.match(ticketHtml, /Extend free shipping/);
  assert.match(ticketHtml, /Customer details/);
  assert.match(ticketHtml, /Recent customer orders/);
  assert.match(ticketHtml, /Ticket thread/);

  // Nav, Today card, glance & brief on homepage
  const homeRes = await w.fetch(at("/"));
  assert.equal(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assert.match(homeHtml, /href="\/shop"/); // In nav
  assert.match(homeHtml, /Northwind Shop/); // Today card
  assert.match(homeHtml, /3 tickets waiting over an hour/);
  assert.match(homeHtml, /1 failed payment/);
  assert.match(homeHtml, /Shop orders/); // Glance
  assert.match(homeHtml, /412/);
  assert.match(homeHtml, /3 support tickets wait over an hour/); // Briefing lede

  // Needs hook produces needs for tickets waiting over an hour
  const shop = northwindShopPack();
  const needs = shop.needs?.({} as any) ?? [];
  assert.equal(needs.length, 3);
  assert.match(needs[0]!.title, /Support ticket waiting over an hour/);
  assert.equal(needs[0]!.ring, "tickets");

  // Packs page
  const packsRes = await w.fetch(at("/packs"));
  assert.equal(packsRes.status, 200);
  const packsHtml = await packsRes.text();
  assert.match(packsHtml, /Northwind Shop/);
  assert.match(packsHtml, /Storefront ops: metrics, support tickets &amp; actions/);
});

/** The demo's shop with hostile text in every field a visitor could see: only tests have it, never the demo. */
function hostileShop(): ShopData {
  const d = demoShopData();
  const t = d.tickets[0]!;
  const order = { ...t.order, id: H, items: [H] };
  return { ...d, tickets: [{ ...t, id: "t-hostile", subject: H, customer: { ...t.customer, id: "c-hostile", name: H, email: H }, order, recentOrders: [order], thread: [{ id: "m-h", from: "customer", author: H, at: H, text: `${H} javascript:alert(1)` }] }, ...d.tickets.slice(1)] };
}

test("demo: Northwind Shop hostile input stays inert, and the demo itself ships none", async () => {
  assert.ok(!JSON.stringify(demoShopData()).includes("<script"), "no hostile fixtures in the demo's own data");
  assert.equal((await createDemoWorker().fetch(at("/shop/tickets/t-hostile"))).status, 404);

  const { get } = signedIn(snapshot(), {}, { packs: [northwindShopPack({ data: hostileShop })] });
  for (const path of ["/shop", "/shop/tickets/t-hostile", "/", `/search?q=${encodeURIComponent("t-hostile")}`]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assertInert(`shop ${path}`, body);
    assert.ok(!body.includes('href="javascript:'), `${path}: javascript: href`);
  }
  assert.equal((await get(`/shop/tickets/${encodeURIComponent(H)}`)).status, 404);
});

test("demo: Northwind Shop's lines are counted from its data, not typed in", () => {
  const d = demoShopData();
  const fewer = { ...d, stats: { ...d.stats, ordersToday: 77 }, tickets: d.tickets.filter((t) => t.id !== "t-101") };
  const pack = northwindShopPack({ data: () => fewer });
  assert.deepEqual(pack.glance?.({} as never), [{ label: "Shop orders", value: 77 }]);
  const brief = JSON.stringify(pack.brief?.({} as never));
  assert.match(brief, /2 support tickets wait over an hour/);
  assert.doesNotMatch(brief, /failed payment/);
  assert.match(String(pack.bino?.({} as never)), /^2 support tickets waiting over an hour \(oldest 1h 18m\)\. 77 orders today, 0 failed payments\.$/);
  assert.equal(pack.needs?.({} as never)?.length, 2);
});

test("Northwind Shop: each support action re-checks, logs to the actions table, and refuses with why", async () => {
  const { post, get, db } = signedIn(snapshot(), {}, { packs: [northwindShopPack({ data: () => demoShopData() })] });
  const paid = demoShopData().tickets.find((t) => t.order.state === "paid")!;
  const locked = demoShopData().tickets.find((t) => t.customer.status === "locked")?.customer;

  assert.equal((await post(`/shop/tickets/${paid.id}/refund`, {})).status, 303);
  assert.match(await (await get(`/shop/tickets/${paid.id}`)).text(), /refunded/);
  const again = await post(`/shop/tickets/${paid.id}/refund`, {});
  assert.equal(again.status, 409, "a refunded order isn't refunded twice");
  assert.match(await again.text(), /already refunded/);
  assert.equal((await post("/shop/tickets/t-101/refund", {})).status, 409, "a failed payment has nothing to refund");
  assert.equal((await post("/shop/tickets/t-101/resend-receipt", {})).status, 409, "nor a receipt");
  assert.equal((await post(`/shop/tickets/${paid.id}/resend-receipt`, {})).status, 303);
  assert.equal((await post("/shop/tickets/nope/refund", {})).status, 409);
  if (locked) {
    assert.equal((await post(`/shop/customers/${locked.id}/unlock`, {})).status, 303);
    assert.equal((await post(`/shop/customers/${locked.id}/unlock`, {})).status, 409, "unlocked already");
  }
  assert.equal((await post(`/shop/customers/${paid.customer.id}/extend-shipping`, {})).status, 303);
  assert.equal((await post(`/shop/customers/${paid.customer.id}/extend-shipping`, {})).status, 409, "extended already");
  assert.equal((await post(`/shop/tickets/${paid.id}/refund`, {}, { origin: "https://evil.example" })).status, 403, "another site's form");

  const log = (await db.DB.prepare("SELECT kind, target, ok FROM actions ORDER BY id").all<{ kind: string; target: string; ok: number }>()).results;
  assert.deepEqual(log.slice(0, 2).map((l) => ({ ...l })), [{ kind: "shop.refund", target: `order ${paid.order.id}`, ok: 1 }, { kind: "shop.refund", target: `order ${paid.order.id}`, ok: 0 }]);
  assert.equal(log.filter((l) => l.ok).length, locked ? 4 : 3);
  assert.ok(log.every((l) => l.kind.startsWith("shop.")));
});

test("demo: Northwind Shop support actions answer 403 read-only page on POST", async () => {
  const w = createDemoWorker();
  const actions = [
    "/shop/tickets/t-101/refund",
    "/shop/tickets/t-101/resend-receipt",
    "/shop/customers/c-101/unlock",
    "/shop/customers/c-101/extend-shipping",
  ];

  for (const actionPath of actions) {
    const res = await w.fetch(at(actionPath, {
      method: "POST",
      headers: { origin: "https://demo.dovre.dev" },
    }));
    assert.equal(res.status, 403, `${actionPath} should answer 403`);
    const text = await res.text();
    assert.match(text, /This demo is read-only/);
    assert.match(text, /The demo shows made-up data/);
    assert.match(text, /href="https:\/\/dovre\.dev\/"/);
  }
});

test("real instances: brand logo still links to /", async () => {
  const { get } = signedIn(snapshot());
  const res = await get("/");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /<a class="brand" href="\/"/);
  assert.doesNotMatch(text, /This is a demo\./);
});
