/** "Since I last looked" on Today without a code host (#421 step 4): visits, rows, the card. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import type { FeedEvent } from "../src/home/feed.ts";
import { packFeedOf } from "../src/home/feed.ts";
import type { Need } from "../src/home/needs.ts";
import { openToday, sinceLabel, sinceRows, VISIT_GAP, VISIT_MAX, visitsOf, visitsStore } from "../src/home/since.ts";
import { homePage } from "../src/pages/home.ts";
import { assertInert, H, snapshot } from "./helpers.ts";

const MIN = 60e3;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse("2026-11-16T09:30:00Z");

test("a visit, not a page load: reloads keep the same since, an hour away starts the next", () => {
  const first = openToday(undefined, NOW);
  assert.equal(first.since, NOW - DAY, "the very first visit counts the day before");
  assert.ok(first.write);
  const reload = openToday(first.visits, NOW + 2 * MIN);
  assert.equal(reload.since, NOW - DAY, "a reload in the same visit: the same since");
  assert.equal(reload.write, false, "and nothing written so soon");
  const later = openToday(first.visits, NOW + 20 * MIN);
  assert.equal(later.since, NOW - DAY);
  assert.ok(later.write, "still here, written down now and then");
  const next = openToday(later.visits, NOW + 20 * MIN + VISIT_GAP + MIN);
  assert.equal(next.since, NOW + 20 * MIN, "back after an hour: since the visit before ended");
  assert.deepEqual(next.visits, { prev: NOW + 20 * MIN, start: NOW + 20 * MIN + VISIT_GAP + MIN, last: NOW + 20 * MIN + VISIT_GAP + MIN });
  const same = openToday(next.visits, next.visits.last + 30 * MIN);
  assert.equal(same.since, NOW + 20 * MIN, "within that visit, still since then");

  // A tab left open: its live swaps keep the visit going, but not for ever.
  let v = openToday(undefined, NOW).visits;
  for (let t = NOW; t < NOW + VISIT_MAX; t += 10 * MIN) v = openToday(v, t).visits;
  const tomorrow = openToday(v, NOW + VISIT_MAX + MIN);
  assert.equal(tomorrow.since, v.last, "after 12 h, a new visit");

  assert.equal(openToday({ prev: NOW - 30 * DAY, start: NOW - 30 * DAY, last: NOW - 30 * DAY }, NOW).since, NOW - 7 * DAY, "never further back than the feed keeps");
  assert.equal(openToday({ start: NOW + DAY, last: NOW + DAY }, NOW).since, NOW - DAY, "a visit from the future (a clock that jumped) starts again");
});

test("stored visits are read back checked", () => {
  assert.equal(visitsOf(null), undefined);
  assert.equal(visitsOf({ start: "1", last: 2 }), undefined);
  assert.equal(visitsOf({ start: 5, last: 3 }), undefined, "last before start");
  assert.deepEqual(visitsOf({ prev: 9, start: 5, last: 6 }), { start: 5, last: 6 }, "a prev after its start is dropped");
  assert.deepEqual(visitsOf({ prev: 4, start: 5, last: 6, x: H }), { prev: 4, start: 5, last: 6 });
});

test("each person's visits are their own, kept between runs", async () => {
  const db = openDb();
  let now = NOW;
  const store = visitsStore(db.DB, () => now);
  assert.equal(await store.open("kari@example.com"), NOW - DAY);
  assert.equal(await store.open(), NOW - DAY, "locally, one person");
  now += 3 * VISIT_GAP;
  assert.equal(await visitsStore(db.DB, () => now).open("kari@example.com"), NOW, "read back: since Kari last looked");
  assert.equal(await store.open("ola@example.com"), now - DAY, "Ola hasn't looked yet");
  const broken = visitsStore({ prepare: () => { throw new Error("down"); } } as never, () => now);
  assert.equal(await broken.open("kari@example.com"), now - DAY, "a store that can't be read: the last day");
});

test("a row a pack: its events counted by what they said, its new needs, mine and older left out", () => {
  const ev = (pack: string, what: string, at: number, o: Partial<FeedEvent> = {}): FeedEvent => ({ key: `c:${pack}:${what}:${at}`, at, tone: "mute", who: pack, what, pack, ...o });
  const need = (pack: string, at: number): Need => ({ kind: "pack", pack, key: `${pack}:${at}`, rank: 2, at, title: "Look", href: "/x", tone: "warn" }) as Need;
  const since = NOW - 10 * 60 * MIN;
  const packs = [{ id: "sentry", name: "Sentry", href: "/sentry" }, { id: "linear", name: "Linear" }, { id: "inbox", name: "Inbox", href: "/inbox" }];
  const rows = sinceRows(
    [
      ev("sentry", "new issue", NOW - 60 * MIN, { tone: "warn" }),
      ev("sentry", "new issue", NOW - 50 * MIN),
      ev("sentry", "rising", NOW - 40 * MIN, { tone: "bad" }),
      ev("linear", "moved to review", NOW - 5 * MIN),
      ev("linear", "commented", NOW - 4 * MIN, { mine: true }),
      ev("linear", "closed", since - MIN),
      ev("hidden", "anything", NOW - MIN),
      ev("inbox", "a", NOW - 9 * 60 * MIN), ev("inbox", "b", NOW - 9 * 60 * MIN), ev("inbox", "c", NOW - 9 * 60 * MIN), ev("inbox", "d", NOW - 9 * 60 * MIN), ev("inbox", "d", NOW - 9 * 60 * MIN),
    ],
    [need("sentry", NOW - 30 * MIN), need("sentry", since - MIN), need("hidden", NOW)],
    packs,
    since,
  );
  assert.deepEqual(rows.map((r) => r.id), ["linear", "sentry", "inbox"], "the newest first; a pack not shown here isn't");
  assert.deepEqual(rows[0], { id: "linear", name: "Linear", bits: [{ n: 1, what: "moved to review" }], more: 0, needs: 0, at: NOW - 5 * MIN });
  assert.deepEqual(rows[1], { id: "sentry", name: "Sentry", href: "/sentry", tone: "bad", bits: [{ n: 2, what: "new issue" }, { n: 1, what: "rising" }], more: 0, needs: 1, at: NOW - 30 * MIN });
  assert.deepEqual(rows[2]!.bits[0], { n: 2, what: "d" }, "most first");
  assert.equal(rows[2]!.bits.length, 3);
  assert.equal(rows[2]!.more, 1);
  assert.deepEqual(sinceRows([], [], packs, since), []);
  assert.equal(packFeedOf([{ pack: { id: "sentry", name: "Sentry" }, item: { key: "1", at: NOW - MIN, what: "rising" } }], NOW)[0]!.pack, "sentry", "the packs' feed says whose an event is");
});

test("since when, in words", () => {
  const z = "Europe/Oslo";
  assert.equal(sinceLabel(Date.parse("2026-11-16T07:12:00Z"), NOW, z), "since 08:12");
  assert.equal(sinceLabel(Date.parse("2026-11-15T17:40:00Z"), NOW, z), "since yesterday 18:40");
  assert.equal(sinceLabel(Date.parse("2026-11-12T17:40:00Z"), NOW, z), "since 12 Nov");
});

test("the card: on the left above Your apps without a code host, a line a pack, quiet said so; none with one", () => {
  const frame = { operator: "me", nav: [], tz: "Europe/Oslo" };
  const rows = [{ id: "sentry", name: "Sentry", href: "/sentry", tone: "bad" as const, bits: [{ n: 2, what: "new issue" }, { n: 1, what: "rising" }], more: 3, needs: 1, at: NOW - 30 * MIN }, { id: "linear", name: "Linear", bits: [{ n: 1, what: "moved to review" }], more: 0, needs: 0, at: NOW - 5 * 60 * MIN }];
  const yourApps = [{ id: "sentry", name: "Sentry", glance: [], working: 0, asking: 0 }];
  const out = String(homePage(frame, snapshot(), () => undefined, { now: NOW, noForge: true, yourApps, since: { since: Date.parse("2026-11-15T17:40:00Z"), rows } }));
  const left = out.split('<div class="today-col">')[1] ?? "";
  assert.ok(left.indexOf('id="since"') >= 0 && left.indexOf('id="since"') < left.indexOf('id="apps"'), "top left, above Your apps");
  assert.match(out, /Since I last looked<\/h2><p>since yesterday 18:40<\/p>/);
  assert.match(out, /<a class="item" href="\/sentry">.*aria-label="Something went wrong".*Sentry.*2 new issue · 1 rising · 3 more.*1 new for me/s);
  assert.match(out, /Linear.*1 moved to review.*5 h/s);
  assert.doesNotMatch(out, /href="[^"]*linear/i, "no page, no link");
  assert.match(String(homePage(frame, snapshot(), () => undefined, { now: NOW, noForge: true, since: { since: NOW - 60 * MIN, rows: [] } })), /<p class="empty">Nothing new since 09:30\.<\/p>/);
  assert.doesNotMatch(String(homePage(frame, snapshot(), () => undefined, { now: NOW, since: { since: NOW - DAY, rows } })), /id="since"/, "with a code host: not yet (#421: decided after using it)");
  const hostile = [{ id: "x", name: H, href: "javascript:alert(1)", tone: "warn" as const, bits: [{ n: 1, what: H }], more: 0, needs: 2, at: NOW }];
  assertInert("Since I last looked, hostile", String(homePage(frame, snapshot(), () => undefined, { now: NOW, noForge: true, since: { since: NOW - DAY, rows: hostile } })));
});
