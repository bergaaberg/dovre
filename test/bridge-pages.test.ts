/**
 * Hosted agent pages through the bridge (PLAN D24, WP-N10d): the app on `remoteDesk`, wired to a
 * real `localDesk` (the Mac's) through the same call dispatcher the bridge serves
 * (src/bridge/serve.ts). Online it starts and shows turns on the Mac; offline it shows what the
 * Mac last said and says so, never an empty page; what the Mac says is escaped like anything else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { localDesk } from "../src/agents/desk.ts";
import { createQueue } from "../src/agents/queue.ts";
import { createRunner } from "../src/agents/runner.ts";
import { remoteDesk } from "../src/bridge/remote.ts";
import { answerCall, stateOf } from "../src/bridge/serve.ts";
import type { MacAnswer, MacView } from "../src/hosted/hub.ts";
import { assertInert, H, session, signedIn, snapshot } from "./helpers.ts";

const SESSION = "5a1e7c2b-0d3f-4e6a-9b8c-1d2e3f4a5b6c";
const OLD = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

function fakeSpawn() {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: 1, kill: () => true });
    setTimeout(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SESSION })}\n`);
      stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `the plan ${H}` }] } })}\n`);
      stdout.write(`${JSON.stringify({ type: "result", result: "planned", total_cost_usd: 0 })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    }, 5);
    return child;
  };
}

/** The Mac (its desk) and the hub between, online or not: the hub keeps the last state either way. */
function setup() {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "shop-api", ".git"), { recursive: true });
  const env = { CODE_DIR: code, CLAUDE_DIR: mkdtempSync(join(tmpdir(), "claude-")), AGENT_DIR: join(code, "agents") };
  // The transcript Claude Code writes on the Mac: where a session's page reads what was said.
  mkdirSync(join(env.CLAUDE_DIR, "projects", "shop-api"), { recursive: true });
  const say = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    join(env.CLAUDE_DIR, "projects", "shop-api", `${SESSION}.jsonl`),
    [say({ type: "user", message: { content: "make a plan" }, timestamp: "2026-10-24T10:00:00Z", cwd: join(code, "shop-api") }), say({ type: "assistant", message: { content: [{ type: "text", text: `the plan ${H}` }] }, timestamp: "2026-10-24T10:00:05Z" })].join("\n") + "\n",
  );
  const runner = createRunner({ spawnFn: fakeSpawn() });
  const recent = [session({ sessionId: OLD, live: false, title: `Old ${H}`, repo: "shop-api", cwd: join(code, "shop-api") })];
  const sessions = async () => ({ live: [], recent });
  const mac = localDesk({ env, runner, queue: createQueue(), sessions });
  const box = { online: true, last: undefined as MacView["state"] };
  const hub = {
    async mac(): Promise<MacView> {
      if (box.online) box.last = stateOf(mac, await sessions());
      return { online: box.online, seen: Date.now() - 5 * 60_000, watching: false, state: box.last };
    },
    async call(c: Parameters<typeof answerCall>[1]): Promise<MacAnswer> {
      if (!box.online) return { ok: false, error: "Your Mac is offline.", offline: true };
      // As it crosses the wire: JSON both ways.
      return answerCall(mac, JSON.parse(JSON.stringify(c))).then(
        (v) => ({ ok: true, value: JSON.parse(JSON.stringify(v ?? null)) }),
        (e) => ({ ok: false, error: String(e.message) }),
      );
    },
  };
  const { get, post } = signedIn(snapshot(), {}, { desk: remoteDesk(hub, { ttlMs: 0 }) });
  return { get, post, box, runner };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "waited too long");
};

test("hosted agents, Mac online: its sessions listed, a turn started in its checkout, what it said shown escaped", async () => {
  const { get, post, runner } = setup();
  const list = await (await get("/agents")).text();
  assert.match(list, /Old &lt;script&gt;/);
  assertInert("/agents", list);
  assert.doesNotMatch(list, /Your Mac is offline/);

  const form = await (await get("/agents/new")).text();
  assert.match(form, /<option value="shop-api"/);

  const started = await post("/agents/new", { repo: "shop-api", prompt: "make a plan", harness: "claude", mode: "default" });
  assert.equal(started.status, 303);
  assert.equal(started.headers.get("location"), `/agents/s/${SESSION}`);
  await until(() => runner.list()[0]?.status === "done");

  const page = await (await get(`/agents/s/${SESSION}`)).text();
  assert.match(page, /the plan &lt;script&gt;/);
  assertInert("session", page);
  assert.match(page, new RegExp(`action="/agents/s/${SESSION}/reply"`));

  const refused = await post("/agents/new", { repo: "../etc", prompt: "x" });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /Pick a checkout in your code folder/);
});

test("hosted agents, Mac offline: what it last said, and saying so; no forms that would go nowhere", async () => {
  const { get, post, box, runner } = setup();
  await post("/agents/new", { repo: "shop-api", prompt: "make a plan", harness: "claude" });
  await until(() => runner.list()[0]?.status === "done");
  await get("/agents");
  box.online = false;

  const list = await (await get("/agents")).text();
  assert.match(list, /Your Mac is offline, last seen 5 min ago/);
  assert.match(list, /Old &lt;script&gt;/, "the sessions it last listed");
  assertInert("/agents offline", list);

  const page = await get(`/agents/s/${SESSION}`);
  assert.equal(page.status, 200, "the session as last listed, not a 404");
  const text = await page.text();
  assert.match(text, /Your Mac is offline/);
  assert.match(text, /make a plan/);
  assert.doesNotMatch(text, /the plan/, "what it said isn't kept off the Mac");
  assert.doesNotMatch(text, new RegExp(`action="/agents/s/${SESSION}/reply"`));

  const form = await (await get("/agents/new")).text();
  assert.match(form, /Your Mac is offline/);
  assert.doesNotMatch(form, /action="\/agents\/new"/);

  const reply = await post(`/agents/s/${SESSION}/reply`, { prompt: "and then?" });
  assert.equal(reply.status, 303);
  assert.match(await (await get(`/agents/s/${SESSION}`)).text(), /Your Mac is offline\./);
});
