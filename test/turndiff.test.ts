// What a turn changed (#241): the checkout's tree at start and end, and each turn's line on its page.
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Turn } from "../src/agents/conversation.ts";
import { daySpend, turnStats } from "../src/agents/latest.ts";
import { createRunner, type Run } from "../src/agents/runner.ts";
import { gitTurnDiff, numstat, type TurnDiffer } from "../src/agents/turndiff.ts";
import { agentPage, statsAt } from "../src/packs/core/agents/session.view.ts";

test("numstat: files and lines; a binary file is a file with no lines", () => {
  assert.deepEqual(numstat("3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tnew.md\n"), { files: 3, add: 13, del: 1 });
  assert.deepEqual(numstat(""), { files: 0, add: 0, del: 0 });
});

test("gitTurnDiff: edits and new files count, ignored ones don't; the real index stays as it was", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  writeFileSync(join(dir, ".gitignore"), "out/\n");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n"); // uncommitted before the turn: not the turn's
  const d = gitTurnDiff();
  const from = await d.tree(dir);
  assert.ok(from);
  const index = readFileSync(join(dir, ".git", "index"));
  writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(dir, "b.txt"), "new\nfile\n");
  execFileSync("mkdir", ["-p", join(dir, "out")]);
  writeFileSync(join(dir, "out", "x.js"), "ignored\n");
  const to = await d.tree(dir);
  assert.deepEqual(await d.between(dir, from!, to!), { files: 2, add: 3, del: 1 });
  assert.ok(readFileSync(join(dir, ".git", "index")).equals(index), "the real index untouched");
  assert.match(g("status", "--porcelain"), / M a.txt\n\?\? b.txt/, "nothing staged");
  assert.equal(await d.tree(tmpdir()), undefined, "not a checkout: nothing");
  assert.equal(await d.between(dir, "--output=/tmp/x", to!), undefined, "only tree ids");
});

/** A turn that ends at once, having said its session. */
const spawnFn = (_bin: string, _args: string[]) => {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined, kill: () => true });
  setImmediate(() => {
    stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" })}\n`);
    stdout.write(`${JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.5 })}\n`);
    stdout.end();
    setImmediate(() => child.emit("close", 0));
  });
  return child;
};

test("the runner counts a turn's change once it ends, and redraws", async () => {
  let reads = 0;
  const diff: TurnDiffer = { tree: async () => (++reads === 1 ? "a".repeat(40) : "b".repeat(40)), between: async (_c, f, t) => (f !== t ? { files: 2, add: 5, del: 1 } : undefined) };
  const seen: Run[] = [];
  const runner = createRunner({ spawnFn, diff, onChange: (r) => seen.push(r) });
  const r = runner.start({ cwd: tmpdir(), prompt: "go" });
  for (let i = 0; i < 50 && !r.diff; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.status, "done");
  assert.deepEqual(r.diff, { files: 2, add: 5, del: 1 });
  assert.equal(r.base, "a".repeat(40));
  assert.ok(seen.at(-1)?.diff, "a change once it's counted");
});

const SID = "11111111-2222-3333-4444-555555555555";
const t0 = Date.parse("2026-10-28T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("statsAt: each ended turn's line before my next message; the live one left to the end", () => {
  const turns: Turn[] = [
    { role: "user", text: "first", at: iso(t0 + 500) },
    { role: "assistant", text: "ok", at: iso(t0 + 9000) },
    { role: "user", text: "typed in a terminal", at: iso(t0 + 20_000) },
    { role: "user", text: "second", at: iso(t0 + 60_500) },
    { role: "assistant", text: "ok", at: iso(t0 + 70_000) },
  ];
  const stats = [
    { id: "r1", startedAt: t0, endedAt: t0 + 10_000, cost: 0.1, diff: { files: 1, add: 2, del: 0 } },
    { id: "r2", startedAt: t0 + 60_000, endedAt: t0 + 75_000, cost: 0.2 },
  ];
  const at = statsAt(turns, stats, "r2");
  assert.deepEqual([...at].map(([i, s]) => [i, s.map((x) => x.id)]), [[2, ["r1"]]]);
  assert.deepEqual([...statsAt(turns, stats)].map(([i, s]) => [i, s.map((x) => x.id)]), [[2, ["r1"]], [5, ["r2"]]]);
});

test("a session's page: cost, time and a linked diff per turn; the list says what it cost today", () => {
  const run = { id: "r2", harness: "claude", sessionId: SID, forked: false, cwd: "/code/a", repo: "a", prompt: "second", mode: "default", model: "", allowed: [], status: "done", startedAt: t0 + 60_000, endedAt: t0 + 75_000, events: [], partial: "", cost: 0.3, diff: { files: 0, add: 0, del: 0 } } as Run;
  const turns: Turn[] = [
    { role: "user", text: "first", at: iso(t0 + 500) },
    { role: "assistant", text: "ok", at: iso(t0 + 9000) },
    { role: "user", text: "second", at: iso(t0 + 60_500) },
  ];
  const body = String(agentPage({ sessionId: SID, turns, run, turnCost: 0.2, diff: "/code/a/diff", stats: [{ id: "r1", startedAt: t0, endedAt: t0 + 10_000, cost: 0.1, diff: { files: 3, add: 12, del: 4 } }, { id: "r2", startedAt: t0 + 60_000, endedAt: t0 + 75_000, cost: 0.2 }] }).body);
  assert.match(body, /\$0\.100 · 10 s · <a href="\/code\/a\/diff"[^>]*>3 files <span class="add">\+12<\/span> <span class="del">−4<\/span><\/a>/);
  assert.match(body, /\$0\.200 · 15 s · no changes/);
  assert.match(body, /\$0\.100[\s\S]*<p>second<\/p>[\s\S]*\$0\.200/, "the first turn's line before the second message, the last at the end");
  assert.doesNotMatch(body, /Last turn cost/);

  const now = t0 + 86400e3 * 2;
  const runs = [{ ...run, id: "old", startedAt: t0, cost: 1 }, { ...run, id: "new", startedAt: now - 1000, cost: 1.4 }] as Run[];
  assert.equal(daySpend(SID, runs, now).toFixed(2), "0.40", "the turn's own cost: Claude Code counts the session's");
  assert.deepEqual(turnStats(SID, runs).map((s) => s.id), ["old", "new"]);
});
