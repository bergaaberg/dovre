/** Runs as conversations: one row per session, and a turn's own cost out of Claude Code's running total. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { latestRuns, sessionCost, turnCost } from "../src/agents/latest.ts";
import type { Run } from "../src/agents/runner.ts";

const now = Date.parse("2026-10-22T20:00:00Z");
const run = (id: string, o: Partial<Run> = {}) => ({ id, harness: "claude", status: "done", startedAt: now - 3600e3, events: [], prompt: id, repo: "shop-api", forked: false, cost: 0, ...o }) as unknown as Run;
const denied = [{ t: "denied", tool: "Bash", spec: "Bash(x)", detail: "x" }] as Run["events"];

// The session from the evening of 2026-10-22: six turns, each "needing an OK", one conversation.
const turns = [3.705, 4.165, 4.362, 4.456, 4.54, 4.582].map((cost, i) => run(`t${i}`, { sessionId: "s1", cost, startedAt: now - (60 - i) * 60e3, events: denied }));

test("a session is one row however many times it was answered: its newest turn", () => {
  const other = run("solo", { startedAt: now - 10e3 });
  const l = latestRuns([...turns, other]);
  assert.deepEqual(l.map((r) => r.id), ["solo", "t5"]);
});

test("Claude Code's cost on a resumed turn is the session's total: the turn's own is the difference", () => {
  assert.equal(turnCost(turns[0]!, turns), 3.705, "the first turn here carries what came before");
  assert.ok(Math.abs(turnCost(turns[5]!, turns) - 0.042) < 1e-9);
  assert.equal(sessionCost(turns[5]!, turns), 4.582, "not the sum of the six");
  const fork = run("f", { sessionId: "s2", resumed: "s1", forked: true, cost: 4.7, startedAt: now });
  assert.ok(Math.abs(turnCost(fork, [...turns, fork]) - (4.7 - 4.582)) < 1e-9, "a fork starts from the session it copied");
  const omp = [run("o1", { harness: "omp", sessionId: "s3", cost: 0.2 }), run("o2", { harness: "omp", sessionId: "s3", cost: 0.1, startedAt: now })];
  assert.equal(turnCost(omp[1]!, omp), 0.1, "omp counts per turn already");
  assert.ok(Math.abs(sessionCost(omp[1]!, omp) - 0.3) < 1e-9);
});
