/** Agent turns run apart from the server (the agent host): they survive a restart, and what's kept of them is only what's shown. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRunner, type Harness, type Run } from "../src/agents/runner.ts";
import { apply } from "../src/agents/harnesses/claude/harness.ts";

const exe = fileURLToPath(new URL(`../bin/dovre${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const skip = existsSync(exe) ? false : "the launcher isn't built (pwsh scripts/install.ps1, or go build in launcher/)";

/** A stand-in for claude: reads the prompt, talks in stream-json, uses a tool whose result holds a secret. */
function fakeAgent(dir: string, waitMs = 0): Harness {
  const script = join(dir, "agent.mjs");
  writeFileSync(
    script,
    `let p = ""; process.stdin.on("data", (d) => (p += d)).on("end", async () => {
  const out = (j) => process.stdout.write(JSON.stringify(j) + "\\n");
  out({ type: "system", subtype: "init", session_id: "sess-1", cwd: "C:/secret/path" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Reading: " + p }, { type: "tool_use", name: "Bash", input: { command: "db ledger:prod q x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", content: "PROD-ROW secret=hunter2" }] } });
  await new Promise((r) => setTimeout(r, ${waitMs}));
  out({ type: "result", result: "All done.", total_cost_usd: 0.02, is_error: false, session_id: "sess-1" });
});`,
  );
  return { id: "claude", bin: process.execPath, pre: [script], args: () => [], apply, stdinPrompt: true, canFork: true };
}

const until = async (ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("a turn through the agent host ends with its text and cost, and no tool result is kept on disk", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-runs-"));
  const runner = createRunner({ harnesses: { claude: fakeAgent(dir) }, host: { exe, dir: join(dir, "runs") } });
  const run = runner.start({ cwd: dir, prompt: "the PR" });
  await until(() => run.status !== "running");
  assert.equal(run.status, "done");
  assert.equal(run.sessionId, "sess-1");
  assert.equal(run.cost, 0.02);
  assert.ok(run.events.some((e) => e.t === "text" && e.text === "Reading: the PR"));
  assert.ok(run.events.some((e) => e.t === "tool" && e.detail.includes("db ledger:prod")));
  for (const f of readdirSync(join(dir, "runs"))) {
    const text = readFileSync(join(dir, "runs", f), "utf8");
    assert.ok(!text.includes("hunter2"), `${f} holds a tool result`);
    assert.ok(!text.includes("C:/secret/path"), `${f} holds more of init than its session id`);
  }
});

test("a turn still going when the server restarts goes on, and the new server picks it up", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-runs-"));
  const host = { exe, dir: join(dir, "runs") };
  const before = createRunner({ harnesses: { claude: fakeAgent(dir, 1500) }, host });
  const run = before.start({ cwd: dir, prompt: "long one" });
  await until(() => !!run.sessionId);
  // A new server: knows nothing but the files.
  const seen: Run[] = [];
  const after = createRunner({ harnesses: { claude: fakeAgent(dir, 1500) }, host, onChange: (r) => seen.push(r) });
  const again = after.get(run.id);
  assert.ok(again, "the run is listed again");
  assert.equal(again.status, "running");
  await until(() => again.status !== "running");
  assert.equal(again.status, "done");
  assert.ok(again.events.some((e) => e.t === "result" && e.text === "All done."));
  assert.ok(seen.length > 0, "and pages hear about it");
  // A third start finds it finished, with its events.
  const later = createRunner({ harnesses: { claude: fakeAgent(dir) }, host }).get(run.id);
  assert.equal(later?.status, "done");
  assert.ok(later?.events.some((e) => e.t === "text"));
});

test("stop ends a turn in the host, and it stays stopped", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-runs-"));
  const runner = createRunner({ harnesses: { claude: fakeAgent(dir, 20_000) }, host: { exe, dir: join(dir, "runs") } });
  const run = runner.start({ cwd: dir, prompt: "forever" });
  await until(() => !!run.sessionId);
  assert.equal(runner.stop(run.id), true);
  await until(() => run.endedAt !== undefined, 10_000);
  assert.equal(run.status, "stopped");
});

test("a relative runs folder still works when the agent runs in another repo", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-runs-"));
  const repo = mkdtempSync(join(tmpdir(), "dovre-repo-"));
  const runner = createRunner({ harnesses: { claude: fakeAgent(dir) }, host: { exe, dir: relative(process.cwd(), join(dir, "runs")) } });
  const run = runner.start({ cwd: repo, prompt: "the PR" });
  await until(() => run.status !== "running");
  assert.equal(run.status, "done", JSON.stringify(run.events));
});

test("a host that ends without an exit note is a failed run with a reason, not a quiet stop", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-runs-"));
  const gone: Harness = { ...fakeAgent(dir), bin: join(dir, "no-such-agent.exe"), pre: [] };
  const runner = createRunner({ harnesses: { claude: gone }, host: { exe, dir: join(dir, "runs") } });
  const run = runner.start({ cwd: dir, prompt: "x" });
  await until(() => run.status !== "running");
  assert.equal(run.status, "failed");
  assert.ok(run.events.some((e) => e.t === "error" && e.text.length > 0));
});
