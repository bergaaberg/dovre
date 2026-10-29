/**
 * The Mac's bridge (PLAN D24, WP-N10): the signed wire (src/bridge/wire.ts) and the hub's end of the
 * socket (src/hosted/hub.ts): hello, frames in order, calls relayed, the Mac's metadata kept,
 * watching, and a socket that outlives the object (hibernation).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { channel, hello, helloOk, HELLO_SKEW_MS, keyOk, machineKey, parseDown, parseUp, sessionKey } from "../src/bridge/wire.ts";
import { DovreHub, type HubSocket, type HubState } from "../src/hosted/hub.ts";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { localDesk } from "../src/agents/desk.ts";
import { createQueue } from "../src/agents/queue.ts";
import { createRunner } from "../src/agents/runner.ts";
import { type BridgeSocket, startBridge } from "../src/bridge/mac.ts";
import type { Ledger, SentCall } from "../src/sent.ts";

const KEY = "a-bridge-key-that-is-long-enough-0123456789";
/** The one machine (the tests before H7 had only the Mac). */
const one = (hub: DovreHub) => hub.mac().machines[0] ?? { id: "", online: false, seen: undefined, state: undefined };

test("wire: a hello only under the key, for this challenge, near now", async () => {
  const challenge = "0".repeat(32);
  const h = await hello(KEY, challenge, { now: 1000 });
  assert.equal(await helloOk(KEY, challenge, h, 1000), true);
  assert.equal(await helloOk("another-key-that-is-long-enough-0123456789", challenge, h, 1000), false, "another key");
  assert.equal(await helloOk(KEY, "1".repeat(32), h, 1000), false, "another challenge");
  assert.equal(await helloOk(KEY, challenge, h, 1000 + HELLO_SKEW_MS + 1), false, "too old");
  assert.equal(await helloOk(KEY, challenge, { ...h, at: 1001 }, 1000), false, "time changed");
  assert.equal(await helloOk(KEY, challenge, { ...h, nonce: challenge }, 1000), false, "the challenge sent back");
  for (const bad of [null, "x", { t: "hello" }, { ...h, mac: "zz" }, { ...h, mac: undefined }]) assert.equal(await helloOk(KEY, challenge, bad, 1000), false);
  assert.equal(keyOk("short"), false);
  assert.equal(keyOk(KEY), true);
});

test("wire: frames in order, signed for their direction; tampered, replayed, reflected or reordered ones are refused", async () => {
  const key = await sessionKey(KEY, "0".repeat(32), "1".repeat(32));
  const up = await channel({ key, send: "up" });
  const down = await channel({ key, send: "down" });
  const a = (await up.seal({ t: "topics", topics: ["run:x"] }))!;
  const b = (await up.seal({ t: "topics", topics: ["run:y"] }))!;
  assert.deepEqual(await down.open(a), { t: "topics", topics: ["run:x"] });
  assert.equal(await down.open(a), undefined, "replayed");
  assert.deepEqual(await down.open(b), { t: "topics", topics: ["run:y"] });

  const c = (await up.seal({ n: 3 }))!;
  const d = (await up.seal({ n: 4 }))!;
  assert.equal(await (await channel({ key, send: "down", got: 2 })).open(d), undefined, "out of order");
  const t = JSON.parse(c);
  assert.equal(await (await channel({ key, send: "down", got: 2 })).open(JSON.stringify({ ...t, body: JSON.stringify({ n: 99 }) })), undefined, "tampered");
  assert.equal(await (await channel({ key, send: "up", got: 2 })).open(c), undefined, "reflected back the way it came");
  const other = await sessionKey(KEY, "2".repeat(32), "1".repeat(32));
  assert.equal(await (await channel({ key: other, send: "down", got: 2 })).open(c), undefined, "another socket's key");

  // Sealed together, they still go out numbered in the order asked.
  const many = await Promise.all([1, 2, 3, 4, 5].map((n) => up.seal({ n })));
  const rx = await channel({ key, send: "down", got: 4 });
  for (const [i, f] of many.entries()) assert.deepEqual(await rx.open(f!), { n: i + 1 });
  assert.equal(await up.seal({ big: "x".repeat(1_000_000) }), undefined, "too big to send");
});

test("wire: bodies by shape", () => {
  const named = parseUp({ t: "state", state: { at: 1, name: "<img src=x onerror=alert(1)>laptop.local", harnesses: [], runs: [], sessions: { live: [], recent: [] } } });
  assert.equal(named?.t === "state" && named.state.name, "img srcx onerroralert1laptop.local", "a machine's name: letters, digits, spaces, dots, dashes only");
  assert.equal(parseUp({ t: "topics", topics: ["ok", "<script>"] })?.t, "topics");
  assert.deepEqual((parseUp({ t: "topics", topics: ["ok", "has space"] }) as { topics: string[] }).topics, ["ok"]);
  assert.equal(parseUp({ t: "topics", topics: ["bad topic"] }), undefined);
  assert.equal(parseUp({ t: "reply", id: "../x", ok: true }), undefined);
  assert.equal(parseUp({ t: "state", state: { at: 1, harnesses: ["claude"], runs: [], sessions: { live: [] } } }), undefined);
  assert.deepEqual(parseUp({ t: "state", state: { at: 1, harnesses: ["claude", "Bad!"], runs: [], sessions: { live: [], recent: [] } } }), { t: "state", state: { at: 1, version: undefined, harnesses: ["claude"], runs: [], sessions: { live: [], recent: [] } } });
  assert.equal(parseUp({ t: "shell", cmd: "rm -rf /" }), undefined);
  assert.equal(parseDown({ t: "call", id: "abcdef12", call: { op: "Rm -rf" } }), undefined);
  assert.equal(parseDown({ t: "call", id: "abcdef12", call: { op: "session", sid: "x" } })?.t, "call");
  assert.equal(parseDown({ t: "exec" }), undefined);
});

// ── The hub's end ──

/** A socket the hub holds; `out` is what it sent, `closed` how it ended. */
class FakeSocket implements HubSocket {
  out: string[] = [];
  closed?: { code?: number; reason?: string };
  private att: unknown;
  send(m: string) {
    if (this.closed) throw new Error("closed");
    this.out.push(m);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return structuredClone(this.att);
  }
}

function fakeState() {
  const db = new DatabaseSync(":memory:");
  const sockets: { ws: FakeSocket; tags: string[] }[] = [];
  const state: HubState = {
    storage: {
      sql: {
        exec(q, ...b) {
          const st = db.prepare(q);
          const rows = /^\s*select/i.test(q) ? (st.all(...(b as never[])) as Record<string, unknown>[]) : (st.run(...(b as never[])), []);
          return { toArray: () => rows };
        },
      },
      setAlarm: () => {},
    },
    acceptWebSocket: (ws, tags = []) => void sockets.push({ ws: ws as FakeSocket, tags }),
    getWebSockets: (tag) => sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws),
  };
  return { state, sockets, db };
}

/** Waits until `ok()`, up to `ms`: a busy machine can take longer than any fixed sleep. */
const until = async (ok: () => boolean | Promise<boolean>, ms = 2000) => {
  for (let i = 0; i < ms / 10; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("waited too long");
};

/** The Mac's side of one socket, by hand: answers the challenge, then speaks in signed frames. */
async function mac(hub: DovreHub, key = KEY, machine?: string, owner?: string) {
  const ws = new FakeSocket();
  hub.accept(ws, machine, owner);
  const challenge = JSON.parse(ws.out.shift()!) as { t: string; nonce: string };
  assert.equal(challenge.t, "challenge");
  const h = await hello(key, challenge.nonce, { now: hub.now() });
  await hub.webSocketMessage(ws, JSON.stringify(h));
  const ch = ws.closed ? undefined : await channel({ key: await sessionKey(key, challenge.nonce, h.nonce), send: "up" });
  const got = async () => {
    const out = [];
    while (ws.out.length) out.push(parseDown(await ch!.open(ws.out.shift()!)));
    return out;
  };
  /** To this object, or (after hibernation) the one that woke for it. */
  const say = async (body: unknown, to = hub) => to.webSocketMessage(ws, (await ch!.seal(body))!);
  return { ws, ch, got, say };
}

const STATE = { at: 1, harnesses: ["claude"], runs: [{ id: "r1", status: "running" }], sessions: { live: [], recent: [{ sessionId: "s1", title: "Fix it" }] } };

test("hub: no hello under the key, no socket; with one, the Mac is welcomed and online", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const bad = await mac(hub, "the-wrong-key-but-long-enough-0123456789");
  assert.deepEqual(bad.ws.closed, { code: 4001, reason: "bad hello" });
  assert.equal(one(hub).online, false);

  const noise = new FakeSocket();
  hub.accept(noise);
  await hub.webSocketMessage(noise, "not json");
  assert.equal(noise.closed?.code, 4001);

  const m = await mac(hub);
  assert.equal(m.ws.closed, undefined);
  assert.deepEqual(await m.got(), [{ t: "welcome", watching: false }]);
  assert.equal(one(hub).online, true);
});

test("hub: the Mac's state is kept (and only it), topics reach open pages, calls go down and their answers back", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  assert.deepEqual(await hub.call({ op: "session", sid: "x" }), { ok: false, error: "No machine is online.", offline: true });
  const m = await mac(hub);
  await m.got();

  await m.say({ t: "state", state: STATE });
  assert.deepEqual(one(hub).state?.sessions.recent, STATE.sessions.recent);
  assert.deepEqual(db.prepare("SELECT k FROM mac ORDER BY k").all().map((r) => r.k), ["seen", "state"], "the hub keeps the state and when it was seen, nothing else");

  // A page's stream opens: the Mac hears it's watched, and its topics reach the page.
  const events = await hub.fetch(new Request("https://hub.internal/events"));
  const reader = events.body!.getReader();
  await reader.read();
  await until(() => m.ws.out.length > 0);
  assert.deepEqual(await m.got(), [{ t: "watch", on: true }]);
  await m.say({ t: "topics", topics: ["run:s1"] });
  const line = new TextDecoder().decode((await reader.read()).value);
  assert.match(line, /"topics":\["run:s1"\]/);

  // A call: down the socket, answered by id.
  const answer = hub.call({ op: "session", sid: "s1" });
  await until(() => m.ws.out.length > 0);
  const [call] = (await m.got()) as { t: "call"; id: string; call: { op: string } }[];
  assert.equal(call!.t, "call");
  assert.equal(call!.call.op, "session");
  await m.say({ t: "reply", id: call!.id, ok: true, value: { turns: 2 } });
  assert.deepEqual(await answer, { ok: true, value: { turns: 2 } });
  // What came back isn't kept.
  assert.equal(db.prepare("SELECT count(*) AS n FROM mac WHERE v LIKE '%turns%'").get()!.n, 0);

  // Unanswered: it gives up, saying so.
  assert.deepEqual(await hub.call({ op: "session", sid: "s1" }, 20), { ok: false, error: "Your Mac didn't answer in time." });
  await reader.cancel();
});

test("hub: a replayed or forged frame closes the socket; a second Mac's hello takes over; closing is 'offline', with when", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  let t = 5000;
  hub.now = () => t;
  const m = await mac(hub);
  await m.got();
  const frame = (await m.ch!.seal({ t: "topics", topics: ["a"] }))!;
  await hub.webSocketMessage(m.ws, frame);
  assert.equal(m.ws.closed, undefined);
  await hub.webSocketMessage(m.ws, frame);
  assert.deepEqual(m.ws.closed, { code: 4002, reason: "bad frame" }, "a replay");

  const a = await mac(hub);
  const b = await mac(hub);
  assert.deepEqual(a.ws.closed, { code: 4000, reason: "replaced" });
  assert.equal(b.ws.closed, undefined);
  const waiting = hub.call({ op: "session", sid: "s1" });
  await new Promise((r) => setTimeout(r, 5));
  t = 9000;
  b.ws.close(1006);
  await hub.webSocketClose(b.ws);
  assert.deepEqual(await waiting, { ok: false, error: "Your Mac went offline.", offline: true });
  const view = one(hub);
  assert.equal(view.online, false);
  assert.equal(view.seen, 9000);
});

test("hub: after hibernation (a new object, the same socket) the socket goes on where it was", async () => {
  const { state } = fakeState();
  const first = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const m = await mac(first);
  await m.got();
  await m.say({ t: "state", state: STATE });

  // Woken by the Mac's next frame: nothing in memory, the attachment holds the key and counters.
  const woken = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  assert.equal(one(woken).online, true);
  assert.deepEqual(one(woken).state?.runs, STATE.runs);
  await m.say({ t: "topics", topics: ["run:s1"] }, woken);
  assert.equal(m.ws.closed, undefined);
  const answer = woken.call({ op: "runs" });
  await until(() => m.ws.out.length > 0);
  const [call] = (await m.got()) as { id: string }[];
  await m.say({ t: "reply", id: call!.id, ok: false, error: "nope" }, woken);
  assert.deepEqual(await answer, { ok: false, error: "nope" });
});

const LAPTOP = "0123456789abcdef";
const DESKTOP = "fedcba9876543210abcd";

test("hub (H7): each machine signs with its own key; both online at once, each its own state", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const laptopKey = await machineKey(KEY, LAPTOP);
  assert.match(laptopKey, /^[0-9a-f]{64}$/);
  assert.notEqual(laptopKey, await machineKey(KEY, DESKTOP));
  assert.equal(await machineKey(KEY, "mac"), KEY, "the Mac from before keeps BRIDGE_KEY");

  // The root key, or another machine's, isn't this machine's.
  assert.equal((await mac(hub, KEY, LAPTOP)).ws.closed?.code, 4001);
  assert.equal((await mac(hub, await machineKey(KEY, DESKTOP), LAPTOP)).ws.closed?.code, 4001);

  const laptop = await mac(hub, laptopKey, LAPTOP);
  const desktop = await mac(hub, await machineKey(KEY, DESKTOP), DESKTOP);
  const legacy = await mac(hub);
  for (const m of [laptop, desktop, legacy]) assert.equal(m.ws.closed, undefined);
  await laptop.say({ t: "state", state: { ...STATE, name: "laptop" } });
  await desktop.say({ t: "state", state: { ...STATE, name: "desktop", harnesses: ["omp"] } });
  const v = hub.mac();
  assert.deepEqual(v.machines.map((m) => [m.id, m.online]).sort(), [[LAPTOP, true], [DESKTOP, true], ["mac", true]]);
  assert.deepEqual(v.machines.find((m) => m.id === DESKTOP)?.state?.harnesses, ["omp"]);
  assert.equal(v.machines.find((m) => m.id === LAPTOP)?.name, "laptop");

  // A new socket for the laptop takes over from the laptop's only.
  const again = await mac(hub, laptopKey, LAPTOP);
  assert.deepEqual(laptop.ws.closed, { code: 4000, reason: "replaced" });
  assert.equal(desktop.ws.closed, undefined);
  assert.equal(again.ws.closed, undefined);
});

test("hub (H7): calls go to the machine named; another machine can't answer them; without a name, only when one is online", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const laptop = await mac(hub, await machineKey(KEY, LAPTOP), LAPTOP);
  await laptop.got();
  await laptop.say({ t: "state", state: { ...STATE, name: "laptop" } });
  // One online: it's the one.
  const only = hub.call({ op: "repos" });
  await until(() => laptop.ws.out.length > 0);
  const [c0] = (await laptop.got()) as { id: string }[];
  await laptop.say({ t: "reply", id: c0!.id, ok: true, value: ["web"] });
  assert.deepEqual(await only, { ok: true, value: ["web"] });

  const desktop = await mac(hub, await machineKey(KEY, DESKTOP), DESKTOP);
  await desktop.got();
  assert.deepEqual(await hub.call({ op: "repos" }), { ok: false, error: "Say which machine." });

  const asked = hub.call({ op: "session", sid: "s1" }, 200, LAPTOP);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await desktop.got(), [], "the desktop never hears the laptop's call");
  const [call] = (await laptop.got()) as { id: string }[];
  // The desktop guessing the call's id: ignored.
  await desktop.say({ t: "reply", id: call!.id, ok: true, value: "forged" });
  await laptop.say({ t: "reply", id: call!.id, ok: true, value: "real" });
  assert.deepEqual(await asked, { ok: true, value: "real" });

  // The laptop drops: its calls end, by its name; the desktop's don't.
  const waitingLaptop = hub.call({ op: "session", sid: "s1" }, 500, LAPTOP);
  const waitingDesktop = hub.call({ op: "session", sid: "s2" }, 50, DESKTOP);
  await new Promise((r) => setTimeout(r, 5));
  laptop.ws.close(1006);
  await hub.webSocketClose(laptop.ws);
  assert.deepEqual(await waitingLaptop, { ok: false, error: '"laptop" went offline.', offline: true });
  assert.deepEqual(await waitingDesktop, { ok: false, error: "That machine didn't answer in time." });
  assert.deepEqual(await hub.call({ op: "repos" }, 100, LAPTOP), { ok: false, error: '"laptop" is offline.', offline: true });
  assert.deepEqual(await hub.call({ op: "repos" }, 100, "../../x"), { ok: false, error: "No such machine." });
});

test("hub (H7): a machine revoked is closed at once, forgotten, and can't come back until its tokens run out", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  let t = 1_000_000;
  hub.now = () => t;
  const key = await machineKey(KEY, LAPTOP);
  const laptop = await mac(hub, key, LAPTOP);
  await laptop.got();
  await laptop.say({ t: "state", state: { ...STATE, name: "laptop" } });
  const waiting = hub.call({ op: "repos" }, 1000, LAPTOP);
  await new Promise((r) => setTimeout(r, 5));

  const res = await hub.fetch(new Request("https://hub.internal/mac/revoke", { method: "POST", body: JSON.stringify({ machine: LAPTOP, until: t + 600_000 }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(laptop.ws.closed, { code: 4004, reason: "revoked" });
  assert.deepEqual(await waiting, { ok: false, error: "That machine was removed.", offline: true });
  await hub.webSocketClose(laptop.ws);
  assert.deepEqual(hub.mac().machines, [], "what it said is gone");
  assert.equal(db.prepare("SELECT count(*) AS n FROM mac WHERE k LIKE 'state%' OR k LIKE 'seen%'").get()!.n, 0);

  // Its token still good: no socket, no hello.
  const up = (m: string) => hub.fetch(new Request("https://hub.internal/bridge", { headers: { upgrade: "websocket", "x-dovre-machine": m } }));
  assert.equal((await up(LAPTOP)).status, 404);
  assert.equal((await mac(hub, key, LAPTOP)).ws.closed?.code, 4001);
  // Its tokens ran out: a machine paired again may come back.
  t += 600_001;
  assert.equal((await mac(hub, key, LAPTOP)).ws.closed, undefined);

  // Nonsense is refused.
  assert.equal((await hub.fetch(new Request("https://hub.internal/mac/revoke", { method: "POST", body: JSON.stringify({ machine: "../x", until: 1 }) }))).status, 400);
  // No machine named on an upgrade (only the worker names one): 404.
  assert.equal((await hub.fetch(new Request("https://hub.internal/bridge", { headers: { upgrade: "websocket" } }))).status, 404);
});

test("hub (T4): each machine keeps who paired it, as its newest token said; a revoke forgets it", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const key = await machineKey(KEY, LAPTOP);
  const owner = (id: string) => hub.mac().machines.find((m) => m.id === id)?.owner;

  await mac(hub, key, LAPTOP, "kari@example.dev");
  await mac(hub, await machineKey(KEY, DESKTOP), DESKTOP);
  assert.equal(owner(LAPTOP), "kari@example.dev");
  assert.equal(owner(DESKTOP), undefined, "a token without an owner: everyone's");
  // A hello that fails keeps nothing it said.
  await mac(hub, KEY, DESKTOP, "ola@example.dev");
  assert.equal(owner(DESKTOP), undefined);

  // A newer token's word wins, either way.
  await mac(hub, key, LAPTOP, "ola@example.dev");
  assert.equal(owner(LAPTOP), "ola@example.dev");
  await mac(hub, key, LAPTOP);
  assert.equal(owner(LAPTOP), undefined);
  await mac(hub, key, LAPTOP, "kari@example.dev");

  await hub.fetch(new Request("https://hub.internal/mac/revoke", { method: "POST", body: JSON.stringify({ machine: LAPTOP, until: hub.now() + 1000 }) }));
  assert.equal(db.prepare("SELECT count(*) AS n FROM mac WHERE k LIKE 'owner%'").get()!.n, 0, "a revoked machine's owner is forgotten");
});

test("hub: no BRIDGE_KEY, no /bridge", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never });
  assert.equal((await hub.fetch(new Request("https://hub.internal/bridge", { headers: { upgrade: "websocket" } }))).status, 404);
});

// ── The Mac and the hub together, over an in-memory socket ──

const SESSION = "5a1e7c2b-0d3f-4e6a-9b8c-1d2e3f4a5b6c";
const line = (o: unknown) => JSON.stringify(o);

/** A turn that says something private, then ends. */
function fakeSpawn() {
  return (_bin: string, _args: string[], _opts: { cwd: string }) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: 1, kill: () => true });
    setTimeout(() => {
      stdout.write(`${line({ type: "system", subtype: "init", session_id: SESSION })}\n`);
      stdout.write(`${line({ type: "assistant", message: { content: [{ type: "text", text: "the secret plan" }] } })}\n`);
      setTimeout(() => {
        stdout.write(`${line({ type: "result", result: "done: the secret plan", total_cost_usd: 0.01 })}\n`);
        stdout.end();
        setImmediate(() => child.emit("close", 0));
      }, 60);
    }, 5);
    return child;
  };
}

/** The hub's socket and the Mac's, joined: what one sends, the other gets a moment later. */
function joined(hub: DovreHub, machine?: string) {
  const sockets: { server: FakeSocket; client: BridgeSocket; headers: Record<string, string> }[] = [];
  const dial = (_url: string, headers: Record<string, string>): BridgeSocket => {
    if (!machine) assert.equal(headers["CF-Access-Client-Id"], "id.access");
    const server = new FakeSocket();
    const client: BridgeSocket = {
      readyState: 0,
      send: (data) => void setImmediate(() => void hub.webSocketMessage(server, data)),
      close: (code) => {
        if (client.readyState === 3) return;
        client.readyState = 3;
        server.closed = { code };
        setImmediate(() => {
          void hub.webSocketClose(server);
          client.onclose?.({ code });
        });
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    // The hub's sends reach the Mac; the hub closing ends the Mac's socket.
    server.send = (m: string) => {
      if (server.closed) throw new Error("closed");
      setImmediate(() => client.onmessage?.({ data: m }));
    };
    server.close = (code?: number, reason?: string) => {
      if (server.closed) return;
      server.closed = { code, reason };
      client.readyState = 3;
      setImmediate(() => client.onclose?.({ code, reason }));
    };
    sockets.push({ server, client, headers });
    setImmediate(() => {
      client.readyState = 1;
      client.onopen?.({});
      hub.accept(server, machine);
    });
    return client;
  };
  return { dial, sockets };
}

test("bridge: the Mac's desk through the hub: started, watched, answered; what turns say is never kept", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "shop-api", ".git"), { recursive: true });
  const env = { CODE_DIR: code, CLAUDE_DIR: mkdtempSync(join(tmpdir(), "claude-")), AGENT_DIR: join(code, "agents") };
  let bridge: ReturnType<typeof startBridge> | undefined;
  const runner = createRunner({ spawnFn: fakeSpawn(), onChange: (r) => bridge?.changed(r) });
  const sessions = async () => ({ live: [], recent: [] });
  const desk = localDesk({ env, runner, queue: createQueue(), sessions });
  const link = joined(hub);
  bridge = startBridge({ url: "wss://dovre.example.dev/bridge", key: KEY, headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s" }, desk, sessions, dial: link.dial, timing: { stateMs: 5, topicMs: 5, backoffMs: 20 } });
  try {
    await until(() => one(hub).online && !!one(hub).state);
    assert.deepEqual(one(hub).state!.harnesses, ["claude"]);
    assert.equal(bridge.status().watching, false);

    // A page opens: the Mac is watched.
    const events = await hub.fetch(new Request("https://hub.internal/events"));
    const reader = events.body!.getReader();
    const heard: string[] = [];
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        heard.push(new TextDecoder().decode(value));
      }
    })();
    await until(() => bridge!.status().watching);

    // From the phone: a new turn, in a checkout on the Mac.
    const started = await hub.call({ op: "start", repo: "shop-api", prompt: "make a plan", harness: "claude", mode: "default" });
    assert.equal(started.ok, true);
    assert.equal((started as { value: { to: string } }).value.to, `/agents/s/${SESSION}`);
    assert.match(String((started as { value: { run?: string } }).value.run), /^[\w-]{36}$/);
    // Not a checkout under CODE_DIR: refused by the Mac's desk.
    assert.deepEqual(((await hub.call({ op: "start", repo: "../etc", prompt: "x" })) as { value: unknown }).value, { error: "Pick a checkout in your code folder, or Dovre's own folder." });
    // While it works, its topic reaches the page.
    await until(() => heard.some((h) => h.includes(`run:${SESSION}`)));
    await until(() => runner.list()[0]?.status === "done");
    await until(() => (one(hub).state!.runs as { status: string }[])[0]?.status === "done");

    // The session's page: what was said, in the answer only.
    const page = (await hub.call({ op: "session", sid: SESSION })) as { ok: true; value: { run: { events: { t: string }[] } } };
    assert.ok(page.value.run.events.some((e) => e.t === "text"));
    const kept = db.prepare("SELECT group_concat(v, ' ') AS v FROM mac").get()!.v as string;
    assert.doesNotMatch(kept, /secret plan/, "what the turn said isn't in the hub's storage");
    assert.match(kept, /make a plan/, "the prompt's first line is, for the lists");

    // Nothing but the desk.
    assert.deepEqual(await hub.call({ op: "exec", cmd: "ls" }), { ok: false, error: 'The Mac doesn\'t do "exec".' });

    // The socket drops: the Mac dials again and is back.
    link.sockets[0]!.server.close(1006, "gone");
    await until(() => link.sockets.length === 2 && one(hub).online);
    await reader.cancel();
  } finally {
    bridge.stop();
  }
});

test("hub: a page's live socket (H5) hears changes, tells the Mac it's watched, and says nothing back", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const m = await mac(hub);
  await m.got();

  const page = new FakeSocket();
  hub.acceptPage(page);
  await until(() => m.ws.out.length > 0);
  assert.deepEqual(await m.got(), [{ t: "watch", on: true }]);
  assert.equal(hub.mac().watching, true);
  assert.deepEqual(state.getWebSockets!("mac").length, 1, "a page isn't taken for the Mac");

  // A second page: the Mac already knew.
  const other = new FakeSocket();
  hub.acceptPage(other);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await m.got(), []);

  await m.say({ t: "topics", topics: ["run:s1"] });
  hub.publish(["snapshot"], 42);
  const got = page.out.map((l) => JSON.parse(l) as { topics: string[]; synced?: number });
  assert.deepEqual(got.map((c) => c.topics), [["run:s1"], ["snapshot"]]);
  assert.equal(got[1]!.synced, 42);
  assert.equal(other.out.length, 2);

  // What a page sends is ignored (its keep-alive is the runtime's), and never closes it.
  await hub.webSocketMessage(page, "hello?");
  await hub.webSocketMessage(page, "ping");
  assert.equal(page.closed, undefined);
  assert.deepEqual(page.out.slice(2), ["pong"]);

  // The last page goes: the Mac stops streaming.
  other.close();
  await hub.webSocketClose(other);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await m.got(), []);
  page.close();
  await hub.webSocketClose(page);
  await until(() => m.ws.out.length > 0);
  assert.deepEqual(await m.got(), [{ t: "watch", on: false }]);
  assert.equal(hub.mac().watching, false);
  assert.equal(one(hub).online, true, "a page closing isn't the Mac going offline");
});

test("hub: /live without an upgrade is a 404", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never });
  assert.equal((await hub.fetch(new Request("https://hub.internal/live"))).status, 404);
});

test("hub: /export dumps every table it keeps, not Cloudflare's or SQLite's own", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never });
  db.exec("CREATE TABLE bino_convs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, conv TEXT NOT NULL)");
  db.exec(`INSERT INTO bino_convs VALUES ('c1', 5, '{"id":"c1"}')`);
  db.exec("CREATE TABLE mac (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.exec("INSERT INTO mac VALUES ('seen', '7')");
  db.exec("CREATE TABLE _cf_KV (key TEXT, value BLOB)");
  db.exec("CREATE TABLE cfish (x)");
  const res = await hub.fetch(new Request("https://hub.internal/export"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tables: { bino_convs: [{ id: "c1", at: 5, conv: '{"id":"c1"}' }], cfish: [], mac: [{ k: "seen", v: "7" }] } });
  assert.equal((await hub.fetch(new Request("https://hub.internal/export", { method: "POST" }))).status, 404, "GET only");
});

test("hub: /size reports the storage's size, or null where it isn't known", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never });
  assert.deepEqual(await (await hub.fetch(new Request("https://hub.internal/size"))).json(), { bytes: null });
  Object.defineProperty(state.storage.sql, "databaseSize", { value: 8192 });
  assert.deepEqual(await (await hub.fetch(new Request("https://hub.internal/size"))).json(), { bytes: 8192 });
  assert.equal((await hub.fetch(new Request("https://hub.internal/size", { method: "POST" }))).status, 404, "GET only");
});

test("bridge (H6): a machine signs in with a token asked for on every dial, and its key; a failed ask is tried again", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const link = joined(hub, LAPTOP);
  let asked = 0;
  const headers = async () => {
    if (++asked === 1) throw new Error("dovre.dev unreachable");
    return { "Cf-Access-Jwt-Assertion": `jwt-${asked}` };
  };
  const desk = localDesk({ env: { CODE_DIR: mkdtempSync(join(tmpdir(), "code-")), CLAUDE_DIR: mkdtempSync(join(tmpdir(), "claude-")) }, runner: createRunner({ spawnFn: fakeSpawn() }), queue: createQueue(), sessions: async () => ({ live: [], recent: [] }) });
  const bridge = startBridge({ url: "wss://alice.dovre.dev/bridge", key: await machineKey(KEY, LAPTOP), headers, name: "laptop", desk, sessions: async () => ({ live: [], recent: [] }), dial: link.dial, timing: { stateMs: 5, backoffMs: 10 } });
  try {
    await until(() => !!hub.mac().machines.find((m) => m.id === LAPTOP)?.state);
    assert.equal(hub.mac().machines[0]!.name, "laptop");
    assert.equal(link.sockets[0]!.headers["Cf-Access-Jwt-Assertion"], "jwt-2");
    link.sockets[0]!.server.close(1006, "gone");
    await until(() => link.sockets.length === 2 && bridge.status().connected);
    assert.equal(link.sockets[1]!.headers["Cf-Access-Jwt-Assertion"], "jwt-3", "a fresh token for the new socket");
  } finally {
    bridge.stop();
  }
});

test("what Dovre sends (#145): the Mac records each dial and frame before it goes, the hub counts what arrived, and the two agree", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  const calls: Omit<SentCall, "k">[] = [];
  const frames: { host: string; kind: string; bytes: number }[] = [];
  const ledger: Ledger = { call: (c) => void calls.push(c), frame: (host, kind, bytes) => void frames.push({ host, kind, bytes }) };
  const sessions = async () => ({ live: [], recent: [] });
  const code = mkdtempSync(join(tmpdir(), "code-"));
  const desk = localDesk({ env: { CODE_DIR: code, CLAUDE_DIR: mkdtempSync(join(tmpdir(), "claude-")), AGENT_DIR: join(code, "agents") }, runner: createRunner({ spawnFn: fakeSpawn() }), queue: createQueue(), sessions });
  const link = joined(hub);
  const bridge = startBridge({ url: "wss://dovre.example.dev/bridge", key: KEY, headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "the-secret" }, ledger, desk, sessions, dial: link.dial, timing: { stateMs: 5, topicMs: 5, backoffMs: 20 } });
  try {
    await until(() => one(hub).online && !!one(hub).state);
    assert.equal((await hub.call({ op: "repos" })).ok, true);
    await until(() => frames.some((f) => f.kind === "reply:repos"));

    assert.deepEqual(calls.map((c) => [c.purpose, c.host, c.path, c.fields]), [["bridge.connect", "dovre.example.dev", "/bridge", ["CF-Access-Client-Id", "CF-Access-Client-Secret"]]]);
    assert.doesNotMatch(JSON.stringify(calls), /the-secret|id\.access/, "header names only, never their values");
    assert.deepEqual([...new Set(frames.map((f) => f.kind))].sort(), ["hello", "reply:repos", "state"]);
    assert.ok(frames.every((f) => f.host === "dovre.example.dev" && f.bytes > 0));

    // The hub's own count, from what arrived: the same kinds, the same sizes.
    const got = hub.received();
    assert.deepEqual(got.map((r) => r.kind).sort(), ["hello", "reply:repos", "state"]);
    for (const kind of ["hello", "state", "reply:repos"]) {
      const sent = frames.filter((f) => f.kind === kind);
      const r = got.find((x) => x.kind === kind)!;
      assert.deepEqual([r.count, r.bytes], [sent.length, sent.reduce((n, f) => n + f.bytes, 0)], kind);
    }
    assert.equal(got[0]!.machine, "mac");
    assert.deepEqual(await (await hub.fetch(new Request("https://hub.internal/sent"))).json(), got);
    // Counts only: what a frame said isn't in the table.
    assert.deepEqual(Object.keys(db.prepare("SELECT * FROM sent").get()!).sort(), ["bytes", "count", "hour", "kind", "machine"]);

    // Older than KEEP_DAYS: gone at the first frame of a new day.
    db.prepare("UPDATE sent SET hour = hour - ?").run(31 * 24 * 3600_000);
    assert.deepEqual(hub.received(), []);
    hub.now = () => Date.now() + 24 * 3600_000;
    await mac(hub);
    assert.equal((db.prepare("SELECT count(*) AS n FROM sent WHERE hour < ?").get(Date.now() - 30 * 24 * 3600_000) as { n: number }).n, 0);
  } finally {
    bridge.stop();
  }
});

test("found models (#238): the Mac reports what its CLIs' configs name, the hub keeps only sound ones, and hosted offers them", async () => {
  const { stateOf } = await import("../src/bridge/serve.ts");
  const { remoteDesk } = await import("../src/bridge/remote.ts");
  const { modelsOf, useFoundModels } = await import("../src/agents/harnesses/index.ts");
  const base = { at: 1, harnesses: ["omp", "claude"], runs: [], sessions: { live: [], recent: [] } };
  const up = parseUp({ t: "state", state: { ...base, models: {
    omp: [{ value: "", label: "omp's default" }, { value: "zai/glm-5.3-flash", label: "glm" }, { value: "x; rm -rf ~", label: "bad" }, { value: "ok", label: 5 }],
    codex: [{ value: "gpt-6", label: "not a harness it has" }],
    claude: "nope",
  } } });
  assert.deepEqual(up && up.t === "state" ? up.state.models : "?", { omp: [{ value: "", label: "omp's default" }, { value: "zai/glm-5.3-flash", label: "glm" }] });
  assert.equal(parseUp({ t: "state", state: { ...base, models: [1] } })?.t, "state", "odd models: the state still counts, without them");

  // The bridge sends only harnesses whose list came from a config.
  const desk = { view: () => ({ harnesses: ["claude", "omp"], runs: [], workDir: "" }) } as any;
  useFoundModels((id) => (id === "omp" ? [{ value: "zai/glm-5.3-flash", label: "glm" }] : []));
  try {
    assert.deepEqual(Object.keys(stateOf(desk, { live: [], recent: [] }).models ?? {}), ["omp"]);
  } finally {
    useFoundModels(undefined);
  }

  // Hosted: the machines online, merged, without each default.
  const state = (models: Record<string, { value: string; label: string }[]>) => ({ ...base, models });
  const hub = { mac: async () => ({ watching: false, machines: [
    { id: "a", online: true, state: state({ omp: [{ value: "", label: "d" }, { value: "zai/glm", label: "glm" }] }) },
    { id: "b", online: true, state: state({ omp: [{ value: "zai/glm", label: "glm" }, { value: "x/y", label: "y" }] }) },
    { id: "c", online: false, state: state({ omp: [{ value: "off/line", label: "gone" }] }) },
  ] }), call: async () => ({ ok: false as const, error: "no" }) };
  const remote = remoteDesk(hub as any, { ttlMs: 0 });
  await remote.refresh();
  assert.deepEqual(remote.foundModels("omp").map((m) => m.value), ["zai/glm", "x/y"]);
  useFoundModels((id) => remote.foundModels(id));
  try {
    assert.deepEqual(modelsOf("omp").slice(1).map((m) => m.value), ["zai/glm", "x/y"]);
  } finally {
    useFoundModels(undefined);
  }
});
