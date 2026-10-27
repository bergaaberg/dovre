/** omp: its session files, live detection, conversation, and the headless harness. Temp dirs only, never the real ~/.omp. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OMP_MODELS, allowOverlay, ompApply, ompArgs, ompHarness, ompToolDetail } from "../src/agents/harnesses/omp/harness.ts";
import { createRunner, type Run } from "../src/agents/runner.ts";
import { liveness, loadOmpSessions, ompAgentDirs, ompProfileOf, ompSessionById, ompTranscriptOf, ompTurnsOf, parseCollabHosts, parseOmpCommandLine, summarizeOmpTranscript } from "../src/sources/omp.ts";

const line = (o: object) => JSON.stringify(o);
const SECRET = "Password=hunter2;Server=prod-db";
const NOW = Date.parse("2026-10-22T09:00:00Z");

const ID_DONE = "01a162a4-b00b-7282-b953-2190fe719dfa";
const ID_IDLE = "01a1629b-e49c-71e4-9f1b-30b0af5e36ba";
const ID_BUSY = "01a162af-65ad-7136-aaf4-2567554b2463";
const ID_EMPTY = "01a0ccf0-cdf7-746c-8509-0481205d9a9d";
const ID_OLD = "01a0b445-4609-7560-82fa-88dfe1db579b";

/** The real shape: a padded `title` header omp rewrites in place, then `session`. */
const header = (id: string, cwd: string, title = "") => {
  const t = { type: "title", v: 1, title, source: "auto", updatedAt: "2026-10-22T07:00:00Z", pad: "" };
  return [line({ ...t, pad: " ".repeat(Math.max(0, 254 - line(t).length)) }), line({ type: "session", version: 3, id, timestamp: "2026-10-22T07:00:00.000Z", cwd, title })];
};
const user = (text: string, ts: string) => line({ type: "message", id: "u" + ts, parentId: "x", timestamp: ts, message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: 1 } });
const assistant = (content: object[], stopReason: string, ts: string, cost = 0.01, model = "gpt-6-luna") =>
  line({ type: "message", id: "a" + ts, parentId: "x", timestamp: ts, message: { role: "assistant", content, api: "openai-responses", provider: "github-copilot", model, usage: { input: 3, output: 5, cost: { total: cost } }, stopReason, timestamp: 2 } });
const toolStart = (ts: string, name: string, args: object) => line({ type: "custom", customType: "tool_execution_start", data: { toolCallId: "call_1", toolName: name, args, startedAt: ts }, id: "c" + ts, parentId: "x", timestamp: ts });
const toolResult = (ts: string, text: string) => line({ type: "message", id: "r" + ts, parentId: "x", timestamp: ts, message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 3 } });
const exit = (ts: string) => line({ type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal", recordedAt: ts }, id: "e" + ts, parentId: "x", timestamp: ts });

/** A finished session with everything that must and mustn't come out of it. */
const doneSession = [
  ...header(ID_DONE, "C:\\Code\\shop-api", "Fix the login bug"),
  line({ type: "model_change", id: "m", parentId: null, timestamp: "2026-10-22T07:00:01Z", model: "github-copilot/gpt-6-luna", role: "default" }),
  line({ type: "thinking_level_change", id: "t", parentId: "m", timestamp: "2026-10-22T07:00:01Z", thinkingLevel: "high" }),
  user("fix the login bug", "2026-10-22T07:01:00Z"),
  line({ type: "custom", customType: "system-prompt-digest", data: "abc", id: "d", parentId: "x", timestamp: "2026-10-22T07:01:00Z" }),
  assistant([{ type: "thinking", thinking: "private chain of thought" }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "dotnet test", i: "Running tests" } }], "toolUse", "2026-10-22T07:01:05Z"),
  toolStart("2026-10-22T07:01:05Z", "bash", { command: "dotnet test" }),
  toolResult("2026-10-22T07:01:30Z", `${SECRET} https://acme.ghe.com/ACME/leak/pull/9`),
  line({ type: "custom_message", customType: "async-result", content: `job output ${SECRET}`, display: true, attribution: "agent", id: "cm", parentId: "x", timestamp: "2026-10-22T07:01:31Z" }),
  line({ type: "message", id: "dev", parentId: "x", timestamp: "2026-10-22T07:01:31Z", message: { role: "developer", content: [{ type: "text", text: "<system-reminder>injected</system-reminder>" }], attribution: "agent" } }),
  assistant([{ type: "text", text: "Fixed it and opened https://acme.ghe.com/ACME/shop-api/pull/812." }], "stop", "2026-10-22T07:02:00Z", 0.02),
  line({ type: "title_change", id: "tc", parentId: "x", timestamp: "2026-10-22T07:02:01Z", title: "Older title", previousTitle: "", source: "auto" }),
  exit("2026-10-22T07:03:00Z"),
  user("/skill review", "2026-10-22T07:10:00Z"),
  assistant([{ type: "text", text: "Reviewed." }], "stop", "2026-10-22T07:10:30Z", 0.03, "gpt-6-sol"),
  exit("2026-10-22T07:11:00Z"),
].join("\n");

function ompDir() {
  const agent = join(mkdtempSync(join(tmpdir(), "omp-")), "agent");
  const put = (enc: string, id: string, ts: string, lines: string, mtime: string) => {
    mkdirSync(join(agent, "sessions", enc, `${ts}_${id}`), { recursive: true }); // omp's tool-log folder beside each file
    const f = join(agent, "sessions", enc, `${ts}_${id}.jsonl`);
    writeFileSync(f, lines + "\n");
    utimesSync(f, new Date(mtime), new Date(mtime));
  };
  put("-Code-shop-api", ID_DONE, "2026-10-22T07-00-00-000Z", doneSession, "2026-10-22T07:11:00Z");
  // Open, last thing an assistant reply that stopped: waiting for the next prompt.
  put("-Code-platform", ID_IDLE, "2026-10-22T07-55-46-205Z", [...header(ID_IDLE, "C:\\Code\\platform"), user("what changed?", "2026-10-22T08:00:00Z"), assistant([{ type: "text", text: "Two files." }], "stop", "2026-10-22T08:00:10Z")].join("\n"), "2026-10-22T08:00:10Z");
  // Open, last thing a tool result: working.
  put("-Code-platform", ID_BUSY, "2026-10-22T08-17-04-429Z", [...header(ID_BUSY, "C:\\Code\\platform"), user("run the tests", "2026-10-22T08:30:00Z"), toolStart("2026-10-22T08:30:05Z", "bash", { command: "pnpm test" }), toolResult("2026-10-22T08:30:20Z", SECRET)].join("\n"), "2026-10-22T08:30:20Z");
  // Started and quit without a word: not listed.
  put("-Code-shop-web", ID_EMPTY, "2026-10-22T06-25-28-567Z", [...header(ID_EMPTY, "C:\\Code\\shop-web"), exit("2026-10-22T06:26:00Z")].join("\n"), "2026-10-22T06:26:00Z");
  // Too old for the window.
  put("-Code-shop-web", ID_OLD, "2026-09-18T11-27-13-929Z", [...header(ID_OLD, "C:\\Code\\shop-web", "Old"), user("old", "2026-09-18T11:30:00Z"), exit("2026-09-18T11:40:00Z")].join("\n"), "2026-09-18T11:40:00Z");
  const db = new DatabaseSync(join(agent, "history.db"));
  db.exec("CREATE TABLE session_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL, recap TEXT NOT NULL, created_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, ?)").run(ID_DONE, "C:\\Code\\shop-api", "Old recap", 1792650000);
  db.prepare("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, ?)").run(ID_DONE, "C:\\Code\\shop-api", "Fixed login; PR 812 open.", 1792652000);
  db.prepare("INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)").run(ID_IDLE, "Platform changes", 1);
  db.close();
  return agent;
}

test("a transcript's metadata: header title, the model actually used, typed prompts, PRs from replies, cost; nothing from tool output", () => {
  const m = summarizeOmpTranscript(doneSession);
  assert.equal(m.sessionId, ID_DONE);
  assert.equal(m.cwd, "C:\\Code\\shop-api");
  assert.equal(m.title, "Fix the login bug", "the in-place header wins over the title_change log");
  assert.equal(m.model, "github-copilot/gpt-6-sol");
  assert.equal(m.lastPrompt, "fix the login bug", "slash commands aren't prompts");
  assert.equal(m.userMessages, 2);
  assert.equal(m.state, "exited");
  assert.equal(m.lastAt, "2026-10-22T07:11:00Z");
  assert.ok(Math.abs((m.cost ?? 0) - 0.06) < 1e-9);
  assert.deepEqual([...m.prs.values()], [{ url: "https://acme.ghe.com/ACME/shop-api/pull/812", repo: "ACME/shop-api", number: 812 }], "a PR URL in a tool result doesn't count");
  const out = JSON.stringify({ ...m, prs: [...m.prs.values()] });
  assert.ok(!out.includes("hunter2") && !out.includes("injected") && !out.includes("chain of thought"));
});

test("sessions list from every encoded-cwd folder: recent ones with metadata and recap, empty and old ones left out", () => {
  const agent = ompDir();
  const { live, recent } = loadOmpSessions(agent, { now: NOW, processes: [] });
  assert.deepEqual(live, [], "no omp process runs, so nothing is live");
  assert.deepEqual(recent.map((s) => s.sessionId), [ID_BUSY, ID_IDLE, ID_DONE]);
  const done = recent.find((s) => s.sessionId === ID_DONE)!;
  assert.equal(done.harness, "omp");
  assert.equal(done.model, "github-copilot/gpt-6-sol");
  assert.equal(done.repo, "shop-api");
  assert.equal(done.title, "Fix the login bug");
  assert.equal(done.summary, "Fixed login; PR 812 open.", "the newest recap");
  assert.equal(done.summaryAt, new Date(1792652000 * 1000).toISOString());
  assert.equal(done.prs.length, 1);
  assert.equal(done.subagentsRunning, 0);
  assert.equal(done.live, false);
  assert.equal(recent.find((s) => s.sessionId === ID_IDLE)!.title, "Platform changes", "history.db's title when the file has none");
  assert.ok(!JSON.stringify(recent).includes("hunter2"));
  assert.equal(loadOmpSessions(agent, { now: NOW, processes: [], limit: 1 }).recent.length, 1);
  assert.equal(loadOmpSessions(join(agent, "nope"), { now: NOW }).recent.length, 0);
});

test("live: an open file counts only when an omp process of that profile could own it; --resume pins it", () => {
  const agent = ompDir();
  // One process, no --resume: it owns the most recently written open file.
  let r = loadOmpSessions(agent, { now: NOW, processes: [{ pid: 1 }] });
  assert.deepEqual(r.live.map((s) => [s.sessionId, s.status, s.live]), [[ID_BUSY, "busy", true]]);
  assert.ok(!r.recent.some((s) => s.sessionId === ID_BUSY), "a live session isn't also recent");
  // --resume <prefix> names the session; the other process takes the next open one.
  r = loadOmpSessions(agent, { now: NOW, processes: [{ pid: 2, resume: ID_IDLE.slice(0, 13) }, { pid: 3 }] });
  assert.deepEqual(r.live.map((s) => [s.sessionId, s.status, s.pid]), [[ID_IDLE, "idle", 2], [ID_BUSY, "busy", undefined]], "idle sorts first; a guessed owner has no pid");
  // Another profile's process doesn't make this profile's sessions live.
  assert.equal(loadOmpSessions(agent, { now: NOW, processes: [{ pid: 4, profile: "work" }] }).live.length, 0);
  assert.equal(loadOmpSessions(agent, { now: NOW, processes: [{ pid: 4, profile: "work" }], profile: "work" }).live.length, 1);
  // No process list: open and recently written is only "probably" live.
  r = loadOmpSessions(agent, { now: NOW });
  assert.deepEqual(r.live.map((s) => [s.sessionId, s.status]), [[ID_IDLE, "probably-idle"], [ID_BUSY, "probably-busy"]]);
  assert.equal(loadOmpSessions(agent, { now: NOW + 13 * 3600e3, days: 30 }).live.length, 0, "stale open files are crashes, not sessions");
});

test("live: a Collab host is omp's own word, with busy / input required", () => {
  const agent = ompDir();
  const hosts = parseCollabHosts(JSON.stringify({ version: 1, hosts: [{ instanceId: "abcdefgh", generation: 1, pid: 9, sessionId: ID_DONE, sessionName: null, cwd: "C:\\Code\\shop-api", model: { provider: "github-copilot", id: "gpt-6-luna" }, startedAt: 1, participants: 1, relayConnected: true, inputRequired: true, busy: false, access: "control" }, { pid: "x" }] }));
  assert.deepEqual(hosts.map((h) => [h.sessionId, h.pid, h.model, h.inputRequired, h.busy]), [[ID_DONE, 9, "github-copilot/gpt-6-luna", true, false]]);
  const { live } = loadOmpSessions(agent, { now: NOW, processes: [], hosts, isAlive: (pid) => pid === 9 });
  assert.deepEqual(live.map((s) => [s.sessionId, s.status, s.pid]), [[ID_DONE, "waiting", 9]]);
  assert.equal(loadOmpSessions(agent, { now: NOW, processes: [], hosts, isAlive: () => false }).live.length, 0, "a dead host's entry is stale");
});

test("liveness is pure over (id, mtime, state)", () => {
  const files = [{ id: "a", mtime: NOW - 60e3, state: "idle" as const }, { id: "b", mtime: NOW - 120e3, state: "exited" as const }];
  const l = liveness(files, { now: NOW, openHours: 12, isAlive: () => true, processes: [{ pid: 1 }, { pid: 2 }] });
  assert.deepEqual([...l.entries()], [["a", { live: true, status: "idle" }]], "an exited session never becomes live, whatever the process count");
});

test("process command lines: sessions are kept, workers, subcommands and --no-session runs aren't", () => {
  const exe = '"C:\\Users\\me\\AppData\\Local\\omp\\omp.exe"';
  assert.deepEqual(parseOmpCommandLine(1, `${exe} --profile company-db`), { pid: 1, profile: "company-db" });
  assert.deepEqual(parseOmpCommandLine(2, `${exe} -p --mode json --approval-mode always-ask --resume ${ID_IDLE}`), { pid: 2, resume: ID_IDLE });
  assert.deepEqual(parseOmpCommandLine(3, `omp --profile=work -r 01a1629b "fix it"`), { pid: 3, profile: "work", resume: "01a1629b" });
  assert.deepEqual(parseOmpCommandLine(4, "omp"), { pid: 4 });
  for (const c of [`${exe} __omp_worker_daemon_broker`, "omp collab list --json", "omp models", `omp -p --no-session "hi"`]) assert.equal(parseOmpCommandLine(9, c), null, c);
});

test("transcripts are found by id across folders and profiles", () => {
  const agent = ompDir();
  const home = join(agent, "..", "home");
  const work = join(home, ".omp", "profiles", "work", "agent", "sessions", "-Code");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, `2026-10-22T07-00-00-000Z_${ID_BUSY}.jsonl`), header(ID_BUSY, "C:\\Code").join("\n"));
  mkdirSync(join(home, ".omp", "agent", "sessions"), { recursive: true });
  assert.deepEqual(ompAgentDirs(home).map((d) => d.profile), [undefined, "work"]);
  assert.equal(ompProfileOf(ID_BUSY, home), "work");
  assert.equal(ompProfileOf(ID_DONE, home), undefined);
  assert.ok(ompTranscriptOf(agent, ID_DONE)?.endsWith(`_${ID_DONE}.jsonl`));
  assert.equal(ompTranscriptOf(agent, "../../etc/passwd"), undefined);
  assert.equal(ompSessionById(agent, ID_DONE)?.title, "Fix the login bug");
  assert.equal(ompSessionById(agent, "01a162a4-0000-0000-0000-000000000000"), undefined);
});

test("the conversation: typed text, replies, one line per tool call; never tool results, injected text or thinking", () => {
  const turns = ompTurnsOf(doneSession);
  assert.deepEqual(turns.map((t) => (t.role === "tools" ? ["tools", t.calls] : t.role === "ask" ? ["ask", t.questions] : [t.role, t.text])), [
    ["user", "fix the login bug"],
    ["tools", [{ name: "bash", detail: "dotnet test" }]],
    ["assistant", "Fixed it and opened https://acme.ghe.com/ACME/shop-api/pull/812."],
    ["user", "/skill review"],
    ["assistant", "Reviewed."],
  ]);
  assert.equal(turns[0].at, "2026-10-22T07:01:00Z");
  const out = JSON.stringify(turns);
  for (const bad of ["hunter2", "job output", "injected", "chain of thought", "leak"]) assert.ok(!out.includes(bad), bad);
  assert.equal(ompTurnsOf(doneSession, 2).length, 2);
});

test("tool detail: the command, the pattern and where, the file; never contents", () => {
  assert.equal(ompToolDetail("bash", { command: "git  status\n--short" }), "git status --short");
  assert.equal(ompToolDetail("grep", { pattern: "TODO", path: "src" }), "TODO in src");
  assert.equal(ompToolDetail("write", { path: "c.txt", content: SECRET }), "c.txt");
  assert.equal(ompToolDetail("web_search", { query: "omp approval" }), "omp approval");
  assert.equal(ompToolDetail("todo", { op: "add", i: "Tracking work" }), "Tracking work");
  assert.equal(ompToolDetail("x", null), "");
});

test("args: headless json, an explicit approval mode that is never yolo, model, resume, fork, profile", () => {
  const base = { cwd: "C:\\Code\\x", prompt: "hi" };
  const a = ompArgs(base);
  assert.deepEqual(a, ["-p", "--mode", "json", "--approval-mode", "always-ask"]);
  assert.ok(!a.includes("hi"), "the prompt goes on stdin");
  assert.deepEqual(ompArgs({ ...base, mode: "acceptEdits" }).slice(3, 5), ["--approval-mode", "write"]);
  const plan = ompArgs({ ...base, mode: "plan" });
  assert.deepEqual(plan.slice(3, 6), ["--approval-mode", "always-ask", "--append-system-prompt"]);
  assert.match(plan[6], /do not edit/);
  assert.deepEqual(ompArgs({ ...base, model: "github-copilot/gpt-6-luna" }).slice(-2), ["--model", "github-copilot/gpt-6-luna"]);
  assert.deepEqual(ompArgs({ ...base, resume: ID_IDLE }).slice(-2), ["--resume", ID_IDLE]);
  const fork = ompArgs({ ...base, resume: ID_IDLE, fork: true });
  assert.deepEqual(fork.slice(-2), ["--fork", ID_IDLE]);
  assert.ok(!fork.includes("--resume"));
  assert.deepEqual(ompArgs({ ...base, resume: ID_IDLE }, { profileOf: (id) => (id === ID_IDLE ? "company-db" : undefined) }).slice(-4), ["--profile", "company-db", "--resume", ID_IDLE]);
  // Values that would be read as flags, or aren't ids/models, are dropped.
  assert.deepEqual(ompArgs({ ...base, model: "--auto-approve", resume: "--approval-mode=yolo" }), a);
  const overlayDir = mkdtempSync(join(tmpdir(), "omp-allow-"));
  for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions" as any]) {
    const x = ompArgs({ ...base, mode, allowed: ["bash"] }, { overlayDir }).join(" ");
    assert.ok(!/yolo|--auto-approve|--plan-yolo/.test(x), x);
  }
  const h = ompHarness("omp.exe");
  assert.deepEqual([h.id, h.bin, h.stdinPrompt, h.canFork], ["omp", "omp.exe", true, true]);
  assert.ok(OMP_MODELS.length < 6 && OMP_MODELS[0].value === "" && OMP_MODELS.slice(1).every((m) => m.value.startsWith("github-copilot/")));
});

test("allowed tools go in as a --config overlay with only tool names in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-allow-"));
  const a = ompArgs({ cwd: "C:\\x", prompt: "go", allowed: ["write", "bash", 'x": "allow"}, "evil'] }, { overlayDir: dir });
  const i = a.indexOf("--config");
  assert.ok(i > 0);
  assert.deepEqual(JSON.parse(readFileSync(a[i + 1], "utf8")), { tools: { approval: { bash: "allow", write: "allow" } } });
  assert.equal(allowOverlay(["bash", "write"], dir), a[i + 1], "the same set reuses its file");
  assert.equal(allowOverlay(["Bash(rm -rf /)"], dir), undefined);
  assert.ok(!ompArgs({ cwd: "C:\\x", prompt: "go", allowed: ["Bash(rm -rf /)"] }, { overlayDir: dir }).includes("--config"));
});

/** A real `omp -p --mode json --approval-mode always-ask` run (a write it may not do), trimmed: no signatures, ids or paths. */
const STREAM = [
  { type: "session", version: 3, id: ID_DONE, timestamp: "2026-10-22T08:05:22.571Z", cwd: "C:\\Code\\probe" },
  { type: "advisor_cost_changed" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Create a file named c.txt containing the word hi." }], attribution: "user", timestamp: 1 } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Create a file named c.txt containing the word hi." }], attribution: "user", timestamp: 1 } },
  { type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "toolCall", id: "call_1", name: "write", arguments: {} }], provider: "github-copilot", model: "gpt-6-luna", usage: { cost: { total: 0 } }, stopReason: "stop" } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"c.txt"' } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: { i: "Creating requested file", path: "c.txt", content: "hi\n" } } } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "toolCall", id: "call_1", name: "write", arguments: { i: "Creating requested file", path: "c.txt", content: "hi\n" }, intent: "Creating requested file" }], provider: "github-copilot", model: "gpt-6-luna", usage: { input: 3, output: 46, cost: { total: 0.00010409 } }, stopReason: "toolUse" } },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "write", args: { path: "c.txt", content: "hi\n" }, intent: "Creating requested file" },
  { type: "tool_execution_end", toolCallId: "call_1", toolName: "write", result: { content: [{ type: "text", text: 'Tool "write" requires approval but no interactive UI available.\nOptions:\n  1. Set tools.approvalMode: yolo in /settings\n  2. Add tools.approval.write: allow to config\n  3. Use an interactive UI to approve the tool call' }], details: {} }, isError: true },
  { type: "message_end", message: { role: "toolResult", toolCallId: "call_1", toolName: "write", content: [{ type: "text", text: "Tool \"write\" requires approval" }], isError: true } },
  { type: "turn_end" },
  { type: "turn_start" },
  // As captured: the assistant's message_start already holds the finished text.
  { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Couldn’t create `c.txt`: the write tool requires approval." }], provider: "github-copilot", model: "gpt-6-luna", usage: { cost: { total: 0 } }, stopReason: "stop" } },
  { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Couldn’t create" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " `c.txt`" } },
  { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Couldn’t create `c.txt`: the write tool requires approval." } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Couldn’t create `c.txt`: the write tool requires approval." }], provider: "github-copilot", model: "gpt-6-luna", usage: { input: 3, output: 183, cost: { total: 0.000173855 } }, stopReason: "stop" } },
  { type: "turn_end" },
  { type: "agent_end", messages: [], isTerminal: true, yielded: true },
].map(line);

const newRun = (over: Partial<Run> = {}): Run => ({ id: "r", harness: "omp", forked: false, cwd: "C:\\Code\\probe", repo: "probe", prompt: "p", mode: "default", model: "", allowed: [], status: "running", startedAt: 0, events: [], partial: "", cost: 0, ...over });

test("apply folds the json stream: session id, streamed text, tool call, denial, one result", () => {
  const run = newRun();
  const partials: string[] = [];
  for (const l of [...STREAM, "not json", line({ type: "something_new" })]) {
    ompApply(run, l);
    partials.push(run.partial);
  }
  assert.equal(run.sessionId, ID_DONE);
  assert.ok(partials.includes("Couldn’t create `c.txt`"), "deltas stream into partial");
  assert.equal(run.partial, "");
  assert.deepEqual(run.events, [
    { t: "tool", name: "write", detail: "c.txt" },
    { t: "denied", tool: "write", spec: "write", detail: "c.txt" },
    { t: "text", text: "Couldn’t create `c.txt`: the write tool requires approval." },
    { t: "result", text: "Couldn’t create `c.txt`: the write tool requires approval.", cost: 0.00010409 + 0.000173855, error: false },
  ]);
  assert.ok(!JSON.stringify(run).includes("hi\\n"), "file contents from tool args aren't kept");
});

test("apply: resume and fork take the id omp reports; a failed last message is an error result", () => {
  const resumed = newRun({ sessionId: ID_IDLE, resumed: ID_IDLE });
  ompApply(resumed, line({ type: "session", id: ID_IDLE, parentSession: undefined }));
  assert.equal(resumed.sessionId, ID_IDLE);
  const forked = newRun({ resumed: ID_IDLE, forked: true });
  ompApply(forked, line({ type: "session", id: ID_BUSY, parentSession: ID_IDLE }));
  assert.equal(forked.sessionId, ID_BUSY);
  const failed = newRun();
  ompApply(failed, line({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited", usage: { cost: { total: 0 } } } }));
  ompApply(failed, line({ type: "agent_end", messages: [], isTerminal: true }));
  assert.deepEqual(failed.events, [{ t: "result", text: "429 rate limited", cost: 0, error: true }]);
  // A tool that failed on its own isn't a denial.
  const plain = newRun();
  ompApply(plain, line({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [{ type: "text", text: `exit 1 ${SECRET}` }] }, isError: true }));
  assert.deepEqual(plain.events, []);
});

test("the runner drives omp: args, prompt on stdin, stream to a finished run", async () => {
  let spawned: { bin: string; args: string[]; cwd: string; stdin?: string } | undefined;
  const fake = () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (s: string) => (spawned!.stdin = s) };
    setImmediate(() => {
      child.stdout.emit("data", STREAM.slice(0, 10).join("\n") + "\n");
      child.stdout.emit("data", STREAM.slice(10).join("\n"));
      child.emit("close", 0);
    });
    return child;
  };
  const runner = createRunner({ harnesses: { omp: ompHarness("omp") }, spawnFn: (bin, args, o) => ((spawned = { bin, args, cwd: o.cwd }), fake()) });
  const run = runner.start({ harness: "omp", cwd: "C:\\Code\\probe", prompt: "-starts with a dash", resume: ID_DONE, mode: "default" });
  assert.equal(await runner.sessionOf(run.id, 2000), ID_DONE);
  for (let i = 0; i < 50 && run.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(spawned?.bin, "omp");
  assert.deepEqual(spawned?.args.slice(-2), ["--resume", ID_DONE]);
  assert.equal(spawned?.stdin, "-starts with a dash");
  assert.equal(run.status, "done");
  assert.deepEqual(run.events.map((e) => e.t), ["tool", "denied", "text", "result"]);
});
