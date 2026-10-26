/** Asking Copilot through omp (src/ai/omp.ts): only on Copilot, through a profile without MCP servers, and a tool call throws the run away. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerOf, ompAsker } from "../src/ai/omp.ts";

const who = { name: "The asker", profileVar: "ASK_PROFILE", modelVar: "ASK_MODEL" };

test("an omp asker runs only on Copilot through a profile without MCP servers, and a tool call throws the run away", async () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-copilot-"));
  const make = (model: string, omp: { bin: string; pre: string[] } | null = { bin: "omp", pre: [] }) => ompAsker({ omp: omp ?? undefined, profile: "dovre-copilot", model, cwd: home, home, who, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.match(make("github-copilot/gpt-6-luna:medium").why()!, /omp --profile dovre-copilot/, "no profile yet: says how to make one");
  mkdirSync(join(home, ".omp", "profiles", "dovre-copilot", "agent"), { recursive: true });
  assert.equal(make("github-copilot/gpt-6-luna:medium").why(), undefined);
  assert.match(make("anthropic/claude-sonnet").why()!, /^The asker runs only on a Copilot model.*ASK_MODEL is anthropic/, "names who and its setting");
  assert.match(make("github-copilot/x", null).why()!, /^The asker needs omp/);
  writeFileSync(join(home, ".omp", "profiles", "dovre-copilot", "agent", "mcp.json"), "{}");
  assert.match(make("github-copilot/gpt-6-luna:medium").why()!, /must have none/);
  await assert.rejects(make("github-copilot/gpt-6-luna:medium").ask("hi"), /must have none/, "asking refuses what why() refuses");
  const line = (j: unknown) => JSON.stringify(j);
  const said = (text: string, provider = "github-copilot") => line({ type: "message_end", message: { role: "assistant", provider, content: [{ type: "text", text }] } });
  assert.equal(answerOf({ code: 0, stdout: [said('{"findings":[]}')].join("\n"), stderr: "" }), '{"findings":[]}');
  assert.throws(() => answerOf({ code: 0, stdout: [line({ type: "tool_execution_start", toolName: "mcp__db_query" }), said("x")].join("\n"), stderr: "" }), /tried a tool/);
  assert.throws(() => answerOf({ code: 0, stdout: line({ type: "message_end", message: { role: "assistant", provider: "github-copilot", content: [{ type: "toolCall" }] } }), stderr: "" }), /tried a tool/);
  assert.throws(() => answerOf({ code: 0, stdout: said("x", "anthropic"), stderr: "" }), /not Copilot/);
  assert.throws(() => answerOf({ code: 1, stdout: "", stderr: "boom\nlast line" }), /omp ended with 1: last line/);
});

test("an omp asker sends no tools, no session and the system prompt as omp's, the question on stdin", async () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-copilot-"));
  mkdirSync(join(home, ".omp", "profiles", "p1", "agent"), { recursive: true });
  const seen: { args: string[]; input: string }[] = [];
  const said = JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "github-copilot", content: [{ type: "text", text: "Hei" }] } });
  const a = ompAsker({ omp: { bin: "omp", pre: ["--x"] }, profile: "p1", model: "github-copilot/m", cwd: home, home, who, run: async (_b, args, o) => (seen.push({ args, input: o.input }), { code: 0, stdout: said, stderr: "" }) });
  assert.equal(await a.ask("the question", { system: "be brief" }), "Hei");
  const { args, input } = seen[0]!;
  assert.equal(args[0], "--x");
  for (const f of ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp"]) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf("--approval-mode") + 1], "always-ask");
  assert.equal(args[args.indexOf("--profile") + 1], "p1");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "be brief");
  assert.equal(input, "the question");
  assert.ok(!args.includes("the question"), "the question isn't an argument");
});
