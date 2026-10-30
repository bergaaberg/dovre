/** Auto review's reviewer (#326 step 3): reading its answer, the caps, its model, CI, and one pass end to end. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../../../db.ts";
import type { PrFile } from "../../../../sources/prview.ts";
import type { AutoShare } from "../../../types.ts";
import { capLevel, ciOf, reviewDraft, reviewerModel, reviewPrompt, riskOf, verdictOf } from "../reviewer.ts";
import { CI_WAIT_MS, MAX_ROUNDS, reviewPass, type ReviewDeps } from "../round.ts";
import { prsStore } from "../store.ts";

const PR = "https://github.com/acme/web/pull/7";
const file = (o: Partial<PrFile> = {}): PrFile => ({ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, sha: "f", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c", ...o });
const block = (...lines: unknown[]) => "Here it is.\n```auto-review\n" + lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n```";
const LEVEL = { kind: "level", level: 4, reasons: ["Does what the issue asks.", "One nit."], summary: "Good." };

test("verdictOf: tagged comments on lines of the diff, and the level; anything else left out", () => {
  const v = verdictOf(
    block(
      { kind: "comment", tag: "blocker", path: "src/a.ts", line: 2, side: "RIGHT", text: "Wrong." },
      { kind: "comment", tag: "urgent", path: "src/a.ts", line: 2, text: "Unknown tag." },
      { kind: "comment", tag: "nit", path: "src/a.ts", line: 99, text: "Not in the diff." },
      { kind: "comment", tag: "nit", path: "../etc/passwd", line: 2, text: "Bad path." },
      "not json",
      LEVEL,
    ),
    [file()],
  );
  assert.deepEqual(v, { comments: [{ tag: "blocker", path: "src/a.ts", line: 2, side: "RIGHT", body: "Wrong." }], level: 4, reasons: LEVEL.reasons, summary: "Good." });
  assert.equal(verdictOf("no block", [file()]), null);
  assert.equal(verdictOf(block({ kind: "comment", tag: "nit", path: "src/a.ts", line: 2, text: "x" }), [file()]), null, "no level, no review");
  assert.equal(verdictOf(block({ kind: "level", level: 7 }), [file()]), null, "out of range");
});

test("capLevel: CI red or pending and an open blocker cap at 2; risky paths and a big diff at 3; nothing caps a clean, green PR", () => {
  const f = [file()];
  assert.deepEqual(capLevel(5, { ci: "green", files: f, blockers: 0 }), { level: 5, was: 5, why: [] });
  assert.equal(capLevel(5, { ci: "red", files: f, blockers: 0 }).level, 2);
  assert.equal(capLevel(5, { ci: "pending", files: f, blockers: 0 }).level, 2);
  assert.equal(capLevel(4, { ci: "green", files: f, blockers: 1 }).level, 2);
  for (const path of [".github/workflows/ci.yml", "package.json", "pnpm-lock.yaml", "migrations/0031_x.sql", ".dovre/sandbox.json", "wrangler.jsonc", "infra/main.tf", ".env.production", "Cargo.lock"])
    assert.equal(capLevel(5, { ci: "green", files: [file({ path })], blockers: 0 }).level, 3, path);
  assert.equal(riskOf("src/app.ts"), undefined);
  const big = capLevel(5, { ci: "green", files: [file({ additions: 700, deletions: 200 })], blockers: 0 });
  assert.equal(big.level, 3);
  assert.match(big.why[0]!, /900 changed lines/);
  assert.deepEqual(capLevel(1, { ci: "red", files: f, blockers: 3 }), { level: 1, was: 1, why: [] }, "a cap above the level isn't a reason");
});

test("the review as posted: level and reasons on top, the cap said, each comment led by its tag", () => {
  const v = verdictOf(block({ kind: "comment", tag: "should-fix", path: "src/a.ts", line: 2, text: "Handle the error." }, { ...LEVEL, level: 5 }), [file()])!;
  const d = reviewDraft(v, capLevel(5, { ci: "pending", files: [file()], blockers: 0 }), { model: "claude-sonnet-5-5", head: "abcdef1234" });
  assert.match(d.summary, /^\*\*Auto review: level 2 of 5\*\* \(Real problems\), on abcdef1\./);
  assert.match(d.summary, /The reviewer said 5; capped at 2 because CI hasn't finished/);
  assert.match(d.summary, /Reviewed by claude-sonnet-5-5, which didn't write this PR\. 1 should-fix/);
  assert.deepEqual(d.comments, [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Should fix:** Handle the error." }]);
});

test("the prompt: the issue and the diff, never more than that", () => {
  const p = reviewPrompt({ repo: "acme/web", number: 3, title: "Fix login", body: "It breaks." }, { repo: "acme/web", number: 7, title: "Fix", body: "" }, [file()]);
  assert.match(p, /# Issue acme\/web#3: Fix login\n\nIt breaks\./);
  assert.match(p, /--- src\/a.ts \(modified\)\n@@ -1,2 \+1,3 @@\n {4}1 {3}a\n {4}2 \+ b/);
});

test("reviewerModel: never the author's family; the set one, else the route's, else another", () => {
  assert.equal(reviewerModel("opus", { route: "claude-opus-5-5" }), "claude-sonnet-5-5");
  assert.equal(reviewerModel("", { route: "claude-opus-5-5" }), "claude-sonnet-5-5", "no model named: Claude Code's default, Opus");
  assert.equal(reviewerModel("opus", { set: "haiku", route: "claude-opus-5-5" }), "haiku");
  assert.equal(reviewerModel("sonnet", { set: "sonnet", route: "claude-sonnet-5-5" }), "claude-opus-5-5");
  assert.equal(reviewerModel("sonnet", { route: "anthropic/claude-opus-5-5" }), "anthropic/claude-opus-5-5");
});

test("ciOf: red if any failed, pending if any runs, green when all passed, none without any", async () => {
  const ghe = (runs: unknown[], statuses: unknown[]) => ({ rest: async <T>(p: string) => (p.includes("check-runs") ? { check_runs: runs } : { state: "pending", statuses }) as T });
  assert.equal(await ciOf(ghe([], []), "a/b", "s"), "none");
  assert.equal(await ciOf(ghe([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }], [{ state: "success" }]), "a/b", "s"), "green");
  assert.equal(await ciOf(ghe([{ status: "in_progress" }], [{ state: "success" }]), "a/b", "s"), "pending");
  assert.equal(await ciOf(ghe([{ status: "in_progress" }], [{ state: "failure" }]), "a/b", "s"), "red");
  assert.equal(await ciOf(ghe([{ status: "completed", conclusion: "timed_out" }], []), "a/b", "s"), "red");
});

// ── One pass, with a fake forge and model ──

function setup(o: { head?: string; merged?: boolean; model?: string; reply?: string; runModel?: string | null; owners?: string; ci?: string } = {}) {
  const { DB } = openDb();
  const gh = { head: o.head ?? "sha1", calls: [] as string[], posted: [] as any[] };
  const ghe = {
    rest: async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      gh.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "POST" && path.endsWith("/reviews")) {
        gh.posted.push(init.body);
        return { html_url: "https://github.com/acme/web/pull/7#r1", id: 99 } as T;
      }
      if (path === "/repos/acme/web/pulls/7") return { state: o.merged ? "closed" : "open", merged: !!o.merged, title: "Fix", body: "", head: { sha: gh.head }, user: { login: "me" } } as T;
      if (path.startsWith("/repos/acme/web/pulls/7/files")) return [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c", sha: "f" }] as T;
      if (path === "/repos/acme/web/issues/3") return { title: "Fix login", body: "It breaks." } as T;
      if (path.includes("/check-runs")) return { check_runs: [o.ci === "pending" ? { status: "in_progress", conclusion: null } : { status: "completed", conclusion: o.ci ?? "success" }] } as T;
      if (path.endsWith("/status")) return { statuses: [] } as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const asked: { model?: string; user: string }[] = [];
  let reply = o.reply;
  const auto: AutoShare = {
    prs: async () => [],
    run: async (id) => (o.runModel === null ? undefined : { id, status: "done", cost: 1, model: o.runModel ?? "opus" }),
    limits: async () => ({ on: true, runUsd: 5, dayUsd: 20, minutes: 60 }),
    fix: async () => ({ wait: "" }),
    land: async () => ({ wait: "" }),
  };
  let clicks = new Map<string, "once" | "twice">();
  const deps: ReviewDeps = {
    db: DB,
    ghe,
    owners: o.owners ?? "acme",
    login: "me",
    auto,
    ask: {
      model: o.model ?? "claude-opus-5-5",
      ask: async (p) => {
        asked.push({ model: p.model, user: p.user });
        return { text: reply ?? block({ kind: "comment", tag: "nit", path: "src/a.ts", line: 2, side: "RIGHT", text: "Name it better." }, { ...LEVEL, level: 5 }), cost: 0.02 };
      },
    },
    clicks: async () => clicks,
    log: () => {},
  };
  const store = prsStore(DB);
  return { DB, gh, asked, deps, store, setReply: (r: string) => (reply = r), setClicks: (c: Map<string, "once" | "twice">) => (clicks = c), add: () => store.add({ pr: PR, issue: "acme/web#3", run: "r1" }) };
}

test("a pass: one Comment review of the head commit by another model than the author's, its level kept; the same head isn't reviewed twice, a new one is", async () => {
  const s = setup();
  await s.add();
  assert.equal(await reviewPass(s.deps), true);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0]!.model, "claude-sonnet-5-5", "the author was Opus");
  assert.match(s.asked[0]!.user, /Fix login/);
  assert.equal(s.gh.posted.length, 1);
  assert.equal(s.gh.posted[0].event, "COMMENT");
  assert.equal(s.gh.posted[0].commit_id, "sha1");
  assert.equal(s.gh.posted[0].comments[0].body, "nit: Name it better.");
  let [r] = await s.store.all();
  // Level 5 is mine to merge, for now.
  assert.deepEqual([r!.level, r!.head, r!.author, r!.claim, r!.state, r!.cost], [5, "sha1", "opus", null, "yours", 0.02]);
  assert.match(r!.why!, /^Level 5 from claude-sonnet-5-5: 1 nit\. Mergeable as is/);
  const log = await s.DB.prepare("SELECT kind, target, ok FROM actions").all<{ kind: string }>();
  assert.deepEqual(log.results.map((x) => x.kind), ["autoreview.review"]);

  await s.store.move(PR, "yours", "reviewing");
  assert.equal(await reviewPass(s.deps), false, "the same head");
  assert.equal(s.asked.length, 1);
  s.gh.head = "sha2";
  await reviewPass(s.deps);
  assert.equal(s.asked.length, 2);
  [r] = await s.store.all();
  assert.deepEqual(r!.levels.map((l) => [l.head, l.level]), [["sha1", 5], ["sha2", 5]]);
});

test("a pass: CI red caps the level it posts and keeps", async () => {
  const s = setup({ ci: "failure" });
  await s.add();
  await reviewPass(s.deps);
  const [r] = await s.store.all();
  assert.equal(r!.level, 2);
  assert.match(s.gh.posted[0].body, /capped at 2 because CI fails/);
});

test("a pass waits, without a model call, while the author's model is unknown, while reviews ask twice, or with no model; and asks no URL outside my owners", async () => {
  const s = setup({ runModel: null });
  await s.add();
  await reviewPass(s.deps);
  assert.equal(s.asked.length, 0);
  assert.match((await s.store.all())[0]!.why!, /which model wrote it/);

  const t = setup();
  await t.add();
  t.setClicks(new Map([["autoreview.review", "twice"]]));
  await reviewPass(t.deps);
  assert.equal(t.asked.length, 0);
  assert.match((await t.store.all())[0]!.why!, /asks twice/);

  const u = setup();
  await u.add();
  await reviewPass({ ...u.deps, ask: undefined });
  assert.equal(u.gh.posted.length, 0);
  assert.match((await u.store.all())[0]!.why!, /No model can answer/);

  const w = setup({ owners: "other" });
  await w.add();
  await reviewPass(w.deps);
  assert.deepEqual(w.gh.calls, []);
  assert.equal((await w.store.all())[0]!.state, "yours");
});

test("a pass: a merged PR leaves the loop; an answer it can't read hands the PR to me rather than paying again", async () => {
  const s = setup({ merged: true });
  await s.add();
  await reviewPass(s.deps);
  assert.equal((await s.store.all())[0]!.state, "merged");
  assert.equal(s.asked.length, 0);

  const t = setup({ reply: "I think it's fine." });
  await t.add();
  await reviewPass(t.deps);
  const [r] = await t.store.all();
  assert.deepEqual([r!.state, r!.cost, r!.level], ["yours", 0.02, null]);
  assert.equal(t.gh.posted.length, 0);
  await reviewPass(t.deps);
  assert.equal(t.asked.length, 1);
});

test("a pass: a PR another pass is reviewing is left to it", async () => {
  const s = setup();
  await s.add();
  assert.equal(await s.store.claim(PR, "reviewing", 60_000), true);
  await reviewPass(s.deps);
  assert.equal(s.asked.length, 0);
});

// ── The decide step (#326 step 4) ──

const SHOULD = { kind: "comment", tag: "should-fix", path: "src/a.ts", line: 2, side: "RIGHT", text: "Check the token first." };
const at = (level: number, ...comments: unknown[]) => block(...comments, { ...LEVEL, level });

test("decide: a should-fix below 5 starts fix round 1 with the review's id kept; nothing but nits hands it to me", async () => {
  const s = setup({ reply: at(3, SHOULD) });
  await s.add();
  await reviewPass(s.deps);
  let [r] = await s.store.all();
  assert.deepEqual([r!.state, r!.round, r!.review, r!.level], ["fixing", 1, 99, 3]);
  assert.match(r!.why!, /Round 1: a fix session for 1 comment\.$/);

  const t = setup({ reply: at(4, { ...SHOULD, tag: "nit" }) });
  await t.add();
  await reviewPass(t.deps);
  [r] = await t.store.all();
  assert.equal(r!.state, "yours");
  assert.match(r!.why!, /Nothing for a fix session to do/);
});

test("decide: CI red is something to fix even without comments", async () => {
  const s = setup({ ci: "failure", reply: at(4) });
  await s.add();
  await reviewPass(s.deps);
  const [r] = await s.store.all();
  assert.deepEqual([r!.state, r!.level], ["fixing", 2]);
  assert.match(r!.why!, /a fix session for CI failing\.$/);
});

test("decide: the limits hand it to me: the last fix round, a level not up in two rounds, the PR's cost cap", async () => {
  // Round after round at level 3: after two fix rounds, the third review sees no progress.
  const s = setup({ reply: at(3, SHOULD) });
  await s.add();
  for (const head of ["sha1", "sha2", "sha3"]) {
    s.gh.head = head;
    await reviewPass(s.deps);
    const [r] = await s.store.all();
    if (r!.state === "fixing") await s.store.move(PR, "fixing", "reviewing");
  }
  let [r] = await s.store.all();
  assert.equal(r!.state, "yours");
  assert.match(r!.why!, /hasn't gone up in two rounds/);

  // Rising each round, but the rounds run out.
  const t = setup({ reply: at(1, SHOULD) });
  await t.add();
  for (let i = 0; i <= MAX_ROUNDS; i++) {
    t.setReply(at(Math.min(4, i + 1), SHOULD));
    t.gh.head = `sha${i}`;
    await reviewPass(t.deps);
    const [x] = await t.store.all();
    if (x!.state === "fixing") await t.store.move(PR, "fixing", "reviewing");
  }
  [r] = await t.store.all();
  assert.equal(r!.state, "yours");
  assert.match(r!.why!, new RegExp(`${MAX_ROUNDS} fix rounds done`));

  const u = setup({ reply: at(3, SHOULD) });
  await u.add();
  await u.store.release(PR, { cost: 15 });
  await reviewPass(u.deps);
  [r] = await u.store.all();
  assert.equal(r!.state, "yours");
  assert.match(r!.why!, /the cap for one PR \(\$15\.00\)/);
});

test("a review waits for CI still running, without a model call, then reviews anyway once it has waited long enough", async () => {
  let t = 1_000_000;
  const s = setup({ ci: "pending", reply: at(4) });
  await s.add();
  const deps = { ...s.deps, now: () => t };
  await reviewPass(deps);
  assert.equal(s.asked.length, 0);
  assert.match((await s.store.all())[0]!.why!, /Waiting for CI on sha1/);
  t += CI_WAIT_MS / 2;
  await reviewPass(deps);
  assert.equal(s.asked.length, 0);
  t += CI_WAIT_MS;
  await reviewPass(deps);
  assert.equal(s.asked.length, 1);
  assert.equal((await s.store.all())[0]!.level, 2, "capped: CI is still pending");
});
