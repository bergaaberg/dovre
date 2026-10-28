// Auto runs (#207): issues an owner labelled dovre:auto, picked up, run in a sandbox, closed out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { autoTick, type IssueCheck, untrusted } from "../src/actions/auto.ts";
import { autoIssueOf, sandboxPrText } from "../src/actions/sandbox.ts";
import { autoOptionsOf, autoPrompt, autoSettingsOf, autoStore, capsFor, DEFAULT_AUTO, isQuiet, localHour, saveAutoSettings } from "../src/agents/auto.ts";
import { capsOf, type Desk } from "../src/agents/desk.ts";
import { argsFor } from "../src/agents/harnesses/claude/harness.ts";
import type { Run } from "../src/agents/runner.ts";
import type { SandboxReady } from "../src/agents/sandbox.ts";
import { openDb } from "../src/db.ts";
import { autoNeeds, autoPanel } from "../src/packs/core/agents/auto.ts";
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
  assert.deepEqual(s, { on: true, off: ["acme/shop"], atOnce: 5, runUsd: 0.5, dayUsd: DEFAULT_AUTO.dayUsd, minutes: 30, quiet: { from: 22, to: 7 } });
  assert.equal(autoSettingsOf({ quietFrom: "22" }).quiet, null);
  assert.equal(autoSettingsOf({}).on, false, "off until switched on");
});

test("isQuiet: across midnight and within a day; localHour reads the zone", () => {
  assert.equal(isQuiet({ quiet: { from: 22, to: 7 } }, 23), true);
  assert.equal(isQuiet({ quiet: { from: 22, to: 7 } }, 3), true);
  assert.equal(isQuiet({ quiet: { from: 22, to: 7 } }, 7), false);
  assert.equal(isQuiet({ quiet: { from: 9, to: 17 } }, 12), true);
  assert.equal(isQuiet({ quiet: null }, 12), false);
  assert.equal(localHour(Date.parse("2026-10-28T12:30:00Z"), "UTC"), 12);
  assert.equal(localHour(Date.parse("2026-10-28T12:30:00Z"), "Asia/Tokyo"), 21);
  assert.equal(typeof localHour(0, "Not/AZone"), "number", "an invalid zone falls back");
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

test("capsOf and the harness: caps checked at the desk, and only a sandbox turn gets them", () => {
  assert.deepEqual(capsOf({ base: "origin/main", maxMs: 30 * 60_000, budget: 2.555, effort: "high" }), { base: "origin/main", maxMs: 30 * 60_000, budget: 2.56, effort: "high" });
  assert.deepEqual(capsOf({ base: "-x", maxMs: 1, budget: 1e9, effort: "turbo" }), {});
  assert.deepEqual(capsOf("nope"), {});
  const yolo = argsFor({ cwd: "/x", prompt: "p", yolo: true, budget: 2, effort: "low" });
  assert.deepEqual(yolo.slice(yolo.indexOf("--max-budget-usd"), yolo.indexOf("--max-budget-usd") + 4), ["--max-budget-usd", "2", "--effort", "low"]);
  const plain = argsFor({ cwd: "/x", prompt: "p", budget: 2, effort: "low" });
  assert.ok(!plain.includes("--max-budget-usd") && !plain.includes("--effort"));
});

// ── The loop, against a fake forge and desk ──

const READY = (o: Partial<SandboxReady> = {}): SandboxReady => ({ state: "ready", branch: "sandbox/aaaa", base: "a".repeat(40), head: "b".repeat(40), repo: "acme/app", commits: [{ sha: "b".repeat(40), subject: "Blue" }], files: [{ path: "a.css", add: 1, del: 1 }], ci: false, ...o });

function world(o: { labeller?: string; repos?: string[] } = {}) {
  const db = openDb();
  const writes: { method: string; path: string; body?: unknown }[] = [];
  let issueOpen = true;
  const ghe = {
    async rest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      const method = init.method ?? "GET";
      if (method !== "GET") writes.push({ method, path, body: init.body });
      if (path === "/user") return { login: "me" } as T;
      if (path.startsWith("/search/issues")) return { items: issueOpen ? [{ number: 12, title: "Make it blue", updated_at: "2026-10-28T10:00:00Z", repository_url: "https://api.github.com/repos/acme/app" }] : [] } as T;
      if (path === "/repos/acme/app") return { default_branch: "main" } as T;
      if (path.includes("/git/ref/heads/")) return { object: { sha: "b".repeat(40) } } as T;
      if (path.includes("/pulls?")) return [] as T;
      if (path.endsWith("/pulls")) return { number: 40, html_url: "https://github.com/acme/app/pull/40" } as T;
      if (method !== "GET") return {} as T;
      throw new Error(`unexpected ${method} ${path}`);
    },
    async graphql<T>(): Promise<T> {
      return { repository: { issue: { state: issueOpen ? "OPEN" : "CLOSED", title: "Make it blue", body: "Blue please.\n```dovre\nbudget: 2\n```", updatedAt: "2026-10-28T10:00:00Z", lastEditedAt: null, author: { login: "stranger" }, editor: null, labels: { nodes: [{ name: "dovre:auto" }] }, timelineItems: { nodes: [{ __typename: "LabeledEvent", createdAt: "2026-10-28T09:00:00Z", actor: { login: o.labeller ?? "me" }, label: { name: "dovre:auto" } }] } } } } as T;
    },
  };
  const runs = new Map<string, Run>();
  const started: Parameters<Desk["start"]>[0][] = [];
  const pushed: string[] = [];
  const desk = {
    view: () => ({ here: true, online: true, harnesses: ["claude"], runs: [...runs.values()], workDir: "/w" }),
    repos: async () => o.repos ?? ["app", "other"],
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
  let clicks = new Map<string, "once" | "twice">();
  const tick = (now = Date.parse("2026-10-28T12:00:00Z")) => autoTick({ db: db.DB, ghe, owners: "acme", desk, clicks: async () => clicks, tz: "UTC", now: () => now });
  return { db, ghe, desk, runs, started, pushed, writes, tick, setClicks: (c: Map<string, "once" | "twice">) => (clicks = c), close: () => (issueOpen = false) };
}

const on = (db: ReturnType<typeof openDb>, o: Partial<typeof DEFAULT_AUTO> = {}) => saveAutoSettings(db.DB, { ...DEFAULT_AUTO, on: true, ...o });

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

test("autoTick: with auto.pr at one click the PR opens by itself; CI changes still wait", async () => {
  const w = world();
  await on(w.db);
  w.setClicks(new Map([["auto.pr", "once"]]));
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
  ci.setClicks(new Map([["auto.pr", "once"]]));
  await ci.tick();
  Object.assign(ci.runs.get("run-1")!, { status: "done", out: READY({ ci: true }) });
  const q = await ci.tick();
  assert.equal(q.rows[0]!.state, "waiting");
  assert.match(q.rows[0]!.why!, /CI config/);
  assert.equal(ci.pushed.length, 0);
});

test("autoTick: a run that makes nothing gets stuck, says why on the issue and swaps the label", async () => {
  const w = world();
  await on(w.db);
  await w.tick();
  Object.assign(w.runs.get("run-1")!, { status: "done", out: { state: "none" }, events: [{ t: "result", text: "The issue isn't clear, cc @boss", cost: 0.3, error: false }] });
  const p = await w.tick();
  assert.equal(p.rows[0]!.state, "stuck");
  const comment = w.writes.find((x) => x.path.endsWith("/comments"))!.body as { body: string };
  assert.match(comment.body, /got stuck/);
  assert.ok(!comment.body.includes("@boss"), "no mentions from the agent's text");
  assert.deepEqual((w.writes.find((x) => x.path.endsWith("/labels") && x.method === "POST")!.body as { labels: string[] }).labels, ["dovre:auto-stuck"]);
  assert.equal(autoNeeds(p, "github.com", Date.now())[0]!.tone, "warn");
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
  // Truly gone: stuck.
  w.runs.delete("run-1");
  p = await w.tick(later);
  assert.equal(p.rows[0]!.state, "stuck");
  assert.match(p.rows[0]!.why ?? "", /cleared away/);
});

test("autoTick: limits hold: at once, the day's cost, quiet hours, a repo left out, no checkout", async () => {
  const quiet = world();
  await on(quiet.db, { quiet: { from: 11, to: 13 } });
  const p = await quiet.tick();
  assert.equal(quiet.started.length, 0);
  assert.match(p.paused!, /Quiet hours/);
  assert.equal(autoNeeds(p, "github.com", Date.now()).at(-1)!.title, "Auto runs are paused");

  const spent = world();
  await on(spent.db, { dayUsd: 1 });
  await autoStore(spent.db.DB).put({ repo: "acme/old", number: 1, title: "old", state: "refused" });
  await spent.db.DB.prepare("UPDATE auto_runs SET cost = 3, at = ?").bind(Date.parse("2026-10-28T11:00:00Z")).run();
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
});

test("autoTick: two passes at once start an issue only once", async () => {
  const w = world();
  await on(w.db, { atOnce: 3 });
  await Promise.all([w.tick(), w.tick()]);
  assert.equal(w.started.length, 1);
});

test("autoTick: an issue closed before its turn doesn't start", async () => {
  const w = world();
  await on(w.db, { quiet: { from: 11, to: 13 } });
  await w.tick();
  w.close();
  await on(w.db);
  const p = await w.tick();
  assert.equal(w.started.length, 0);
  assert.equal(p.rows[0]!.state, "refused");
});

test("autoPanel: hostile titles, reasons and links stay inert", () => {
  const row = { key: "acme/app#1", repo: "acme/app", number: 1, title: H, state: "done" as const, run: H, cost: 1, why: H, pr: "javascript:alert(1)", seen: null, options: null, at: 1, updated: 1 };
  const out = String(autoPanel(DEFAULT_AUTO, { rows: [row], paused: H }, "github.com"));
  assertInert("auto panel", out);
  assert.ok(!out.includes("javascript:"));
});
