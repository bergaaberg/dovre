/** Sandbox runs (#205): yolo only inside a container, set by the runner alone; a fresh clone in, the token in a 0600 file that goes. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { createRunner, type Run, type StartOpts } from "../src/agents/runner.ts";
import { claudeHarness, argsFor, SANDBOX_NOTE } from "../src/agents/harnesses/claude/harness.ts";
import { appleContainer, BUNDLE_SCRIPT, containerArgs, numstat, originRepo, readToken, sandboxBranch, type SandboxBox, type SandboxEngine, type SandboxOut, type SandboxState } from "../src/agents/sandbox.ts";
import { localDesk } from "../src/agents/desk.ts";
import { createQueue } from "../src/agents/queue.ts";
import { WORK } from "../src/agents/workdir.ts";
import { agentPage, newAgentPage } from "../src/packs/core/agents/session.view.ts";
import { runMeta } from "../src/bridge/serve.ts";
import { openSandboxPr, sandboxKind } from "../src/actions/sandbox.ts";
import { openDb } from "../src/db.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A turn that says its session, then ends (or hangs until killed). */
function fakeSpawn(o: { hang?: boolean } = {}) {
  const seen: { bin: string; args: string[]; stdin: string }[] = [];
  const spawnFn = (bin: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const rec = { bin, args, stdin: "" };
    seen.push(rec);
    stdin.on("data", (b) => (rec.stdin += String(b)));
    const end = (code: number) => {
      stdout.end();
      setImmediate(() => child.emit("close", code));
    };
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, pid: undefined, kill: () => (end(143), true) });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" })}\n`);
      if (!o.hang) {
        stdout.write(`${JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.01 })}\n`);
        end(0);
      }
    });
    return child;
  };
  return { spawnFn, seen };
}

/** An engine that records what's asked of it. `out`: what collecting a run's commits gives. */
function fakeEngine(state: SandboxState = { ok: true }, maxMs = 60_000, out: SandboxOut = { state: "none" }) {
  const calls: string[] = [];
  const engine: SandboxEngine = {
    maxMs,
    state: () => state,
    prepare: ({ id, repo }) => (calls.push(`prepare ${repo}`), { dir: `/boxes/${id}`, name: `dovre-${id.slice(0, 8)}`, base: "abc123" }),
    command: (box, inner) => ({ bin: "container", args: ["run", box.name, "img", ...inner] }),
    kill: (box) => void calls.push(`kill ${box.name}`),
    ended: (box) => void calls.push(`ended ${box.dir}`),
    remove: (box) => void calls.push(`remove ${box.dir}`),
    collect: async (box, o) => (calls.push(`collect ${box.dir} ${o.cwd} ${o.branch}`), out),
    push: async (o) => void calls.push(`push ${o.cwd} ${o.branch} ${o.head} ${o.repo}`),
    dropBranch: async (o) => void calls.push(`drop ${o.cwd} ${o.branch}`),
  };
  return { engine, calls };
}

test("container args: the prompt on stdin (-i), the clone mounted at /work, the token through an env file, then the image and the harness", () => {
  const args = containerArgs({ name: "dovre-1", work: "/b/1/work", envFile: "/b/1/env", image: "dovre-sandbox", memory: "4g", cpus: 4 }, ["claude", "-p"]);
  assert.deepEqual(args, ["run", "--progress", "none", "--rm", "-i", "--name", "dovre-1", "-m", "4g", "-c", "4", "--env-file", "/b/1/env", "-v", "/b/1/work:/work", "-w", "/work", "dovre-sandbox", "claude", "-p"]);
  assert.ok(!args.some((a) => a.includes("oat01")), "no token in argv");
});

test("Claude Code skips permissions only when the runner says yolo; otherwise it's the mode, never bypass", () => {
  const plain = argsFor({ cwd: "/x", prompt: "p", mode: "acceptEdits" });
  assert.ok(plain.includes("--permission-mode") && !plain.includes("--dangerously-skip-permissions"));
  const yolo = argsFor({ cwd: "/x", prompt: "p", yolo: true });
  assert.ok(yolo.includes("--dangerously-skip-permissions") && !yolo.includes("--permission-mode"));
  assert.ok(yolo.includes(SANDBOX_NOTE));
});

test("a caller can't turn yolo on: outside a sandbox the turn asks as its mode says", async () => {
  const f = fakeSpawn();
  const runner = createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn });
  runner.start({ cwd: "/x", prompt: "p", ...({ yolo: true } as Partial<StartOpts>) });
  await tick();
  assert.ok(!f.seen[0]!.args.includes("--dangerously-skip-permissions"));
  assert.equal(f.seen[0]!.bin, "claude");
});

test("a sandbox run: the engine's command around the image's own claude, yolo, no MCP token, and its box on the run", async () => {
  const f = fakeSpawn();
  const { engine, calls } = fakeEngine();
  const runner = createRunner({ harnesses: { claude: { ...claudeHarness("/host/claude"), pre: ["/host/shim.js"] } }, spawnFn: f.spawnFn, sandbox: engine, mcp: { url: "http://127.0.0.1:1/mcp" } });
  const run = runner.start({ cwd: "/code/a", prompt: "fix it", sandbox: true, allowed: ["Bash(rm -rf /)"] });
  await tick();
  const { bin, args, stdin } = f.seen[0]!;
  assert.equal(bin, "container");
  assert.deepEqual(args.slice(0, 4), ["run", run.sandbox!.name, "img", "claude"], "the image's claude, not the host's program or shim");
  assert.ok(!args.includes("/host/shim.js"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--mcp-config"), "no MCP token into the sandbox");
  assert.ok(!args.includes("--allowedTools"));
  assert.equal(stdin, "fix it");
  assert.equal(run.cwd, "/code/a");
  assert.deepEqual(calls, ["prepare /code/a", `ended /boxes/${run.id}`, `collect /boxes/${run.id} /code/a ${sandboxBranch(run.id)}`]);
  assert.equal(run.status, "done");
  assert.ok(runner.discard(run.id));
  assert.equal(calls.at(-1), `remove /boxes/${run.id}`);
});

test("stopping a sandbox run kills its container too, and the wall-clock cap stops it", async () => {
  const f = fakeSpawn({ hang: true });
  const { engine, calls } = fakeEngine({ ok: true }, 40);
  const runner = createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn, sandbox: engine });
  const run = runner.start({ cwd: "/code/a", prompt: "p", sandbox: true });
  await tick(120);
  assert.equal(run.status, "stopped");
  assert.ok(calls.includes(`kill ${run.sandbox!.name}`));
  assert.ok(run.events.some((e) => e.t === "error" && /went past/.test(e.text)));
  assert.ok(calls.includes(`ended /boxes/${run.id}`), "the token file goes when it ends");
});

test("sandbox runs are refused without an engine, when it isn't ready, for a resume, and for a harness that can't", () => {
  const f = fakeSpawn();
  assert.throws(() => createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn }).start({ cwd: "/a", prompt: "p", sandbox: true }), /aren't set up/);
  const off = fakeEngine({ ok: false, why: "Apple container isn't running." }).engine;
  assert.throws(() => createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn, sandbox: off }).start({ cwd: "/a", prompt: "p", sandbox: true }), /isn't running/);
  const { engine } = fakeEngine();
  const r = createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn, sandbox: engine });
  assert.throws(() => r.start({ cwd: "/a", prompt: "p", sandbox: true, resume: "11111111-1111-4111-8111-111111111111" }), /new session/);
  const { sandbox: _s, ...noBox } = claudeHarness();
  assert.throws(() => createRunner({ harnesses: { claude: noBox }, spawnFn: f.spawnFn, sandbox: engine }).start({ cwd: "/a", prompt: "p", sandbox: true }), /can't run in a sandbox/);
  assert.equal(f.seen.length, 0, "nothing started");
});

test("Apple container engine: a fresh clone at the base with origin gone, the token in a 0600 env file that goes when it ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "dovre-box-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("remote", "add", "origin", "https://example.invalid/repo.git");
  const head = git("rev-parse", "HEAD");
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "sk-ant-oat01-test\n", { mode: 0o600 });
  const engine = appleContainer({ root: join(root, "boxes"), tokenFile, exec: async () => ({ ok: true, out: "" }) });
  const box: SandboxBox = engine.prepare({ id: "aaaaaaaa-1111", repo });
  assert.equal(box.base, head);
  assert.equal(box.name, "dovre-aaaaaaaa");
  const work = join(box.dir, "work");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["remote"], { cwd: work, encoding: "utf8" }).trim(), "", "no origin to push to");
  const env = join(box.dir, "env");
  assert.equal(readFileSync(env, "utf8"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n");
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.ok(!engine.command(box, ["claude"]).args.join(" ").includes("oat01"));
  engine.ended(box);
  assert.ok(!existsSync(env) && existsSync(work));
  engine.remove(box);
  assert.ok(!existsSync(box.dir));
  await tick();
  assert.deepEqual(engine.state(), { ok: true });
});

test("no token, or a token that isn't one line: the reason says what to do", () => {
  const root = mkdtempSync(join(tmpdir(), "dovre-box-"));
  assert.throws(() => readToken(join(root, "none")), /claude setup-token/);
  writeFileSync(join(root, "two"), "a b\n");
  assert.throws(() => readToken(join(root, "two")), /one line/);
});

test("the desk: a sandbox start from the form, never in Dovre's own folder, and no replies to a sandbox run", async () => {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "a", ".git"), { recursive: true });
  const f = fakeSpawn();
  const { engine } = fakeEngine();
  const runner = createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn, sandbox: engine });
  const desk = localDesk({ env: { CODE_DIR: code, CLAUDE_DIR: join(code, ".claude"), AGENT_DIR: join(code, "agents") }, runner, queue: createQueue({}), sessions: async () => ({ live: [], recent: [] }) });
  assert.deepEqual(desk.view().sandbox, { ok: true });
  assert.ok("error" in (await desk.start({ repo: WORK, prompt: "p", sandbox: "on" })));
  const r = await desk.start({ repo: "a", prompt: "p", sandbox: "on" });
  assert.ok("to" in r);
  await tick();
  const run = runner.list()[0] as Run;
  assert.ok(run.sandbox);
  const done = await desk.reply(run.sessionId!, { prompt: "more" });
  assert.match(done.flash ?? "", /one prompt/);
  assert.equal(f.seen.length, 1);
});

test("the new-agent form offers the sandbox when it's ready, and says why not (escaped) when it isn't", () => {
  const page = (sandbox: { ok: boolean; why?: string }) => String(newAgentPage({ repos: ["a"], sandbox }).body);
  assert.match(page({ ok: true }), /name="sandbox" value="on">/);
  const off = page({ ok: false, why: "<img src=x onerror=alert(1)>" });
  assert.match(off, /name="sandbox" value="on" disabled>/);
  assert.ok(!off.includes("<img src=x"));
  assert.ok(!String(newAgentPage({ repos: ["a"] }).body).includes('name="sandbox"'));
});

// ── #206: the work comes home as a branch, then a draft PR ──

test("origin's owner/name from https, ssh and scp-like URLs; nothing else", () => {
  assert.equal(originRepo("https://github.com/acme/app.git"), "acme/app");
  assert.equal(originRepo("https://x-access-token:t@github.com/acme/app"), "acme/app");
  assert.equal(originRepo("git@github.com:acme/app.git"), "acme/app");
  assert.equal(originRepo("ssh://git@ghe.example.com/acme/app.git"), "acme/app");
  assert.equal(originRepo("/Users/me/src/app"), undefined);
  assert.equal(originRepo("https://github.com/acme/../x"), undefined);
});

test("numstat: counts, binary files as 0/0, odd paths kept as they are", () => {
  assert.deepEqual(numstat("3\t1\ta.ts\0-\t-\timg.png\0" + "1\t0\tdir/<b> x.md\0"), [
    { path: "a.ts", add: 3, del: 1 },
    { path: "img.png", add: 0, del: 0 },
    { path: "dir/<b> x.md", add: 1, del: 0 },
  ]);
});

/** A checkout with a GitHub origin, whose pushes go to a bare repo next to it. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "dovre-home-"));
  const repo = join(root, "repo");
  const bare = join(root, "bare.git");
  mkdirSync(repo);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  git(root, "init", "-q", "--bare", bare);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", "https://github.com/acme/app.git");
  // Pushes only, to the bare repo; origin still reads as GitHub's.
  git(repo, "config", `url.${bare}.pushInsteadOf`, "https://github.com/acme/app.git");
  return { root, repo, bare, git };
}

/** The bundle container, played here: the script run on the clone, /out the run's out folder. */
const playContainer = async (bin: string, args: string[]) => {
  if (args[0] !== "run") return { ok: true, out: "" };
  const vols = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a.split(":")] : []));
  const work = vols.find((v) => v[1] === "/work")![0]!;
  const out = vols.find((v) => v[1] === "/out")![0]!;
  const base = args.find((a) => a.startsWith("DOVRE_BASE="))!.slice("DOVRE_BASE=".length);
  try {
    execFileSync("sh", ["-c", BUNDLE_SCRIPT.replaceAll("/out", out)], { cwd: work, env: { ...process.env, DOVRE_BASE: base, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" } });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: "", err: String((e as Error).message) };
  }
};

test("Apple container engine: the commits come home as sandbox/<id> (uncommitted work too), CI config noticed, then pushed once checked", async () => {
  const { root, repo, bare, git } = checkout();
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "sk-ant-oat01-test\n", { mode: 0o600 });
  const engine = appleContainer({ root: join(root, "boxes"), tokenFile, exec: playContainer });
  const box = engine.prepare({ id: "bbbbbbbb-2222", repo });
  const work = join(box.dir, "work");
  // The agent: one commit touching CI, one file left uncommitted, and a hook that would fail any commit.
  mkdirSync(join(work, ".github", "workflows"), { recursive: true });
  writeFileSync(join(work, ".github", "workflows", "ci.yml"), "on: push\n");
  git(work, "add", "-A");
  git(work, "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "Add CI");
  writeFileSync(join(work, "notes.md"), "left over\n");
  writeFileSync(join(work, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const branch = sandboxBranch("bbbbbbbb-2222");
  const out = await engine.collect(box, { cwd: repo, branch });
  assert.equal(out.state, "ready", JSON.stringify(out));
  if (out.state !== "ready") return;
  assert.equal(out.repo, "acme/app");
  assert.equal(out.base, box.base);
  assert.equal(out.head, git(repo, "rev-parse", branch));
  assert.deepEqual(out.commits.map((c) => c.subject), ["Uncommitted work from the sandbox run", "Add CI"]);
  assert.deepEqual(out.files.map((f) => f.path).sort(), [".github/workflows/ci.yml", "notes.md"]);
  assert.equal(out.ci, true);
  assert.ok(!existsSync(join(box.dir, "out", "work.bundle")), "the bundle goes once fetched");
  // Pushed only when the branch is still the run's and origin still the repo.
  await assert.rejects(engine.push({ cwd: repo, branch, head: box.base, repo: "acme/app" }), /changed since/);
  await assert.rejects(engine.push({ cwd: repo, branch, head: out.head, repo: "acme/other" }), /origin isn't/);
  await engine.push({ cwd: repo, branch, head: out.head, repo: "acme/app" });
  assert.equal(git(bare, "rev-parse", branch), out.head);
  await engine.dropBranch({ cwd: repo, branch });
  assert.equal(git(repo, "branch", "--list", branch), "");
});

test("Apple container engine: no commits is 'none'; a failed bundle is 'failed' with why", async () => {
  const { root, repo } = checkout();
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "t\n", { mode: 0o600 });
  const box = appleContainer({ root: join(root, "boxes"), tokenFile, exec: playContainer }).prepare({ id: "cccccccc-3333", repo });
  assert.deepEqual(await appleContainer({ root: join(root, "boxes"), tokenFile, exec: playContainer }).collect(box, { cwd: repo, branch: "sandbox/cccccccc" }), { state: "none" });
  const broken = appleContainer({ root: join(root, "boxes"), tokenFile, exec: async (_b, a) => (a[0] === "run" ? { ok: false, out: "", err: "boom\n" } : { ok: true, out: "" }) });
  const r = await broken.collect(box, { cwd: repo, branch: "sandbox/cccccccc" });
  assert.equal(r.state, "failed");
  assert.match(r.state === "failed" ? r.why : "", /boom/);
});

const READY: SandboxOut = { state: "ready", branch: "sandbox/aaaa", base: "a".repeat(40), head: "b".repeat(40), repo: "acme/app", commits: [{ sha: "b".repeat(40), subject: "Fix it" }], files: [{ path: "a.ts", add: 2, del: 1 }], ci: false };

test("the runner: a sandbox run's commits are collected when it ends, pushed on asking, and the clone goes once its PR is open", async () => {
  const f = fakeSpawn();
  const { engine, calls } = fakeEngine({ ok: true }, 60_000, structuredClone(READY));
  const runner = createRunner({ harnesses: { claude: claudeHarness() }, spawnFn: f.spawnFn, sandbox: engine });
  const run = runner.start({ cwd: "/code/a", prompt: "p", sandbox: true });
  await tick();
  assert.equal(run.out?.state, "ready");
  assert.deepEqual(await runner.pushSandbox(run.id), { repo: "acme/app", branch: "sandbox/aaaa", head: "b".repeat(40) });
  assert.ok(calls.includes(`push /code/a sandbox/aaaa ${"b".repeat(40)} acme/app`));
  assert.ok(runner.landed(run.id, { number: 7, url: "https://github.com/acme/app/pull/7" }));
  assert.equal(run.out?.state === "ready" && run.out.pr?.number, 7);
  assert.equal(calls.at(-1), `remove /boxes/${run.id}`);
  await assert.rejects(runner.pushSandbox(run.id), /open already/);
  // Discarded, its local branch goes too.
  assert.ok(runner.discard(run.id));
  await tick();
  assert.ok(calls.includes("drop /code/a sandbox/aaaa"));
});

test("the hub keeps a sandbox run's branch and PR, not its commits' subjects or paths", () => {
  const run = { id: "r", harness: "claude", forked: false, cwd: "/c", repo: "c", prompt: "p", mode: "default", model: "", allowed: [], status: "done", startedAt: 1, events: [], partial: "", cost: 0, out: READY } as Run;
  const meta = runMeta(run);
  assert.ok(meta.out?.state === "ready" && meta.out.commits.length === 0 && meta.out.files.length === 0 && meta.out.branch === "sandbox/aaaa");
});

test("the run page: what it made, escaped; Open draft PR asks under its kind, and a PR link only ever goes through safeUrl", () => {
  const hostile: SandboxOut = { ...READY, commits: [{ sha: "c".repeat(40), subject: "<script>alert(1)</script>" }], files: [{ path: "<img src=x onerror=alert(1)>.ts", add: 1, del: 0 }], ci: true };
  const run = { id: "run-1", harness: "claude", forked: false, cwd: "/c", repo: "c", prompt: "p", mode: "default", model: "", allowed: [], status: "done", startedAt: 1, events: [{ t: "result", text: "Done <iframe src=x>", cost: 0.5, error: false }], partial: "", cost: 0.5, sandbox: { dir: "/b", name: "n", base: "a".repeat(40) }, out: hostile } as Run;
  const body = String(agentPage({ sessionId: "11111111-1111-4111-8111-111111111111", turns: [], run }).body);
  assert.ok(!body.includes("<script>alert") && !body.includes("<img src=x") && !body.includes("<iframe"));
  assert.match(body, /action="\/agents\/r\/run-1\/pr"/);
  assert.match(body, /It changed CI config/);
  assert.match(body, /action="\/agents\/r\/run-1\/discard"/);
  const landed = String(agentPage({ sessionId: "11111111-1111-4111-8111-111111111111", turns: [], run: { ...run, out: { ...READY, pr: { number: 3, url: "javascript:alert(1)" } } } }).body);
  assert.ok(!landed.includes("javascript:"));
  assert.match(landed, /Draft PR #3/);
});

test("openSandboxPr: refused before any push outside the owners; else pushed, checked again, a draft PR, logged under its kind", async () => {
  const db = openDb();
  const asked: { path: string; method?: string; body?: unknown }[] = [];
  const ghe = {
    rest: async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      asked.push({ path, ...init });
      if (path.includes("/git/ref/heads/")) return { object: { sha: "b".repeat(40) } } as T;
      if (path.includes("/pulls?")) return [] as T;
      if (path === "/repos/acme/app") return { default_branch: "main" } as T;
      if (path.endsWith("/pulls")) return { number: 9, html_url: "https://github.com/acme/app/pull/9" } as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const run = { id: "r", repo: "app", prompt: "Fix the thing\nmore", events: [{ t: "result", text: "Fixed, cc @someone", cost: 0, error: false }], cost: 0.25, out: { ...READY, ci: true } } as unknown as Run;
  let pushes = 0;
  const push = async () => (pushes++, { repo: "acme/app", branch: "sandbox/aaaa", head: "b".repeat(40) });
  const no = await openSandboxPr({ db: db.DB, ghe, owners: "other", run, push });
  assert.equal(no.ok, false);
  assert.equal(pushes, 0, "nothing pushed for a repo outside the owners");
  const yes = await openSandboxPr({ db: db.DB, ghe, owners: "acme", run, push });
  assert.deepEqual(yes, { ok: true, number: 9, url: "https://github.com/acme/app/pull/9" });
  const pr = asked.find((a) => a.method === "POST")!;
  const body = pr.body as { draft: boolean; base: string; head: string; title: string; body: string };
  assert.equal(body.draft, true);
  assert.equal(body.base, "main");
  assert.equal(body.head, "sandbox/aaaa");
  assert.equal(body.title, "Fix the thing");
  assert.ok(!body.body.includes("@someone"), "no mentions from the agent's text");
  const logged = db.raw.prepare("SELECT kind, ok FROM actions ORDER BY id").all().map((l) => ({ ...l }));
  assert.deepEqual(logged, [{ kind: "sandbox.pr-ci", ok: 0 }, { kind: "sandbox.pr-ci", ok: 1 }]);
  assert.equal(sandboxKind({ ci: false }), "sandbox.pr");
});

test("openSandboxPr: a forge branch not at the run's head is refused; a PR that fails takes its pushed branch with it", async () => {
  const db = openDb();
  const run = { id: "r", repo: "app", prompt: "p", events: [], cost: 0, out: READY } as unknown as Run;
  const push = async () => ({ repo: "acme/app", branch: "sandbox/aaaa", head: "b".repeat(40) });
  const moved = await openSandboxPr({ db: db.DB, owners: "acme", run, push, ghe: { rest: async <T>(path: string) => (path.includes("/git/ref/") ? { object: { sha: "c".repeat(40) } } : []) as T } });
  assert.match(moved.ok ? "" : moved.error, /isn't at the run's last commit/);
  const deleted: string[] = [];
  const failing = await openSandboxPr({
    db: db.DB, owners: "acme", run, push,
    ghe: {
      rest: async <T>(path: string, init: { method?: string } = {}): Promise<T> => {
        if (init.method === "DELETE") return (deleted.push(path), {}) as T;
        if (init.method === "POST") throw new Error("GitHub: 422");
        if (path.includes("/git/ref/")) return { object: { sha: "b".repeat(40) } } as T;
        if (path.includes("/pulls?")) return [] as T;
        return { default_branch: "main" } as T;
      },
    },
  });
  assert.equal(failing.ok, false);
  assert.deepEqual(deleted, ["/repos/acme/app/git/refs/heads/sandbox/aaaa"]);
});
