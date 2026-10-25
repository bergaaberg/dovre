/** The packs' events in Today's feed (src/home/feed.ts packFeedOf, src/pages/home.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { packFeedOf, mergeFeeds } from "../src/home/feed.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const pack = { id: "shop", name: "Shop" };

test("a pack's events become the feed's: the app is who, keys under the pack, newest first", () => {
  const out = packFeedOf(
    [
      { pack, item: { key: "a", at: NOW - 3600e3, tone: "ok", what: "signed up", title: "Kari" } },
      { pack, item: { key: "b", at: NOW - 60e3, tone: "acc", what: "deployed", app: "web", href: "/health" } },
    ],
    NOW,
  );
  assert.deepEqual(
    out.map((e) => [e.key, e.who, e.what]),
    [
      ["c:shop:b", "web", "deployed"],
      ["c:shop:a", "Shop", "signed up"],
    ],
  );
});

test("malformed, future and too-old events are left out, an unknown tone is quiet", () => {
  const out = packFeedOf(
    [
      { pack, item: null },
      { pack, item: { key: "", at: NOW, what: "x" } },
      { pack, item: { key: "k", at: "yesterday", what: "x" } },
      { pack, item: { key: "k", at: NOW + 3600e3, what: "from the future" } },
      { pack, item: { key: "k", at: NOW - 8 * 24 * 3600e3, what: "too old" } },
      { pack, item: { key: "ok", at: NOW - 1000, what: "kept", tone: "purple" } },
    ],
    NOW,
  );
  assert.deepEqual(out.map((e) => [e.what, e.tone]), [["kept", "mute"]]);
});

test("merged feeds stay newest first and capped", () => {
  const a = packFeedOf([{ pack, item: { key: "1", at: NOW - 10, what: "a" } }], NOW);
  const b = packFeedOf([{ pack, item: { key: "2", at: NOW - 5, what: "b" } }], NOW);
  assert.deepEqual(mergeFeeds(a, b).map((e) => e.what), ["b", "a"]);
  assert.equal(mergeFeeds(a, b, 1).length, 1);
});

test("hosted, the panel is the apps' events alone: What's happening, no org movement", async () => {
  const { homePage } = await import("../src/pages/home.ts");
  const { snapshot } = await import("./helpers.ts");
  const events = packFeedOf([{ pack, item: { key: "a", at: Date.now() - 3 * 24 * 3600e3, tone: "ok", what: "signed up", title: "Kari" } }], Date.now());
  const out = String(homePage({ operator: "me", nav: [] }, snapshot(), () => undefined, { feed: { events, only: true } }));
  const feed = out.match(/<aside class="card feed"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.match(feed, /What's happening/);
  assert.match(feed, /signed up/);
  assert.doesNotMatch(feed, /\/movement/);
});
