/** The local sources: Claude Code's files, worktrees, settings. Against temp dirs, never the real ~/.claude. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseVars } from "../src/env.ts";
import { loadSessions, summarizeTranscript, tail } from "../src/sources/claude.ts";
import { branchOf, loadWorktrees } from "../src/sources/worktrees.ts";

const line = (o: object) => JSON.stringify(o);

test("a transcript's newest metadata wins; slash commands and junk are skipped; tool output isn't kept", () => {
  const text = [
    line({ type: "ai-title", aiTitle: "Old title" }),
    line({ type: "last-prompt", lastPrompt: "fix the bug" }),
    "{not json",
    line({ type: "user", cwd: "C:\\Code\\shop-api", gitBranch: "feat/a", timestamp: "2026-10-22T06:00:00Z", message: { content: [{ type: "tool_result", content: "SECRET ROW" }] } }),
    line({ type: "pr-link", prUrl: "https://acme.ghe.com/ACME/a/pull/1", prRepository: "ACME/a", prNumber: 1 }),
    line({ type: "pr-link", prUrl: "https://acme.ghe.com/ACME/a/pull/1", prRepository: "ACME/a", prNumber: 1 }),
    line({ type: "ai-title", aiTitle: "New title" }),
    line({ type: "last-prompt", lastPrompt: "/clear" }),
    line({ type: "system", subtype: "away_summary", content: "Built it. Next: push? (disable recaps in /config)", timestamp: "2026-10-22T06:05:00Z" }),
    line({ type: "cost-state", totalCostUSD: 1.5 }),
    line({ type: "assistant", gitBranch: "HEAD", timestamp: "2026-10-22T06:06:00Z" }),
  ].join("\n");
  const m = summarizeTranscript(text);
  assert.equal(m.title, "New title");
  assert.equal(m.lastPrompt, "fix the bug");
  assert.equal(m.summary, "Built it. Next: push?");
  assert.equal(m.cost, 1.5);
  assert.equal(m.branch, "feat/a", "HEAD isn't a branch");
  assert.equal(m.lastAt, "2026-10-22T06:06:00Z");
  assert.equal(m.prs.size, 1);
  assert.ok(!JSON.stringify(m).includes("SECRET ROW"));
});

test("tail starts at a whole line", () => {
  const dir = mkdtempSync(join(tmpdir(), "u-"));
  const f = join(dir, "t.jsonl");
  writeFileSync(f, `${"x".repeat(50)}\n{"a":1}\n{"b":2}\n`);
  assert.equal(tail(f, 14), `{"b":2}\n`);
  assert.equal(tail(f, 10_000).split("\n").length, 4);
});

function claudeDir() {
  const dir = mkdtempSync(join(tmpdir(), "claude-"));
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "C--Code-shop-api", "aaa", "subagents"), { recursive: true });
  writeFileSync(join(dir, "sessions", "100.json"), line({ pid: 100, sessionId: "aaa", cwd: "C:\\Code\\shop-api", status: "idle", statusUpdatedAt: 5, name: "shop-api-1" }));
  writeFileSync(join(dir, "sessions", "200.json"), line({ pid: 200, sessionId: "dead", cwd: "C:\\Code\\x", status: "busy" }));
  writeFileSync(join(dir, "sessions", "100.abc.key"), "secret");
  writeFileSync(join(dir, "projects", "C--Code-shop-api", "aaa.jsonl"), [line({ type: "ai-title", aiTitle: "Live one" }), "x".repeat(5000)].join("\n"));
  writeFileSync(join(dir, "projects", "C--Code-shop-api", "aaa", "subagents", "agent-1.meta.json"), line({ finished: false }));
  writeFileSync(join(dir, "projects", "C--Code-shop-api", "bbb.jsonl"), [line({ type: "ai-title", aiTitle: "Recent one" }), line({ type: "user", cwd: "C:\\Code\\platform", timestamp: "2026-10-22T05:00:00Z" }), "y".repeat(5000)].join("\n"));
  writeFileSync(join(dir, "history.jsonl"), [line({ sessionId: "bbb", display: "review PR 3" }), line({ sessionId: "bbb", display: "/quit" })].join("\n"));
  return dir;
}

test("live sessions are the registry entries whose process runs; the rest of recent transcripts are 'recent'", () => {
  const { live, recent } = loadSessions(claudeDir(), { isAlive: (pid) => pid === 100 });
  assert.deepEqual(live.map((s) => [s.sessionId, s.status, s.title, s.repo, s.subagentsRunning]), [["aaa", "idle", "Live one", "shop-api", 1]]);
  assert.deepEqual(recent.map((s) => [s.sessionId, s.title, s.repo, s.lastPrompt, s.live]), [["bbb", "Recent one", "platform", "review PR 3", false]]);
});

test("worktrees are found by their .git file; a detached HEAD has no branch", () => {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  const main = join(code, "shop-web", ".git", "worktrees");
  mkdirSync(join(main, "shop-web-ung"), { recursive: true });
  mkdirSync(join(main, "shop-web-pr"), { recursive: true });
  writeFileSync(join(main, "shop-web-ung", "HEAD"), "ref: refs/heads/feat/ung-studieland\n");
  writeFileSync(join(main, "shop-web-pr", "HEAD"), "0123456789abcdef\n");
  for (const n of ["shop-web-ung", "shop-web-pr"]) {
    mkdirSync(join(code, n));
    writeFileSync(join(code, n, ".git"), `gitdir: ${join(main, n)}\n`);
  }
  mkdirSync(join(code, "plain", ".git"), { recursive: true });
  const wts = loadWorktrees(code).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(wts.map((w) => [w.name, w.main, w.branch, w.head]), [["shop-web-pr", "shop-web", null, "0123456"], ["shop-web-ung", "shop-web", "feat/ung-studieland", ""]]);
  assert.equal(branchOf("ref: refs/heads/a/b"), "a/b");
});

test("settings: KEY=value lines, quotes dropped, comments ignored", () => {
  assert.deepEqual(parseVars(`# c\nA=1\r\nB = "two words"\nbad line\nC='x'`), { A: "1", B: "two words", C: "x" });
});


test("from agents --json: a session started with claude -p is headless, not a terminal (agents --json calls both interactive)", () => {
  const dir = claudeDir();
  writeFileSync(join(dir, "sessions", "100.json"), line({ pid: 100, sessionId: "aaa", entrypoint: "cli", statusUpdatedAt: 5 }));
  writeFileSync(join(dir, "sessions", "300.json"), line({ pid: 300, sessionId: "ccc", entrypoint: "sdk-cli", statusUpdatedAt: 6 }));
  const agents = [{ sessionId: "aaa", pid: 100, kind: "interactive" }, { sessionId: "ccc", pid: 300, kind: "interactive" }];
  const { live } = loadSessions(dir, { agents });
  assert.deepEqual(Object.fromEntries(live.map((s) => [s.sessionId, s.kind])), { aaa: "interactive", ccc: "headless" });
});
