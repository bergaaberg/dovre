// Auto runs (#207): issues an owner labelled dovre:auto, picked up, run in a sandbox, closed out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, savePolicy as saveNotifyPolicy } from "../src/notify.ts";
import { autoTick, type IssueCheck, runAgain, untrusted } from "../src/actions/auto.ts";
import { autoIssueOf, sandboxPrText } from "../src/actions/sandbox.ts";
import { type AutoRow, autoKey, MAX_TRIES, autoOptionsOf, autoPrompt, autoSettingsOf, autoStore, capsFor, DEFAULT_AUTO, saveAutoSettings } from "../src/agents/auto.ts";
import { capsOf, type Desk } from "../src/agents/desk.ts";
import { argsFor } from "../src/agents/harnesses/claude/harness.ts";
import type { Run } from "../src/agents/runner.ts";
import type { SandboxReady } from "../src/agents/sandbox.ts";
import { openDb } from "../src/db.ts";
import { alonePanel, autoNeeds, autoPanel } from "../src/packs/core/agents/auto.ts";
import { assertInert, H } from "./helpers.ts";

test("autoOptionsOf: a fenced dovre block's known keys; junk and unsafe bases left out", () => {
  const body = "Do the thing.\n\n```dovre\nmodel: Sonnet\neffort: low\nbudget: $2.5\nminutes: 30\nbase: release/1.2\nyolo: please\n```\n";
  assert.deepEqual(autoOptionsOf(body), { model: "sonnet", effort: "low", budget: 2.5, minutes: 30, base: "release/1.2" });
  assert.deepEqual(autoOptionsOf("```dovre\nmodel: gpt-9\neffort: ludicrous\nbudget: -1\nbase: --upload-pack=x\n```"), {});
  assert.deepEqual(autoOptionsOf("```dovre\nbase: main..evil\n```"), {});
  assert.deepEqual(autoOptionsOf("```js\nmodel: opus\n```"), {}, "only the dovre block");
  assert.deepEqual(autoOptionsOf(null), {});
});

test("capsFor: an issue's options only narrow Settings", () => {
  const s = { ...DEFAULT_AUTO, runUsd: 5, minutes: 60 };
  assert.deepEqual(capsFor(s, { budget: 50, minutes: 600 }), { model: "", budget: 5, maxMs: 60 * 60_000 });
  assert.deepEqual(capsFor(s, { budget: 1, minutes: 10, model: "haiku", effort: "low" }), { model: "haiku", effort: "low", budget: 1, maxMs: 10 * 60_000 });
});

test("autoSettingsOf: bounded, repos lowercased, quiet hours only when both are given", () => {
  const s = autoSettingsOf({ on: "on", off: "ACME/Shop, not a repo, acme/shop", atOnce: "99", runUsd: "0", dayUsd: "abc", minutes: "30", quietFrom: "22", quietTo: "7" });
  assert.deepEqual(s, { on: true, off: ["acme/shop"], atOnce: 5, runUsd: 0.5, dayUsd: DEFAULT_AUTO.dayUsd, minutes: 30, quietOwn: true, quiet: { from: 22, to: 7 } });
  // Before #272, its own hours were its own; now a form says which (#272).
  assert.equal(autoSettingsOf({ quiet: null }).quietOwn, false, "none kept: Notifications' hours");
  assert.equal(autoSettingsOf({ quietAs: "notify", quietFrom: "22", quietTo: "7" }).quietOwn, false);
  assert.deepEqual(autoSettingsOf({ quietAs: "own", quietWeekends: "on" }).quiet, { from: 0, to: 0, weekends: true });
  assert.equal(autoSettingsOf({ quietFrom: "22" }).quiet, null);
  assert.equal(autoSettingsOf({}).on, false, "off until switched on");
});


const check = (o: Partial<IssueCheck> = {}): IssueCheck => ({ open: true, labelled: true, title: "Fix it", body: "please", updated: "2026-10-28T10:00:00Z", author: "stranger", label: { by: "me", at: "2026-10-28T09:00:00Z" }, renames: [], ...o });
const owner = (l: string | undefined) => l === "me" || l === "acme";

test("untrusted: only an owner's label counts, and only for the text the owner saw", () => {
  assert.equal(untrusted(check(), owner), null);
  assert.match(untrusted(check({ label: { by: "stranger", at: "2026-10-28T09:00:00Z" } }), owner)!, /only an owner's label/);
  assert.match(untrusted(check({ editedAt: "2026-10-28T09:30:00Z", editor: "stranger" }), owner)!, /edited it after/);
  assert.equal(untrusted(check({ editedAt: "2026-10-28T08:00:00Z", editor: "stranger" }), owner), null, "edited before the label: the owner saw it");
  assert.equal(untrusted(check({ editedAt: "2026-10-28T09:30:00Z", editor: "me" }), owner), null);
  assert.match(untrusted(check({ renames: [{ by: "stranger", at: "2026-10-28T09:10:00Z" }] }), owner)!, /renamed/);
  assert.match(untrusted(check({ open: false }), owner)!, /closed/);
  assert.match(untrusted(check({ labelled: false }), owner)!, /isn't labelled/);
});

test("the prompt names the issue; its PR takes the issue's title and closes it", () => {
  const prompt = autoPrompt({ repo: "acme/app", number: 12, title: "Make the button blue", body: "# Not the title\nIt's red." });
  assert.deepEqual(autoIssueOf(prompt), { repo: "acme/app", number: 12, title: "Make the button blue" });
  const out = { state: "ready", branch: "sandbox/aaaa", base: "a".repeat(40), head: "b".repeat(40), repo: "acme/app", commits: [{ sha: "b".repeat(40), subject: "x" }], files: [], ci: false } as SandboxReady;
  const t = sandboxPrText({ prompt, events: [], cost: 1 }, out);
  assert.equal(t.title, "Make the button blue");
  assert.match(t.body, /Closes #12/);
  assert.ok(!t.body.includes("It's red"), "the issue isn't quoted back");
  assert.equal(autoIssueOf("Fix the thing"), undefined);
});

test("capsOf and the harness: caps checked at the desk, and only a sandbox turn gets them (effort goes on any turn, #236)", () => {
  assert.deepEqual(capsOf({ base: "origin/main", maxMs: 30 * 60_000, budget: 2.555, effort: "high" }), { base: "origin/main", maxMs: 30 * 60_000, budget: 2.56, effort: "high" });
  assert.deepEqual(capsOf({ base: "-x", maxMs: 1, budget: 1e9, effort: "turbo" }), {});
  assert.deepEqual(capsOf("nope"), {});
  const yolo = argsFor({ cwd: "/x", prompt: "p", yolo: true, budget: 2, effort: "low" });
  assert.deepEqual(yolo.slice(yolo.indexOf("--max-budget-usd"), yolo.indexOf("--max-budget-usd") + 4), ["--max-budget-usd", "2", "--effort", "low"]);
  const plain = argsFor({ cwd: "/x", prompt: "p", budget: 2, effort: "low" });
  assert.ok(!plain.includes("--max-budget-usd"));
  assert.deepEqual(plain.slice(plain.indexOf("--effort"), plain.indexOf("--effort") + 2), ["--effort", "low"]);
});

// ── The loop, against a fake forge and desk ──

const READY = (o: Partial<SandboxReady> = {}): SandboxReady => ({ state: "ready", branch: "sandbox/aaaa", base: "a".repeat(40), head: "b".repeat(40), repo: "acme/app", commits: [{ sha: "b".repeat(40), subject: "Blue" }], files: [{ path: "a.css", add: 1, del: 1 }], ci: false, ...o });

function world(o: { labeller?: string; repos?: string[] | null } = {}) {
  const db = openDb();
  const writes: { method: string; path: string; body?: unknown }[] = [];
  let issueOpen = true;
  let labelAt = "2026-10-28T09:00:00Z";
  const ghe = {
    async rest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      const method = init.method ?? "GET";
      if (method !== "GET") writes.push({ method, path, body: init.body });
      if (path === "/user") return { login: "me" } as T;
      if (path.startsWith("/search/issues")) return { items: issueOpen ? [{ number: 12, title: "Make it blue", updated_at: "2026-10-28T10:00:00Z", repository_url: "https://api.github.com/repos/acme/app" }] : [] } as T;
      if (path === "/repos/acme/app") return { default_branch: "main" } as T;
      if (path === "/repos/acme/app/issues/12" && method === "GET") return { state: issueOpen ? "open" : "closed" } as T;
      if (path.includes("/git/ref/heads/")) return { object: { sha: "b".repeat(40) } } as T;
      if (path.includes("/pulls?")) return [] as T;
      if (path.endsWith("/pulls")) return { number: 40, html_url: "https://github.com/acme/app/pull/40" } as T;
      if (method !== "GET") return {} as T;
      throw new Error(`unexpected ${method} ${path}`);
    },
    async graphql<T>(): Promise<T> {
      return { repository: { issue: { state: issueOpen ? "OPEN" : "CLOSED", title: "Make it blue", body: "Blue please.\n```dovre\nbudget: 2\n```", updatedAt: "2026-10-28T10:00:00Z", lastEditedAt: null, author: { login: "stranger" }, editor: null, labels: { nodes: [{ name: "dovre:auto" }] }, timelineItems: { nodes: [{ __typename: "LabeledEvent", createdAt: labelAt, actor: { login: o.labeller ?? "me" }, label: { name: "dovre:auto" } }] } } } } as T;
    },
  };
  const runs = new Map<string, Run>();
  const started: Parameters<Desk["start"]>[0][] = [];
  const pushed: string[] = [];
  const desk = {
    view: () => ({ here: true, online: true, harnesses: ["claude"], runs: [...runs.values()], workDir: "/w" }),
    repos: async () => {
      if (o.repos === null) throw new Error("timed out");
      return o.repos ?? ["app", "other"];
    },
    run: async (id: string) => runs.get(id),
    async start(f: Parameters<Desk["start"]>[0]) {
      started.push(f);
      const id = `run-${started.length}`;
      runs.set(id, { id, status: "running", prompt: String(f.prompt), events: [], cost: 0, sandbox: { dir: "/d", name: "n", base: "a".repeat(40) } } as unknown as Run);
      return { to: `/agents/r/${id}`, run: id };
    },
    pushSandbox: async (id: string) => (pushed.push(id), { repo: "acme/app", branch: "sandbox/aaaa", head: "b".repeat(40) }),
    async landed(id: string, pr: { number?: unknown; url?: unknown }) {
      const r = runs.get(id)!;
      if (r.out?.state === "ready") r.out.pr = { number: pr.number as number, url: pr.url as string };
    },
  } as unknown as Desk;
  let clicks = new Map<string, "once" | "twice">([["auto.pr", "twice"]]);
  const tick = (now = Date.parse("2026-10-28T12:00:00Z")) => autoTick({ db: db.DB, ghe, owners: "acme", desk, clicks: async () => clicks, tz: "UTC", now: () => now });
  return { db, ghe, desk, runs, started, pushed, writes, tick, setClicks: (c: Map<string, "once" | "twice">) => (clicks = c), close: () => (issueOpen = false), relabel: (at: string) => (labelAt = at) };
}

const on = (db: ReturnType<typeof openDb>, o: Partial<typeof DEFAULT_AUTO> = {}) => saveAutoSettings(db.DB, { ...DEFAULT_AUTO, on: true, ...o });

/** Each try's run ends having made nothing, until the issue is stuck for good (#254). */
async function stickAll(w: ReturnType<typeof world>, now?: number, events: unknown[] = []) {
  for (let i = 0; i < MAX_TRIES; i++) {
    Object.assign(w.runs.get(`run-${w.started.length}`)!, { status: "done", out: { state: "none" }, events });
    await w.tick(now);
  }
}

test("autoTick: off does nothing at all; on, an owner's issue is queued and started in a sandbox with its caps", async () => {
  const w = world();
  const p0 = await w.tick();
  assert.deepEqual(p0.rows, []);
  assert.equal(w.started.length, 0);
  await on(w.db, { runUsd: 5, minutes: 45 });
  const p = await w.tick();
  assert.equal(p.rows[0]!.state, "running");
  assert.equal(w.started.length, 1);
  const f = w.started[0]!;
  assert.equal(f.repo, "app");
  assert.equal(f.sandbox, true);
  assert.deepEqual(f.caps, { base: "origin/main", maxMs: 45 * 60_000, budget: 2 });
  assert.match(String(f.prompt), /^You are working on GitHub issue acme\/app#12 on your own\./);
  // Again: still running, not started twice.
  await w.tick();
  assert.equal(w.started.length, 1);
});

test("autoTick: a label from someone who isn't an owner is refused, and nothing starts", async () => {
  const w = world({ labeller: "stranger" });
  await on(w.db);
  const p = await w.tick();
  assert.equal(p.rows[0]!.state, "refused");
  assert.equal(w.started.length, 0);
  assert.equal(w.writes.length, 0, "nothing said on the issue");
});

test("autoTick: a run with commits waits for my OK (a need), and once its PR is open, the issue gets a comment and the done label", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  const run = w.runs.get("run-1")!;
  run.status = "done";
  run.cost = 1.2;
  run.out = READY();
  const p = await w.tick();
  assert.equal(p.rows[0]!.state, "waiting");
  assert.equal(p.rows[0]!.cost, 1.2);
  assert.equal(w.pushed.length, 0, "not pushed without my OK");
  const needs = autoNeeds(p, "github.com", Date.now());
  assert.equal(needs[0]!.href, "/agents/r/run-1");
  assert.equal(needs[0]!.ring, "agent-auto");
  // I opened it from the run's page.
  (run.out as SandboxReady).pr = { number: 40, url: "https://github.com/acme/app/pull/40" };
  const p2 = await w.tick();
  assert.equal(p2.rows[0]!.state, "done");
  assert.equal(p2.rows[0]!.pr, "https://github.com/acme/app/pull/40");
  assert.deepEqual(w.writes.map((x) => `${x.method} ${x.path}`), ["POST /repos/acme/app/issues/12/comments", "DELETE /repos/acme/app/issues/12/labels/dovre%3Aauto", "POST /repos/acme/app/issues/12/labels"]);
  assert.deepEqual((w.writes[2]!.body as { labels: string[] }).labels, ["dovre:auto-done"]);
  const logged = w.db.raw.prepare("SELECT kind, ok FROM actions").all().map((l) => ({ ...l }));
  assert.deepEqual(logged, [{ kind: "auto.done", ok: 1 }]);
});

test("autoTick: with auto.pr at one click (the default) the PR opens by itself; CI changes still wait", async () => {
  const w = world();
  await on(w.db);
  w.setClicks(new Map());
  await w.tick();
  const run = w.runs.get("run-1")!;
  run.status = "done";
  run.out = READY();
  const p = await w.tick();
  assert.equal(p.rows[0]!.state, "done");
  assert.deepEqual(w.pushed, ["run-1"]);
  assert.ok(w.writes.some((x) => x.path === "/repos/acme/app/pulls" && (x.body as { draft: boolean }).draft));

  const ci = world();
  await on(ci.db);
  ci.setClicks(new Map());
  await ci.tick();
  Object.assign(ci.runs.get("run-1")!, { status: "done", out: READY({ ci: true }) });
  const q = await ci.tick();
  assert.equal(q.rows[0]!.state, "waiting");
  assert.match(q.rows[0]!.why!, /CI config/);
  assert.equal(ci.pushed.length, 0);
});

test("autoTick: a stuck run goes back in the queue on its own, label kept and nothing said, and starts again (#254)", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  Object.assign(w.runs.get("run-1")!, { status: "done", out: { state: "none" }, events: [] });
  await on(w.db, { quietOwn: true, quiet: { from: 11, to: 13 } });
  let p = await w.tick();
  assert.equal(p.rows[0]!.state, "queued");
  assert.equal(p.rows[0]!.tries, 1);
  assert.match(p.rows[0]!.why!, /Stuck 1 of 3 times; trying again\. It ended without committing/);
  assert.equal(w.writes.length, 0, "nothing on the issue, label kept");
  await on(w.db);
  p = await w.tick();
  assert.equal(p.rows[0]!.state, "running");
  assert.equal(w.started.length, 2);
  for (const id of ["run-2", "run-3"]) {
    Object.assign(w.runs.get(id)!, { status: "done", out: { state: "none" }, events: [] });
    p = await w.tick();
  }
  assert.equal(p.rows[0]!.state, "stuck", "the third time: left for me");
  assert.equal(p.rows[0]!.tries, 3);
  assert.equal(w.started.length, 3);
  assert.deepEqual(w.writes.map((x) => x.method), ["POST", "DELETE", "POST"], "comment, label swapped");
  // Labelled again by me after it ended: a fresh count.
  w.relabel("2026-10-28T12:30:00Z");
  p = await w.tick(Date.parse("2026-10-28T12:31:00Z"));
  assert.equal(p.rows[0]!.tries, 0);
});

test("autoTick: a run that makes nothing gets stuck, says why on the issue and swaps the label", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  await stickAll(w, undefined, [{ t: "result", text: "The issue isn't clear, cc @boss", cost: 0.3, error: false }]);
  const p = await w.tick();
  assert.equal(p.rows[0]!.state, "stuck");
  const comment = w.writes.find((x) => x.path.endsWith("/comments"))!.body as { body: string };
  assert.match(comment.body, /got stuck 3 times/);
  assert.ok(!comment.body.includes("@boss"), "no mentions from the agent's text");
  assert.deepEqual((w.writes.find((x) => x.path.endsWith("/labels") && x.method === "POST")!.body as { labels: string[] }).labels, ["dovre:auto-stuck"]);
  assert.equal(autoNeeds(p, "github.com", Date.parse("2026-10-28T13:00:00Z"))[0]!.tone, "warn");
});

test("autoTick: a machine too busy to answer (pushing for a PR) isn't a run cleared away; one it no longer lists is", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  const run = w.runs.get("run-1")!;
  run.status = "done";
  run.out = READY();
  await w.tick();
  const later = Date.parse("2026-10-28T12:30:00Z");
  // The call times out (the remote desk answers undefined), but the machine still lists the run.
  const ask = w.desk.run;
  (w.desk as { run: Desk["run"] }).run = async () => undefined;
  let p = await w.tick(later);
  assert.equal(p.rows[0]!.state, "waiting");
  assert.equal(w.writes.length, 0, "nothing said on the issue");
  (w.desk as { run: Desk["run"] }).run = ask;
  // Truly gone: stuck, so it tries again.
  w.runs.delete("run-1");
  p = await w.tick(later);
  assert.equal(w.started.length, 2, "tried again");
  assert.equal(p.rows[0]!.tries, 1);
  assert.equal(w.writes.length, 0);
});

test("autoTick: limits hold: at once, the day's cost, quiet hours, a repo left out, no checkout", async () => {
  const quiet = world();
  await on(quiet.db, { quietOwn: true, quiet: { from: 11, to: 13 } });
  const p = await quiet.tick();
  assert.equal(quiet.started.length, 0);
  assert.match(p.paused!, /Quiet hours/);
  assert.equal(autoNeeds(p, "github.com", Date.now()).at(-1)!.title, "Auto runs are paused");

  // As Notifications' quiet hours (#272): those count, not the auto runs' own.
  const shared = world();
  await on(shared.db, { quiet: { from: 1, to: 2 } });
  await saveNotifyPolicy(shared.db.DB, { ...DEFAULT_POLICY, quiet: { from: 11, to: 13 } });
  assert.match((await shared.tick()).paused ?? "", /Quiet hours/);
  assert.equal(shared.started.length, 0);

  const spent = world();
  await on(spent.db, { dayUsd: 1 });
  const old = autoStore(spent.db.DB, () => Date.parse("2026-10-28T11:00:00Z"));
  await old.put({ repo: "acme/old", number: 1, title: "old", state: "refused" });
  await spent.db.DB.prepare("UPDATE auto_runs SET run = 'r-old'").run();
  await old.setCost(autoKey("acme/old", 1), 3);
  const p2 = await spent.tick();
  assert.equal(spent.started.length, 0);
  assert.match(p2.paused!, /day's cap/);

  const left = world();
  await on(left.db, { off: ["acme/app"] });
  await left.tick();
  assert.equal(left.started.length, 0);

  const none = world({ repos: ["something-else"] });
  await on(none.db);
  const p3 = await none.tick();
  assert.equal(p3.rows[0]!.state, "stuck");
  assert.match(p3.rows[0]!.why!, /no checkout named app/);

  // A machine that doesn't answer in time isn't one without the checkout: it stays queued.
  const slow = world({ repos: null });
  await on(slow.db);
  const p4 = await slow.tick();
  assert.equal(slow.started.length, 0);
  assert.equal(p4.rows[0]!.state, "queued");
  assert.match(p4.rows[0]!.why!, /didn't list its checkouts/);
  assert.equal(slow.writes.length, 0);
});

test("auto store: claim starts a queued row only while fewer than atOnce are busy, counted in the same statement", async () => {
  const db = openDb();
  const store = autoStore(db.DB, () => 1);
  for (const n of [1, 2, 3]) await store.put({ repo: "acme/app", number: n, title: `t${n}`, state: "queued" });
  // Another isolate's pass already has one running.
  assert.ok(await store.move(autoKey("acme/app", 1), "queued", "running", { run: "r1" }));
  assert.equal(await store.claim(autoKey("acme/app", 2), 2), true);
  assert.equal(await store.claim(autoKey("acme/app", 3), 2), false, "two busy: no room");
  assert.equal(await store.claim(autoKey("acme/app", 2), 5), false, "only from queued");
  assert.equal((await store.get(autoKey("acme/app", 3)))!.state, "queued");
});

test("autoTick: two passes at once start an issue only once", async () => {
  const w = world();
  await on(w.db, { atOnce: 3 });
  await Promise.all([w.tick(), w.tick()]);
  assert.equal(w.started.length, 1);
});

test("autoTick: an issue closed before its turn doesn't start", async () => {
  const w = world();
  await on(w.db, { quietOwn: true, quiet: { from: 11, to: 13 } });
  await w.tick();
  w.close();
  await on(w.db);
  const p = await w.tick();
  assert.equal(w.started.length, 0);
  assert.equal(p.rows[0]!.state, "refused");
});

test("autoPanel: hostile titles, reasons and links stay inert", () => {
  const row = { key: "acme/app#1", repo: "acme/app", number: 1, title: H, state: "done" as const, run: H, cost: 1, why: H, pr: "javascript:alert(1)", seen: null, options: null, tries: 0, at: 1, updated: 1 };
  const out = String(autoPanel(DEFAULT_AUTO, { rows: [row], paused: H }, "github.com"));
  assertInert("auto panel", out);
  assert.ok(!out.includes("javascript:"));
});

test("autoTick: a stuck issue still showing its old label (closing out) doesn't start again; a label put on after it does", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  await stickAll(w, Date.parse("2026-10-28T12:00:00Z"));
  // Another pass, while the forge still shows dovre:auto from 09:00.
  const p = await w.tick(Date.parse("2026-10-28T12:00:05Z"));
  assert.equal(p.rows[0]!.state, "stuck");
  assert.equal(w.started.length, MAX_TRIES, "not run again");
  w.relabel("2026-10-28T12:30:00Z");
  await w.tick(Date.parse("2026-10-28T12:31:00Z"));
  assert.equal(w.started.length, MAX_TRIES + 1, "labelled again after it ended");
});

test("runAgain: a stuck issue is labelled dovre:auto again (-stuck off), queued, logged, and the next pass starts it", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  await stickAll(w);
  const key = "acme/app#12";
  assert.deepEqual(await runAgain({ db: w.db.DB, ghe: w.ghe, owners: "other", key }), { ok: false, error: "Not in your repos." });
  w.writes.length = 0;
  assert.deepEqual(await runAgain({ db: w.db.DB, ghe: w.ghe, owners: "acme", key }), { ok: true });
  assert.deepEqual(w.writes.map((x) => `${x.method} ${x.path}`), ["POST /repos/acme/app/issues/12/labels", "DELETE /repos/acme/app/issues/12/labels/dovre%3Aauto-stuck"]);
  assert.deepEqual((w.writes[0]!.body as { labels: string[] }).labels, ["dovre:auto"]);
  assert.equal((await autoStore(w.db.DB).get(key))!.state, "queued");
  assert.equal((await autoStore(w.db.DB).get(key))!.tries, 0, "my say-so: a fresh count");
  assert.deepEqual(await runAgain({ db: w.db.DB, ghe: w.ghe, owners: "acme", key }), { ok: false, error: "That auto run isn't stuck any more." });
  const logged = w.db.raw.prepare("SELECT kind, ok, error FROM actions WHERE kind = 'auto.again'").all().map((l) => ({ ...l }));
  assert.deepEqual(logged, [{ kind: "auto.again", ok: 0, error: "Not in your repos." }, { kind: "auto.again", ok: 1, error: null }]);
  await w.tick();
  assert.equal(w.started.length, MAX_TRIES + 1, "started again");
});

test("runAgain: a closed issue isn't labelled", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  await stickAll(w);
  w.close();
  w.writes.length = 0;
  assert.deepEqual(await runAgain({ db: w.db.DB, ghe: w.ghe, owners: "acme", key: "acme/app#12" }), { ok: false, error: "acme/app#12 is closed." });
  assert.equal(w.writes.length, 0);
});

test("alonePanel: active rows and the last four days, cost against its cap, Run again on a stuck one; hostile input inert; nothing when off and empty", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const row = (o: Partial<AutoRow>): AutoRow => ({ key: "acme/app#1", repo: "acme/app", number: 1, title: "t", state: "running", run: "run-1", cost: 1, why: null, pr: null, seen: null, options: null, tries: 0, at: now, updated: now, ...o });
  const s = { ...DEFAULT_AUTO, on: true, runUsd: 5 };
  const out = String(alonePanel(s, { rows: [row({ options: JSON.stringify({ budget: 2 }) }), row({ key: "acme/app#2", number: 2, state: "stuck", why: "No commits." }), row({ key: "acme/app#3", number: 3, state: "done", updated: now - 5 * 86_400_000 })] }, "github.com", now));
  assert.match(out, /Working alone/);
  assert.match(out, /\$1\.00 of \$2\.00/);
  assert.match(out, /action="\/agents\/auto\/again"/);
  assert.match(out, /value="acme\/app#2"/);
  assert.ok(!out.includes("app#3"), "older than four days");
  assert.equal(alonePanel({ ...DEFAULT_AUTO, on: false }, { rows: [] }, "github.com", now), "");
  const bad = String(alonePanel(s, { rows: [row({ title: H, run: H, why: H, pr: "javascript:alert(1)", state: "stuck", key: H })], paused: H }, "github.com", now));
  assertInert("working alone", bad);
  assert.ok(!bad.includes("javascript:"));
});

test("autoStore: a run's cost still counts for the day after its issue is relabelled or run again (#234)", async () => {
  const { DB } = openDb();
  let t = 1_000;
  const store = autoStore(DB, () => t);
  const key = autoKey("acme/app", 7);
  await store.put({ repo: "acme/app", number: 7, title: "x", state: "queued" });
  await store.move(key, "queued", "running", { run: "r1" });
  await store.setCost(key, 2);
  assert.ok(await store.move(key, "running", "stuck", { cost: 2.5, why: "no" }));
  t = 2_000;
  await store.put({ repo: "acme/app", number: 7, title: "x", state: "queued" }); // relabelled
  assert.equal((await store.get(key))!.cost, 0);
  await store.move(key, "queued", "running", { run: "r2" });
  await store.setCost(key, 1);
  assert.equal(await store.spent(0), 3.5);
  assert.equal(await store.spent(1_500), 1);
});
