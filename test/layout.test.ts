/** Settings → Layout (src/layout.ts): the phone's tabs, Today's cards, the feed's sources, packs hidden; kept in the database, applied at once. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { html } from "hono/html";
import { packsOf } from "../src/app.ts";
import { refresher } from "../src/packs/registry.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { openDb } from "../src/db.ts";
import { type NavItem, tabsOf } from "../src/html.ts";
import { layoutOf, layoutStore, placeCards, withTabs } from "../src/layout.ts";
import { Card } from "../src/ui/kit.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

test("layoutOf: only what it knows, in shape; junk dropped", () => {
  assert.deepEqual(layoutOf(null), {});
  assert.deepEqual(
    layoutOf({ tabs: ["/", "/a", "javascript:x", "/a", "/b", "/c", "/d"], cards: { agents: { col: "off", order: 5 }, "x y": { col: "left" }, prs: { col: "middle" }, ship: { col: "right", order: 1e9 } }, feedOff: ["ok", "Bad!"], packsOff: "nope", extra: 1 }),
    { tabs: ["/a", "/b"], cards: { agents: { col: "off", order: 5 }, ship: { col: "right", order: 999 } }, feedOff: ["ok"] },
  );
});

test("withTabs: my tabs in my order, the rest unmarked; unset leaves the menu's own; none means no bar", () => {
  const nav: NavItem[] = [{ href: "/", title: "Today" }, { href: "/a", title: "A", tab: true }, { href: "/b", title: "B" }, { href: "/c", title: "C" }];
  assert.deepEqual(tabsOf(withTabs(nav, undefined)).map((p) => p.href), ["/", "/a"]);
  assert.deepEqual(tabsOf(withTabs(nav, ["/c", "/b"])).map((p) => p.href), ["/", "/c", "/b"]);
  assert.deepEqual(tabsOf(withTabs(nav, [])), []);
});

test("placeCards: where my layout says, else where the code puts them; hidden ones gone", () => {
  const slot = (id: string, col: "left" | "right", order: number) => ({ id, label: id, col, order, render: id });
  const cols = placeCards([slot("a", "left", 10), slot("b", "left", 20), slot("c", "right", 10), slot("d", "right", 20)], { b: { col: "right", order: 5 }, c: { col: "off", order: 0 } });
  assert.deepEqual(cols.left.map((s) => s.id), ["a"]);
  assert.deepEqual(cols.right.map((s) => s.id), ["b", "d"]);
});

test("layoutStore: saved, read back by another (as another isolate would after its TTL), reset", async () => {
  const db = openDb().DB;
  const a = layoutStore(db);
  await a.ready;
  await a.save({ tabs: ["/x"] });
  assert.deepEqual(a.get(), { tabs: ["/x"] });
  let t = 0;
  const b = layoutStore(db, { now: () => t, ttlMs: 10 });
  await b.ready;
  assert.deepEqual(b.get(), { tabs: ["/x"] });
  await a.save({ tabs: ["/y"] });
  t = 100;
  b.get();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(b.get(), { tabs: ["/y"] });
  await a.reset();
  assert.deepEqual(a.get(), {});
});

const pack = (id: string, name: string, hooks: Partial<Pack> = {}): Pack => ({ manifest: { api: PACK_API, id, name, description: "", domain: "personal" }, ...hooks });

test("Settings → Layout: tabs, a card moved and one hidden, a feed off, a pack hidden (menu, Today, pages, refresh); back to defaults", async () => {
  let refreshed = 0;
  const shop = pack("shop", "Shop", {
    nav: () => [{ href: "/shop", title: "Shop", icon: "inbox", tab: true }],
    routes: (app, ctx) => app.get("/shop", (c) => ctx.page(c, { title: "Shop", body: "the shop" })),
    today: () => [{ id: "now", column: "right", render: Card({ id: "shop-card", title: "Shop", children: "" }) }],
    feed: () => [{ key: "1", at: Date.now(), tone: "ok", what: "sold", title: "a kettle" }],
    refresh: async () => void refreshed++,
  });
  const blog = pack("blog", H, {
    nav: () => [{ href: "/blog", title: "Blog", icon: "pen" }],
    routes: (app, ctx) => app.get("/blog", (c) => ctx.page(c, { title: "Blog", body: html`the blog` })),
    today: () => [{ id: "now", render: Card({ id: "blog-card", title: "Blog", children: "" }) }],
    feed: () => [{ key: "2", at: Date.now(), tone: "ok", what: "posted", title: "a post" }],
  });
  const { app, get, post } = signedIn(snapshot(), {}, { packs: [shop, blog] });
  const settings = await (await get("/settings/layout")).text();
  assertInert("settings with a hostile pack", settings);
  assert.match(settings, /<form method="post" action="\/settings\/layout" data-autosave>/);
  assert.match(settings, /<select name="tab1">[\s\S]*?<option value="\/shop" selected>Shop<\/option>/, "the tab the pack marks, as it is now");
  assert.match(settings, /name="col:shop-now"/);

  const res = await post("/settings/layout", { tab1: "/prs", tab2: "/blog", tab3: "", "col:agents": "off", "order:agents": "10", "col:shop-now": "left", "order:shop-now": "1", "col:prs": "right", "order:prs": "10", feed: "shop", pack: "shop" });
  assert.equal(res.status, 303);
  const today = await (await get("/")).text();
  assert.doesNotMatch(today, /class="card" id="agents"/, "a hidden card isn't drawn");
  const left = today.split('<div class="today-col">')[1]!;
  assert.ok(left.indexOf('id="shop-card"') >= 0 && left.indexOf('id="shop-card"') < left.indexOf('id="ship"'), "moved left, first");
  assert.doesNotMatch(today, /blog-card/, "a hidden pack's card is gone");
  assert.match(today, /a kettle/);
  assert.doesNotMatch(today, /a post/);
  const bar = today.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.deepEqual([...bar.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ["/", "/prs"], "my tabs; a hidden pack's page isn't one");
  assert.doesNotMatch(today, /href="\/blog"/, "out of the menu");
  assert.equal((await get("/blog")).status, 404);
  assert.equal((await get("/shop")).status, 200);
  const mounted = packsOf(app)!;
  assert.ok(mounted.hidden("blog") && !mounted.hidden("shop"));
  await refresher(mounted.on, mounted.ctxOf, () => {}, { skip: mounted.hidden }).due(true);
  assert.equal(refreshed, 1);

  await post("/settings/layout/reset", {});
  const back = await (await get("/")).text();
  assert.match(back, /class="card" id="agents"/);
  assert.match(back, /blog-card/);
  assert.equal((await get("/blog")).status, 200);
});

test("look: a picked theme and accent are on every page's <html>, the CSS has a block for each, junk is dropped", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  for (const sel of [':root[data-theme="dark"] {', ':root[data-theme="light"]', ':root[data-accent="heather"]', ':root[data-accent="glacier"]', ':root[data-theme="dark"][data-accent="heather"]', ':root:not([data-theme])[data-accent="glacier"]']) assert.ok(STYLE.includes(sel), sel);
  assert.ok(!STYLE.includes("${"), "every token block filled in");
  assert.deepEqual(layoutOf({ theme: "sepia", accent: "red" }), {});
  const { get, post } = signedIn(snapshot());
  const unset = await (await get("/")).text();
  assert.match(unset, /<html lang="en">/, "unset: the system's, fjord");
  assert.match(unset, /<meta name="theme-color" content="#efe7db" media="\(prefers-color-scheme: light\)">/, "the browser's bar follows the system too");
  assert.match(unset, /<meta name="theme-color" content="#0e1922" media="\(prefers-color-scheme: dark\)">/);
  await post("/settings/layout", { theme: "dark", accent: "heather" });
  const page = await (await get("/prs")).text();
  assert.match(page, /<html lang="en" data-theme="dark" data-accent="heather">/);
  assert.equal(page.match(/name="theme-color"/g)?.length, 1, "picked: one bar colour, the theme's");
  assert.match(page, /<meta name="theme-color" content="#0e1922">/);
  assert.match(await (await get("/settings/look")).text(), /name="accent" value="heather" checked>/);
  await post("/settings/layout", { theme: "light" });
  assert.match(await (await get("/prs")).text(), /<meta name="theme-color" content="#efe7db">/);
  await post("/settings/layout", { theme: "ember", accent: "glacier" });
  const ember = await (await get("/prs")).text();
  assert.match(ember, /<html lang="en" data-theme="ember" data-accent="glacier">/);
  assert.match(ember, /<meta name="theme-color" content="#1b140f">/);
  assert.match(await (await get("/settings/look")).text(), /name="theme" value="ember" checked>/);
});

test("reading settings (#183): font, text size and line height on <html>, a CSS block for each, junk dropped, back to default", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  for (const sel of [':root[data-font="sans"]', ':root[data-font="serif"]', ':root[data-size="small"]', ':root[data-size="large"]', ':root[data-size="larger"]', ':root[data-lh="tight"]', ':root[data-lh="loose"]', "font: var(--fs-m)/var(--lh) var(--sans)"]) assert.ok(STYLE.includes(sel), sel);
  assert.deepEqual(layoutOf({ font: "comic", textSize: "huge", lineHeight: 3 }), {});
  const { get, post } = signedIn(snapshot());
  await post("/settings/layout", { font: "serif", textSize: "larger", lineHeight: "loose" });
  assert.match(await (await get("/prs")).text(), /<html lang="en" data-font="serif" data-size="larger" data-lh="loose">/);
  const settings = await (await get("/settings/look")).text();
  for (const v of ["serif", "larger", "loose"]) assert.match(settings, new RegExp(`value="${v}" checked>`));
  await post("/settings/layout", { font: "", textSize: "", lineHeight: "" });
  assert.match(await (await get("/prs")).text(), /<html lang="en">/);
});

test("themes (#95): each has its block, its accents and its scheme; the browser's bar is its --sky; the system's dark leaves a picked theme alone", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  const { SKY } = await import("../src/html.ts");
  const { THEMES } = await import("../src/layout.ts");
  for (const t of THEMES) {
    assert.ok(SKY[t], `${t} has a bar colour`);
    if (t === "light") continue;
    const block = STYLE.slice(STYLE.lastIndexOf(`:root[data-theme="${t}"] {`));
    assert.ok(block.length < STYLE.length, `${t} has a block`);
    // The last --sky in the block wins (polar and ember start from night's).
    const skies = [...block.slice(0, block.indexOf("\n}")).matchAll(/--sky: (#[0-9a-f]{6})/g)].map((m) => m[1]);
    assert.equal(skies.at(-1), SKY[t], `${t}'s bar is its --sky`);
    for (const a of ["heather", "glacier"]) assert.ok(STYLE.includes(`:root[data-theme="${t}"][data-accent="${a}"]`), `${t} + ${a}`);
  }
  assert.match(STYLE, /:root\[data-theme="birch"\] \{\n  color-scheme: light;/);
  assert.match(STYLE, /:root\[data-theme="polar"\] \{\n  color-scheme: dark;/);
  assert.ok(!STYLE.includes(':not([data-theme="light"])'), "the system's dark only fills in when no theme is picked");
  assert.deepEqual(layoutOf({ theme: "polar" }), { theme: "polar" });
});

test("Bino's button: the assistant icon without an avatar; with one, the avatar unless Settings → Layout says the icon", async () => {
  const { createApp } = await import("../src/app.ts");
  const { noMemory } = await import("../src/packs/core/assistant/bino/memory.ts");
  const { fakeGhe, fixedGatherer } = await import("./helpers.ts");
  const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
  const bino = { route: { via: "claude" as const, ready: true, model: "sonnet", reflectModel: "haiku", ask: async () => ({ text: "", cost: 0 }) }, memory: noMemory("no") };
  const face = pack("face", "Face", { slots: () => ({ "bino.face": () => html`<img class="av-face" alt="">` }) });
  const appWith = (packs: Pack[]) => {
    const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino, packs: { on: packs, off: [], env: {} } });
    const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
    const post = (path: string, body: Record<string, string>) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: new URLSearchParams(body).toString() });
    return { get, post };
  };
  const button = (page: string) => page.match(/<a class="tdock-btn[^"]*" id="bdock-btn"[^]*?<\/a>/)?.[0] ?? "";
  const icon = button(await (await appWith([]).get("/prs")).text());
  assert.match(icon, /class="tdock-btn bino-btn"/);
  assert.match(icon, /href="#i-bino"/);
  assert.match(icon, /aria-label="Bino"/);
  const { get, post } = appWith([face]);
  assert.match(button(await (await get("/prs")).text()), /face-btn[^]*av-face/);
  await post("/settings/layout", { binoButton: "icon" });
  assert.match(button(await (await get("/prs")).text()), /href="#i-bino"/);
  assert.match(await (await get("/settings/look")).text(), /name="binoButton" value="icon" checked>[^]*?The assistant icon/);
  assert.deepEqual(layoutOf({ binoButton: "face" }), {}, "only what it knows");
});

test("motion: Always puts data-motion on <html>, and the reduced-motion rules and script step aside for it; back to the system's", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  const { SCRIPT } = await import("../src/ui/app.js.ts");
  // Each reduced-motion block's body, by matching braces, comments left out.
  const reduced = [...STYLE.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)].map((m) => {
    const from = m.index! + m[0].length;
    let depth = 1;
    let i = from;
    for (; depth; i++) depth += STYLE[i] === "{" ? 1 : STYLE[i] === "}" ? -1 : 0;
    return STYLE.slice(from, i - 1).replace(/\/\*[^]*?\*\//g, "");
  });
  assert.ok(reduced.length >= 3, "core's two and the splash's");
  // Every rule under reduced motion is scoped to "not Always", and the page swap no longer switches off by @view-transition.
  for (const block of reduced) for (const rule of block.split("}").map((r) => r.split("{")[0]!.trim()).filter(Boolean))
    for (const sel of rule.split(",")) assert.match(sel.trim(), /^:root:not\(\[data-motion="always"\]\)/, sel);
  assert.doesNotMatch(STYLE, /navigation: none/);
  assert.match(SCRIPT, /dataset\.motion !== "always"/);
  assert.deepEqual(layoutOf({ motion: "never" }), {}, "only what it knows");
  const { get, post } = signedIn(snapshot());
  assert.doesNotMatch(await (await get("/prs")).text(), /data-motion/);
  await post("/settings/layout", { motion: "always" });
  assert.match(await (await get("/prs")).text(), /<html lang="en" data-motion="always">/);
  assert.match(await (await get("/settings/look")).text(), /name="motion" value="always" checked>/);
  await post("/settings/layout", { motion: "" });
  assert.match(await (await get("/prs")).text(), /<html lang="en">/);
});
