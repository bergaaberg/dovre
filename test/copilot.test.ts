/** Copilot CLI: its session files, live detection and conversation. Temp dirs only, never the real ~/.copilot. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copilotEventsOf, copilotProcessesOf, copilotSessionById, copilotTurnsOf, loadCopilotSessions, parseCopilotCommandLine, parseWorkspace, summarizeCopilotEvents } from "../src/sources/copilot.ts";
import { resumeCommand, sessionItem } from "../src/pages/parts.ts";
import { agentPage } from "../src/packs/core/agents/session.view.ts";

/** A page for ctx.page, as text: its head and body. */
const bodyOf = (p: { head?: unknown; body: unknown }) => `${p.head ?? ""}${p.body}`;

const SECRET = "Password=hunter2;Server=prod-db";
const NOW = Date.parse("2026-10-23T09:00:00Z");
const ID_DONE = "0814bfd3-d4f5-4c19-ba8e-e9a57283f67d";
const ID_ASKS = "22e16377-770f-48c0-99d8-2f65b82f2da4";
const ID_IDLE = "3441b4ff-1f2f-4285-a988-eff85e057d73";
const ID_EMPTY = "13f75d76-8d51-4238-92c8-51fdd56de0e5";
const ID_OLD = "65a3c9d1-0000-4000-8000-000000000001";

let n = 0;
/** One event in the real shape: type first, then data, id, timestamp, parentId. */
const ev = (type: string, data: object, ts = "2026-10-23T07:00:00.000Z") => JSON.stringify({ type, data, id: `e${++n}`, timestamp: ts, parentId: null });
const start = (id: string, cwd: string) => ev("session.start", { sessionId: id, version: 1, producer: "copilot-agent", copilotVersion: "1.0.95", startTime: "2026-10-23T07:00:00.000Z", selectedModel: "claude-sonnet-4.6", context: { cwd, gitRoot: cwd, branch: "main", repository: "ACME/shop-api", hostType: "github" } });
const user = (content: string, ts?: string) => ev("user.message", { content, transformedContent: `<current_datetime>now</current_datetime>${content}<reminder>${SECRET}</reminder>`, attachments: [], interactionId: "i" }, ts);
const said = (content: string, tools: object[] = [], ts?: string) => ev("assistant.message", { messageId: "m", content, toolRequests: tools, model: "gpt-5.6-luna", reasoningText: `chain of thought ${SECRET}`, outputTokens: 5, turnId: "t" }, ts);
const call = (name: string, args: object | string, intent = "") => ({ toolCallId: "c1", name, arguments: args, type: "function", intentionSummary: intent });

/** Everything that must never come out: tool output, hook input, a permission's diff, the system prompt, compaction. */
const noise = [
  ev("system.message", { role: "system", content: `You are Copilot ${SECRET}` }),
  ev("tool.execution_start", { toolCallId: "c1", toolName: "powershell", arguments: { command: "git status" }, turnId: "t" }),
  ev("hook.start", { hookInvocationId: "h", hookType: "postToolUse", input: { cwd: "C:\\x", toolName: "powershell", toolArgs: "{}", toolResult: { textResultForLlm: SECRET } } }),
  ev("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: SECRET, detailedContent: SECRET }, turnId: "t" }),
  ev("model.model_call_success", { requestMessages: SECRET, responseChunk: { choices: [] } }),
  ev("session.compaction_complete", { summaryContent: SECRET, success: true }),
  ev("system.notification", { content: SECRET, kind: { type: "shell_completed" } }),
];

const doneEvents = [
  start(ID_DONE, "C:\\Code\\shop-api"),
  ev("session.model_change", { newModel: "claude-sonnet-4.6" }),
  user("fix the login bug", "2026-10-23T07:01:00.000Z"),
  ev("assistant.turn_start", { turnId: "t", interactionId: "i" }),
  said("Looking at it.", [call("powershell", { command: "git status", description: "status" }), call("report_intent", { intent: "Fixing" })]),
  ...noise,
  ev("assistant.turn_end", { turnId: "t" }),
  said("Done: https://acme.ghe.com/ACME/shop-api/pull/840 is open.", [], "2026-10-23T07:05:00.000Z"),
  ev("assistant.turn_end", { turnId: "t" }),
  ev("session.task_complete", { summary: "Fixed login; PR 840 open.", success: true }),
  ev("session.shutdown", { shutdownType: "routine", totalPremiumRequests: 3, currentModel: "gpt-5.6-luna" }, "2026-10-23T07:06:00.000Z"),
];
const asksEvents = [
  start(ID_ASKS, "C:\\Code\\platform"),
  user("run the migrations"),
  said("", [call("powershell", { command: "dotnet ef database update" }, "Run migrations")]),
  ev("tool.execution_start", { toolCallId: "c1", toolName: "powershell", arguments: {} }),
  ev("permission.requested", { requestId: "r1", permissionRequest: { kind: "shell", canOfferSessionApproval: true, commandSegments: [], fullCommandText: SECRET, intention: SECRET }, promptRequest: { kind: "shell", fullCommandText: SECRET } }, "2026-10-23T08:59:00.000Z"),
];
const idleEvents = [start(ID_IDLE, "C:\\Code\\dovre"), user("what's red?"), said("Nothing is red."), ev("assistant.turn_end", { turnId: "t" }, "2026-10-23T08:30:00.000Z")];

function copilotDir(): string {
  const root = mkdtempSync(join(tmpdir(), "dovre-copilot-"));
  const put = (id: string, yaml: string, events: string[] | undefined, mtime: number) => {
    const d = join(root, "session-state", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "workspace.yaml"), yaml);
    if (events) {
      writeFileSync(join(d, "events.jsonl"), events.join("\n") + "\n");
      utimesSync(join(d, "events.jsonl"), mtime / 1000, mtime / 1000);
    }
    writeFileSync(join(d, "session.db"), SECRET);
  };
  put(ID_DONE, `id: ${ID_DONE}\ncwd: C:\\Code\\shop-api\ngit_root: C:\\Code\\shop-api\nbranch: fix/login\nname: |-\n  Fix the login\n  bug\nuser_named: false\ncreated_at: 2026-10-23T07:00:00.000Z\n`, doneEvents, NOW - 3 * 3600e3);
  put(ID_ASKS, `id: ${ID_ASKS}\ncwd: C:\\Code\\platform\nname: "Run \\"migrations\\""\n`, asksEvents, NOW - 60e3);
  put(ID_IDLE, `id: ${ID_IDLE}\ncwd: C:\\Code\\dovre\n`, idleEvents, NOW - 30 * 60e3);
  put(ID_EMPTY, `id: ${ID_EMPTY}\ncwd: C:\\Code\\dovre\n`, [start(ID_EMPTY, "C:\\Code\\dovre")], NOW - 60e3);
  put(ID_OLD, `id: ${ID_OLD}\ncwd: C:\\Code\\dovre\n`, idleEvents, NOW - 9 * 86400e3);
  put("0f295857-e2f7-49fb-9544-03b9c3f3316d", "id: x\n", undefined, NOW);
  mkdirSync(join(root, "session-state", "not-a-session"));
  return root;
}

test("workspace.yaml: plain, quoted and block scalars", () => {
  const w = parseWorkspace("id: abc\r\nname: |-\r\n  Two\r\n  lines\r\nsummary: 'it''s'\r\ntitle: \"a \\\"b\\\"\"\r\nfold: >-\n  one\n  two\nempty:\nnested:\n  key: v\n");
  assert.equal(w.id, "abc");
  assert.equal(w.name, "Two\nlines");
  assert.equal(w.summary, "it's");
  assert.equal(w.title, 'a "b"');
  assert.equal(w.fold, "one two");
  assert.equal(w.empty, "");
  assert.equal(w.key, undefined, "nothing nested");
});

test("events: metadata and state, with tool output, hooks, permission text, reasoning and the system prompt never read", () => {
  const m = summarizeCopilotEvents(doneEvents.join("\n"));
  assert.equal(m.sessionId, ID_DONE);
  assert.equal(m.state, "exited");
  assert.equal(m.model, "gpt-5.6-luna", "the newest assistant message's model");
  assert.equal(m.lastPrompt, "fix the login bug", "what was typed, not the transformed content");
  assert.equal(m.userMessages, 1);
  assert.equal(m.summary, "Fixed login; PR 840 open.");
  assert.equal(m.lastAt, "2026-10-23T07:06:00.000Z");
  assert.deepEqual([...m.prs.keys()], ["https://acme.ghe.com/ACME/shop-api/pull/840"]);
  assert.ok(!JSON.stringify({ ...m, prs: [...m.prs.values()] }).includes("hunter2"));

  const asks = summarizeCopilotEvents(asksEvents.join("\n"));
  assert.equal(asks.state, "waiting");
  assert.equal(asks.waitingFor, "a command", "the permission's kind, never its command text");
  assert.ok(!JSON.stringify({ ...asks, prs: [] }).includes("hunter2"));
  assert.equal(summarizeCopilotEvents([...asksEvents, ev("permission.completed", { requestId: "r1", result: { kind: "approved" } })].join("\n")).state, "busy");
  assert.equal(summarizeCopilotEvents(idleEvents.join("\n")).state, "idle", "a turn that ended without tool calls waits for me");
  assert.equal(summarizeCopilotEvents([...idleEvents.slice(0, 2), said("", [call("view", { path: "x" })]), ev("assistant.turn_end", { turnId: "t" })].join("\n")).state, "busy", "a turn that asked for tools goes on");
  assert.equal(summarizeCopilotEvents([...asksEvents, ev("abort", { reason: "user_initiated" })].join("\n")).state, "idle");
  assert.doesNotThrow(() => summarizeCopilotEvents('{"type":"user.message","data":{broken\nnot json\n'));
});

test("sessions list from session-state: recent ones with metadata, empty, old and event-less ones left out", () => {
  const root = copilotDir();
  const { live, recent } = loadCopilotSessions(root, { now: NOW, processes: [] });
  assert.deepEqual(live, [], "no copilot process runs, so nothing is live");
  assert.deepEqual(recent.map((s) => s.sessionId), [ID_ASKS, ID_IDLE, ID_DONE]);
  const done = recent.find((s) => s.sessionId === ID_DONE)!;
  assert.equal(done.harness, "copilot");
  assert.equal(done.title, "Fix the login bug", "workspace.yaml's name, one line");
  assert.equal(done.repo, "shop-api");
  assert.equal(done.branch, "fix/login", "workspace.yaml's branch over the start's");
  assert.equal(done.summary, "Fixed login; PR 840 open.");
  assert.equal(done.prs.length, 1);
  assert.equal(done.cost, undefined, "premium requests aren't dollars");
  assert.equal(recent.find((s) => s.sessionId === ID_ASKS)!.title, 'Run "migrations"');
  assert.ok(!JSON.stringify(recent).includes("hunter2"));
  assert.equal(loadCopilotSessions(join(root, "nope"), { now: NOW }).recent.length, 0);
});

test("live: an open file counts when a copilot process could own it; --resume pins it; a waiting one says for what", () => {
  const root = copilotDir();
  let r = loadCopilotSessions(root, { now: NOW, processes: [{ pid: 1 }] });
  assert.deepEqual(r.live.map((s) => [s.sessionId, s.status, s.waitingFor]), [[ID_ASKS, "waiting", "a command"]], "the newest open file");
  r = loadCopilotSessions(root, { now: NOW, processes: [{ pid: 2, resume: ID_IDLE.slice(0, 8) }, { pid: 3 }] });
  assert.deepEqual(r.live.map((s) => [s.sessionId, s.status, s.pid]), [[ID_ASKS, "waiting", undefined], [ID_IDLE, "idle", 2]], "waiting sorts first");
  r = loadCopilotSessions(root, { now: NOW });
  assert.deepEqual(r.live.map((s) => [s.sessionId, s.status]), [[ID_ASKS, "probably-waiting"], [ID_IDLE, "probably-idle"]], "no process list: open and recent is only probably live");
});

test("command lines: sessions, resumes, and what isn't a session", () => {
  assert.deepEqual(parseCopilotCommandLine(1, '"C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe"'), { pid: 1 });
  assert.deepEqual(parseCopilotCommandLine(2, `copilot.exe --resume ${ID_IDLE} --model gpt-5.6-luna`), { pid: 2, resume: ID_IDLE });
  assert.deepEqual(parseCopilotCommandLine(3, `copilot --session-id=${ID_DONE}`), { pid: 3, resume: ID_DONE });
  assert.deepEqual(parseCopilotCommandLine(4, "copilot -r my-session-name"), { pid: 4 }, "a name isn't an id");
  assert.equal(parseCopilotCommandLine(5, "copilot login"), null);
  assert.equal(parseCopilotCommandLine(6, "copilot --version"), null);
  assert.equal(parseCopilotCommandLine(7, "copilot --acp"), null);
  assert.deepEqual(copilotProcessesOf([{ name: "omp", pid: 8, cmd: "omp" }, { name: "copilot", pid: 9, cmd: "copilot -p hi" }]), [{ pid: 9 }]);
});

test("conversation: what was typed, what was said, one line per tool call; never results, reasoning or the CLI's own calls", () => {
  const turns = copilotTurnsOf([...doneEvents, ...asksEvents].join("\n"));
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "tools", "assistant", "user", "tools"]);
  assert.deepEqual(turns[2], { role: "tools", calls: [{ name: "powershell", detail: "git status" }], at: "2026-10-23T07:00:00.000Z" }, "report_intent left out");
  assert.deepEqual((turns[5] as { calls: unknown[] }).calls, [{ name: "powershell", detail: "dotnet ef database update" }]);
  assert.deepEqual(copilotTurnsOf(said("", [call("apply_patch", "*** Begin Patch", "Patch the file")])), [{ role: "tools", calls: [{ name: "apply_patch", detail: "Patch the file" }], at: "2026-10-23T07:00:00.000Z" }], "a string argument isn't shown; the intent is");
  assert.ok(!JSON.stringify(turns).includes("hunter2"));
  assert.equal(copilotTurnsOf(doneEvents.join("\n"), 2).length, 2);
});

test("by id: found live or from its folder; nothing outside session-state", () => {
  const root = copilotDir();
  assert.equal(copilotSessionById(root, ID_DONE)?.title, "Fix the login bug");
  assert.equal(copilotSessionById(root, "../../etc"), undefined);
  assert.equal(copilotEventsOf(root, "..\\x"), undefined);
  const live = loadCopilotSessions(root, { now: NOW, processes: [{ pid: 1 }] }).live;
  assert.equal(copilotSessionById(root, ID_ASKS, live)?.live, true);
});

test("a Copilot session's row and resume line", () => {
  const root = copilotDir();
  const s = copilotSessionById(root, ID_DONE)!;
  assert.equal(resumeCommand(s), `cd "C:\\Code\\shop-api"; copilot --resume ${ID_DONE}`);
  const row = String(sessionItem(s, { org: "ACME", mine: new Map(), refs: new Map() }));
  assert.match(row, /class="harness copilot"/);
  assert.ok(row.includes(resumeCommand(s).replaceAll('"', "&quot;")));
});

test("a Copilot session's page shows its conversation and how to carry on, with no reply box (turns don't start from here yet)", () => {
  const root = copilotDir();
  const s = copilotSessionById(root, ID_DONE)!;
  const turns = copilotTurnsOf(doneEvents.join("\n"));
  const out = bodyOf(agentPage({ sessionId: ID_DONE, session: s, turns }));
  assert.match(out, /Copilot CLI sessions are read here/);
  assert.ok(out.includes(`copilot --resume ${ID_DONE}`));
  assert.ok(!out.includes('class="chatbox"'), "no reply box");
  assert.match(out, /Fixed login; PR 840 open\./, "the agent's own summary as the recap");
  assert.ok(!out.includes("hunter2"));
});
