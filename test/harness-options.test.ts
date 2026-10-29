/** Each harness declares its options (#236): the new-session form and the chatbox (#237) offer only those, and each passes effort its own way. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDesk } from "../src/agents/desk.ts";
import { argsFor } from "../src/agents/harnesses/claude/harness.ts";
import { codexArgs } from "../src/agents/harnesses/codex/harness.ts";
import { agyArgs } from "../src/agents/harnesses/agy/harness.ts";
import { ompArgs } from "../src/agents/harnesses/omp/harness.ts";
import { HARNESS_DEFS } from "../src/agents/harnesses/index.ts";
import { createQueue } from "../src/agents/queue.ts";
import { MODES, type Run, type Runner, type StartOpts } from "../src/agents/runner.ts";
import { agentPage, newAgentPage } from "../src/packs/core/agents/session.view.ts";

const bodyOf = (p: { head?: unknown; body: unknown }) => `${p.head ?? ""}${p.body}`;
const SID = "149b2627-6461-4857-8a90-2f4522ba4529";
const o = (x: Partial<StartOpts>): StartOpts => ({ cwd: "/x", prompt: "p", ...x });
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("every harness names all three modes and starts its efforts at its own default", () => {
  for (const d of HARNESS_DEFS) {
    for (const m of MODES) assert.ok(d.options.modes[m].label && d.options.modes[m].short, `${d.id} ${m}`);
    assert.equal(d.options.efforts[0]?.value, "", d.id);
  }
});

test("each harness passes effort its own way, on any turn, and only a level it knows", () => {
  assert.equal(after(argsFor(o({ effort: "high" })), "--effort"), "high");
  assert.equal(after(codexArgs(o({ effort: "high" })), "-c"), 'model_reasoning_effort="high"');
  assert.ok(ompArgs(o({ effort: "high" })).includes("--thinking=high"));
  assert.equal(after(agyArgs(o({ effort: "max" })), "--effort"), "max");
  // Not on its list: left out, never passed through.
  for (const bad of ["turbo", "--yolo", "minimal; rm"]) {
    assert.ok(!argsFor(o({ effort: bad })).includes("--effort"), bad);
    assert.ok(!codexArgs(o({ effort: bad })).some((a) => a.includes("reasoning")), bad);
    assert.ok(!ompArgs(o({ effort: bad })).some((a) => a.startsWith("--thinking")), bad);
    assert.ok(!agyArgs(o({ effort: bad })).includes("--effort"), bad);
  }
  // Each list is its own: Codex has no "max", omp has "off".
  assert.ok(!codexArgs(o({ effort: "max" })).some((a) => a.includes("reasoning")));
  assert.ok(ompArgs(o({ effort: "off" })).includes("--thinking=off"));
  assert.ok(!argsFor(o({})).includes("--effort"), "no effort: the CLI's own default");
});

test("the new-session form shows only what the picked harness takes, in its own words", () => {
  const codex = bodyOf(newAgentPage({ repos: ["a"], harnesses: ["codex"] }));
  assert.match(codex, /Workspace-write/);
  assert.match(codex, /value="minimal"/);
  assert.doesNotMatch(codex, /value="max"/);
  assert.doesNotMatch(codex, /harness-opts/, "one harness: its fields, nothing to swap");
  const two = bodyOf(newAgentPage({ repos: ["a"], harnesses: ["claude", "omp"] }));
  assert.match(two, /data-new-agent/);
  assert.match(two, /<select name="harness" data-harness-pick>/);
  const omp = two.slice(two.indexOf('data-harness="omp"'));
  assert.match(omp, /^data-harness="omp" hidden disabled>/);
  assert.match(omp, /Always ask: only reads run/);
  assert.match(omp, /Default thinking/);
  assert.match(omp, /value="off"/);
});

const run = (x: Partial<Run>): Run => ({ id: "r1", harness: "claude", sessionId: SID, forked: false, cwd: "/x", repo: "x", prompt: "p", mode: "default", model: "", allowed: [], status: "done", startedAt: 1, events: [], partial: "", cost: 0, ...x });

test("the chatbox offers the session's harness's options, and the cards carry the effort on (#237)", () => {
  const omp = bodyOf(agentPage({ sessionId: SID, turns: [], run: run({ harness: "omp", effort: "high", events: [{ t: "denied", tool: "bash", spec: "bash", detail: "ls" }] }) }));
  assert.match(omp, /Always ask: only reads run/);
  assert.match(omp, /<option value="high" selected>/);
  assert.match(omp, /name="copy"/, "omp can fork: Reply in a copy");
  assert.match(omp, /always ask · default model · high effort/);
  // Allow and No both go on at the same effort.
  assert.equal(omp.match(/<input type="hidden" name="effort" value="high">/g)?.length, 2);
  const codex = bodyOf(agentPage({ sessionId: SID, turns: [], run: run({ harness: "codex" }) }));
  assert.match(codex, /Workspace-write/);
  assert.doesNotMatch(codex, /name="copy"/, "Codex can't fork");
  assert.doesNotMatch(codex, /value="max"/);
});

test("the desk passes effort and a ticked copy to the runner, checked against the harness", async () => {
  const starts: StartOpts[] = [];
  const current = run({ harness: "omp", status: "done" });
  const runner = {
    harnesses: () => ["claude", "omp"],
    ofSession: () => current,
    copiesOf: () => [],
    list: () => [current],
    get: () => current,
    sandbox: () => undefined,
    start: (s: StartOpts) => (starts.push(s), { ...current, id: "r2" }),
    sessionOf: async () => SID,
  } as unknown as Runner;
  const desk = localDesk({ env: { CODE_DIR: mkdtempSync(join(tmpdir(), "code-")), CLAUDE_DIR: mkdtempSync(join(tmpdir(), "claude-")) }, runner, queue: createQueue(), sessions: async () => ({ live: [], recent: [] }) });
  await desk.reply(SID, { prompt: "go on", mode: "acceptEdits", effort: "xhigh", copy: "on" });
  assert.deepEqual([starts[0]!.effort, starts[0]!.fork, starts[0]!.mode], ["xhigh", true, "acceptEdits"]);
  await desk.reply(SID, { prompt: "again", effort: "ludicrous" });
  assert.deepEqual([starts[1]!.effort, starts[1]!.fork], [undefined, false]);
  await desk.allow(SID, { specs: ["bash"], effort: "low" });
  assert.equal(starts[2]!.effort, "low");
});
