/** Terminals: reachable only from Dovre's own pages, only fixed programs in checkouts, output kept nowhere. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../../../app.ts";
import { activePacks } from "../../../registry.ts";
import { openDb } from "../../../../db.ts";
import { terminalPack } from "../index.ts";
import { argvFor, findPrograms, launcherFlags, type Program } from "../programs.ts";
import { resumeButton } from "../view.ts";
import type { Session } from "../../../../sources/claude.ts";
import { type Chunk, createTerminals } from "../terms.ts";
import { appWithAgents, assertInert, fakeGhe, fixedGatherer, H, signedIn, snapshot } from "../../../../../test/helpers.ts";

/** A code folder with one checkout in it. */
function codeDir() {
  const dir = mkdtempSync(join(tmpdir(), "dovre-code-"));
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  return dir;
}

const frame = (kind: string, payload: string | Buffer) => {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const b = Buffer.alloc(5 + p.length);
  b[0] = kind.charCodeAt(0);
  b.writeUInt32LE(p.length, 1);
  p.copy(b, 5);
  return b;
};

/** A stand-in for the pty host: records what it's sent; the test says what it answers. */
function fakeHost() {
  const sent: { kind: string; payload: Buffer }[] = [];
  let args: string[] = [];
  let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => void } | undefined;
  const spawnFn = ((_bin: string, a: string[]) => {
    args = a;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let buf = Buffer.alloc(0);
    stdin.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 5) {
        const n = buf.readUInt32LE(1);
        if (buf.length < 5 + n) break;
        sent.push({ kind: String.fromCharCode(buf[0]!), payload: buf.subarray(5, 5 + n) });
        buf = buf.subarray(5 + n);
      }
    });
    child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => child!.emit("close") });
    return child;
  }) as never;
  return { spawnFn, sent, args: () => args, say: (kind: string, p: string) => child!.stdout.write(frame(kind, p)) };
}

const PROGRAMS: Program[] = [
  { id: "pwsh", label: "PowerShell", argv: ["C:\\pwsh.exe", "-NoLogo"] },
  { id: "claude", label: "Claude Code", argv: ["C:\\claude.exe"], harness: "claude" },
];
const tick = () => new Promise((r) => setTimeout(r, 10));

test("only a listed program, only in a checkout right under the code folder, only an agent CLI resumes", () => {
  const host = fakeHost();
  const t = createTerminals({ hostExe: "host.exe", codeDir: codeDir(), programs: PROGRAMS, spawnFn: host.spawnFn });
  assert.ok("problem" in t.start({ program: "powershell -c evil", repo: "repo" }));
  for (const repo of ["..", "../repo", "C:\\Windows", "nope", ""]) assert.ok("problem" in t.start({ program: "pwsh", repo }), repo);
  assert.ok("problem" in t.start({ program: "pwsh", repo: "repo", resume: "0b9e3f2a-1111-2222-3333-444444444444" }), "a shell doesn't resume");
  assert.ok("problem" in t.start({ program: "claude", repo: "repo", resume: "x; rm -rf" }), "an id looks like one");
  const ok = t.start({ program: "claude", repo: "repo", resume: "0b9e3f2a-1111-2222-3333-444444444444" });
  assert.ok(!("problem" in ok));
  assert.deepEqual(host.args().slice(-3), ["C:\\claude.exe", "--resume", "0b9e3f2a-1111-2222-3333-444444444444"]);
  assert.equal(argvFor(PROGRAMS[0]!, undefined)?.[0], "C:\\pwsh.exe");
});

test("a company profile's launcher flags are read narrowly, with the policy path put in", () => {
  const script = "$ompArguments = @(\n    '--profile', 'company-db',\n    '--config', $policyPath,\n    '--skills', 'db',\n    '--no-extensions'\n)";
  assert.deepEqual(launcherFlags(script, "C:\\p.yml"), ["--profile", "company-db", "--config", "C:\\p.yml", "--skills", "db", "--no-extensions"]);
  assert.deepEqual(launcherFlags("$ompArguments = @('--x', 'a b; calc', '--y')", "p"), ["--x", "--y"], "anything that isn't a plain flag or value is left out");
});

test("keys, sizes and close go to the host as frames; output replays to a page that comes back; exit ends it", async () => {
  const host = fakeHost();
  const changes: number[] = [];
  const t = createTerminals({ hostExe: "host.exe", codeDir: codeDir(), programs: PROGRAMS, spawnFn: host.spawnFn, onChange: () => changes.push(1) });
  const term = t.start({ program: "pwsh", repo: "repo", cols: 100, rows: 30 });
  assert.ok(!("problem" in term));
  assert.deepEqual(host.args().slice(0, 7), ["pty-host", "--cols", "100", "--rows", "30", "--cwd", join(t.get(term.id)!.cwd)]);
  host.say("o", "PS C:\\repo> ");
  await tick();
  t.input(term.id, "git status\r");
  t.resize(term.id, 80, 24);
  await tick();
  assert.deepEqual(host.sent.map((s) => s.kind), ["i", "r"]);
  assert.equal(host.sent[0]!.payload.toString(), "git status\r");
  assert.deepEqual([host.sent[1]!.payload.readUInt16LE(0), host.sent[1]!.payload.readUInt16LE(2)], [80, 24]);
  const seen: Chunk[] = [];
  const off = t.attach(term.id, (c) => seen.push(c))!;
  assert.deepEqual(seen, [{ t: "out", data: "PS C:\\repo> " }], "what was there already");
  host.say("o", "On branch main");
  await tick();
  assert.equal(seen.length, 2);
  off();
  t.close(term.id);
  await tick();
  assert.equal(host.sent.at(-1)!.kind, "k");
  host.say("x", '{"code":0}');
  await tick();
  assert.equal(t.get(term.id)!.code, 0);
  assert.ok(t.get(term.id)!.endedAt);
  assert.equal(t.input(term.id, "more"), false, "an ended terminal takes no keys");
  assert.ok(changes.length >= 2);
});

/** The app with the terminal pack mounted as index.ts mounts it, signed in; requests as a browser on Dovre's own page would send them. */
function app(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dovre-term-app-"));
  const host = fakeHost();
  const terminals = createTerminals({ hostExe: "host.exe", codeDir: codeDir(), programs: PROGRAMS, spawnFn: host.spawnFn });
  const packs = { ...activePacks([terminalPack(terminals)], { env, hosted: false, which: () => undefined }), env, core: ["terminal"] };
  const a = appWithAgents({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", U_DB: join(dir, "u.sqlite"), DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, packs });
  const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) =>
    a.request(`http://${init.host ?? "localhost"}${path}`, { method: init.method ?? "GET", headers: init.headers, body: init.body });
  return { req, terminals, host, dir };
}
const COOKIE = { cookie: "u_tk=test-token" };
const SAME = { ...COOKIE, origin: "http://localhost", "content-type": "application/json" };

test("the guard: no cookie, another host, a request another site started, or a write without this app's Origin gets nowhere", async () => {
  const { req, terminals } = app();
  const t = terminals.start({ program: "pwsh", repo: "repo" });
  assert.ok(!("problem" in t));
  const paths = ["/terminal", `/terminal/${t.id}`, `/terminal/${t.id}/stream`];
  for (const p of paths) {
    assert.equal((await req(p)).status, 404, `${p} without the cookie`);
    assert.equal((await req(p, { headers: COOKIE, host: "evil.example" })).status, 404, `${p} on another host`);
    assert.equal((await req(p, { headers: { ...COOKIE, "sec-fetch-site": "cross-site" } })).status, 404, `${p} from another site`);
  }
  const input = (headers: Record<string, string>) => req(`/terminal/${t.id}/input`, { method: "POST", headers, body: JSON.stringify({ data: "calc\r" }) });
  assert.equal((await input({ cookie: "u_tk=test-token", "content-type": "application/json" })).status, 403, "no Origin: refused here, though the app lets it through elsewhere");
  assert.equal((await input({ ...SAME, origin: "http://evil.example" })).status, 403, "another origin");
  assert.equal((await input({ ...SAME, origin: "null" })).status, 403, "an opaque origin (a file page, a sandbox)");
  assert.equal((await input({ ...SAME, origin: "http://localhost", "sec-fetch-site": "same-site" })).status, 404, "a sibling site");
  assert.equal((await req("/terminal", { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded" }, body: "program=pwsh&repo=repo" })).status, 403, "starting one needs the Origin too");
  assert.equal((await input(SAME)).status, 204, "Dovre's own page gets through");
});

test("pages: the list, a terminal, and its stream; starting one from the form", async () => {
  const { req, host } = app();
  const list = await req("/terminal", { headers: COOKIE });
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.match(html, /<option value="pwsh">PowerShell<\/option>/);
  assert.match(html, /<option value="repo">repo<\/option>/);
  const started = await req("/terminal", { method: "POST", headers: { ...COOKIE, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: "program=pwsh&repo=repo" });
  assert.equal(started.status, 303);
  const at = started.headers.get("location")!;
  assert.match(at, /^\/terminal\/[0-9a-f-]{36}$/);
  const page = await (await req(at, { headers: COOKIE })).text();
  assert.match(page, /<div id="term" class="term" data-id="[0-9a-f-]{36}"/);
  assert.match(page, /<script src="\/terminal\/xterm-[\d.]+\/xterm\.js" defer><\/script>/);
  // Its scripts and xterm's are served under /terminal, as a pack's routes must be.
  for (const src of page.matchAll(/<(?:script src|link rel="stylesheet" href)="(\/terminal\/[^"]+)"/g)) {
    const r = await req(src[1]!, { headers: { ...COOKIE, "sec-fetch-site": "same-origin" } });
    assert.equal(r.status, 200, src[1]);
  }
  assert.equal((await req("/terminal/not-an-id", { headers: COOKIE })).status, 404);
  // The stream: what the terminal showed so far, as an "out" event.
  host.say("o", "PS repo> ");
  await tick();
  const stream = await req(`${at}/stream`, { headers: COOKIE });
  assert.equal(stream.headers.get("content-type")?.split(";")[0], "text/event-stream");
  const reader = stream.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes('event: out') && first.includes('data: "PS repo> "'), first);
  await reader.cancel();
  const bad = await req("/terminal", { method: "POST", headers: { ...COOKIE, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: "program=pwsh&repo=..%2F.." });
  assert.equal(bad.status, 400);
});

const exe = fileURLToPath(new URL(`../../../../../bin/dovre${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const hostReady = existsSync(exe) && readFileSync(exe).includes(Buffer.from("pty-host"));
const skip = hostReady ? false : "needs the launcher built with pty-host (go build -o ../bin/dovre . in launcher/)";

test("for real: shell in a checkout through the pty host echoes, closes, and nothing it showed is kept", { skip }, async () => {
  const dir = codeDir();
  const isWin = process.platform === "win32";
  const shellBin = isWin ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "/bin/sh";
  const t = createTerminals({ hostExe: exe, codeDir: dir, programs: [{ id: "sh", label: "Shell", argv: [shellBin] }] });
  const term = t.start({ program: "sh", repo: "repo" });
  assert.ok(!("problem" in term));
  let out = "";
  t.attach(term.id, (c) => (c.t === "out" ? (out += c.data) : undefined));
  const until = async (ok: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(out.slice(-300))}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  if (isWin) {
    await until(() => out.includes(">"));
    t.input(term.id, "echo SECRET-ROW-%USERNAME%-4242\r");
    await until(() => /SECRET-ROW-.+-4242/.test(out.split("echo")[1] ?? ""));
  } else {
    t.input(term.id, "echo SECRET-ROW-$USER-4242\n");
    await until(() => /SECRET-ROW-.*-4242/.test(out));
  }
  t.close(term.id);
  await until(() => !!t.get(term.id)!.endedAt);
  // Nothing in the code folder but what was there.
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(dir)) assert.ok(!readFileSync(f, "utf8").includes("SECRET-ROW"), f);
});

test("as a pack: PACK_TERMINAL=off takes its routes and nav away", async () => {
  const on = app();
  assert.match(await (await on.req("/agents", { headers: COOKIE })).text(), /href="\/terminal"/);
  const off = app({ PACK_TERMINAL: "off" });
  assert.equal((await off.req("/terminal", { headers: COOKIE })).status, 404);
  const t = off.terminals.start({ program: "pwsh", repo: "repo" });
  assert.ok(!("problem" in t));
  assert.equal((await off.req(`/terminal/${t.id}`, { headers: COOKIE })).status, 404);
  assert.doesNotMatch(await (await off.req("/agents", { headers: COOKIE })).text(), /href="\/terminal"/);
});

test("slots: the panel on Agents, a worktree's button, resuming an ended session here; hostile names stay text", async () => {
  const ended = { sessionId: "0814bfd3-d4f5-4c19-ba8e-e9a57283f67d", live: false, kind: "interactive", cwd: `C:\\Code\\${H}`, repo: H, harness: "copilot", prs: [], lastAt: Date.now() - 60_000 } as unknown as Session;
  const { get } = signedIn(snapshot(), {}, { worktrees: [{ name: H, main: "repo", branch: "fix/x", head: "abc1234", changedAt: Date.now() }] as never, sessions: { recent: [ended] } });
  const agents = await (await get("/agents")).text();
  assert.match(agents, /Terminals here/);
  assert.match(agents, /<form method="post" action="\/terminal" class="resume-here"><input type="hidden" name="program" value="copilot">/);
  assertInert("/agents", agents);
  const trees = await (await get("/worktrees")).text();
  assert.match(trees, /<a class="btn sm" href="\/terminal\?repo=%3Cscript%3E/);
  assertInert("/worktrees", trees);
  assert.equal(resumeButton({ ...ended, repo: undefined }), "", "no checkout, nothing to resume in");
  assert.match(String(resumeButton({ ...ended, harness: "omp", profile: "work" } as Session)), /value="omp:work"/);
});

test("programs: Copilot CLI from its own path, and each CLI resumes with its own flag", () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-home-"));
  const bin = join(mkdtempSync(join(tmpdir(), "dovre-bin-")), process.platform === "win32" ? "copilot.exe" : "copilot");
  writeFileSync(bin, "");
  const p = findPrograms({ env: { PATH: "", PATHEXT: ".EXE" }, home, copilotBin: bin }).find((x) => x.id === "copilot")!;
  assert.deepEqual(p.argv, [bin, "--no-auto-update"]);
  assert.deepEqual(argvFor(p, "c1-2222-3333"), [bin, "--no-auto-update", "--resume", "c1-2222-3333"]);
  assert.deepEqual(argvFor({ id: "agy", label: "Antigravity CLI", argv: ["agy"], harness: "agy" }, "c1-2222-3333"), ["agy", "--conversation", "c1-2222-3333"]);
  assert.deepEqual(argvFor({ id: "claude", label: "Claude Code", argv: ["claude"], harness: "claude" }, "c1-2222-3333"), ["claude", "--resume", "c1-2222-3333"]);
});

test("programs: Codex from its own path resumes with `resume`, and a CLI switched off isn't offered", () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-home-"));
  const dir = mkdtempSync(join(tmpdir(), "dovre-bin-"));
  const exe = (n: string) => join(dir, process.platform === "win32" ? `${n}.exe` : n);
  writeFileSync(exe("codex"), "");
  writeFileSync(exe("copilot"), "");
  const env = { PATH: "", PATHEXT: ".EXE" };
  const p = findPrograms({ env, home, codexBin: exe("codex") }).find((x) => x.id === "codex")!;
  assert.deepEqual(p.argv, [exe("codex")]);
  assert.deepEqual(argvFor(p, "0199a213-81c0-7800"), [exe("codex"), "resume", "0199a213-81c0-7800"]);
  const ids = findPrograms({ env, home, codexBin: exe("codex"), copilotBin: exe("copilot"), on: (h) => h === "codex" }).map((x) => x.id);
  assert.ok(ids.includes("codex"));
  assert.ok(!ids.includes("copilot"), "switched off");
});

test("openExternal: launches Warp launch config or Windows Terminal with validated program, checkout, and session id", async () => {
  const spawned: { bin: string; args: string[] }[] = [];
  const spawnFn = ((bin: string, args: string[]) => {
    spawned.push({ bin, args });
    return Object.assign(new EventEmitter(), { unref: () => {} });
  }) as never;
  const warpDir = mkdtempSync(join(tmpdir(), "dovre-warp-"));
  const dir = codeDir();
  const t = createTerminals({ hostExe: "host.exe", codeDir: dir, programs: PROGRAMS, spawnFn, warpDir });

  // Refuses unvalidated repo, program, or session id
  assert.ok("problem" in t.openExternal({ app: "warp", program: "evil", repo: "repo", resume: "0b9e3f2a-1111-2222-3333-444444444444" }));
  assert.ok("problem" in t.openExternal({ app: "warp", program: "claude", repo: "../etc", resume: "0b9e3f2a-1111-2222-3333-444444444444" }));
  assert.ok("problem" in t.openExternal({ app: "warp", program: "claude", repo: "repo", resume: "bad; rm -rf" }));
  assert.equal(spawned.length, 0);

  // Warp: writes ~/.warp/launch_configurations/dovre-session.yaml and opens warp://launch/dovre-session
  const warpRes = t.openExternal({ app: "warp", program: "claude", repo: "repo", resume: "0b9e3f2a-1111-2222-3333-444444444444" });
  assert.deepEqual(warpRes, { ok: true });
  const yaml = readFileSync(join(warpDir, "dovre-session.yaml"), "utf8");
  assert.match(yaml, /name: dovre-session/);
  assert.match(yaml, /--resume 0b9e3f2a-1111-2222-3333-444444444444/);
  assert.ok(spawned.at(-1)!.args.includes("warp://launch/dovre-session"));

  // Windows Terminal: spawns wt.exe -d <cwd> -- <argv>
  const wtRes = t.openExternal({ app: "wt", program: "claude", repo: "repo", resume: "0b9e3f2a-1111-2222-3333-444444444444" });
  assert.deepEqual(wtRes, { ok: true });
  assert.equal(spawned.at(-1)!.bin, "wt.exe");
  assert.deepEqual(spawned.at(-1)!.args.slice(-4), ["--", "C:\\claude.exe", "--resume", "0b9e3f2a-1111-2222-3333-444444444444"]);

  // resumeButton renders both in-Dovre and external terminal buttons and maps codex/agy harnesses
  const btn = String(resumeButton({ sessionId: "0814bfd3-d4f5", live: false, repo: "repo", harness: "codex", prs: [] } as unknown as Session, "warp"));
  assert.match(btn, /value="codex"/);
  assert.match(btn, /formaction="\/terminal\/external"[^>]*>Open in Warp<\/button>/);
});
