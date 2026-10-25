/** The agents pack's own read of this machine: sessions and worktrees, read again on its schedule, telling pages only when something changed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { session } from "../../../../../test/helpers.ts";
import { createHere, fixedHere, type Sessions } from "../here.ts";

const tick = (ms = 5) => new Promise((res) => setTimeout(res, ms));

test("a read keeps what it found, and says whether pages need redrawing", async () => {
  let live = [session({ status: "busy" })];
  let reads = 0;
  const here = createHere({ sessions: async () => (reads++, { live, recent: [] }), worktrees: () => [] });
  assert.deepEqual(here.sessions(), { live: [], recent: [] }, "nothing before the first read");
  assert.equal(await here.read(), true);
  assert.equal(here.sessions().live[0]!.status, "busy");
  assert.equal(await here.read(), false, "the same again: nothing to redraw");
  live = [session({ status: "idle" })];
  assert.equal(await here.read(), true);
  assert.equal(reads, 3);
});

test("ready() waits for the first read; reads asked for meanwhile join it, and one more follows", async () => {
  let open = () => {};
  let reads = 0;
  const here = createHere({ sessions: () => (reads++, new Promise<Sessions>((res) => (open = () => res({ live: [session()], recent: [] })))), worktrees: () => [] });
  const first = here.ready();
  void here.read();
  void here.read();
  assert.equal(reads, 1, "one read at a time");
  open();
  assert.equal((await first).live.length, 1);
  await tick();
  assert.equal(reads, 2, "the reads asked for while it ran come as one more");
  open();
});

test("a read that fails keeps the last sessions; start() tells pages only on a change, and stops", async () => {
  let fail = false;
  let n = 0;
  const logged: string[] = [];
  const here = createHere({
    sessions: async () => {
      if (fail) throw new Error("no claude");
      return { live: [session({ sessionId: `s-${n}` })], recent: [] };
    },
    worktrees: () => [],
    everyMs: 10,
    log: (l) => logged.push(l),
  });
  let changed = 0;
  const stop = here.start(() => changed++);
  await tick(30);
  assert.equal(changed, 1, "the first read changed what's shown; the same again didn't");
  fail = true;
  await tick(30);
  assert.equal(here.sessions().live[0]!.sessionId, "s-0", "a failed read keeps the last");
  assert.match(logged[0]!, /couldn't read the sessions \(no claude\)/);
  fail = false;
  n = 1;
  await tick(30);
  assert.equal(changed, 2);
  stop();
  n = 2;
  await tick(30);
  assert.equal(changed, 2, "stopped: no more reads");
});

test("fixedHere: what a machine that reads nothing has, or a test's", async () => {
  const none = fixedHere();
  assert.deepEqual(await none.ready(), { live: [], recent: [] });
  assert.equal(await none.read(), false);
  assert.deepEqual(none.worktrees(), []);
});
