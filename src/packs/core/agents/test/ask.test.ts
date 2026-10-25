/** An agent's question (AskUserQuestion): shown with its choices, answered on the page with only what it offered. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { answersPrompt, askOf, turnsOf } from "../../../../agents/conversation.ts";
import { apply, type Run } from "../../../../agents/runner.ts";
import { agentPage } from "../session.view.ts";
import { assertInert, H } from "../../../../../test/helpers.ts";

/** A page for ctx.page, as text: its head and body. */
const bodyOf = (p: { head?: unknown; body: unknown }) => `${p.head ?? ""}${p.body}`;

const INPUT = {
  questions: [
    { question: "Which database?", header: "Target", multiSelect: false, options: [{ label: "ledger:at", description: "Test" }, { label: "shop:at", description: "" }] },
    { question: "What to include?", header: "Scope", multiSelect: true, options: [{ label: "Tables" }, { label: "Views" }, { label: "Procs" }] },
  ],
};

test("a question is read narrowly: up to 4 of up to 6 choices, nothing without a question", () => {
  const qs = askOf(INPUT)!;
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[0]!.options.map((o) => o.label), ["ledger:at", "shop:at"]);
  assert.equal(qs[1]!.multiSelect, true);
  assert.equal(askOf({}), null);
  assert.equal(askOf({ questions: [{ options: [{ label: "x" }] }] }), null);
  assert.equal(askOf({ questions: Array.from({ length: 9 }, () => ({ question: "q", options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) })) })!.length, 4);
});

test("in a transcript and in a live run the question is its own turn, and a headless run's refusal of it isn't an 'allow' ask", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: INPUT }] } });
  const turns = turnsOf(line);
  assert.equal(turns[0]!.role, "ask");
  const run = { events: [], partial: "", cost: 0 } as unknown as Run;
  apply(run, line);
  apply(run, JSON.stringify({ type: "result", result: "", total_cost_usd: 0, permission_denials: [{ tool_name: "AskUserQuestion", tool_input: INPUT }, { tool_name: "Bash", tool_input: { command: "ls" } }] }));
  assert.deepEqual(run.events.map((e) => e.t), ["ask", "denied", "result"]);
  assert.equal(run.events.find((e) => e.t === "denied")!.t === "denied" && (run.events.find((e) => e.t === "denied") as { tool: string }).tool, "Bash");
});

test("the answer is what was picked from what was offered, one unless several are allowed, plus an own answer", () => {
  const qs = askOf(INPUT)!;
  assert.equal(answersPrompt(qs, {}), undefined, "nothing answered: nothing sent");
  const p = answersPrompt(qs, { a0: ["1", "0"], a1: ["0", "2", "7"], o1: "and triggers\nplease" })!;
  assert.match(p, /- Which database\?: shop:at$/m, "one pick for a single-choice question");
  assert.match(p, /- What to include\?: Tables; Procs; and triggers please$/m, "several where allowed; index 7 wasn't offered");
  assert.match(answersPrompt(qs, { a0: "x", o0: "ledger:pre" })!, /- Which database\?: ledger:pre/);
});

test("the session page shows the newest question with its choices to answer, older ones read-only, hostile text inert", () => {
  const hostile = { questions: [{ question: `Pick ${H}`, header: H, options: [{ label: `A ${H}`, description: H }] }] };
  const turns = [{ role: "ask" as const, questions: askOf(INPUT)! }, { role: "assistant" as const, text: "ok" }, { role: "ask" as const, questions: askOf(hostile)! }];
  const out = bodyOf(agentPage({ sessionId: "149b2627-6461-4857-8a90-2f4522ba4529", turns }));
  assertInert("agent page", out);
  assert.equal((out.match(/action="\/agents\/s\/149b2627-6461-4857-8a90-2f4522ba4529\/answer"/g) ?? []).length, 1, "only the newest is answerable");
  assert.match(out, /The agent asked/);
  assert.match(out, /ledger:at/);
  assert.match(out, /type="radio" name="a0" value="0"/);
});

test("a session marks what to move between: my messages as sections (labelled, inert), replies as items, the list following the latest", () => {
  const turns = [{ role: "user" as const, text: `Fix ${H}` }, { role: "assistant" as const, text: "ok" }];
  const out = bodyOf(agentPage({ sessionId: "149b2627-6461-4857-8a90-2f4522ba4529", turns }));
  assertInert("agent page", out);
  assert.match(out, /<ol class="chat" data-follow>/);
  assert.match(out, /<li class="turn-row user" data-stop="1" data-stop-label="Fix [^"]*">/);
  assert.match(out, /<li class="turn-row agent first" data-stop="2"><div class="who">Agent/, "the agent's run says who once");
  const two = bodyOf(agentPage({ sessionId: "149b2627-6461-4857-8a90-2f4522ba4529", turns: [...turns, { role: "assistant" as const, text: "more" }] }));
  assert.match(two, /<li class="turn-row agent" data-stop="2"><div class="bubble">/, "a second reply in the same run doesn't");
  assert.match(out, /<textarea name="prompt" rows="1" required aria-label="Reply" placeholder="Reply…" data-enter-send/, "a chat box: Enter sends");
});
