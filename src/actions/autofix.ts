/**
 * Fix sessions on auto PRs (#326), the agents pack's side: Auto review asks for them through the
 * pack's `auto` share (src/packs/core/agents/share.ts), never by reaching in here.
 *
 * - Starting: a sandbox run from the PR's head commit, within auto runs' limits. It takes the same
 *   at-once slot (`fixStore.claim` counts auto runs and fixes in one statement), counts toward the
 *   day's cap, waits out quiet hours, and is capped at Settings' minutes, `runUsd` and FIX_TURNS.
 * - Landing: once it ended, its commits go onto the PR's branch, never forced, so they land only on
 *   top of the commit it started from. Only onto a sandbox branch, only in my repos, and never
 *   commits that change CI config (a push runs the repo's workflows with its secrets).
 * - Following: each pass keeps a running fix's cost and gives its slot back once it ends.
 */
import { randomUUID } from "node:crypto";
import { type AutoSettings, fixStore, loadAutoSettings, repoOn } from "../agents/auto.ts";
import type { Desk } from "../agents/desk.ts";
import type { Run } from "../agents/runner.ts";
import { SANDBOX_BRANCH } from "../agents/sandbox.ts";
import type { D1 } from "../db.ts";
import { loadPolicy } from "../notify.ts";
import { quietAt } from "../quiet.ts";
import { ownedRepo } from "../sources/files.ts";
import { type AutoFixAsk, type AutoFixLanded, FIX_TURNS } from "../packs/types.ts";
import { findCheckout } from "./auto.ts";
import { logAction } from "./deploys.ts";

const MIN = 60_000;

/** The agent's last word (its final result), bounded. */
export function saidOf(run: Pick<Run, "events"> | undefined): string {
  const r = run ? [...run.events].reverse().find((e) => e.t === "result") : undefined;
  return r?.t === "result" ? r.text.trim().slice(0, 8000) : "";
}

export type FixDeps = { db: D1; desk: Desk; owners: string; tz?: string; now?: () => number };

/** Why nothing starts now, or undefined when a fix may start (the slot aside). */
async function paused(d: FixDeps, s: AutoSettings, repo: string): Promise<string | undefined> {
  const now = d.now ?? Date.now;
  if (!repoOn(s, repo)) return `Auto runs are off${s.on ? ` for ${repo}` : ""}, and fix sessions with them.`;
  const quiet = s.quietOwn ? s.quiet : ((await loadPolicy(d.db).catch(() => undefined))?.quiet ?? null);
  if (quietAt(quiet, now(), d.tz)) return "Quiet hours: the fix session starts after them.";
  const spent = await d.db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM auto_spend WHERE at >= ?").bind(now() - 24 * 60 * MIN).first<{ c: number }>();
  if (Number(spent?.c ?? 0) >= s.dayUsd) return `Auto runs and fix sessions have spent $${s.dayUsd.toFixed(2)} in the last 24 hours, the day's cap.`;
  return undefined;
}

export async function startFix(d: FixDeps, a: AutoFixAsk): Promise<{ run: string } | { wait: string } | { error: string }> {
  const repo = ownedRepo(d.owners, a.repo);
  if (!repo) return { error: `${a.repo} isn't in your repos.` };
  if (!/^[0-9a-f]{40}$/.test(a.head)) return { error: "That isn't a commit to start from." };
  const s = await loadAutoSettings(d.db);
  const why = await paused(d, s, repo);
  if (why) return { wait: why };
  const fixes = fixStore(d.db, d.now);
  const id = randomUUID();
  if (!(await fixes.claim({ id, key: a.key, pr: a.pr }, s.atOnce))) return { wait: `Auto runs and fix sessions already use the ${s.atOnce === 1 ? "one slot" : `${s.atOnce} slots`} Settings allows at once.` };
  try {
    await d.desk.refresh?.();
    const found = await findCheckout(d.desk, repo);
    if ("silent" in found) {
      await fixes.end(id);
      return { wait: `${found.silent} didn't list its checkouts in time; trying again.` };
    }
    if ("none" in found) {
      await fixes.end(id);
      return { error: found.none };
    }
    const r = await d.desk.start({
      repo: found.checkout,
      prompt: a.prompt,
      harness: "claude",
      mode: "default",
      model: a.model,
      sandbox: true,
      ...(found.machine ? { machine: found.machine } : {}),
      caps: { base: a.head, maxMs: s.minutes * MIN, budget: Math.max(0.01, Math.min(s.runUsd, a.budget)), turns: FIX_TURNS },
    });
    const run = "run" in r ? r.run : undefined;
    if ("error" in r || !run) {
      await fixes.end(id);
      // The machine or the sandbox isn't ready: asked again on a later pass.
      return { wait: "error" in r ? `Couldn't start: ${r.error.slice(0, 300)}` : "The machine didn't say which run it started." };
    }
    await fixes.started(id, run);
    return { run };
  } catch (e) {
    await fixes.end(id);
    return { wait: `Couldn't start: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
  }
}

export async function landFix(d: FixDeps, id: string, to: { repo: string; branch: string; base: string; pr: { number: number; url: string }; kind: string }): Promise<AutoFixLanded> {
  const now = d.now ?? Date.now;
  const fixes = fixStore(d.db, d.now);
  const row = await fixes.byRun(id);
  const target = `${to.repo}:${to.branch}`;
  const refuse = async (error: string, cost?: number): Promise<AutoFixLanded> => {
    await logAction(d.db, { kind: to.kind, target, ok: false, error }).catch(() => {});
    if (row) await fixes.end(row.id);
    return { error, ...(cost !== undefined ? { cost } : {}) };
  };
  if (!row) return { error: "That isn't a fix session Dovre started." };
  const run = await d.desk.run(id).catch(() => undefined);
  if (!run) return { wait: "The machine that ran it doesn't answer now." };
  if (run.status === "running") return { wait: "It's still running." };
  await fixes.setCost(row.id, run.cost);
  await fixes.end(row.id);
  const said = saidOf(run);
  const out = run.out;
  if (!out || out.state === "collecting") {
    if (now() - (run.endedAt ?? now()) > 15 * MIN) return refuse("Its commits never came home from the sandbox.", run.cost);
    return { wait: "Its commits are coming home from the sandbox." };
  }
  if (out.state === "none") return { none: run.status === "done" ? "It committed nothing." : `It ${run.status === "stopped" ? "was stopped" : "failed"} without committing anything.`, said, cost: run.cost };
  if (out.state === "failed") return refuse(`Its commits couldn't be brought home: ${out.why.slice(0, 300)}`, run.cost);
  const repo = ownedRepo(d.owners, to.repo);
  if (!repo || out.repo?.toLowerCase() !== repo.toLowerCase()) return refuse(`Its checkout's origin is ${out.repo ?? "not on the forge"}, not ${to.repo}.`, run.cost);
  if (!SANDBOX_BRANCH.test(to.branch)) return refuse(`${to.branch} isn't an auto run's branch.`, run.cost);
  if (out.base !== to.base) return refuse("It started from another commit than the PR's head it was asked to fix.", run.cost);
  if (out.ci) return refuse("Its commits change CI config, so they aren't pushed on their own.", run.cost);
  // Pushed by a pass that went away before it said so: landed already.
  if (out.pr) return out.pr.number === to.pr.number ? { head: out.head, commits: out.commits.length, said, cost: run.cost } : refuse("Its commits went to another PR.", run.cost);
  const pushed = await d.desk.pushSandbox(id, to.branch);
  if ("error" in pushed) return refuse(`Couldn't push: ${pushed.error.slice(0, 300)}`, run.cost);
  if (pushed.repo !== repo || pushed.branch !== to.branch || pushed.head !== out.head) return refuse("The machine pushed something other than what the run made.", run.cost);
  await d.desk.landed(id, to.pr);
  const n = out.commits.length;
  await logAction(d.db, { kind: to.kind, target, detail: `${out.head.slice(0, 7)} onto #${to.pr.number}`, ok: true }).catch(() => {});
  return { head: out.head, commits: n, said, cost: run.cost };
}

/** Running fixes: cost kept; the slot back once a run ends, or a claim's pass died, or its machine forgot it. */
export async function followFixes(d: Pick<FixDeps, "db" | "desk" | "now">): Promise<void> {
  const now = d.now ?? Date.now;
  const fixes = fixStore(d.db, d.now);
  const open = await fixes.open();
  if (!open.length) return;
  const view = d.desk.view();
  const listed = new Set(view.runs.map((r) => r.id));
  for (const f of open) {
    if (!f.run) {
      if (now() - f.updated > 5 * MIN) await fixes.end(f.id);
      continue;
    }
    const run = await d.desk.run(f.run).catch(() => undefined);
    if (!run) {
      if (view.online && !listed.has(f.run) && now() - f.updated > 5 * MIN) await fixes.end(f.id);
      continue;
    }
    if (run.cost !== f.cost) await fixes.setCost(f.id, run.cost);
    if (run.status !== "running") await fixes.end(f.id);
  }
}
