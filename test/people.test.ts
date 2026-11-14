/**
 * A snapshot per person (#538): who gets their own, who stays on the instance's, and that a
 * person's gather only ever goes out with their own token, kept apart from everyone else's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import type { Gatherer, Snapshot } from "../src/gather.ts";
import { FIND_MS, MISS_MS, PEOPLE_MAX, perPerson, SAME_MS, STUCK_MS } from "../src/hosted/people.ts";
import { d1SnapshotStore, personKey } from "../src/hosted/snapshot.ts";
import { currentViewer, viewingAs } from "../src/viewer.ts";
import { personFinder } from "../src/worker.ts";
import { snapshot } from "./helpers.ts";

/** A gatherer that answers with one snapshot and counts what it's asked. */
function fakeGatherer(login: string) {
  const s = snapshot({ login });
  const asked = { get: 0, stale: 0 };
  let busy = false;
  const g: Gatherer = {
    get: async () => (asked.get++, s),
    stale: () => void asked.stale++,
    gathering: () => busy,
    peek: () => s,
    seed: () => {},
  };
  return { g, asked, busy: (b: boolean) => (busy = b) };
}

test("per person: no viewer, no token, or the instance's own login stay on the instance's snapshot; anyone else gets their own", async () => {
  const shared = fakeGatherer("op");
  const two = fakeGatherer("two");
  let t = 1_000_000;
  const finds: string[] = [];
  let drained = 0;
  async function find(email: string) {
    finds.push(email);
    if (email === "op@x.dev") return { login: "op", start: async () => assert.fail("the operator needs no second gatherer") };
    if (email === "two@x.dev") return { login: "two", start: async () => ({ gatherer: two.g, drain: async () => void drained++ }) };
    throw new Error("No GitHub token of your own");
  }
  // The viewer comes from the request, as in the app.
  const as = <T>(email: string | undefined, fn: () => T) => viewingAs(email, fn);
  const real = perPerson({ shared: shared.g, login: "Op", viewer: currentViewer, now: () => t, find });
  assert.equal((await real.gatherer.get()).login, "op", "no viewer (cron, lookups): the instance's");
  assert.equal(real.gatherer.peek()?.login, "op");
  assert.deepEqual(finds, [], "and nobody to ask about");

  // Before anyone has been asked about: nothing to peek at, so a page waits on get().
  assert.equal(as("two@x.dev", () => real.gatherer.peek()), undefined);
  assert.equal((await as("Two@X.dev ", () => real.gatherer.get())).login, "two");
  assert.equal(as("two@x.dev", () => real.gatherer.peek())?.login, "two");
  assert.equal((await as("op@x.dev", () => real.gatherer.get())).login, "op", "same login as the instance, whatever its case");
  assert.equal((await as("three@x.dev", () => real.gatherer.get())).login, "op", "no token of their own: the instance's, as before");
  assert.equal(as("three@x.dev", () => real.gatherer.peek())?.login, "op");
  assert.equal(real.size(), 1);

  // Each is asked about once, not on every page.
  await as("two@x.dev", () => real.gatherer.get());
  await as("three@x.dev", () => real.gatherer.get());
  await as("op@x.dev", () => real.gatherer.get());
  assert.deepEqual(finds, ["two@x.dev", "op@x.dev", "three@x.dev"]);

  // Someone without a token is asked about again a minute later (they may have signed in with GitHub since); the operator later.
  t += MISS_MS + 1;
  assert.equal(as("three@x.dev", () => real.gatherer.peek())?.login, "op", "still drawn from the instance's meanwhile");
  await as("three@x.dev", () => real.gatherer.get());
  await as("op@x.dev", () => real.gatherer.get());
  assert.deepEqual(finds.slice(3), ["three@x.dev"]);
  t += SAME_MS;
  await as("op@x.dev", () => real.gatherer.get());
  assert.deepEqual(finds.slice(4), ["op@x.dev"]);

  // An action's stale() reaches the snapshot the person sees.
  as("two@x.dev", () => real.gatherer.stale());
  as("three@x.dev", () => real.gatherer.stale());
  as(undefined, () => real.gatherer.stale());
  assert.deepEqual([two.asked.stale, shared.asked.stale], [1, 2]);

  // After a response the Worker waits for people's gathers and their kept snapshots.
  const before = two.asked.get;
  await real.settle();
  assert.equal(two.asked.get, before, "nothing under way: nothing asked");
  two.busy(true);
  await real.settle();
  assert.equal(two.asked.get, before + 1);
  assert.equal(drained, 2);
  assert.equal(as("two@x.dev", () => real.gatherer.gathering()), true);
  assert.equal(as("three@x.dev", () => real.gatherer.gathering()), false);
});

test("per person: a slow answer doesn't hold the page, a stuck one is asked again, and an isolate keeps a bounded number of people", async () => {
  const shared = fakeGatherer("op");
  let t = 1_000_000;
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  let asks = 0;
  const slow = perPerson({
    shared: shared.g,
    login: "op",
    viewer: currentViewer,
    now: () => t,
    findMs: 5,
    find: async () => {
      asks++;
      await gate;
      return { login: "two", start: async () => ({ gatherer: fakeGatherer("two").g, drain: async () => {} }) };
    },
  });
  assert.ok(FIND_MS <= 2_000, "a page never waits longer than this to learn whose snapshot to draw");
  assert.equal((await viewingAs("two@x.dev", () => slow.gatherer.get())).login, "op", "the instance's for now");
  await viewingAs("two@x.dev", () => slow.gatherer.get());
  assert.equal(asks, 1, "the question under way is joined, not asked again");
  t += STUCK_MS + 1;
  await viewingAs("two@x.dev", () => slow.gatherer.get());
  assert.equal(asks, 2, "one running this long was cancelled with its request");
  release();
  await new Promise((res) => setTimeout(res, 5));
  assert.equal((await viewingAs("two@x.dev", () => slow.gatherer.get())).login, "two", "the answer landed for the next page");

  const many = perPerson({ shared: shared.g, login: "op", viewer: currentViewer, find: async (email) => ({ login: email.split("@")[0]!, start: async () => ({ gatherer: fakeGatherer(email).g, drain: async () => {} }) }) });
  for (let i = 0; i < PEOPLE_MAX + 5; i++) await viewingAs(`p${i}@x.dev`, () => many.gatherer.get());
  assert.equal(many.size(), PEOPLE_MAX);
  assert.equal(viewingAs("p0@x.dev", () => many.gatherer.peek()), undefined, "the oldest went first");

  // A gatherer that can't start leaves the person on the instance's.
  const errors: string[] = [];
  const broken = perPerson({ shared: shared.g, login: "op", viewer: currentViewer, log: (l) => errors.push(l), find: async () => ({ login: "two", start: async () => Promise.reject(new Error("D1 is down")) }) });
  assert.equal((await viewingAs("two@x.dev", () => broken.gatherer.get())).login, "op");
  assert.match(errors[0]!, /D1 is down/);
});

test("a person's snapshot is kept in its own row; rows of people gone a week are dropped, the instance's never", async () => {
  const db = openDb().DB;
  let t = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(personKey(" Two@X.dev "), "snapshot:two@x.dev");
  const instance = d1SnapshotStore(db, "v1", { now: () => t });
  const two = d1SnapshotStore(db, "v1", { now: () => t, key: personKey("two@x.dev") });
  const gone = d1SnapshotStore(db, "v1", { now: () => t, key: personKey("gone@x.dev") });
  instance.save(snapshot({ at: t, login: "op" }));
  two.save(snapshot({ at: t, login: "two" }));
  gone.save(snapshot({ at: t, login: "gone" }));
  await Promise.all([instance.drain(), two.drain(), gone.drain()]);
  assert.equal((await d1SnapshotStore(db, "v1", { now: () => t }).load())?.login, "op");
  assert.equal((await d1SnapshotStore(db, "v1", { now: () => t, key: personKey("two@x.dev") }).load())?.login, "two");

  t += 8 * 86_400_000;
  two.save(snapshot({ at: t, login: "two" }));
  await two.drain();
  const keys = (await db.prepare("SELECT key FROM settings WHERE key LIKE 'snapshot%' ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
  assert.deepEqual(keys, ["snapshot", "snapshot:two@x.dev"]);
});

test("a person's own GitHub: only their token, their own kept reads, and a snapshot gathered as them", async () => {
  const { DB } = openDb();
  const tokens: Record<string, string> = { "two@x.dev": "ghu_two", "four@x.dev": "ghu_four" };
  const logins: Record<string, string> = { ghu_two: "two", ghu_four: "four" };
  const asked: Array<{ email?: string; own?: boolean }> = [];
  const provider = async (_b: unknown, actor?: { email: string; own?: true }) => {
    asked.push({ email: actor?.email, own: actor?.own });
    const t = actor?.email ? tokens[actor.email] : undefined;
    if (!t) throw new Error("No GitHub token of your own: sign in with GitHub.");
    return t;
  };
  const pr = (login: string) => ({
    number: 7, title: `${login}'s change`, url: `https://github.com/acme/app/pull/${login.length}`, isDraft: false, updatedAt: "2026-11-14T10:00:00Z", headRefName: "b", author: { login },
    repository: { nameWithOwner: "acme/app" }, reviewDecision: null, commits: { nodes: [] }, reviewThreads: { nodes: [] },
  });
  const calls: Array<{ url: string; token: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).authorization).replace("Bearer ", "");
    const u = String(url);
    calls.push({ url: u, token });
    const login = logins[token]!;
    if (u.endsWith("/user")) return new Response(JSON.stringify({ login }), { headers: { etag: '"u"' } });
    if (u.includes("/notifications")) return new Response(JSON.stringify([]), { headers: { etag: `"n-${login}"` } });
    if (u.endsWith("/graphql")) return new Response(JSON.stringify({ data: { mine: { nodes: [pr(login)] }, review: { nodes: [] } } }));
    return new Response("[]");
  }) as typeof fetch;
  try {
    const told: boolean[] = [];
    const find = personFinder({ DB, GITHUB_USER: "op", REPO_OWNERS: "acme" } as never, provider as never, { version: "v1", instanceLogin: "op", linked: () => [], told: (_at, changed) => void told.push(changed) });
    await assert.rejects(find("three@x.dev"), /token of your own/, "nobody else's token stands in");
    assert.ok(asked.every((a) => a.own === true), "every question names the person and asks for their own");

    const two = await find(" Two@X.dev ");
    assert.equal(two.login, "two");
    const mine = await two.start();
    const s = await mine.gatherer.get();
    assert.equal(s.login, "two");
    assert.equal(s.org, "acme", "over the instance's owners");
    assert.deepEqual(s.prs.ok && s.prs.value.mine.map((p) => p.title), ["two's change"]);
    await mine.drain();

    const four = await (await find("four@x.dev")).start();
    assert.deepEqual(((await four.gatherer.get()) as Snapshot).prs.ok && (four.gatherer.peek()!.prs as { value: { mine: { title: string }[] } }).value.mine.map((p) => p.title), ["four's change"]);
    await four.drain();
    assert.ok(calls.every((c) => c.token === "ghu_two" || c.token === "ghu_four"));
    assert.ok(told.length >= 2, "open pages hear of a person's gather");

    // Kept apart in D1: each person's snapshot in their own row, each one's reads under their own keys.
    assert.equal((await d1SnapshotStore(DB, "v1", { key: personKey("two@x.dev") }).load())?.login, "two");
    assert.equal((await d1SnapshotStore(DB, "v1", { key: personKey("four@x.dev") }).load())?.login, "four");
    assert.equal(await d1SnapshotStore(DB, "v1").load(), undefined, "the instance's row is untouched");
    const reads = (await DB.prepare("SELECT key FROM forge_reads ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
    assert.ok(reads.length > 0 && reads.every((k) => k.startsWith("as:two@x.dev:") || k.startsWith("as:four@x.dev:")), reads.join("\n"));

    // A fresh isolate draws the kept one at once, and one kept under another login isn't shown.
    const again = await (await find("two@x.dev")).start();
    assert.equal(again.gatherer.peek()?.login, "two");
    logins.ghu_two = "renamed";
    await DB.prepare("DELETE FROM forge_reads").run();
    const other = await find("two@x.dev");
    assert.equal(other.login, "renamed");
    assert.equal((await other.start()).gatherer.peek(), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
