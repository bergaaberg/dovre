/** The phone's tab bar (src/html.ts): Today, the tabs the nav marks (three at most), and More. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type NavItem, shell } from "../src/html.ts";

const nav: NavItem[] = [
  { href: "/", title: "Today", icon: "home" },
  { href: "/prs", title: "Pull requests", icon: "pr", group: "Code" },
  { href: "/a", title: "A", icon: "inbox", tab: true, count: 3, hot: true },
  { href: "/b", title: "B", icon: "alert", tab: true },
  { href: "/c", title: "C", icon: "alert", tab: true },
  { href: "/d", title: "D", icon: "alert", tab: true },
  { href: "/settings", title: "Settings", icon: "gear", group: "You" },
];
const page = (current: string, items = nav) => String(shell({ title: "t", frame: { operator: "me", nav: items }, current, body: "" }));
const bar = (out: string) => out.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)?.[0] ?? "";

test("the bar holds Today and the first three marked tabs, with their counts, then More", () => {
  const b = bar(page("/"));
  const hrefs = [...b.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/", "/a", "/b", "/c"]);
  assert.match(b, /<b class="hot">3<\/b>/);
  assert.match(b, /id="tab-more"[^>]*aria-controls="side-sheet"/);
  assert.match(b, /<a href="\/"\s*aria-current="page"/);
});

test("on a page that isn't a tab, More is the one lit; on a tab, it isn't", () => {
  assert.match(bar(page("/prs")), /id="tab-more" class="on"/);
  assert.doesNotMatch(bar(page("/b")), /class="on"/);
  assert.match(bar(page("/b")), /<a href="\/b" aria-current="page"/);
});

test("with no marked tabs there's no bar, and the header's menu button stays", () => {
  const out = page("/", nav.map(({ tab: _, ...p }) => p));
  assert.equal(bar(out), "");
  assert.match(out, /id="side-menu"/);
});

test("the More sheet leaves out what the bar holds: tabs marked, a group of only tabs marked whole", () => {
  const items: NavItem[] = [
    { href: "/", title: "Today", icon: "home" },
    { href: "/prs", title: "Pull requests", icon: "pr", group: "Code" },
    { href: "/a", title: "A", icon: "inbox", group: "Ops", tab: true },
    { href: "/b", title: "B", icon: "alert", group: "Ops", tab: true },
  ];
  const out = page("/", items);
  assert.match(out, /<div class="side-sheet" id="side-sheet">/);
  assert.match(out, /<a href="\/a" title="A" class="is-tab"/);
  assert.match(out, /<a href="\/prs" title="Pull requests">/);
  assert.match(out, /class="side-g all-tabs"><p class="side-h">Ops/);
  assert.match(out, /class="side-g"><p class="side-h">Code/);
});

test("on the phone a dock is a sheet that fits above the keyboard, and opening it doesn't pop the keyboard up", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  const { SCRIPT } = await import("../src/ui/app.js.ts");
  assert.match(page("/"), /<meta name="viewport" content="[^"]*interactive-widget=resizes-content/, "the layout shrinks with the keyboard, so fixed things don't pan");
  const phone = STYLE.slice(STYLE.indexOf("@media (max-width: 560px) {\n  .docks"));
  assert.match(phone, /\.tdock-panel \{ position: fixed; top: [^}]*bottom: [^}]*height: auto/, "pinned to the visible edges, not a height that runs off the top");
  // Only while the keyboard is up: a box focused on open with the keyboard down (Android's autofocus) hides nothing.
  assert.match(STYLE, /html\.kb :is\(\.tabbar, \.docks\) \{ display: none; \}/);
  assert.doesNotMatch(STYLE, /:focus\) :is\(\.tabbar/);
  assert.match(SCRIPT, /classList\.toggle\("kb", typing\(document\.activeElement\) && h < tallest \* 0\.8\)/);
  assert.match(SCRIPT, /function dockFocus\(frame\) \{\n  if \(!frame\) return;\n[^\n]*\n  if \(matchMedia\("\(pointer: coarse\)"\)\.matches\) return;/);
});

test("on the phone the bar never takes a short page's spare height, and a bare row's end keeps its words", async () => {
  const { STYLE } = await import("../src/ui/style.ts");
  const narrow = STYLE.slice(STYLE.indexOf("@media (max-width: 900px) {\n  /* Two rows"));
  assert.match(narrow, /\.shell, \.side-slim \.shell \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: auto minmax\(0, 1fr\); \}/);
  assert.match(STYLE, /\.item\.bare \{ grid-template-columns: minmax\(0, 1fr\) auto; \}/, "no empty lead column squeezing the end");
  assert.doesNotMatch(STYLE, /\.item\.bare > \.end \{[^}]*overflow-wrap: anywhere/, "an end wrapped letter by letter");
});
