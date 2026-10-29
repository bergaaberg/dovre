/** The same prompt on two harnesses, side by side (#242): a worktree each, linked as a pair, and one page to compare them. */
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { localDesk } from "../src/agents/desk.ts";
import { lastSaid, pairWorktree } from "../src/agents/pair.ts";
import { createQueue } from "../src/agents/queue.ts";
import { createRunner, type Run } from "../src/agents/runner.ts";
import { claudeHarness } from "../src/agents/harnesses/claude/harness.ts";
import { codexHarness } from "../src/agents/harnesses/codex/harness.ts";
import { pairPage } from "../src/packs/core/agents/session.view.ts";
import { H, assertInert } from "./helpers.ts";

/** Turns that never end, and remember where they ran. */
function spawner() {
  const calls: { bin: string; cwd: string }[] = [];
  const spawnFn = (bin: string, _args: string[], o: { cwd?: string }) => {
    calls.push({ bin, cwd: String(o.cwd) });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined, kill: () => true });
    return child;
  };
  return { calls, spawnFn };
}

function setup() {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "app", ".git"), { recursive: true });
  const s = spawner();
  const runner = createRunner({ spawnFn: s.spawnFn as never, harnesses: { claude: claudeHarness("claude"), codex: codexHarness("codex") } });
  const made: string[] = [];
  const worktree = async (checkout: string, h: string, id: string) => {
    const dir = join(code, `app-${h}-${id}`);
    mkdirSync(dir);
    made.push(dir);
    return dir;
  };
  const desk = localDesk({ env: { CODE_DIR: code, CLAUDE_DIR: join(code, "none") }, runner, queue: createQueue(), sessions: async () => ({ live: [], recent: [] }), worktree });
  return { code, desk, runner, calls: s.calls, made };
}

test("one submit starts both, each in its own worktree, linked as a pair; the second takes its own defaults", async () => {
  const { desk, runner, calls, made } = setup();
  const r = await desk.start({ repo: "app", prompt: "fix it", harness: "claude", also: "codex", mode: "acceptEdits", model: "opus", effort: "high" });
  assert.ok("to" in r, JSON.stringify(r));
  const id = r.to.match(/^\/agents\/pair\/([0-9a-f]{8})$/)?.[1];
  assert.ok(id, r.to);
  const runs = runner.list().filter((x) => x.pair === id);
  assert.deepEqual(runs.map((x) => x.harness).sort(), ["claude", "codex"]);
  assert.deepEqual(calls.map((c) => c.cwd).sort(), made.sort(), "each runs in its own worktree");
  assert.ok(runs.every((x) => x.prompt === "fix it" && x.mode === "acceptEdits"));
  const claude = runs.find((x) => x.harness === "claude")!;
  const codex = runs.find((x) => x.harness === "codex")!;
  assert.equal(claude.model, "opus");
  assert.equal(claude.effort, "high");
  assert.equal(codex.model, "");
  assert.equal(codex.effort, undefined);
});

test("a pair is refused in Dovre's folder, in a sandbox, with the same harness twice, or one that isn't here; nothing starts", async () => {
  const { desk, runner, made } = setup();
  for (const f of [
    { repo: "@dovre", also: "codex" },
    { repo: "app", also: "codex", sandbox: "on" },
    { repo: "app", also: "claude" },
    { repo: "app", also: "agy" },
    { repo: "app", also: "<script>" },
  ]) {
    const r = await desk.start({ prompt: "fix it", harness: "claude", ...f });
    assert.ok("error" in r, JSON.stringify(f));
  }
  assert.equal(runner.list().length, 0);
  assert.equal(made.length, 0);
});

test("pairWorktree: a worktree beside the checkout, on its own branch from HEAD; never the same one twice", async () => {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  const app = join(code, "app");
  mkdirSync(app);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: app, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(app, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "one");
  const dir = await pairWorktree(app, "codex", "0a1b2c3d");
  assert.equal(dir, join(code, "app-codex-0a1b2c3d"));
  assert.ok(existsSync(join(dir, "a.txt")));
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: dir }).toString().trim(), "dovre/app-codex-0a1b2c3d");
  await assert.rejects(pairWorktree(app, "codex", "0a1b2c3d"), /there already/);
  await assert.rejects(pairWorktree(app, "codex", "../x"), /Not a pair/);
});

test("lastSaid: the last message, else the result", () => {
  assert.equal(lastSaid({ events: [{ t: "text", text: "one" }, { t: "tool", name: "Bash", detail: "ls" }, { t: "text", text: "two" }, { t: "result", text: "two", cost: 0, error: false }] }), "two");
  assert.equal(lastSaid({ events: [{ t: "result", text: "only this", cost: 0, error: false }] }), "only this");
  assert.equal(lastSaid({ events: [] }), "");
});

test("the pair's page: both sides, what each said, cost, time and diff; hostile text stays text", () => {
  const run = (o: Partial<Run>): Run => ({ id: "r1", harness: "claude", forked: false, cwd: `/c/${H}`, repo: H, prompt: `${H}\nmore`, mode: "default", model: H, allowed: [], status: "done", startedAt: 1000, endedAt: 61_000, events: [], partial: "", cost: 0.25, pair: "0a1b2c3d", ...o });
  const p = pairPage("0a1b2c3d", [
    { run: run({ sessionId: "11111111-1111-4111-8111-111111111111", diff: { files: 2, add: 10, del: 3 } }), said: `**done** ${H}`, diff: "/viewer/diff?x=1" },
    { run: run({ id: "r2", harness: "codex", status: "running", endedAt: undefined }) },
  ]);
  const page = `${p.head}${p.body}`;
  assertInert("/agents/pair", page);
  assert.match(page, /Claude Code/);
  assert.match(page, /Codex/);
  assert.match(page, /\$0\.250/);
  assert.match(page, /2 files <span class="add">\+10<\/span>/);
  assert.match(page, /<strong>done<\/strong>/, "what it said is markdown");
  assert.match(page, /href="\/agents\/s\/11111111-1111-4111-8111-111111111111"/);
  assert.match(page, /href="\/agents\/r\/r2"/, "a side without its session yet links its run");
  assert.match(page, /Working…/);
  assert.match(page, /run:r1 run:11111111-1111-4111-8111-111111111111 run:r2/, "it follows both sides' turns");
});
