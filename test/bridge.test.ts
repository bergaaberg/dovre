/**
 * The Mac's bridge (PLAN D24, WP-N10): the signed wire (src/bridge/wire.ts) and the hub's end of the
 * socket (src/hosted/hub.ts): hello, frames in order, calls relayed, the Mac's metadata kept,
 * watching, and a socket that outlives the object (hibernation).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { channel, hello, helloOk, HELLO_SKEW_MS, keyOk, parseDown, parseUp, sessionKey } from "../src/bridge/wire.ts";
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

const KEY = "a-bridge-key-that-is-long-enough-0123456789";

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

/** The Mac's side of one socket, by hand: answers the challenge, then speaks in signed frames. */
async function mac(hub: DovreHub, key = KEY) {
  const ws = new FakeSocket();
  hub.accept(ws);
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
  assert.equal(hub.mac().online, false);

  const noise = new FakeSocket();
  hub.accept(noise);
  await hub.webSocketMessage(noise, "not json");
  assert.equal(noise.closed?.code, 4001);

  const m = await mac(hub);
  assert.equal(m.ws.closed, undefined);
  assert.deepEqual(await m.got(), [{ t: "welcome", watching: false }]);
  assert.equal(hub.mac().online, true);
});

test("hub: the Mac's state is kept (and only it), topics reach open pages, calls go down and their answers back", async () => {
  const { state, db } = fakeState();
  const hub = new DovreHub(state, { DB: undefined as never, BRIDGE_KEY: KEY });
  assert.deepEqual(await hub.call({ op: "session", sid: "x" }), { ok: false, error: "Your Mac is offline.", offline: true });
  const m = await mac(hub);
  await m.got();

  await m.say({ t: "state", state: STATE });
  assert.deepEqual(hub.mac().state?.sessions.recent, STATE.sessions.recent);
  assert.deepEqual(db.prepare("SELECT k FROM mac ORDER BY k").all().map((r) => r.k), ["seen", "state"], "the hub keeps the state and when it was seen, nothing else");

  // A page's stream opens: the Mac hears it's watched, and its topics reach the page.
  const events = await hub.fetch(new Request("https://hub.internal/events"));
  const reader = events.body!.getReader();
  await reader.read();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await m.got(), [{ t: "watch", on: true }]);
  await m.say({ t: "topics", topics: ["run:s1"] });
  const line = new TextDecoder().decode((await reader.read()).value);
  assert.match(line, /"topics":\["run:s1"\]/);

  // A call: down the socket, answered by id.
  const answer = hub.call({ op: "session", sid: "s1" });
  await new Promise((r) => setTimeout(r, 5));
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
  const view = hub.mac();
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
  assert.equal(woken.mac().online, true);
  assert.deepEqual(woken.mac().state?.runs, STATE.runs);
  await m.say({ t: "topics", topics: ["run:s1"] }, woken);
  assert.equal(m.ws.closed, undefined);
  const answer = woken.call({ op: "runs" });
  await new Promise((r) => setTimeout(r, 5));
  const [call] = (await m.got()) as { id: string }[];
  await m.say({ t: "reply", id: call!.id, ok: false, error: "nope" }, woken);
  assert.deepEqual(await answer, { ok: false, error: "nope" });
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
function joined(hub: DovreHub) {
  const sockets: { server: FakeSocket; client: BridgeSocket }[] = [];
  const dial = (_url: string, headers: Record<string, string>): BridgeSocket => {
    assert.equal(headers["CF-Access-Client-Id"], "id.access");
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
    sockets.push({ server, client });
    setImmediate(() => {
      client.readyState = 1;
      client.onopen?.({});
      hub.accept(server);
    });
    return client;
  };
  return { dial, sockets };
}

const until = async (ok: () => boolean | Promise<boolean>, ms = 2000) => {
  for (let i = 0; i < ms / 10; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("waited too long");
};

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
    await until(() => hub.mac().online && !!hub.mac().state);
    assert.deepEqual(hub.mac().state!.harnesses, ["claude"]);
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
    assert.deepEqual((started as { value: unknown }).value, { to: `/agents/s/${SESSION}` });
    // Not a checkout under CODE_DIR: refused by the Mac's desk.
    assert.deepEqual(((await hub.call({ op: "start", repo: "../etc", prompt: "x" })) as { value: unknown }).value, { error: "Pick a checkout in your code folder, or Dovre's own folder." });
    // While it works, its topic reaches the page.
    await until(() => heard.some((h) => h.includes(`run:${SESSION}`)));
    await until(() => runner.list()[0]?.status === "done");
    await until(() => (hub.mac().state!.runs as { status: string }[])[0]?.status === "done");

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
    await until(() => link.sockets.length === 2 && hub.mac().online);
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
  await new Promise((r) => setTimeout(r, 5));
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
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await m.got(), [{ t: "watch", on: false }]);
  assert.equal(hub.mac().watching, false);
  assert.equal(hub.mac().online, true, "a page closing isn't the Mac going offline");
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
