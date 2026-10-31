/** dovreOn (src/ui/on.js.ts): how a pack's script hears changes without multiplying requests by the open tabs. */
import test from "node:test";
import assert from "node:assert/strict";
import { ON_JS, RAW_CHANGE } from "../src/ui/on.js.ts";

type Change = { topics?: string[]; notes?: { title: string }[] };

function page() {
  const on = new Map<string, ((e: { detail?: unknown }) => void)[]>();
  const doc = { hidden: false, addEventListener: (t: string, f: (e: { detail?: unknown }) => void) => on.set(t, [...(on.get(t) ?? []), f]) };
  const win: { dovreOn?: (topics: string[], fn: (c: Required<Change>) => unknown, o?: { notes?: boolean }) => void } = {};
  new Function("window", "document", ON_JS)(win, doc);
  return {
    doc,
    dovreOn: win.dovreOn!,
    change: (detail: Change) => on.get("dovre:change")?.forEach((f) => f({ detail })),
    shown: () => on.get("visibilitychange")?.forEach((f) => f({})),
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test("dovreOn: only its topics (a trailing ':' a prefix) or, asked, notes", async () => {
  const p = page();
  const heard: string[][] = [];
  p.dovreOn(["snapshot", "run:"], (c) => void heard.push(c.topics));
  p.change({ topics: [] });
  p.change({ topics: ["packs"] });
  p.change({ topics: ["bino:1"] });
  p.change({ notes: [{ title: "ci" }] });
  await settle();
  assert.deepEqual(heard, [], "a synced tick, a pack's refresh, another stream, a note it didn't ask for");
  p.change({ topics: ["run:s1"] });
  await settle();
  assert.deepEqual(heard, [["run:s1"]]);

  const notes: number[] = [];
  p.dovreOn(["x"], (c) => void notes.push(c.notes.length), { notes: true });
  p.change({ notes: [{ title: "a" }] });
  await settle();
  assert.deepEqual(notes, [1]);
});

test("dovreOn: one call out at a time, what comes meanwhile merged into one after it; a hidden tab waits until shown", async () => {
  const p = page();
  const calls: Required<Change>[] = [];
  let done: () => void = () => {};
  p.dovreOn(["snapshot", "avatar", "mac"], (c) => (calls.push(c), new Promise<void>((r) => (done = r))), { notes: true });
  p.change({ topics: ["snapshot"] });
  await settle();
  for (let i = 0; i < 30; i++) p.change({ topics: [i % 2 ? "mac" : "avatar"], notes: i === 3 ? [{ title: "n" }] : [] });
  await settle();
  assert.equal(calls.length, 1, "30 changes while the first is out: no more calls yet");
  done();
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.topics, ["avatar", "mac"]);
  assert.deepEqual(calls[1]!.notes, [{ title: "n" }]);
  done();
  await settle();
  assert.equal(calls.length, 2, "nothing more came");

  p.doc.hidden = true;
  p.change({ topics: ["snapshot"] });
  p.change({ topics: ["snapshot"] });
  await settle();
  assert.equal(calls.length, 2, "hidden: waits");
  p.doc.hidden = false;
  p.shown();
  await settle();
  assert.equal(calls.length, 3, "shown: one call for both");
  done();
  p.shown();
  await settle();
  assert.equal(calls.length, 3, "shown again with nothing new: nothing");
});

test("dovreOn: a call that throws doesn't stop the next", async () => {
  const p = page();
  let n = 0;
  p.dovreOn(["a"], () => {
    n++;
    throw new Error("boom");
  });
  p.change({ topics: ["a"] });
  await settle();
  p.change({ topics: ["a"] });
  await settle();
  assert.equal(n, 2);
});

test("RAW_CHANGE: a script listening to dovre:change itself, however quoted", () => {
  for (const s of [`document.addEventListener("dovre:change", f)`, `document.addEventListener( 'dovre:change',f)`, "addEventListener(`dovre:change`, f)"]) assert.match(s, RAW_CHANGE);
  for (const s of [`dovreOn(["snapshot"], f)`, `document.addEventListener("dovre:swap", f)`]) assert.doesNotMatch(s, RAW_CHANGE);
});
