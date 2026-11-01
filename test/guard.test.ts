/** What keeps a pack inside the pack: its markup checked, its styles scoped, its pages' failures its own. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { html, raw } from "hono/html";
import { boxed, checkHtml, classesOf, guardHtml, ownsSelector, scopeCss, scriptOf } from "../src/packs/guard.ts";
import { STYLE } from "../src/ui/style.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const pack = (id: string, hooks: Partial<Pack> = {}): Pack => ({ manifest: { api: PACK_API, id, name: `${id[0]!.toUpperCase()}${id.slice(1)}`, description: id, domain: "general" }, ...hooks });

test("checkHtml: a well-formed fragment passes, with void tags, SVG's />, tags the browser closes itself, and markup-free script text", () => {
  for (const ok of [
    `<div class="a"><p>one<p>two</div>`,
    `<ul><li>a<li>b</ul><br><img src="x" alt="a > b">`,
    `<svg viewBox="0 0 1 1"><path d="M0 0"/><rect /></svg>`,
    `<table><tr><td>a<td>b<tr><td>c</table>`,
    `<script>if (a < b && "</div>") {}</script><textarea></main></textarea>`,
    `<!-- </div> --><span>${"&lt;/div&gt;"}</span>`,
    "plain text",
  ])
    assert.equal(checkHtml(ok), undefined, ok);
});

test("checkHtml: what would reshape the page around a fragment is named", () => {
  assert.match(checkHtml(`</main><main>`)!, /<\/main> closes what it didn't open/);
  assert.match(checkHtml(`<div><section></div>`)!, /<\/div> closes/);
  assert.match(checkHtml(`<div class="x">open`)!, /<div> isn't closed/);
  assert.match(checkHtml(`<base href="https://evil.example/">`)!, /<base> belongs to the page/);
  assert.match(checkHtml(`<body>`)!, /<body> belongs/);
  assert.match(checkHtml(`<style>body { display: none }</style>`)!, /<style> isn't scoped/);
  assert.match(checkHtml(`<script>never closed`)!, /<script> isn't closed/);
});

test("guardHtml: broken markup and failed async fragments become a note, logged; plain strings and good markup pass", async () => {
  const log: string[] = [];
  const l = (s: string) => log.push(s);
  const good = html`<p>${H}</p>`;
  assert.equal(guardHtml(good, "Pk", "page", l), good);
  assert.equal(guardHtml("</div>", "Pk", "page", l), "</div>", "a plain string is escaped where it's drawn");
  assert.match(String(guardHtml(html`${raw("</main>")}`, "Pk", "page", l)), /Pk couldn't draw this part/);
  assert.match(String(await guardHtml(Promise.reject(new Error("async boom")) as never, "Pk", "slot x", l)), /couldn't draw/);
  assert.match(String(await guardHtml(Promise.resolve(html`${raw("<div>")}`), "Pk", "card", l)), /couldn't draw/);
  assert.deepEqual(log, ["page: markup refused: </main> closes what it didn't open", "slot x: async boom", "card: markup refused: <div> isn't closed"]);
  assert.equal(String(boxed(html`<b>x</b>`, "pk", "Pk", "page", l)), `<div class="pack-box" data-pack="pk"><b>x</b></div>`);
});

test("scopeCss: a pack keeps rules for its own markup; rules that restyle core go, named", () => {
  const core = classesOf(STYLE);
  for (const sel of [".av", ".av:hover", "a.av-card.bad", ".panel-body > .health-grid", ".skribb .item.bare > .below > * + .buttons", ":root:not([data-motion=\"always\"]) .av *", "body:has(.tab-gap) .av-say", ".av-face[data-scene=\"x\"]", ".d-add mark.cr-x"])
    assert.ok(ownsSelector(sel, core), sel);
  for (const sel of ["body", ":root", "html", "*", ".panel", ".item .line svg.pulse", ".av ~ .panel", ".av + .item", ".panel:has(.av)", ":is(.av) .panel", ".face-btn:has(.av-face)", "div", "[data-x]"])
    assert.ok(!ownsSelector(sel, core), sel);
  const { css, dropped } = scopeCss(
    `@import url("https://x/y.css");
/* a comment { with braces } */
body { display: none }
.av, .panel { color: red; background: url("a{b}.png") }
@media (max-width: 40rem) { :root { --accent: red } .av { width: 100% } }
@media print { .wrap { display: none } }
@keyframes av-bob { from { transform: none } to { transform: translateY(2px) } }
@font-face { font-family: X; src: url(x.woff2) }
.av { &:hover { color: blue } }`,
    core,
  );
  assert.deepEqual(dropped, [`@import url("https://x/y.css")`, "body", ".panel", ":root", ".wrap"]);
  assert.doesNotMatch(css, /body|\.panel|:root|\.wrap|@import|@media print/);
  assert.match(css, /^\.av \{ color: red; background: url\("a\{b\}\.png"\) \}$/m);
  assert.match(css, /@media \(max-width: 40rem\) \{\n\.av \{ width: 100% \}\n\}/);
  assert.match(css, /@keyframes av-bob \{ from \{ transform: none \} to \{ transform: translateY\(2px\) \} \}/);
  assert.match(css, /@font-face/);
  assert.match(css, /\.av \{ &:hover \{ color: blue \} \}/);
  assert.equal(scopeCss("} .av { color: red }", core).css.trim(), ".av { color: red }", "a stray brace doesn't end the sheet");
});

test("scriptOf: a pack's script in a try of its own", () => {
  assert.equal(scriptOf("pk", "boom();"), `// pk\ntry {\nboom();\n} catch (e) { console.error("pack pk:", e); }\n`);
});

test("pack pages: one that throws or hangs is that pack's broken page in the shell; the rest of Dovre still answers", async () => {
  const bad = pack("bad", {
    routes: (app) => {
      app.get("/bad", () => {
        throw new Error(`exploded ${H}`);
      });
      app.get("/bad/slow", () => new Promise<Response>(() => {}));
    },
  });
  const { get } = signedIn(snapshot(), {}, { packs: [bad], routeMs: 50 });
  const r = await get("/bad");
  assert.equal(r.status, 500);
  const body = await r.text();
  assertInert("broken pack page", body);
  assert.match(body, /Bad broke on this page/);
  assert.match(body, /class="tabbar|<nav/, "inside the shell");
  const slow = await get("/bad/slow");
  assert.equal(slow.status, 500);
  assert.match(await slow.text(), /didn&#39;t answer in 0.05 s/);
  assert.equal((await get("/prs")).status, 200, "core pages still answer");
});

test("pack pages and cards: broken markup becomes a note in the pack's box, the shell around it intact; styles that restyle core aren't served", async () => {
  const sloppy = pack("sloppy", {
    styles: `body { display: none } .sloppy-x { color: red }`,
    routes: (app, ctx) => {
      app.get("/sloppy", (c) => ctx.page(c, { title: "Sloppy", body: html`<p>hi</p>${raw("</main></div>")}` }));
      app.get("/sloppy/fine", (c) => ctx.page(c, { title: "Sloppy", body: html`<p class="sloppy-x">fine</p>` }));
    },
  });
  const { get } = signedIn(snapshot(), {}, { packs: [sloppy] });
  const page = await (await get("/sloppy")).text();
  assert.match(page, /<div class="pack-box" data-pack="sloppy"><p class="pack-broke t3">Sloppy couldn't draw this part.<\/p><\/div>/);
  assert.doesNotMatch(page, /<p>hi<\/p><\/main>/);
  const fine = await (await get("/sloppy/fine")).text();
  assert.match(fine, /<div class="pack-box" data-pack="sloppy"><p class="sloppy-x">fine<\/p><\/div>/);
  const href = fine.match(/href="(\/assets\/packs\.[0-9a-z]+\.css)"/)?.[1];
  assert.ok(href);
  const css = await (await get(href)).text();
  assert.match(css, /\.sloppy-x \{ color: red \}/);
  assert.doesNotMatch(css, /body/);
});

test("the pack box is its overlays' frame: clipped width, layout contained", () => {
  const rule = /\.pack-box \{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
  for (const want of ["overflow-x: clip", "max-width: 100%", "contain: layout"]) assert.ok(rule.includes(want), want);
  // Not size containment: that collapses flex and shrink-to-fit parents around the box.
  assert.doesNotMatch(rule, /contain:[^;]*\b(size|inline-size|strict|content)\b/);
});
