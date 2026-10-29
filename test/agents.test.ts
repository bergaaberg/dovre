/** Running agents from Dovre: the CLI args, reading the stream, the narrow allow rules, the conversation, and the routes. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { cleanUserText, turnsOf } from "../src/agents/conversation.ts";
import { cachedTurns } from "../src/agents/desk.ts";
import { createRunner, repoDir, type Run } from "../src/agents/runner.ts";
import { apply, argsFor, HEADLESS_NOTE } from "../src/agents/harnesses/claude/harness.ts";
import { toolSpec } from "../src/agents/harnesses/shared.ts";

const line = (o: object) => JSON.stringify(o);

test("CLI args: headless stream-json, the chosen mode, resume and fork, never a bypass", () => {
  assert.deepEqual(argsFor({ cwd: "x", prompt: "p" }), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "default", "--append-system-prompt", HEADLESS_NOTE]);
  assert.match(HEADLESS_NOTE, /inside this repo's folder/, "told to keep its work in the repo (#163)");
  const a = argsFor({ cwd: "x", prompt: "p", resume: "abc", fork: true, mode: "plan", model: "opus", allowed: ["Bash(dotnet test)"] });
  assert.ok(a.includes("--fork-session") && a.includes("--resume") && a.includes("plan") && a.includes("opus"));
  assert.deepEqual(a.slice(-2), ["--allowedTools", "Bash(dotnet test)"]);
  assert.ok(!argsFor({ cwd: "x", prompt: "p", fork: true }).includes("--fork-session"), "nothing to fork without a resume");
  assert.ok(!a.some((x) => /bypass|dangerously/i.test(x)));
});

test("an allow rule is as narrow as the denied call", () => {
  assert.equal(toolSpec("Bash", { command: "dotnet test" }), "Bash(dotnet test)");
  assert.equal(toolSpec("Edit", { file_path: "C:\\Code\\a\\b.cs" }), "Edit(C:\\Code\\a\\b.cs)");
  assert.equal(toolSpec("WebFetch", { url: "https://docs.example.com/x" }), "WebFetch(domain:docs.example.com)");
  assert.equal(toolSpec("mcp__db__query", { sql: "x" }), "mcp__db__query");
});

const newRun = (): Run => ({ id: "r", harness: "claude", forked: false, cwd: "C:\\Code\\a", repo: "a", prompt: "p", mode: "default", model: "", allowed: [], status: "running", startedAt: 0, events: [], partial: "", cost: 0 });

test("the stream folds into the run: session id, streamed text, tool calls, denials, the result", () => {
  const r = newRun();
  for (const l of [
    line({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" }),
    line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
    line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }),
    "not json",
  ])
    apply(r, l);
  assert.equal(r.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(r.partial, "Hello");
  apply(r, line({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", name: "Bash", input: { command: "dotnet test" } }] } }));
  assert.equal(r.partial, "");
  apply(r, line({ type: "user", message: { content: [{ type: "tool_result", content: "SECRET ROW" }] } }));
  apply(r, line({ type: "result", result: "Done", total_cost_usd: 0.12, permission_denials: [{ tool_name: "Bash", tool_input: { command: "dotnet test" } }] }));
  assert.deepEqual(r.events.map((e) => e.t), ["text", "tool", "denied", "result"]);
  assert.equal((r.events[2] as { spec: string }).spec, "Bash(dotnet test)");
  assert.equal(r.cost, 0.12);
  assert.ok(!JSON.stringify(r).includes("SECRET ROW"), "tool results stay out of the run");
});

test("agents start only in git checkouts right under the code folder", () => {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "shop-api", ".git"), { recursive: true });
  mkdirSync(join(code, "notes"));
  assert.equal(repoDir(code, "shop-api"), join(code, "shop-api"));
  for (const bad of ["notes", "..", "../x", "shop-api/../notes", "C:\\Windows", "", 5]) assert.equal(repoDir(code, bad), null, String(bad));
});

/** A child process that plays back stream-json lines, then exits. */
function fakeSpawn(lines: string[], code = 0) {
  const calls: { bin: string; args: string[]; cwd: string; stdin: string }[] = [];
  const spawnFn = (bin: string, args: string[], opts: { cwd: string }) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let input = "";
    stdin.on("data", (d) => (input += d));
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, pid: 1, kill: () => true });
    calls.push({ bin, args, cwd: opts.cwd, stdin: "" });
    setImmediate(() => {
      calls[calls.length - 1]!.stdin = input;
      for (const l of lines) stdout.write(`${l}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", code));
    });
    return child;
  };
  return { spawnFn, calls };
}

test("a run takes its prompt on stdin, learns its session, and ends done", async () => {
  const { spawnFn, calls } = fakeSpawn([line({ type: "system", subtype: "init", session_id: "s-new" }), line({ type: "result", result: "ok", total_cost_usd: 0 })]);
  const runner = createRunner({ spawnFn });
  const run = runner.start({ cwd: "C:\\Code\\a", prompt: "hi there" });
  assert.equal(await runner.sessionOf(run.id, 2000), "s-new");
  for (let i = 0; i < 50 && runner.get(run.id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.get(run.id)!.status, "done");
  assert.equal(calls[0]!.stdin, "hi there");
  assert.equal(calls[0]!.bin, "claude");
  assert.equal(runner.ofSession("s-new")!.id, run.id);
});

test("the conversation: what was asked and said, tool calls as one line, nothing injected or returned by tools", () => {
  const text = [
    line({ type: "user", message: { content: "Fix the login <system-reminder>secret harness text</system-reminder>" }, timestamp: "t1" }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.cs" } }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "dotnet build" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "PROD ROW 12345678901" }] } }),
    line({ type: "user", isMeta: true, message: { content: "meta" } }),
    line({ type: "user", isSidechain: true, message: { content: "subagent" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
  ].join("\n");
  const turns = turnsOf(text);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "tools", "assistant"]);
  assert.equal((turns[0] as { text: string }).text, "Fix the login");
  assert.deepEqual((turns[2] as { calls: { name: string }[] }).calls.map((c) => c.name), ["Read", "Bash"]);
  const all = JSON.stringify(turns);
  for (const bad of ["secret harness", "PROD ROW", "meta", "subagent"]) assert.ok(!all.includes(bad), bad);
  assert.equal(cleanUserText("<command-name>/clear</command-name>"), "");
});

test("a transcript is parsed again only when it changes (#267)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dovre-cache-")), "t.jsonl");
  const line = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-10-29T07:00:00Z", message: { role: "user", content: text } }) + "\n";
  writeFileSync(file, line("first"));
  let parses = 0;
  const parse = (t: string) => (parses++, turnsOf(t));
  const a = cachedTurns(file, parse);
  assert.equal(cachedTurns(file, parse), a);
  assert.equal(parses, 1);
  appendFileSync(file, line("second"));
  assert.equal(cachedTurns(file, parse).length, 2);
  assert.equal(parses, 2);
  assert.deepEqual(cachedTurns(join(file, "..", "gone.jsonl"), parse), []);
});
