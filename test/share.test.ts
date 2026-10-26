/** Running it on someone else's machine: the token is kept, a missing GHE login gets a setup page, only the tools that exist are offered. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunner } from "../src/agents/runner.ts";
import { ompHarness } from "../src/agents/omp.ts";
import { launchToken, maskedLogin, serveSetup } from "../src/boot.ts";
import { loadEnv, reposOf } from "../src/env.ts";
import { newAgentPage } from "../src/packs/core/agents/session.view.ts";
import { resumeCommand } from "../src/pages/parts.ts";
import { setupLines } from "../src/pages/settings.ts";
import { agentPanel } from "../src/pages/work.ts";
import { setupApp, setupPage } from "../src/setup.ts";
import { findTool, found, shimTarget, summariesWanted, which } from "../src/tools.ts";
import { H, assertInert, pr, session, signedIn, snapshot } from "./helpers.ts";

/** A page for ctx.page, as text: its head and body. */
const bodyOf = (p: { head?: unknown; body: unknown }) => `${p.head ?? ""}${p.body}`;

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("the login token is made once, kept, and used on every later start; a pinned one wins", () => {
  const dir = tmp("dovre-tk-");
  const first = launchToken(dir);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(readFileSync(join(dir, "launch-token"), "utf8").trim(), first);
  assert.equal(launchToken(dir), first, "the next start uses the kept one");
  assert.equal(launchToken(dir, "pinned-from-dev-vars"), "pinned-from-dev-vars");
  writeFileSync(join(dir, "launch-token"), "x; rm");
  assert.notEqual(launchToken(dir), "x; rm", "a broken file gets a new token");
  assert.ok(!maskedLogin("http://127.0.0.1:4848").includes(first), "the log never shows it");
});

test("no GHE login: a setup page that says how, local only, the app's shell still public", async () => {
  const app = setupApp({ problem: { kind: "login", host: "acme.ghe.com" }, token: "tok-1234567890abcdef", info: { version: "t", startedAt: 1 }, state: () => ({}) });
  const page = await app.request("http://127.0.0.1:4848/deploys");
  assert.equal(page.status, 503);
  assert.match(await page.text(), /gh auth login --hostname acme\.ghe\.com/);
  assert.equal((await app.request("http://evil.example/")).status, 404, "another host learns nothing");
  assert.equal((await app.request("http://127.0.0.1:4848/healthz")).status, 200);
  assert.equal((await app.request("http://127.0.0.1:4848/starting.js")).status, 200);
  assert.equal((await app.request("http://127.0.0.1:4848/login?tk=wrong")).status, 404);
  const login = await app.request("http://127.0.0.1:4848/login?tk=tok-1234567890abcdef");
  assert.match(login.headers.get("set-cookie") ?? "", /u_tk=tok-1234567890abcdef; .*HttpOnly/, "signed in for when the app comes");
  assertInert("setup", String(setupPage({ kind: "unreachable", host: "acme.ghe.com", error: H }, {})));
  assert.match(String(setupPage({ kind: "unreachable", host: "acme.ghe.com", error: "fetch failed" }, {})), /VPN/);
  assert.match(String(setupPage({ kind: "login", host: "h" }, { ready: true })), /dovre restart/);
});

test("once GHE answers, a supervised server exits 75 to start again for real", async () => {
  const dir = tmp("dovre-setup-");
  let answers = false;
  const exited: number[] = [];
  const stop = new AbortController();
  void serveSetup({ problem: { kind: "login", host: "h" }, token: "t".repeat(20), port: 48731, dataDir: dir, version: "t", supervised: true, everyMs: 20, check: async () => answers, exit: (c) => void exited.push(c), signal: stop.signal });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(exited, [], "not while it doesn't");
  assert.match(readFileSync(join(dir, "up-48731.js"), "utf8"), /dovreUp/, "the starting page goes on to it");
  answers = true;
  await new Promise((r) => setTimeout(r, 120));
  stop.abort();
  assert.equal(exited[0], 75);
});

test("tools: found on the PATH with Windows' extensions, an npm .cmd shim runs its script through node, an override wins", () => {
  const dir = tmp("dovre-path-");
  writeFileSync(join(dir, "omp.exe"), "");
  mkdirSync(join(dir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "");
  writeFileSync(join(dir, "claude.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
  assert.equal(which("omp", env, "win32"), join(dir, "omp.exe"));
  const omp = findTool("omp", undefined, { env, platform: "win32" })!;
  assert.deepEqual([omp.bin, omp.pre], [join(dir, "omp.exe"), []]);
  const claude = findTool("claude", undefined, { env, platform: "win32", node: "node.exe" })!;
  assert.deepEqual([claude.bin, claude.pre], ["node.exe", [join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")]]);
  assert.equal(findTool("codex", undefined, { env, platform: "win32" }), undefined, "not there: off");
  assert.equal(findTool("x", join(dir, "omp.exe"), { env: { PATH: "" }, platform: "win32" })?.bin, join(dir, "omp.exe"), "CLAUDE_BIN/OMP_BIN style override");
  assert.equal(shimTarget(join(dir, "x.cmd"), "@echo nothing to run"), undefined);
  writeFileSync(join(dir, "broken.cmd"), '"%dp0%\\missing\\cli.js" %*');
  assert.equal(findTool("broken", undefined, { env, platform: "win32" }), undefined, "a shim whose script is gone isn't a tool");
});

test("summaries go to Claude only: on when it's here unless told no, never without it", () => {
  assert.equal(summariesWanted(true), true);
  assert.equal(summariesWanted(true, "off"), false);
  assert.equal(summariesWanted(true, "on"), true);
  assert.equal(summariesWanted(false, "on"), false);
  assert.equal(summariesWanted(false), false);
});

test("with summaries off, a PR shows no summary line at all", async () => {
  const { get } = signedIn(snapshot({ prs: { ok: true, value: { mine: [pr({ title: "Mine" })], review: [] } } }));
  const out = await (await get("/prs")).text();
  assert.doesNotMatch(out, /No summary|Writing a summary|class="ai/);
});

test("a list set to nothing is off, and so is one left unset", () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  try {
    // Away from this checkout's own .dev.vars, which would win.
    process.chdir(mkdtempSync(join(tmpdir(), "dovre-env-")));
    process.env.GHE_TOKEN = "t";
    process.env.FORM_REPOS = "";
    delete process.env.SORTING_REPOS;
    const env = loadEnv();
    assert.deepEqual(reposOf("ACME", env.FORM_REPOS, "FORMS"), []);
    assert.deepEqual(reposOf("ACME", env.SORTING_REPOS, ""), []);
  } finally {
    process.chdir(cwd);
    process.env = saved;
  }
});

test("the GitHub token: GHE_TOKEN first; a GITHUB_TOKEN from the shell only ever goes to github.com", () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  try {
    process.chdir(mkdtempSync(join(tmpdir(), "dovre-env-")));
    process.env.PATH = ""; // no gh: nothing to fall back on
    process.env.GITHUB_TOKEN = "github-com-token";
    process.env.GHE_HOST = "acme.ghe.com";
    process.env.GHE_TOKEN = "ghe-token";
    assert.equal(loadEnv().GHE_TOKEN, "ghe-token");
    delete process.env.GHE_TOKEN;
    assert.equal(loadEnv().GHE_TOKEN, undefined, "not sent to the enterprise host");
    process.env.GHE_HOST = "github.com";
    assert.equal(loadEnv().GHE_TOKEN, "github-com-token");
  } finally {
    process.chdir(cwd);
    process.env = saved;
  }
});

test("omp sessions resume with omp, in their profile; a profile that isn't a plain name is left out", () => {
  const s = session({ sessionId: "abc", cwd: "C:\\Code\\x" });
  assert.equal(resumeCommand(s), 'cd "C:\\Code\\x"; claude --resume abc');
  assert.equal(resumeCommand({ ...s, harness: "omp" }), 'cd "C:\\Code\\x"; omp --resume abc');
  assert.equal(resumeCommand({ ...s, harness: "omp", profile: "company-db" }), 'cd "C:\\Code\\x"; omp --profile company-db --resume abc');
  assert.equal(resumeCommand({ ...s, harness: "omp", profile: "x; rm -rf ~" }), 'cd "C:\\Code\\x"; omp --resume abc');
});

test("only the harnesses found are offered and run; with none, the pages say so instead of offering", () => {
  assert.match(bodyOf(newAgentPage({ repos: ["a"], harnesses: [] })), /No agent CLI found/);
  assert.doesNotMatch(bodyOf(newAgentPage({ repos: ["a"], harnesses: [] })), /action="\/agents\/new"/);
  const ompOnly = bodyOf(newAgentPage({ repos: ["a"], harnesses: ["omp"] }));
  assert.match(ompOnly, /Starts Copilot · omp headless/);
  assert.doesNotMatch(ompOnly, /value="claude"/);
  const was = found.harnesses;
  try {
    found.harnesses = [];
    assert.equal(agentPanel({ kind: "any" }), "", "nothing to hand a note to");
    found.harnesses = ["omp"];
    assert.match(String(agentPanel({ kind: "any" })), /Draft with an agent/);
  } finally {
    found.harnesses = was;
  }
  const runner = createRunner({ harnesses: { omp: ompHarness("omp") }, spawnFn: () => { throw new Error("not started in a test"); } });
  assert.deepEqual(runner.harnesses(), ["omp"], "no Claude unless it's here");
});

test("Settings → Setup says what's on, and how to turn on what's off", async () => {
  const lines = setupLines({ ghe: { host: "acme.ghe.com", org: "ACME", login: "me" }, claude: undefined, omp: "C:\\bin\\omp.exe", codeDir: "C:\\Code", repos: 0, platform: "win32" });
  const by = Object.fromEntries(lines.map((l) => [l.name, l]));
  assert.equal(by.GHE!.on, true);
  assert.match(by["Claude Code"]!.fix ?? "", /CLAUDE_BIN/);
  assert.equal(by["PowerShell 7"], undefined, "PowerShell is the Teams pack's business, not core's");
  assert.equal(by.db, undefined, "db is the Data pack's business, not core's");
  assert.equal(by.omp!.on, true);
  assert.match(by["Code folder"]!.fix ?? "", /directly in it/);
  assert.match(by["Copilot CLI"]!.fix ?? "", /winget/);
  assert.ok(by.Edge, "Edge is a Windows line");
  const mac = Object.fromEntries(setupLines({ ghe: { host: "github.com", org: "me", login: "me" }, codeDir: "/Users/me/src", repos: 3, platform: "darwin" }).map((l) => [l.name, l]));
  assert.match(mac["Copilot CLI"]!.fix ?? "", /npm install -g @github\/copilot/);
  assert.equal(mac.Edge, undefined);
  const { get } = signedIn(snapshot());
  const out = await (await get("/settings")).text();
  assert.match(out, /Setup/);
  assert.match(out, /Code folder/);
});
