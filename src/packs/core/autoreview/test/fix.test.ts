/** Auto review's fix sessions (#326 step 4): the prompt, the replies, and one fix pass with a fake forge and agents share. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../../../db.ts";
import type { AutoFixAsk, AutoFixLanded, AutoRunResult, AutoShare } from "../../../types.ts";
import { fixPass, type FixDeps } from "../fix.ts";
import { fixPrompt, repliesOf, taggedOf } from "../fixer.ts";
import { prsStore } from "../store.ts";

const PR = "https://github.com/acme/web/pull/7";
const HEAD = "a".repeat(40);
const NEW = "b".repeat(40);

test("taggedOf: the reviewer's tag in front of a comment, and the text after it", () => {
  assert.deepEqual(taggedOf("**Blocker:** Wrong."), { tag: "blocker", text: "Wrong." });
  assert.deepEqual(taggedOf("**Should fix:** Check it."), { tag: "should-fix", text: "Check it." });
  assert.deepEqual(taggedOf("nit: Name."), { tag: "nit", text: "Name." });
  assert.deepEqual(taggedOf("Plain."), { tag: "nit", text: "Plain." });
});

test("repliesOf: the last block's lines, one per known comment; others, and @mentions, go nowhere", () => {
  const said = "Done.\n```auto-replies\n1: old\n```\nThen:\n```auto-replies\n1: Fixed in abc1234: checks it.\n2: Left as is, @boss said so.\n1: again\n77: not ours\nnoise\n```";
  assert.deepEqual(repliesOf(said, [1, 2]), [
    { commentId: 1, body: "Fixed in abc1234: checks it." },
    { commentId: 2, body: "Left as is, @​boss said so." },
  ]);
  assert.deepEqual(repliesOf("No block.", [1]), []);
  assert.equal(repliesOf("```auto-replies\n1: " + "x".repeat(5000) + "\n```", [1])[0]!.body.length, 1000);
});

test("fixPrompt: the issue, each comment by id and tag, failing checks, and how to answer", () => {
  const p = fixPrompt({ repo: "acme/web", number: 7, issue: { ref: "acme/web#3", title: "Fix login", body: "It breaks." }, comments: [{ id: 11, path: "src/a.ts", line: 2, tag: "blocker", text: "Wrong." }], failing: ["test"], round: 2 });
  assert.match(p, /^You are fixing pull request acme\/web#7 on your own: round 2/);
  assert.match(p, /## Comment 11 \(blocker\) on src\/a\.ts line 2\n\nWrong\./);
  assert.match(p, /Failing on the head commit: test\./);
  assert.match(p, /```auto-replies/);
  assert.match(p, /# The issue: Fix login\n\nIt breaks\./);
});

// ── One pass ──

function setup(o: { ref?: string; head?: string; state?: string } = {}) {
  const { DB } = openDb();
  const gh = { head: o.head ?? HEAD, calls: [] as string[], replies: [] as { path: string; body: unknown }[] };
  const ghe = {
    rest: async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      gh.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "POST" && path.endsWith("/replies")) {
        gh.replies.push({ path, body: init.body });
        return {} as T;
      }
      if (path === "/repos/acme/web/pulls/7") return { state: o.state ?? "open", merged: false, html_url: PR, head: { sha: gh.head, ref: o.ref ?? "sandbox/abcd1234" } } as T;
      if (path.startsWith("/repos/acme/web/pulls/7/reviews/99/comments")) return [{ id: 11, path: "src/a.ts", line: 2, body: "**Should fix:** Check the token." }, { id: 12, path: "src/a.ts", line: 3, body: "nit: Name." }] as T;
      if (path.startsWith("/repos/acme/web/pulls/7/comments")) return [{ id: 11, in_reply_to_id: null }, { id: 12, in_reply_to_id: null }] as T;
      if (path === "/repos/acme/web/issues/3") return { title: "Fix login", body: "It breaks." } as T;
      if (path.includes("/check-runs")) return { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] } as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const asked: AutoFixAsk[] = [];
  const landed: { run: string; to: unknown }[] = [];
  const share = {
    run: undefined as AutoRunResult | undefined,
    start: { run: "fix-1" } as { run: string } | { wait: string } | { error: string },
    land: { wait: "" } as AutoFixLanded,
  };
  const auto: AutoShare = {
    prs: async () => [],
    run: async () => share.run,
    limits: async () => ({ on: true, runUsd: 5, dayUsd: 20, minutes: 60 }),
    fix: async (a) => (asked.push(a), share.start),
    land: async (run, to) => (landed.push({ run, to }), share.land),
  };
  let clicks = new Map<string, "once" | "twice">();
  const deps: FixDeps = { db: DB, ghe, owners: "acme", auto, clicks: async () => clicks, log: () => {} };
  const store = prsStore(DB);
  /** A PR reviewed at HEAD (review 99, level 3), in fix round 1, written by Opus for $1. */
  const fixing = async () => {
    await store.add({ pr: PR, issue: "acme/web#3", run: "r1" });
    await store.author(PR, "opus");
    await store.level(PR, "reviewing", { head: HEAD, level: 3, cost: 1, review: 99 });
    await store.move(PR, "reviewing", "fixing", { round: 1 });
  };
  return { DB, gh, deps, store, share, asked, landed, fixing, setClicks: (c: Map<string, "once" | "twice">) => (clicks = c) };
}

const row = async (s: ReturnType<typeof setup>) => (await s.store.all())[0]!;

test("a fix pass starts a session from the reviewed head, with the review's comments and failing CI, the author's model and what's left of the budget", async () => {
  const s = setup();
  await s.fixing();
  assert.equal(await fixPass(s.deps), true);
  assert.equal(s.asked.length, 1);
  const a = s.asked[0]!;
  assert.deepEqual([a.key, a.pr, a.repo, a.head, a.model, a.budget], ["acme/web#3", PR, "acme/web", HEAD, "opus", 5]);
  assert.match(a.prompt, /## Comment 11 \(should fix\) on src\/a\.ts line 2\n\nCheck the token\./);
  assert.match(a.prompt, /## Comment 12 \(nit\)/);
  assert.match(a.prompt, /Failing on the head commit: test\./);
  const r = await row(s);
  assert.deepEqual([r.state, r.fix], ["fixing", "fix-1"]);
  assert.match(r.why!, /a fix session is working on it/);
  // Running: nothing new starts, nothing lands.
  s.share.run = { id: "fix-1", status: "running", cost: 0.5, model: "opus" };
  await fixPass(s.deps);
  assert.equal(s.asked.length, 1);
  assert.equal(s.landed.length, 0);
});

test("a fix pass: its commits pushed onto the PR's branch, a reply on each thread it answered, and back to review with its cost", async () => {
  const s = setup();
  await s.fixing();
  await fixPass(s.deps);
  s.share.run = { id: "fix-1", status: "done", cost: 2, model: "opus" };
  s.share.land = { head: NEW, commits: 1, cost: 2, said: "Done.\n```auto-replies\n11: Fixed in bbbbbbb: checks it.\n55: not ours\n```" };
  s.gh.head = NEW;
  assert.equal(await fixPass(s.deps), true);
  assert.deepEqual(s.landed[0], { run: "fix-1", to: { repo: "acme/web", branch: "sandbox/abcd1234", base: HEAD, pr: { number: 7, url: PR }, kind: "autoreview.fix" } });
  assert.deepEqual(s.gh.replies, [{ path: "/repos/acme/web/pulls/7/comments/11/replies", body: { body: "Fixed in bbbbbbb: checks it." } }]);
  const r = await row(s);
  assert.deepEqual([r.state, r.fix, r.cost, r.round, r.head], ["reviewing", null, 3, 1, HEAD]);
  assert.match(r.why!, /^Round 1: pushed bbbbbbb, replied on 1 thread; reviewing it\.$/);
  const log = await s.DB.prepare("SELECT kind FROM actions").all<{ kind: string }>();
  assert.deepEqual(log.results.map((x) => x.kind), ["autoreview.reply"]);
});

test("a fix pass hands the PR to me when its session committed nothing, couldn't push, or couldn't start", async () => {
  const s = setup();
  await s.fixing();
  await fixPass(s.deps);
  s.share.run = { id: "fix-1", status: "done", cost: 1, model: "opus" };
  s.share.land = { none: "It committed nothing.", said: "The comment is wrong: the token is checked upstream.", cost: 1 };
  await fixPass(s.deps);
  let r = await row(s);
  assert.deepEqual([r.state, r.cost], ["yours", 2]);
  assert.match(r.why!, /^Round 1: It committed nothing\. Its last word: The comment is wrong/);

  const t = setup();
  await t.fixing();
  await fixPass(t.deps);
  t.share.run = { id: "fix-1", status: "done", cost: 1, model: "opus" };
  t.share.land = { error: "Its commits change CI config, so they aren't pushed on their own.", cost: 1 };
  await fixPass(t.deps);
  r = await row(t);
  assert.equal(r.state, "yours");
  assert.match(r.why!, /weren't pushed: Its commits change CI config/);

  const u = setup();
  await u.fixing();
  u.share.start = { error: "There's no checkout named web in the code folder." };
  await fixPass(u.deps);
  assert.equal((await row(u)).state, "yours");
});

test("a fix pass waits within the limits, and starts nothing it shouldn't: asked twice, a branch not an auto run's, new commits, a closed PR", async () => {
  const s = setup();
  await s.fixing();
  s.share.start = { wait: "Quiet hours: the fix session starts after them." };
  assert.equal(await fixPass(s.deps), true);
  assert.equal(await fixPass(s.deps), false, "said once");
  let r = await row(s);
  assert.deepEqual([r.state, r.fix, r.claim], ["fixing", null, null]);
  assert.match(r.why!, /Quiet hours/);

  const t = setup();
  await t.fixing();
  t.setClicks(new Map([["autoreview.fix", "twice"]]));
  await fixPass(t.deps);
  assert.equal(t.asked.length, 0);
  assert.match((await row(t)).why!, /asks twice/);

  const u = setup({ ref: "feature/mine" });
  await u.fixing();
  await fixPass(u.deps);
  assert.equal(u.asked.length, 0);
  assert.equal((await row(u)).state, "yours");

  const v = setup({ head: NEW });
  await v.fixing();
  await fixPass(v.deps);
  assert.equal(v.asked.length, 0);
  assert.equal((await row(v)).state, "reviewing", "the new head gets reviewed");

  const w = setup({ state: "closed" });
  await w.fixing();
  await fixPass(w.deps);
  assert.equal((await row(w)).state, "closed");
});

test("a fix pass: a PR's budget nearly spent hands it to me before a session starts", async () => {
  const s = setup();
  await s.fixing();
  await s.store.release(PR, { cost: 13.8 });
  await fixPass(s.deps);
  assert.equal(s.asked.length, 0);
  assert.match((await row(s)).why!, /nearly the cap for one PR/);
});
