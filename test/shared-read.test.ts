import test from "node:test";
import assert from "node:assert/strict";
import type { D1 } from "../src/db.ts";
import { layoutStore } from "../src/layout.ts";
import { onboardingStore } from "../src/onboarding.ts";
import { sharedRead } from "../src/shared-read.ts";

/** A D1 whose reads answer from `rows` in turn: `"stuck"` never settles (its request was cancelled). */
function fakeDb(rows: ("stuck" | string | null)[]) {
  const writes: string[] = [];
  const db = {
    prepare: (sql: string) => {
      const q = {
        bind: (...args: unknown[]) => ((q as { args?: unknown[] }).args = args, q),
        first: () => {
          const next = rows.shift() ?? null;
          return next === "stuck" ? new Promise(() => {}) : Promise.resolve(next === null ? null : { value: next });
        },
        run: async () => (writes.push(`${sql.split(" ")[0]} ${JSON.stringify((q as { args?: unknown[] }).args ?? [])}`), { success: true }),
      };
      return q;
    },
  } as unknown as D1;
  return { db, writes };
}

test("sharedRead: callers share a read, wait on their own timer, and a stale one is started again", async () => {
  let t = 0;
  let runs = 0;
  const r = sharedRead(() => (runs++ === 0 ? new Promise(() => {}) : Promise.resolve()), { ms: 20, now: () => t });
  await r.read();
  assert.equal(r.done, false, "the stuck read didn't finish; the caller stopped waiting");
  await r.read();
  assert.equal(runs, 1, "a recent one in flight is shared");
  t = 20;
  await r.read();
  assert.equal(runs, 2, "an old one is dropped and started again");
  assert.equal(r.done, true);
});

test("layout: a save goes through while the read before it never settles, and that read can't undo it", async () => {
  const { db, writes } = fakeDb(["stuck", JSON.stringify({ theme: "light" })]);
  let t = 0;
  const layout = layoutStore(db, { now: () => t, readMs: 20, ttlMs: 30_000 });
  await layout.save({ packsOff: ["agents"] });
  assert.equal(writes.length, 1, "written, not held by the stuck read");
  assert.deepEqual(layout.get().packsOff, ["agents"]);
  t = 40_000;
  layout.get();
  await layout.ready;
  assert.equal(layout.get().theme, "light", "past the ttl, read again");
});

test("onboarding: a stuck first read leaves it not loaded (Today doesn't send me up the climb); the next wait reads it", async () => {
  const { db } = fakeDb(["stuck", JSON.stringify({ answers: {}, done: true })]);
  const o = onboardingStore(db, { readMs: 20 });
  await o.ready;
  assert.equal(o.loaded?.(), false);
  await new Promise((r) => setTimeout(r, 25));
  await o.ready;
  assert.equal(o.loaded?.(), true);
  assert.equal(o.get().done, true);
});
