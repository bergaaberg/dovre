/** Auto review's reviewer (#326 step 3, #555): reading its answer, the caps, its model, CI, and one pass end to end. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../../../db.ts";
import type { PrFile } from "../../../../sources/prview.ts";
import type { AutoShare } from "../../agents/share.ts";
import { autoConfigOf } from "../config.ts";
import { findingsStore } from "../findings.ts";
import { AUTOREVIEW_SYSTEM, capLevel, ciOf, MAX_FINDINGS, reviewDraft, reviewerModel, reviewPrompt, riskOf, verdictOf } from "../reviewer.ts";
import { CI_WAIT_MS, MAX_ROUNDS, reviewPass, type ReviewDeps } from "../round.ts";
import { prsStore } from "../store.ts";
import { editorsOf, iso, type Said, saidAt } from "./said.ts";

const PR = "https://github.com/acme/web/pull/7";
const file = (o: Partial<PrFile> = {}): PrFile => ({ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, sha: "f", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c", ...o });
const block = (...lines: unknown[]) => "Here it is.\n```auto-review\n" + lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n```";
const LEVEL = { kind: "level", level: 4, reasons: ["Does what the issue asks.", "One nit."], summary: "Good." };

const FINDING = { kind: "finding", severity: "high", tags: ["correctness"], path: "src/a.ts", line: 2, side: "RIGHT", title: "Wrong sum", text: "It adds twice.", fix: "Add once." };

test("verdictOf: findings on lines of the diff, the most severe first, and the level; anything else left out", () => {
  const v = verdictOf(
    block(
      { ...FINDING, severity: "low", tags: ["clarity", "made-up", "clarity"], title: "", text: "Name it better.\nIt misleads.", fix: undefined },
      FINDING,
      { ...FINDING, severity: "urgent", text: "Unknown severity." },
      { ...FINDING, line: 99, text: "Not in the diff." },
      { ...FINDING, path: "../etc/passwd", text: "Bad path." },
      { ...FINDING, text: "" },
      { kind: "comment", tag: "blocker", path: "src/a.ts", line: 2, text: "The old shape." },
      "not json",
      LEVEL,
    ),
    [file()],
  );
  assert.deepEqual(v, {
    findings: [
      { severity: "high", tags: ["correctness"], path: "src/a.ts", line: 2, side: "RIGHT", title: "Wrong sum", body: "It adds twice.", fix: "Add once." },
      { severity: "low", tags: ["clarity"], path: "src/a.ts", line: 2, side: "RIGHT", title: "Name it better.", body: "Name it better.\nIt misleads.", fix: "" },
    ],
    level: 4,
    reasons: LEVEL.reasons,
    summary: "Good.",
  });
  assert.equal(verdictOf("no block", [file()]), null);
  assert.equal(verdictOf(block(FINDING), [file()]), null, "no level, no review");
  assert.equal(verdictOf(block({ kind: "level", level: 7 }), [file()]), null, "out of range");
});

test("verdictOf: a finding over several lines keeps its first line when the diff has it; past the limit the most severe stay", () => {
  const span = verdictOf(block({ ...FINDING, line: 3, start: 2 }, { ...FINDING, line: 2, start: 2 }, LEVEL), [file()])!;
  assert.deepEqual(span.findings.map((f) => [f.startLine, f.line]), [[2, 3], [undefined, 2]]);
  const many = verdictOf(block(...Array.from({ length: MAX_FINDINGS + 5 }, () => ({ ...FINDING, severity: "low" })), { ...FINDING, severity: "critical" }, LEVEL), [file()])!;
  assert.equal(many.findings.length, MAX_FINDINGS);
  assert.equal(many.findings[0]!.severity, "critical");
});

test("the reviewer's rules: only what the diff introduces, house style isn't a defect, a fix with each finding, no findings is fine, and the fixed lists", () => {
  for (const said of [/only problems this diff introduces/, /house style, not a defect/, /suggests a fix/, /how an attacker reaches it/, /what input or load makes it hurt/, /No findings is a fine answer/, /critical: /, /only from: correctness, security, performance, ux, tests, error-handling, scope, clarity\./])
    assert.match(AUTOREVIEW_SYSTEM, said);
});

test("capLevel: CI red or pending and a finding that must be fixed cap at 2; risky paths and a big diff at 3; nothing caps a clean, green PR", () => {
  const f = [file()];
  assert.deepEqual(capLevel(5, { ci: "green", files: f, gating: 0 }), { level: 5, was: 5, why: [] });
  assert.equal(capLevel(5, { ci: "red", files: f, gating: 0 }).level, 2);
  assert.equal(capLevel(5, { ci: "pending", files: f, gating: 0 }).level, 2);
  assert.equal(capLevel(4, { ci: "green", files: f, gating: 1 }).level, 2);
  for (const path of [".github/workflows/ci.yml", "package.json", "pnpm-lock.yaml", "migrations/0031_x.sql", ".dovre/sandbox.json", "wrangler.jsonc", "infra/main.tf", ".env.production", "Cargo.lock"])
    assert.equal(capLevel(5, { ci: "green", files: [file({ path })], gating: 0 }).level, 3, path);
  assert.equal(riskOf("src/app.ts"), undefined);
  const big = capLevel(5, { ci: "green", files: [file({ additions: 700, deletions: 200 })], gating: 0 });
  assert.equal(big.level, 3);
  assert.match(big.why[0]!, /900 changed lines/);
  assert.deepEqual(capLevel(1, { ci: "red", files: f, gating: 3 }), { level: 1, was: 1, why: [] }, "a cap above the level isn't a reason");
});

test("the review as posted: level and reasons on top, the cap said, each finding a line comment with its severity, fix, tags and which finding it posts", () => {
  const v = verdictOf(block({ ...FINDING, severity: "medium", tags: ["error-handling", "tests"], title: "Unhandled error", text: "Handle the error." }, { ...LEVEL, level: 5 }), [file()])!;
  const d = reviewDraft({ ...v, findings: v.findings.map((f) => ({ ...f, id: "0123456789ab" })) }, capLevel(5, { ci: "pending", files: [file()], gating: 0 }), { model: "claude-sonnet-5-5", head: "abcdef1234" });
  assert.match(d.summary, /^\*\*Auto review: level 2 of 5\*\* \(Real problems\), on abcdef1\./);
  assert.match(d.summary, /The reviewer said 5; capped at 2 because CI hasn't finished/);
  assert.match(d.summary, /Reviewed by claude-sonnet-5-5, which didn't write this PR\. Findings: 1 medium\./);
  assert.deepEqual(d.comments, [
    { path: "src/a.ts", line: 2, side: "RIGHT", body: "**Medium:** Unhandled error\n\nHandle the error.\n\n**Suggested fix:** Add once.\n\n<sub>error-handling, tests</sub>\n\n<!-- dovre:finding 0123456789ab -->\n\n<!-- dovre:autoreview -->" },
  ]);
  assert.match(reviewDraft({ ...v, findings: [] }, capLevel(5, { ci: "green", files: [file()], gating: 0 }), { model: "m", head: "abcdef1234" }).summary, /No findings\./);
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

function setup(o: { head?: string; merged?: boolean; model?: string; reply?: string; runModel?: string | null; owners?: string; ci?: string; config?: string; said?: Said[]; noComments?: boolean } = {}) {
  const { DB } = openDb();
  const gh = { head: o.head ?? "sha1", calls: [] as string[], posted: [] as any[], said: o.said ?? [] };
  const ghe = {
    rest: async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      gh.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "POST" && path.endsWith("/reviews")) {
        gh.posted.push(init.body);
        return { html_url: "https://github.com/acme/web/pull/7#r1", id: 99 } as T;
      }
      // A review's line comments, as the forge lists them: ids from 501.
      if (path === "/repos/acme/web/pulls/7/reviews/99/comments?per_page=100") {
        if (o.noComments) throw new Error("502");
        return (gh.posted[gh.posted.length - 1]?.comments ?? []).map((c: { body: string }, i: number) => ({ id: 501 + i, body: c.body })) as T;
      }
      if (path === "/repos/acme/web/pulls/7") return { state: o.merged ? "closed" : "open", merged: !!o.merged, title: "Fix", body: "", head: { sha: gh.head }, base: { sha: "c".repeat(40) }, user: { login: "me" } } as T;
      if (path === `/repos/acme/web/contents/.dovre/auto.json?ref=${"c".repeat(40)}` && o.config !== undefined) return { content: btoa(o.config), encoding: "base64", size: o.config.length } as T;
      if (path.startsWith("/repos/acme/web/pulls/7/files")) return [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c", sha: "f" }] as T;
      if (path === "/repos/acme/web/issues/3") return { title: "Fix login", body: "It breaks." } as T;
      if (path.includes("/check-runs")) return { check_runs: [o.ci === "pending" ? { status: "in_progress", conclusion: null } : { status: "completed", conclusion: o.ci ?? "success" }] } as T;
      if (path.endsWith("/status")) return { statuses: [] } as T;
      const said = saidAt(path, gh.said);
      if (said) return said as T;
      throw new Error(`unexpected ${path}`);
    },
    graphql: async <T>(q: string): Promise<T> => (gh.calls.push(`graphql ${q}`), editorsOf(q) as T),
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
        return { text: reply ?? block({ ...FINDING, severity: "low", tags: ["clarity"], title: "A vague name", text: "Name it better.", fix: "" }, { ...LEVEL, level: 5 }), cost: 0.02 };
      },
    },
    clicks: async () => clicks,
    log: () => {},
  };
  const store = prsStore(DB);
  return { DB, gh, asked, deps, store, findings: findingsStore(DB), setReply: (r: string) => (reply = r), setClicks: (c: Map<string, "once" | "twice">) => (clicks = c), add: () => store.add({ pr: PR, issue: "acme/web#3", run: "r1" }) };
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
  assert.match(s.gh.posted[0].comments[0].body, /^\*\*Low:\*\* A vague name\n\nName it better\.\n\n<sub>clarity<\/sub>\n\n<!-- dovre:finding [0-9a-f]{12} -->\n\n<!-- dovre:autoreview -->$/);
  let [r] = await s.store.all();
  // Level 5 is mine to merge, for now.
  assert.deepEqual([r!.level, r!.head, r!.author, r!.claim, r!.state, r!.cost], [5, "sha1", "opus", null, "yours", 0.02]);
  assert.match(r!.why!, /^Level 5 from claude-sonnet-5-5: findings: 1 low\. Mergeable as is\. Automerge is off for this repo/);
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

const HIGH = { ...FINDING, title: "Token unchecked", text: "Check the token first." };
const at = (level: number, ...comments: unknown[]) => block(...comments, { ...LEVEL, level });

test("decide: a critical or high finding caps the level at 2 and starts fix round 1 with the review's id kept; medium and low are only reported", async () => {
  const s = setup({ reply: at(3, HIGH) });
  await s.add();
  await reviewPass(s.deps);
  let [r] = await s.store.all();
  assert.deepEqual([r!.state, r!.round, r!.review, r!.level], ["fixing", 1, 99, 2]);
  assert.match(r!.why!, /^Level 2 from claude-sonnet-5-5: findings: 1 high; capped because a finding that must be fixed is open\. Round 1: a fix session for 1 finding\.$/);

  const t = setup({ reply: at(4, { ...HIGH, severity: "medium" }, { ...HIGH, severity: "low" }) });
  await t.add();
  await reviewPass(t.deps);
  [r] = await t.store.all();
  assert.equal(r!.state, "yours");
  assert.equal(r!.level, 4);
  assert.match(r!.why!, /findings: 1 medium, 1 low\. Nothing for a fix session to do/);
});

test("findings are records: each kept with the round, the commit and its line comment; a later review closes what it doesn't raise again", async () => {
  const s = setup({ reply: at(3, HIGH, { ...HIGH, severity: "low", line: 3, start: 2, tags: ["clarity", "tests"], title: "Vague", fix: "" }) });
  await s.add();
  await reviewPass(s.deps);
  let kept = await s.findings.of(PR);
  assert.deepEqual(
    kept.map((f) => [f.severity, f.status, f.round, f.head, f.review, f.comment, f.path, f.startLine, f.line, f.side, f.title, f.body, f.fix, f.tags.join()]),
    [
      ["high", "open", 0, "sha1", 99, 501, "src/a.ts", undefined, 2, "RIGHT", "Token unchecked", "Check the token first.", "Add once.", "correctness"],
      ["low", "open", 0, "sha1", 99, 502, "src/a.ts", 2, 3, "RIGHT", "Vague", "Check the token first.", "", "clarity,tests"],
    ],
  );
  assert.ok(s.gh.posted[0].comments[0].body.includes(`<!-- dovre:finding ${kept[0]!.id} -->`), "the comment says which finding it posts");
  assert.deepEqual([s.gh.posted[0].comments[1].start_line, s.gh.posted[0].comments[1].line], [2, 3]);

  // The fix round pushed; the next review raises another thing, and what was open before is fixed.
  await s.store.move(PR, "fixing", "reviewing");
  s.gh.head = "sha2";
  s.setReply(at(4, { ...HIGH, severity: "medium", tags: ["performance"], title: "Still loose" }));
  await reviewPass(s.deps);
  kept = await s.findings.of(PR);
  assert.deepEqual(kept.map((f) => [f.title, f.status, f.round, f.head]), [["Token unchecked", "fixed", 0, "sha1"], ["Vague", "fixed", 0, "sha1"], ["Still loose", "open", 1, "sha2"]]);

  // A review whose comments the forge won't list still keeps its findings; which comment waits for the fix round.
  const t = setup({ reply: at(3, HIGH), noComments: true });
  await t.add();
  await reviewPass(t.deps);
  assert.deepEqual((await t.findings.of(PR)).map((f) => [f.status, f.comment]), [["open", null]]);
  assert.equal((await t.store.all())[0]!.state, "fixing");
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
  const s = setup({ reply: at(3, HIGH) });
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
  const t = setup({ reply: at(1, HIGH) });
  await t.add();
  for (let i = 0; i <= MAX_ROUNDS; i++) {
    t.setReply(at(Math.min(4, i + 1), HIGH));
    t.gh.head = `sha${i}`;
    await reviewPass(t.deps);
    const [x] = await t.store.all();
    if (x!.state === "fixing") await t.store.move(PR, "fixing", "reviewing");
  }
  [r] = await t.store.all();
  assert.equal(r!.state, "yours");
  assert.match(r!.why!, new RegExp(`${MAX_ROUNDS} fix rounds done`));

  const u = setup({ reply: at(3, HIGH) });
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

// ── The repo's .dovre/auto.json (#326 step 5) ──

test("autoConfigOf: merge only when it says true; a size limit in range; a threshold other than 5 ignored, and said", () => {
  assert.deepEqual(autoConfigOf(undefined), { merge: false, notes: [] });
  assert.deepEqual(autoConfigOf('{"merge": true, "sizeLimit": 300}'), { merge: true, sizeLimit: 300, notes: [] });
  assert.deepEqual(autoConfigOf('{"merge": "yes"}').merge, false);
  assert.match(autoConfigOf('{"merge": true, "threshold": 4}').notes[0]!, /only at level 5/);
  assert.deepEqual(autoConfigOf('{"sizeLimit": -1}').sizeLimit, undefined);
  assert.equal(autoConfigOf("not json").merge, false);
  assert.equal(autoConfigOf("[1]").merge, false);
});

test("decide: level 5 goes to merging where the repo's file at the base commit allows it", async () => {
  const s = setup({ config: '{"merge": true}' });
  await s.add();
  await reviewPass(s.deps);
  let [r] = await s.store.all();
  assert.equal(r!.state, "merging");
  assert.match(r!.why!, /Merging it once the checks before a merge pass\.$/);

  const t = setup({ config: '{"merge": true, "sizeLimit": 0}' });
  await t.add();
  await reviewPass(t.deps);
  [r] = await t.store.all();
  assert.equal(r!.state, "merging", "an out-of-range limit leaves the default");
});

test("capLevel: a repo's size limit replaces the default", () => {
  const files = [file({ additions: 30, deletions: 0 })];
  assert.equal(capLevel(5, { ci: "green", files, gating: 0 }).level, 5);
  const c = capLevel(5, { ci: "green", files, gating: 0, sizeLimit: 20 });
  assert.equal(c.level, 3);
  assert.match(c.why[0]!, /over the limit of 20/);
});

// ── A problem raised again (#555 step 2) ──

test("a problem a later review raises again stays the finding it was: its row takes the new report and comment, and the comment says so", async () => {
  const s = setup({ reply: at(3, HIGH) });
  await s.add();
  await reviewPass(s.deps);
  const [first] = await s.findings.of(PR);
  await s.store.move(PR, "fixing", "reviewing");
  s.gh.head = "sha2";
  // The same problem two lines down, in other words but a similar title; and a new one.
  s.setReply(at(3, { ...HIGH, line: 3, title: "The token is still unchecked", text: "Still not checked.", tags: ["security"] }, { ...HIGH, severity: "low", line: 1, tags: ["clarity"], title: "Vague name" }));
  await reviewPass(s.deps);
  const kept = await s.findings.of(PR);
  assert.deepEqual(
    kept.map((f) => [f.id === first!.id, f.title, f.status, f.raised, f.round, f.head, f.line, f.comment, f.body]),
    [
      [true, "The token is still unchecked", "open", 2, 1, "sha2", 3, 501, "Still not checked."],
      [false, "Vague name", "open", 1, 1, "sha2", 1, 502, "Check the token first."],
    ],
  );
  const again = s.gh.posted[1].comments[0].body as string;
  assert.match(again, /Raised again: an earlier review reported it, and it's still there\./);
  assert.ok(again.includes(`<!-- dovre:finding ${first!.id} -->`), "its new comment posts the same finding");
  assert.doesNotMatch(s.gh.posted[1].comments[1].body, /Raised again/);
  assert.equal((await s.store.all())[0]!.state, "fixing", "still open and high: another round");
});

test("a finding the owner said to ignore, raised again: not posted, it doesn't hold the PR back, and it stays ignored; a new problem beside it with only a tag in common is its own", async () => {
  const s = setup({ reply: at(3, HIGH) });
  await s.add();
  await reviewPass(s.deps);
  const [first] = await s.findings.of(PR);
  await s.DB.prepare("UPDATE autoreview_findings SET status = 'force-ignore' WHERE id = ?").bind(first!.id).run();
  await s.store.move(PR, "fixing", "reviewing");
  s.gh.head = "sha2";
  s.setReply(at(5, HIGH));
  await reviewPass(s.deps);
  assert.deepEqual(s.gh.posted[1].comments, []);
  assert.match(s.gh.posted[1].body, /No findings\. One you said to ignore was raised again and left out\./);
  assert.doesNotMatch(s.gh.posted[1].body, /capped/);
  let kept = await s.findings.of(PR);
  assert.deepEqual(kept.map((f) => [f.status, f.raised, f.head, f.comment]), [["force-ignore", 2, "sha1", 501]]);
  const [r] = await s.store.all();
  assert.deepEqual([r!.level, r!.state], [5, "yours"]);

  await s.store.move(PR, "yours", "reviewing");
  s.gh.head = "sha3";
  s.setReply(at(3, { ...HIGH, title: "Password logged in the clear" }));
  await reviewPass(s.deps);
  kept = await s.findings.of(PR);
  assert.deepEqual(kept.map((f) => [f.title, f.status, f.raised]), [["Token unchecked", "force-ignore", 2], ["Password logged in the clear", "open", 1]]);
  assert.equal((await s.store.all())[0]!.level, 2);
});

// ── What owners say (#326 step 6) ──

test("capLevel: an owner's open comment or Request changes holds the level at 2", () => {
  const c = capLevel(5, { ci: "green", files: [file()], gating: 0, owner: "acme's Request changes is open" });
  assert.deepEqual([c.level, c.why], [2, ["acme's Request changes is open"]]);
});

test("a review: an owner's comment since the loop started caps the level at 2 and starts a round, past the rounds' limit too; a stranger's and Dovre's own don't", async () => {
  const later = Date.now() + 60_000;
  const s = setup({ reply: at(5), said: [{ kind: "issue", login: "acme", at: later, body: "Use the new client." }, { kind: "issue", login: "stranger", at: later }, { kind: "line", login: "me", at: later, body: "Fixed.\n\n<!-- dovre:autoreview -->" }] });
  await s.add();
  await s.store.move(PR, "reviewing", "fixing", { round: MAX_ROUNDS });
  await s.store.move(PR, "fixing", "reviewing");
  await reviewPass(s.deps);
  const [r] = await s.store.all();
  assert.deepEqual([r!.state, r!.level, r!.round], ["fixing", 2, MAX_ROUNDS + 1]);
  assert.match(r!.why!, new RegExp(`Round ${MAX_ROUNDS + 1}: a fix session for 1 owner comment\\.$`));
  assert.match(s.gh.posted[0].body, /capped at 2 because 1 owner comment is open/);

  // Before the loop started, it was said to the draft: not this loop's.
  const t = setup({ reply: at(5), said: [{ kind: "issue", login: "acme", at: Date.now() - 60_000 }] });
  await t.add();
  await reviewPass(t.deps);
  assert.equal((await t.store.all())[0]!.level, 5);
});

test("a review: an owner's Request changes counts until they approve", async () => {
  const later = Date.now() + 60_000;
  const s = setup({ reply: at(5), said: [{ kind: "review", login: "acme", at: later, review: 3, state: "CHANGES_REQUESTED", body: "" }] });
  await s.add();
  await reviewPass(s.deps);
  let [r] = await s.store.all();
  assert.deepEqual([r!.state, r!.level], ["fixing", 2]);
  assert.match(r!.why!, /a fix session for acme's Request changes\.$/);

  const t = setup({ reply: at(5), said: [{ kind: "review", login: "acme", at: later, review: 3, state: "CHANGES_REQUESTED", body: "" }, { kind: "review", login: "acme", at: later + 5, review: 4, state: "APPROVED", body: "" }] });
  await t.add();
  await reviewPass(t.deps);
  [r] = await t.store.all();
  assert.equal(r!.level, 5, "approved since");
});

test("a PR handed to me: my comment after the hand-over starts a round; what was said before it doesn't; one someone else edited is said once", async () => {
  const s = setup({ reply: at(4, { ...HIGH, severity: "low" }) });
  await s.add();
  await reviewPass(s.deps);
  let [r] = await s.store.all();
  assert.equal(r!.state, "yours");
  const handed = r!.heard;
  const later = { ...s.deps, now: () => Date.now() + 11 * 60_000 };
  // Said before it was handed over: taken in already.
  s.gh.said = [{ kind: "issue", login: "me", at: handed - 1 }];
  await reviewPass(later);
  assert.equal((await s.store.all())[0]!.state, "yours");
  s.gh.said = [{ kind: "line", login: "me", at: handed + 1000, body: "Call it fetchUser." }];
  await reviewPass({ ...s.deps, now: () => Date.now() + 22 * 60_000 });
  [r] = await s.store.all();
  assert.deepEqual([r!.state, r!.round], ["fixing", 1]);
  assert.match(r!.why!, /^Round 1: a fix session for 1 owner comment\.$/);

  const t = setup({ reply: at(4, { ...HIGH, severity: "low" }) });
  await t.add();
  await reviewPass(t.deps);
  t.gh.said = [{ kind: "issue", login: "me", at: (await t.store.all())[0]!.heard + 1000, edited: Date.now() + 5 * 60_000, id: 901 }];
  t.deps.ghe.graphql = async <X>(q: string): Promise<X> => editorsOf(q, { N_901: "mallory" }) as X;
  assert.equal(await reviewPass({ ...t.deps, now: () => Date.now() + 11 * 60_000 }), true);
  [r] = await t.store.all();
  assert.equal(r!.state, "yours");
  assert.match(r!.why!, /mallory edited me's comment/);
  assert.equal(await reviewPass({ ...t.deps, now: () => Date.now() + 22 * 60_000 }), false, "said once");
});
