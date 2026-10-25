/** Agents started here: Dovre's own folder for work outside a repo, and stopping and clearing away what was started here. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { createDismissed } from "../src/agents/dismissed.ts";
import { createRunner, type Runner } from "../src/agents/runner.ts";
import { WORK, ensureWorkDir, inWorkDir, workDirOf } from "../src/agents/workdir.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { appWithAgents, fakeGhe, session, snapshot } from "./helpers.ts";

const SID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("the working folder: under ~/.dovre unless AGENT_DIR moves it (never a checkout's name), made with a note for agents, never overwritten", () => {
  const home = resolve(tmpdir(), "home");
  assert.equal(workDirOf({}, home), join(home, ".dovre", "agents"));
  const agents = resolve(tmpdir(), "agents");
  assert.equal(workDirOf({ AGENT_DIR: agents }, home), agents);
  const dir = join(mkdtempSync(join(tmpdir(), "code-")), "agents");
  ensureWorkDir(dir);
  for (const f of ["CLAUDE.md", "AGENTS.md"]) assert.match(readFileSync(join(dir, f), "utf8"), /isn't a repo/);
  writeFileSync(join(dir, "CLAUDE.md"), "mine");
  ensureWorkDir(dir);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "mine");
  assert.ok(inWorkDir(dir, dir) && inWorkDir(dir, join(dir, "notes")) && inWorkDir(dir, dir.toUpperCase()));
  assert.ok(!inWorkDir(dir, `${dir}-other`) && !inWorkDir(dir, undefined) && !inWorkDir(dir, join(dir, "..")));
});

test("cleared sessions stay cleared across restarts, until a new turn brings them back; running ones always show", async () => {
  const db = openDb();
  const d = createDismissed(db.DB);
  await d.ready;
  await d.add([SID(1), SID(2)]);
  const again = createDismissed(db.DB);
  await again.ready;
  assert.ok(again.has(SID(1)) && again.has(SID(2)));
  await again.remove(SID(1));
  const third = createDismissed(db.DB);
  await third.ready;
  assert.ok(!third.has(SID(1)) && third.has(SID(2)));
});

/** Each run says which session it is, then ends (or keeps going, for `hold`). */
function fakeSpawn(hold: Set<string> = new Set()) {
  let n = 10;
  return (_bin: string, _args: string[], _o: { cwd: string }) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let prompt = "";
    stdin.on("data", (x) => (prompt += x));
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, pid: undefined, kill: () => (child.emit("close", 1), true) });
    const sid = SID(++n);
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sid })}\n`);
      if (hold.has(prompt)) return;
      stdout.write(`${JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0 })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

function world(o: { recent?: (work: string, code: string) => ReturnType<typeof session>[]; hold?: Set<string> } = {}) {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "people", ".git"), { recursive: true });
  const work = join(code, "agents");
  const snap = snapshot();
  const runner: Runner = createRunner({ spawnFn: fakeSpawn(o.hold) });
  const gatherer = { get: async () => snap, stale: () => {}, gathering: () => false, peek: () => snap };
  const app = appWithAgents({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: code, AGENT_DIR: work, CLAUDE_DIR: join(code, "no-claude"), DB: openDb().DB }, { gatherer, ghe: fakeGhe({}).ghe, runner, sessions: { recent: o.recent?.(work, code) ?? [] } });
  const get = async (path: string) => (await app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } })).text();
  const post = async (path: string, body: Record<string, string> = {}, referer?: string) => {
    const res = await app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...(referer ? { referer } : {}) }, body: new URLSearchParams(body).toString() });
    return { status: res.status, location: res.headers.get("location") };
  };
  return { code, work, runner, get, post };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("a new session runs in Dovre's folder unless a checkout is picked; the folder is made on first use", async () => {
  const w = world();
  assert.match(await w.get("/agents/new"), new RegExp(`<option value="${WORK}" selected>`));
  assert.match(await w.get("/agents/new?repo=people"), /<option value="people" selected>people<\/option>/);
  assert.match(await w.get("/agents/new?repo=nope"), new RegExp(`<option value="${WORK}" selected>`), "a repo that isn't here falls back to the folder");
  assert.ok(!existsSync(w.work));
  assert.equal((await w.post("/agents/new", { repo: WORK, prompt: "draft a ticket" })).status, 303);
  assert.equal(w.runner.list()[0]!.cwd, w.work);
  assert.ok(existsSync(join(w.work, "CLAUDE.md")));
  await w.post("/agents/new", { repo: "people", prompt: "fix it" });
  assert.equal(w.runner.list().find((r) => r.prompt === "fix it")!.cwd, join(w.code, "people"));
  for (const bad of ["..", "agents", "@other", ""]) assert.equal((await w.post("/agents/new", { repo: bad, prompt: "x" })).status, 400, bad);
});

test("a working run has Stop; an ended one is cleared away (off the lists), and back where the button was", async () => {
  const w = world({ hold: new Set(["slow"]) });
  await w.post("/agents/new", { repo: WORK, prompt: "slow" });
  await w.post("/agents/new", { repo: WORK, prompt: "quick" });
  await settle();
  const [quick, slow] = [w.runner.list().find((r) => r.prompt === "quick")!, w.runner.list().find((r) => r.prompt === "slow")!];
  assert.equal(quick.status, "done");
  assert.equal(slow.status, "running");
  const page = await w.get("/agents");
  assert.match(page, new RegExp(`action="/agents/r/${slow.id}/stop"`));
  assert.match(page, new RegExp(`action="/agents/r/${quick.id}/discard"`));
  assert.doesNotMatch(page, new RegExp(`action="/agents/r/${slow.id}/discard"`), "nothing working can be cleared");
  assert.equal((await w.post(`/agents/r/${slow.id}/discard`)).status, 303);
  assert.ok(w.runner.get(slow.id), "a running run stays");
  assert.equal((await w.post(`/agents/r/${quick.id}/discard`, {}, "http://localhost/")).location, "/", "back to Today");
  assert.equal(w.runner.get(quick.id), undefined);
  assert.equal((await w.post(`/agents/r/${slow.id}/stop`)).location, "/agents");
  assert.equal(w.runner.get(slow.id)!.status, "stopped");
});

test("Clear finished takes every ended run and the ended sessions in Dovre's folder, and leaves sessions from elsewhere", async () => {
  const v = world({
    recent: (work, code) => [
      session({ sessionId: SID(1), live: false, cwd: work, title: "work 1" }),
      session({ sessionId: SID(2), live: false, cwd: join(code, "people"), title: "mine elsewhere" }),
    ],
  });
  await v.post("/agents/new", { repo: WORK, prompt: "quick" });
  await settle();
  const page = await v.get("/agents");
  assert.match(page, /Clear finished/);
  assert.match(page, new RegExp(`action="/agents/s/${SID(1)}/discard"`), "a session in the folder can be cleared");
  assert.doesNotMatch(page, new RegExp(`action="/agents/s/${SID(2)}/discard"`), "one from elsewhere can't");
  assert.equal((await v.post(`/agents/s/${SID(2)}/discard`)).location, `/agents/s/${SID(2)}`, "refused, back to the session");
  assert.equal((await v.post("/agents/clear")).location, "/agents");
  assert.equal(v.runner.list().length, 0);
  const after = await v.get("/agents");
  assert.doesNotMatch(after, /work 1/);
  assert.match(after, /mine elsewhere/);
});
