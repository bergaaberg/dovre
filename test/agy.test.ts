/** Tests for agy harness, session discovery, and Bino AI Gateway route (PLAN D12, D17, WP-G4). */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agyArgs, agyApply, agyHarness } from "../src/agents/agy.ts";
import type { Run } from "../src/agents/runner.ts";
import { loadAgySessions, parseHistoryLine } from "../src/sources/agy.ts";
import { createCfGatewayAsk, routeOf, viaOf } from "../src/packs/core/assistant/bino/route.ts";
import { agyCli } from "../src/ai/llm.ts";
import { summariesVia } from "../src/tools.ts";

const newRun = (o: Partial<Run> = {}): Run => ({
  id: "r1",
  harness: "agy",
  forked: false,
  cwd: "/Users/test/Code/shop-api",
  repo: "shop-api",
  prompt: "fix issue",
  mode: "default",
  model: "",
  allowed: [],
  status: "running",
  startedAt: 1,
  events: [],
  partial: "",
  cost: 0,
  ...o,
});

test("agyArgs formats flags: mode, model, and conversation resume", () => {
  const base = agyArgs({ cwd: "x", prompt: "hello" });
  assert.deepEqual(base, ["--output-format", "stream-json"]);

  const plan = agyArgs({ cwd: "x", prompt: "hello", mode: "plan", model: "gemini-2.5-pro" });
  assert.deepEqual(plan, ["--output-format", "stream-json", "--mode", "plan", "--model", "gemini-2.5-pro"]);

  const resume = agyArgs({ cwd: "x", prompt: "hello", resume: "conv-123", mode: "acceptEdits" });
  assert.deepEqual(resume, ["--output-format", "stream-json", "--mode", "accept-edits", "--conversation", "conv-123"]);
  assert.equal(agyHarness().stdinPrompt, true);
});

test("agyApply folds stream-json lines into the run", () => {
  const r = newRun();

  // 1. init event
  agyApply(r, JSON.stringify({ event: "init", conversation_id: "conv-456", init: { cwd: "/tmp" } }));
  assert.equal(r.sessionId, "conv-456");

  // 2. step_update streaming text
  agyApply(r, JSON.stringify({ event: "step_update", step_update: { text_delta: "Hello " } }));
  agyApply(r, JSON.stringify({ event: "step_update", step_update: { text_delta: "world!", state: "DONE" } }));
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { t: "text", text: "Hello world!" });
  assert.equal(r.partial, "");

  // 3. tool call
  agyApply(r, JSON.stringify({ event: "step_update", step_update: { tool_calls: [{ name: "run_command", args: { CommandLine: "ls -la" } }] } }));
  assert.equal(r.events.length, 2);
  assert.equal(r.events[1]!.t, "tool");
  assert.equal((r.events[1] as any).name, "run_command");

  // 4. result event
  agyApply(r, JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "All done", usage: { total_tokens: 100_000 } } }));
  const last = r.events[r.events.length - 1]!;
  assert.equal(last.t, "result");
  assert.equal((last as any).text, "All done");
  assert.equal((last as any).error, false);
  assert.ok(r.cost! > 0, "cost was calculated from tokens");
});

test("loadAgySessions reads history.jsonl and extracts sessions with repo names", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-"));
  const history = [
    JSON.stringify({ conversationId: "c1", workspace: "/Users/test/src/dovre", timestamp: 1000, display: "First task" }),
    JSON.stringify({ conversationId: "c2", workspace: "C:\\Code\\shop-api", timestamp: 2000, display: "Second task" }),
  ].join("\n");
  writeFileSync(join(dir, "history.jsonl"), history);

  const { recent } = loadAgySessions(dir);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.sessionId, "c2", "newest timestamp first");
  assert.equal(recent[0]!.repo, "shop-api", "normalized Windows path");
  assert.equal(recent[0]!.harness, "agy");
  assert.equal(recent[1]!.sessionId, "c1");
  assert.equal(recent[1]!.repo, "dovre", "normalized POSIX path");
});

test("an agy session is titled by its first prompt; slash commands like /quit aren't prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-"));
  const line = (timestamp: number, display: string, command = false) => JSON.stringify({ conversationId: "c1", workspace: "/Users/me/src/dovre", timestamp, display, ...(command ? { type: "slash_command" } : {}) });
  writeFileSync(join(dir, "history.jsonl"), [line(1000, "/model", true), line(2000, "Fix the build"), line(3000, "Now the docs"), line(4000, "/quit", true), JSON.stringify({ display: "/model", timestamp: 5000, type: "slash_command" })].join("\n"));
  const [s] = loadAgySessions(dir).recent;
  assert.equal(s!.title, "Fix the build");
  assert.equal(s!.lastPrompt, "Now the docs");
  assert.equal(s!.lastAt, new Date(4000).toISOString(), "a command still says when it was last used");
});

test("viaOf detects agy, cf-gateway, and fallbacks", () => {
  assert.equal(viaOf("cf-gateway", false), "cf-gateway");
  assert.equal(viaOf("agy", false), "agy");
  assert.equal(viaOf(undefined, false, false, false, true), "off", "agy is never picked by itself: it keeps its tools");
  assert.equal(viaOf(undefined, false, true, false, true), "omp");
  assert.equal(viaOf(undefined, true, false, false, true), "claude", "claude takes precedence by default");
});

test("createCfGatewayAsk calls Cloudflare AI Gateway and parses response", async () => {
  let calledUrl = "";
  let calledHeaders: Record<string, string> = {};
  let calledBody: any = null;

  const mockFetch: any = async (url: string, init: any) => {
    calledUrl = url;
    calledHeaders = init.headers;
    calledBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        model: "claude-sonnet-5-5",
        content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Gateway reply." }],
        usage: { input_tokens: 1500, output_tokens: 300 },
      }),
    };
  };

  const ask = createCfGatewayAsk({
    accountId: "acc-123",
    gateway: "my-gateway",
    apiToken: "cf-token",
    fetchFn: mockFetch,
  });

  const res = await ask({ system: "You are Bino.", user: "Status check." });
  assert.equal(res.text, "Gateway reply.");
  assert.equal(res.cost, 0.006, "Sonnet 5.5: 1500 × $2 + 300 × $10 per 1M");
  assert.equal(calledBody.model, "claude-sonnet-5-5", "the default is a model the API serves");
  assert.equal(calledUrl, "https://gateway.ai.cloudflare.com/v1/acc-123/my-gateway/anthropic/v1/messages");
  assert.equal(calledHeaders["cf-aig-authorization"], "Bearer cf-token");
  assert.equal(calledBody.system, "You are Bino.");
  assert.equal(calledBody.messages[0].content, "Status check.");
  await ask({ system: "s", user: "u", model: "haiku" });
  assert.equal(calledBody.model, "claude-haiku-5-5", "the CLI's short names become API ids");
});

test("routeOf handles cf-gateway and agy routes", async () => {
  // cf-gateway unconfigured
  const unconfGateway = routeOf({ via: "cf-gateway" });
  assert.equal(unconfGateway.ready, false);
  assert.match(unconfGateway.why ?? "", /CF_ACCOUNT_ID and CF_AIG_TOKEN/);

  // cf-gateway configured
  const confGateway = routeOf({
    via: "cf-gateway",
    cfGateway: { accountId: "acc-1", apiToken: "tok-1" },
  });
  assert.equal(confGateway.ready, true);
  assert.equal(confGateway.via, "cf-gateway");

  // agy unconfigured (no tool)
  const unconfAgy = routeOf({ via: "agy" });
  assert.equal(unconfAgy.ready, false);
  assert.match(unconfAgy.why ?? "", /install it/);

  // agy configured with mock run
  const mockRun = async () => ({
    code: 0,
    stdout: JSON.stringify({ status: "SUCCESS", response: "Bino reply from agy." }),
    stderr: "",
  });
  const confAgy = routeOf({
    via: "agy",
    agy: { bin: "agy", pre: [], path: "/usr/bin/agy" },
    run: mockRun,
  });
  assert.equal(confAgy.ready, true);
  assert.equal(confAgy.via, "agy");
  const reply = await confAgy.ask!({ system: "System", user: "User" });
  assert.equal(reply.text, "Bino reply from agy.");
  assert.equal(reply.cost, 0);
});

test("summariesVia handles agy", () => {
  assert.equal(summariesVia("agy", false, false, false, true), "agy");
  assert.equal(summariesVia("AGY", false, false, false, true), "agy");
  assert.equal(summariesVia(undefined, false, false, false, true), "off", "only when chosen: agy keeps its tools");
  assert.equal(summariesVia(undefined, true, false, false, true), "claude");
  assert.equal(summariesVia(undefined, false, false, false, false), "off");
});

test("agyCli executes and parses JSON response", async () => {
  let capturedArgs: string[] = [];
  let capturedInput = "";
  const mockRun = async (_bin: string, args: string[], opts: { input?: string }) => {
    capturedArgs = args;
    capturedInput = opts.input ?? "";
    return {
      code: 0,
      stdout: JSON.stringify({ status: "SUCCESS", response: "Summary text.", usage: { total_tokens: 500 } }),
      stderr: "",
    };
  };

  const complete = agyCli({ bin: "custom-agy", run: mockRun });
  const result = await complete({ system: "Summarize this", user: "Changes: diff", model: "flash" });
  assert.equal(result.text, "Summary text.");
  assert.deepEqual(capturedArgs, ["--output-format", "json", "--disable-slash-commands", "--sandbox", "--model", "flash"]);
  assert.equal(capturedInput, "Summarize this\n\nChanges: diff");
});
