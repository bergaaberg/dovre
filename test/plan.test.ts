/** #240: the agent's plan (Claude's to-do list, Codex's steps), subagent calls and omp's thinking, read narrowly and shown as text. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { turnsOf } from "../src/agents/conversation.ts";
import { apply as claudeApply } from "../src/agents/harnesses/claude/harness.ts";
import { codexApply } from "../src/agents/harnesses/codex/harness.ts";
import { ompApply } from "../src/agents/harnesses/omp/harness.ts";
import type { Run } from "../src/agents/runner.ts";
import { stepsOf, subagentOf, todosOf } from "../src/agents/todos.ts";
import { agentPage } from "../src/packs/core/agents/session.view.ts";
import { H, assertInert } from "./helpers.ts";

const SID = "149b2627-6461-4857-8a90-2f4522ba4529";
const run = (x: Partial<Run> = {}): Run => ({ id: "r1", harness: "claude", sessionId: SID, forked: false, cwd: "/x", repo: "x", prompt: "p", mode: "default", model: "", allowed: [], status: "running", startedAt: 1, events: [], partial: "", cost: 0, ...x });
const bodyOf = (p: { body: unknown }) => String(p.body);
const line = (j: unknown) => JSON.stringify(j);

test("todosOf and stepsOf read only words and status, capped; subagentOf names the kind", () => {
  assert.deepEqual(todosOf({ todos: [{ content: " Read ", status: "completed", activeForm: "x" }, { content: "Fix", status: "in_progress" }, { content: "Ship", status: "weird" }, { content: 4 }, { content: "" }] }), [
    { text: "Read", status: "done" },
    { text: "Fix", status: "active" },
    { text: "Ship", status: "pending" },
  ]);
  assert.equal(todosOf({ todos: "no" }), null);
  assert.equal(todosOf(null), null);
  assert.equal(todosOf({ todos: Array.from({ length: 50 }, () => ({ content: "x", status: "pending" })) })!.length, 30);
  assert.equal(todosOf({ todos: [{ content: "y".repeat(900), status: "pending" }] })![0]!.text.length, 300);
  assert.deepEqual(stepsOf([{ text: "Plan", completed: true }, { text: "Build", completed: false }, { text: "Test", completed: "yes" }]), [
    { text: "Plan", status: "done" },
    { text: "Build", status: "active" },
    { text: "Test", status: "pending" },
  ]);
  assert.equal(subagentOf("Task", { subagent_type: "Explore" }), "Explore");
  assert.equal(subagentOf("Agent", {}), "agent");
  assert.equal(subagentOf("Bash", { subagent_type: "x" }), undefined);
});

test("Claude: TodoWrite is a plan, Task a subagent call; in the stream and in the transcript", () => {
  const r = run();
  claudeApply(r, line({ type: "assistant", session_id: SID, message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Read", status: "in_progress" }] } }, { type: "tool_use", name: "Task", input: { description: "Find callers", subagent_type: "Explore" } }] } }));
  assert.deepEqual(r.events, [
    { t: "todos", items: [{ text: "Read", status: "active" }] },
    { t: "tool", name: "Task", detail: "Find callers", sub: "Explore" },
  ]);
  const turns = turnsOf(
    [
      line({ type: "user", message: { content: "go" }, timestamp: "2026-10-29T10:00:00Z" }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Read", status: "pending" }] } }] }, timestamp: "2026-10-29T10:00:01Z" }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: { description: "Look", subagent_type: "Plan" } }] }, timestamp: "2026-10-29T10:00:02Z" }),
    ].join("\n"),
  );
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user", "todos", "tools"],
  );
  assert.deepEqual(turns[2]!.role === "tools" && turns[2]!.calls[0], { name: "Agent", detail: "Look", sub: "Plan" });
});

test("Codex: its todo list is one plan, updated in place while it's the newest event", () => {
  const r = run({ harness: "codex" });
  codexApply(r, line({ type: "item.started", item: { id: "t", type: "todo_list", items: [{ text: "Plan", completed: false }, { text: "Build", completed: false }] } }));
  codexApply(r, line({ type: "item.updated", item: { id: "t", type: "todo_list", items: [{ text: "Plan", completed: true }, { text: "Build", completed: false }] } }));
  assert.deepEqual(r.events, [{ t: "todos", items: [{ text: "Plan", status: "done" }, { text: "Build", status: "active" }] }]);
  codexApply(r, line({ type: "item.completed", item: { id: "c", type: "command_execution", command: "ls", status: "completed" } }));
  codexApply(r, line({ type: "item.completed", item: { id: "t", type: "todo_list", items: [{ text: "Plan", completed: true }, { text: "Build", completed: true }] } }));
  assert.equal(r.events.filter((e) => e.t === "todos").length, 2);
  // Any other item that's started or updated is still not read.
  codexApply(r, line({ type: "item.updated", item: { id: "c2", type: "command_execution", command: "cat x" } }));
  assert.equal(r.events.length, 3);
});

test("omp: thinking blocks become folded thoughts, empty ones don't", () => {
  const r = run({ harness: "omp" });
  ompApply(r, line({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "  " }, { type: "thinking", thinking: "Tests first." }, { type: "text", text: "Done." }], usage: { cost: { total: 0 } }, stopReason: "stop" } }));
  assert.deepEqual(
    r.events.filter((e) => e.t === "thinking"),
    [{ t: "thinking", text: "Tests first." }],
  );
});

test("the page: a hostile plan, subagent and thought stay text; the newest plan is open, older ones folded", () => {
  const live = bodyOf(agentPage({ sessionId: SID, turns: [], run: run({ events: [{ t: "thinking", text: H }, { t: "tool", name: "Task", detail: H, sub: H }, { t: "todos", items: [{ text: H, status: "active" }, { text: "Done it", status: "done" }] }] }) }));
  assertInert("live plan", live);
  assert.match(live, /Plan · 1 of 2 done/);
  assert.match(live, /class="plan-active"/);
  assert.match(live, /<summary>Thought<\/summary>/);
  assert.match(live, /subagent · /);

  const turns = [
    { role: "user" as const, text: "go" },
    { role: "todos" as const, items: [{ text: "Old plan", status: "pending" as const }] },
    { role: "thinking" as const, text: H },
    { role: "tools" as const, calls: [{ name: "Task", detail: H, sub: H }] },
    { role: "todos" as const, items: [{ text: H, status: "done" as const }] },
  ];
  const done = bodyOf(agentPage({ sessionId: SID, turns }));
  assertInert("transcript plan", done);
  assert.match(done, /<details><summary>Plan · 0 of 1 done<\/summary>/, "the older plan folds");
  assert.match(done, /class="todos-card"><div class="who">Plan · 1 of 1 done/, "the newest is open");

  // Ended without a transcript (Codex): its last plan still shows.
  const codex = bodyOf(agentPage({ sessionId: SID, turns: [], run: run({ harness: "codex", status: "done", events: [{ t: "todos", items: [{ text: "Build", status: "done" }] }] }) }));
  assert.match(codex, /Plan · 1 of 1 done/);
});
