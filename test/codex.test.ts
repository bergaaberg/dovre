/** Codex as a harness, its sessions, Bino and summaries through it, and switching harnesses off (PLAN WP-M1). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexApply, codexArgs, codexCost, codexHarness } from "../src/agents/codex.ts";
import { modelOf } from "../src/agents/desk.ts";
import type { Run } from "../src/agents/runner.ts";
import { codexCli } from "../src/ai/llm.ts";
import { routeOf, viaOf } from "../src/packs/core/assistant/bino/route.ts";
import { configFromForm, panesOf } from "../src/config.ts";
import { resumeCommand } from "../src/pages/parts.ts";
import { loadCodexSessions, rolloutMeta } from "../src/sources/codex.ts";
import { harnessesOn, summariesVia } from "../src/tools.ts";

const newRun = (o: Partial<Run> = {}): Run => ({ id: "r1", harness: "codex", forked: false, cwd: "/c/shop-api", repo: "shop-api", prompt: "fix it", mode: "default", model: "", allowed: [], status: "running", startedAt: 1, events: [], partial: "", cost: 0, ...o });

test("a Codex turn never widens its sandbox: plan and default read only, acceptEdits writes in the checkout", () => {
  assert.deepEqual(codexArgs({ cwd: "x", prompt: "p" }), ["exec", "--json", "--sandbox", "read-only", "-"]);
  assert.deepEqual(codexArgs({ cwd: "x", prompt: "p", mode: "plan", model: "gpt-5" }), ["exec", "--json", "--sandbox", "read-only", "--model", "gpt-5", "-"]);
  assert.deepEqual(codexArgs({ cwd: "x", prompt: "p", mode: "acceptEdits", resume: "0199a213-81c0" }), ["exec", "--json", "--sandbox", "workspace-write", "resume", "0199a213-81c0", "-"]);
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    const a = codexArgs({ cwd: "x", prompt: "p", mode }).join(" ");
    assert.doesNotMatch(a, /danger|bypass|full-auto|never/, mode);
  }
  const h = codexHarness("/bin/codex");
  assert.equal(h.stdinPrompt, true);
  assert.equal(h.canFork, false);
});

test("Codex's stream folds into the run: the thread, messages, commands, changes, the end and an estimated cost", () => {
  const run = newRun();
  for (const line of [
    `{"type":"thread.started","thread_id":"0199a213-81c0-7800"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thinking"}}`,
    `{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc 'ls  -la'","exit_code":0,"status":"completed"}}`,
    `{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"rm -rf x","status":"declined"}}`,
    `{"type":"item.completed","item":{"id":"i3","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"},{"path":"b.md","kind":"add"}],"status":"completed"}}`,
    `{"type":"item.completed","item":{"id":"i4","item_type":"agent_message","text":"Fixed it."}}`,
    `not json`,
    `{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":0,"output_tokens":0}}`,
  ])
    codexApply(run, line);
  assert.equal(run.sessionId, "0199a213-81c0-7800");
  assert.deepEqual(run.events, [
    { t: "tool", name: "shell", detail: "bash -lc 'ls -la'" },
    { t: "tool", name: "shell (refused or failed)", detail: "rm -rf x" },
    { t: "tool", name: "edit", detail: "update src/a.ts, add b.md" },
    { t: "text", text: "Fixed it." },
    { t: "result", text: "Fixed it.", cost: 1.25, error: false },
  ]);
  const failed = newRun();
  codexApply(failed, `{"type":"turn.failed","error":{"message":"stream disconnected"}}`);
  assert.deepEqual(failed.events, [{ t: "result", text: "stream disconnected", cost: 0, error: true }]);
  assert.equal(codexCost({ input_tokens: 2_000_000, cached_input_tokens: 1_000_000, output_tokens: 100_000 }), 2.375);
});

test("Codex's models are its own: one it doesn't know falls back to its default", () => {
  assert.equal(modelOf("gpt-5-codex", "codex"), "gpt-5-codex");
  assert.equal(modelOf("opus", "codex"), "");
  assert.equal(modelOf("flash", "agy"), "flash");
});

test("Codex's sessions: id and folder from the rollout's first line, title and last prompt from history; nothing else read", () => {
  const root = mkdtempSync(join(tmpdir(), "dovre-codex-"));
  const day = join(root, "sessions", "2026", "10", "25");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-10-25T06-00-00-aaaa.jsonl"), `{"timestamp":"2026-10-25T06:00:00Z","type":"session_meta","payload":{"id":"aaaa-1111","cwd":"/c/shop-api","instructions":"secret"}}\n{"type":"response_item","payload":{"type":"message","content":"PROD-ROW"}}\n`);
  writeFileSync(join(day, "rollout-2026-10-25T07-00-00-bbbb.jsonl"), `{"type":"session_meta","payload":{"id":"bbbb-2222","cwd":"${join(tmpdir(), "dovre-llm-codex").replace(/\\/g, "\\\\")}"}}\n`);
  writeFileSync(join(root, "history.jsonl"), [`{"session_id":"aaaa-1111","ts":1793000000,"text":"fix the\\nlogin"}`, `{"session_id":"aaaa-1111","ts":1793000600,"text":"and the tests"}`, `garbage`].join("\n"));
  const { live, recent } = loadCodexSessions(root);
  assert.equal(live.length, 0);
  assert.equal(recent.length, 1, "Dovre's own Codex calls aren't sessions");
  const s = recent[0]!;
  assert.equal(s.sessionId, "aaaa-1111");
  assert.equal(s.harness, "codex");
  assert.equal(s.repo, "shop-api");
  assert.equal(s.title, "fix the login");
  assert.equal(s.lastPrompt, "and the tests");
  assert.doesNotMatch(JSON.stringify(s), /secret|PROD-ROW/);
  assert.equal(resumeCommand(s), `cd "/c/shop-api"; codex resume aaaa-1111`);
  assert.deepEqual(rolloutMeta(`{"id":"old-1","timestamp":"2025-01-01T00:00:00Z"}`), { id: "old-1", cwd: undefined, at: "2025-01-01T00:00:00Z" });
  assert.equal(rolloutMeta("nope"), undefined);
  assert.deepEqual(loadCodexSessions(join(root, "missing")), { live: [], recent: [] });
});

test("Bino and summaries go through Codex only when it's chosen, read-only in an empty folder", async () => {
  assert.equal(viaOf(undefined, false, false, false, true), "off");
  assert.equal(viaOf("codex", true), "codex");
  assert.equal(summariesVia(undefined, false, false), "off");
  assert.equal(summariesVia("codex", true, true), "codex");
  assert.equal(routeOf({ via: "codex" }).ready, false);

  let seen: { bin: string; args: string[]; input?: string; cwd?: string } | undefined;
  const run = async (bin: string, args: string[], o: { cwd?: string; input?: string }) => {
    seen = { bin, args, input: o.input, cwd: o.cwd };
    return { code: 0, stdout: [`{"type":"thread.started","thread_id":"t"}`, `{"type":"item.completed","item":{"id":"i","type":"agent_message","text":" Short. "}}`, `{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":100000}}`].join("\n"), stderr: "" };
  };
  const got = await codexCli({ bin: "codex", run })({ system: "Be brief.", user: "Summarise", model: "gpt-5" });
  assert.deepEqual(got, { text: "Short.", cost: 1 });
  assert.deepEqual(seen!.args, ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--model", "gpt-5", "-"]);
  assert.equal(seen!.input, "Be brief.\n\nSummarise");
  assert.match(seen!.cwd!, /dovre-llm-codex$/);
  const failing = async () => ({ code: 1, stdout: `{"type":"turn.failed","error":{"message":"quota"}}`, stderr: "" });
  await assert.rejects(codexCli({ run: failing })({ system: "", user: "x" }), /quota/);

  const route = routeOf({ via: "codex", codex: { bin: "codex", pre: [], path: "/bin/codex" }, run });
  assert.equal(route.ready, true);
  assert.equal((await route.ask!({ system: "s", user: "u" })).text, "Short.");
  assert.equal(panesOf({ BINO_VIA: "codex" }, { claude: true, omp: false, pwsh: false, db: false, terminals: false }).bino.why, "Needs Codex (`codex` on the PATH, or CODEX_BIN).");
  assert.equal(panesOf({ SUMMARIES: "codex" }, { claude: true, omp: false, codex: true, pwsh: false, db: false, terminals: false }).summaries.on, true);
});

test("each agent CLI switches off on its own (AGENT_HARNESSES); unset, all of them", () => {
  const all = harnessesOn(undefined);
  assert.ok((["claude", "omp", "copilot", "agy", "codex"] as const).every(all));
  assert.ok((["claude", "codex"] as const).every(harnessesOn("")));
  const some = harnessesOn(" Claude, codex ");
  assert.equal(some("claude"), true);
  assert.equal(some("codex"), true);
  assert.equal(some("omp"), false);
  assert.equal(some("agy"), false);
  assert.equal(configFromForm({ AGENT_HARNESSES: "claude, codex" }, {}, new Set(), { general: true }).config.AGENT_HARNESSES, "claude, codex");
  assert.deepEqual(configFromForm({ AGENT_HARNESSES: "claude; rm -rf" }, {}, new Set(), { general: true }).bad, ["Agent CLIs to use"]);
});
