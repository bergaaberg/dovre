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
import type { MacState } from "../src/bridge/wire.ts";
import { viewingAs } from "../src/viewer.ts";
import { assertInert, H, session, signedIn, snapshot } from "./helpers.ts";

const SESSION = "5a1e7c2b-0d3f-4e6a-9b8c-1d2e3f4a5b6c";
const OLD = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

function fakeSpawn(sid = SESSION) {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: 1, kill: () => true });
    setTimeout(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sid })}\n`);
      stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `the plan ${H}` }] } })}\n`);
      stdout.write(`${JSON.stringify({ type: "result", result: "planned", total_cost_usd: 0 })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    }, 5);
    return child;
  };
}

/** One machine: its own code folder (with `repo`), transcript and desk, online or not. */
function machine(o: { id: string; name?: string; owner?: string; repo: string; sid: string; old: string }) {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, o.repo, ".git"), { recursive: true });
  const env = { CODE_DIR: code, CLAUDE_DIR: mkdtempSync(join(tmpdir(), "claude-")), AGENT_DIR: join(code, "agents") };
  // The transcript Claude Code writes on the machine: where a session's page reads what was said.
  mkdirSync(join(env.CLAUDE_DIR, "projects", o.repo), { recursive: true });
  const say = (x: unknown) => JSON.stringify(x);
  writeFileSync(
    join(env.CLAUDE_DIR, "projects", o.repo, `${o.sid}.jsonl`),
    [say({ type: "user", message: { content: "make a plan" }, timestamp: "2026-10-24T10:00:00Z", cwd: join(code, o.repo) }), say({ type: "assistant", message: { content: [{ type: "text", text: `the plan ${H}` }] }, timestamp: "2026-10-24T10:00:05Z" })].join("\n") + "\n",
  );
  const runner = createRunner({ spawnFn: fakeSpawn(o.sid) });
  const recent = [session({ sessionId: o.old, live: false, title: `Old ${H}`, repo: o.repo, cwd: join(code, o.repo) })];
  const sessions = async () => ({ live: [], recent });
  const desk = localDesk({ env, runner, queue: createQueue(), sessions });
  return { id: o.id, name: o.name, owner: o.owner, desk, sessions, runner, online: true, last: undefined as MacState | undefined, calls: 0 };
}
type Machine = ReturnType<typeof machine>;

/** The machines (their desks) and the hub between, online or not: the hub keeps each one's last state either way. */
function setup(machines: Machine[] = [machine({ id: "mac", repo: "shop-api", sid: SESSION, old: OLD })]) {
  const hub = {
    async mac(): Promise<MacView> {
      for (const m of machines) if (m.online) m.last = { ...stateOf(m.desk, await m.sessions()), ...(m.name ? { name: m.name } : {}) };
      return { watching: false, machines: machines.map((m) => ({ id: m.id, name: m.name, ...(m.owner ? { owner: m.owner } : {}), online: m.online, seen: Date.now() - 5 * 60_000, state: m.last })) };
    },
    async call(c: Parameters<typeof answerCall>[1], _ms?: number, id?: string): Promise<MacAnswer> {
      const on = machines.filter((m) => m.online);
      const m = id ? machines.find((x) => x.id === id) : on.length === 1 ? on[0] : undefined;
      if (!m && !id && on.length > 1) return { ok: false, error: "Say which machine." };
      if (!m?.online) return { ok: false, error: "Your Mac is offline.", offline: true };
      m.calls++;
      // As it crosses the wire: JSON both ways.
      return answerCall(m.desk, JSON.parse(JSON.stringify(c))).then(
        (v) => ({ ok: true, value: JSON.parse(JSON.stringify(v ?? null)) }),
        (e) => ({ ok: false, error: String(e.message) }),
      );
    },
  };
  const { get, post } = signedIn(snapshot(), {}, { desk: remoteDesk(hub, { ttlMs: 0 }) });
  const first = machines[0]!;
  return { get, post, machines, box: first, runner: first.runner };
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

test("hosted agents, two machines: both listed and named, a turn starts on the one picked, a session's actions go to its own", async () => {
  const LAPTOP_SID = "7c1e7c2b-0d3f-4e6a-9b8c-1d2e3f4a5b6c";
  const LAPTOP_OLD = "1b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
  const desktop = machine({ id: "0123456789abcdef", name: `desk ${H}`, repo: "shop-api", sid: SESSION, old: OLD });
  const laptop = machine({ id: "fedcba9876543210", name: "laptop", repo: "web", sid: LAPTOP_SID, old: LAPTOP_OLD });
  const { get, post } = setup([desktop, laptop]);

  const list = await (await get("/agents")).text();
  assert.match(list, /desk &lt;script&gt;/, "each row says its machine, escaped");
  assert.match(list, />laptop</);
  assertInert("/agents two machines", list);

  const form = await (await get("/agents/new")).text();
  assert.match(form, /<select name="machine"/);
  assert.match(form, /<option value="fedcba9876543210">laptop</);
  assert.match(form, /<option value="web"/, "every machine's checkouts");
  assert.match(form, /<option value="shop-api"/);
  assertInert("/agents/new two machines", form);

  // Not saying which: refused, the form again.
  const unsaid = await post("/agents/new", { repo: "web", prompt: "x", harness: "claude" });
  assert.equal(unsaid.status, 400);
  assert.match(await unsaid.text(), /Pick the machine to run it on/);

  const started = await post("/agents/new", { machine: laptop.id, repo: "web", prompt: "make a plan", harness: "claude", mode: "default" });
  assert.equal(started.headers.get("location"), `/agents/s/${LAPTOP_SID}`);
  await until(() => laptop.runner.list()[0]?.status === "done");
  assert.equal(desktop.runner.list().length, 0, "nothing ran on the other machine");

  // The laptop's session: read from the laptop, and a reply goes there too.
  await get("/agents");
  const before = desktop.calls;
  assert.match(await (await get(`/agents/s/${LAPTOP_SID}`)).text(), /the plan &lt;script&gt;/);
  await post(`/agents/s/${LAPTOP_SID}/reply`, { prompt: "and then?" });
  assert.equal(desktop.calls, before, "the desktop wasn't asked");

  // The laptop goes offline: the page says that one is, by name; the other still works.
  laptop.online = false;
  const off = await (await get("/agents")).text();
  assert.match(off, /laptop is offline, last seen 5 min ago/);
  assert.doesNotMatch(off, /None of your machines/);
  const page = await (await get(`/agents/s/${LAPTOP_SID}`)).text();
  assert.match(page, /laptop is offline/);
  assert.doesNotMatch(page, new RegExp(`action="/agents/s/${LAPTOP_SID}/reply"`));
  const one = await (await get("/agents/new")).text();
  assert.doesNotMatch(one, /<select name="machine"/, "one online: nothing to pick");

  desktop.online = false;
  assert.match(await (await get("/agents")).text(), /None of your machines is online/);
});

test("hosted agents (T4): each person sees only the machines they paired, and those nobody did; another's are as if not there", async () => {
  const KARI_SID = "7c1e7c2b-0d3f-4e6a-9b8c-1d2e3f4a5b6c";
  const KARI_OLD = "1b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
  const OLA_SID = "2d1e7c2b-0d3f-4e6a-9b8c-1d2e3f4a5b6c";
  const OLA_OLD = "3c1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
  const kari = machine({ id: "0123456789abcdef", name: "kari-laptop", owner: "kari@example.dev", repo: "shop-api", sid: KARI_SID, old: KARI_OLD });
  const ola = machine({ id: "fedcba9876543210", name: "ola-desktop", owner: "ola@example.dev", repo: "web", sid: OLA_SID, old: OLA_OLD });
  const { get, post } = setup([kari, ola]);
  const asKari = <T>(fn: () => T | Promise<T>) => Promise.resolve(viewingAs("Kari@example.dev", fn));
  const asOla = <T>(fn: () => T | Promise<T>) => Promise.resolve(viewingAs("ola@example.dev", fn));

  const list = await asKari(async () => (await get("/agents")).text());
  assert.match(list, new RegExp(KARI_OLD));
  assert.doesNotMatch(list, new RegExp(OLA_OLD), "Ola's sessions aren't on Kari's list");
  assert.doesNotMatch(list, /ola-desktop/);
  const form = await asKari(async () => (await get("/agents/new")).text());
  assert.doesNotMatch(form, /<select name="machine"/, "one machine of hers: nothing to pick");
  assert.doesNotMatch(form, /<option value="web"/, "nor Ola's checkouts");

  // Ola's machine named outright: refused, nothing runs there.
  const theirs = await asKari(() => post("/agents/new", { machine: ola.id, repo: "web", prompt: "x", harness: "claude" }));
  assert.equal(theirs.status, 400);
  assert.equal(ola.calls, 0);
  // Kari's own, with no machine named: hers, the one she sees online.
  const started = await asKari(() => post("/agents/new", { repo: "shop-api", prompt: "make a plan", harness: "claude", mode: "default" }));
  assert.equal(started.headers.get("location"), `/agents/s/${KARI_SID}`);
  await until(() => kari.runner.list()[0]?.status === "done");

  // Ola can't open, answer or stop Kari's session, even knowing its id.
  await asOla(() => get("/agents"));
  const before = kari.calls;
  const page = await asOla(() => get(`/agents/s/${KARI_SID}`));
  assert.equal(page.status, 404);
  await asOla(() => post(`/agents/s/${KARI_SID}/reply`, { prompt: "and then?" }));
  await asOla(() => post(`/agents/s/${KARI_SID}/stop`, {}));
  assert.equal(kari.calls, before, "Kari's machine wasn't asked anything");
  assert.match(await asOla(async () => (await get("/agents")).text()), new RegExp(OLA_OLD));

  // Nobody signed in (background work): only machines nobody paired.
  assert.doesNotMatch(await (await get("/agents")).text(), new RegExp(`${KARI_OLD}|${OLA_OLD}`));

  // A machine nobody paired (a self-hosted bridge) is everyone's.
  ola.owner = undefined;
  assert.match(await asKari(async () => (await get("/agents")).text()), new RegExp(OLA_OLD));
});
