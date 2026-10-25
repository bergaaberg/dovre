/**
 * Dovre hosted's Durable Object (PLAN D16, WP-N2, WP-H9), one per instance (named "hub"), for
 * what must outlive a request and be one thing across the Worker's isolates:
 *
 * - The hub: open pages' live sockets (GET /live, H5) and event streams (GET /events, the same
 *   "change"/"ping" events as the local server's /events, src/app.ts), and publish (POST /publish),
 *   so packs' publish() and Bino's replies swap pages hosted as they do locally. A page's socket is
 *   taken with the hibernation API and its keep-alive answered by the runtime, so an idle open tab
 *   lets the object sleep; a stream keeps it awake, so it's only the fallback.
 * - Bino: its conversations in this object's SQLite (the last few, as data/bino.json holds them
 *   locally) and its answers, through Cloudflare AI Gateway (src/packs/core/assistant/bino/gateway.ts). A Worker gives
 *   up background work 30 s after it answers; an answer here takes as long as the model does.
 *   What Bino knows comes with each message from the Worker (it has the packs and my list) and
 *   stays in memory for that one answer. Memory is memlet on the shared D1.
 *
 * - The Mac's bridge (PLAN D24, WP-N10): one WebSocket the Mac opens (src/bridge/wire.ts), taken
 *   with the hibernation API so an idle socket costs nothing (keep-alive pings are answered
 *   without waking the object). The object keeps only the Mac's metadata (runs, sessions,
 *   harnesses, when it was last seen); calls the Worker makes go down the socket and their
 *   answers back to that request, never kept. It tells the bridge when a page is watching, so
 *   the Mac streams only then.
 *
 * Only the Worker reaches it, through its binding, after Cloudflare Access let the request in
 * (src/worker.ts, src/app.ts): it has no route of its own. The instance's worker.ts exports it
 * (`export { DovreHub } from "dovre/hosted/hub.ts"`) and binds it as HUB.
 */
import { createBino, type ConvStore, type Conv, type Engine } from "../packs/core/assistant/bino/bino.ts";
import { apiKeyRouteOf, gatewayRouteOf, openRouterRouteOf } from "../packs/core/assistant/bino/gateway.ts";
import { loadMemory, noMemory } from "../packs/core/assistant/bino/memory.ts";
import type { D1 } from "../db.ts";
import { type Call, type Channel, channel, type Down, helloOk, keyOk, type MacState, nonce, parseUp, sessionKey } from "../bridge/wire.ts";

/** A hibernatable WebSocket, as much of one as this uses. */
export type HubSocket = {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};

/** What this object uses of its state: SQLite storage and alarms, and the hibernation API for the Mac's socket. */
export type HubState = {
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
    setAlarm(at: number): Promise<void> | void;
    getAlarm?(): Promise<number | null> | number | null;
  };
  acceptWebSocket?(ws: HubSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): HubSocket[];
  setWebSocketAutoResponse?(pair?: unknown): void;
};

/** What a socket keeps across hibernation: its challenge, and once the hello passed, its key and counters. */
type Attached = { challenge: string; key?: string; sent: number; got: number; since: number };

/** The Mac as pages see it: online or when it was last, and its metadata. */
export type MacView = { online: boolean; seen?: number; watching: boolean; state?: MacState };
/** A call's answer: the Mac's, or why there isn't one. */
export type MacAnswer = { ok: true; value: unknown } | { ok: false; error: string; offline?: boolean };

const MAC = "mac";
/** Pages' live sockets (H5). */
const PAGE = "page";
/** The most pages that may watch at once (tabs and phones): past it, the newest is turned away and falls back to /events. */
const MAX_PAGES = 64;
/** How long a call waits for the Mac (start a turn, read a session). */
const CALL_MS = 10_000;
/** The most a state may weigh here (sessions' and runs' metadata). */
const MAX_STATE = 512_000;

export type HubEnv = {
  DB: D1;
  CF_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
  AI_GATEWAY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ASSISTANT_API_KEY?: string;
  ASSISTANT_VIA?: string;
  ASSISTANT_MODEL?: string;
  BINO_VIA?: string;
  BINO_MODEL?: string;
  BINO_REFLECT_MODEL?: string;
  /** The bridge's shared key (WP-N10): without one, /bridge is closed. */
  BRIDGE_KEY?: string;
  [k: string]: unknown;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Bino / Assistant hosted: through Cloudflare AI Gateway, Direct API Key, or OpenRouter, unless BINO_VIA/ASSISTANT_VIA=off. */
export function hostedBinoRoute(env: HubEnv, fetchFn?: typeof fetch, log?: (l: string) => void) {
  const via = (str(env.ASSISTANT_VIA) ?? str(env.BINO_VIA))?.toLowerCase();
  const model = str(env.ASSISTANT_MODEL) ?? str(env.BINO_MODEL);
  const reflectModel = str(env.BINO_REFLECT_MODEL);
  if (via === "api-key") {
    const key = str(env.ASSISTANT_API_KEY) ?? str(env.ANTHROPIC_API_KEY) ?? str(env.OPENAI_API_KEY) ?? str(env.GEMINI_API_KEY);
    return apiKeyRouteOf({ apiKey: { apiKey: key, fetchFn }, model, reflectModel, log });
  }
  if (via === "openrouter") {
    const key = str(env.OPENROUTER_API_KEY) ?? str(env.ASSISTANT_API_KEY);
    return openRouterRouteOf({ openRouter: { apiKey: key, fetchFn }, model, reflectModel, log });
  }
  const route = gatewayRouteOf({
    cfGateway: { accountId: str(env.CF_ACCOUNT_ID), apiToken: str(env.CF_AIG_TOKEN), gateway: str(env.AI_GATEWAY) ?? "dovre", apiKey: str(env.ANTHROPIC_API_KEY), fetchFn },
    model,
    reflectModel,
    log,
  });
  if (via === "off") return { ...route, ready: false, ask: undefined, why: "Bino is off (BINO_VIA=off)." };
  return route;
}

/** Bino's conversations in the object's SQLite: one row each, rewritten whole on a change (there are a dozen at most). */
export function sqlConvStore(sql: HubState["storage"]["sql"]): ConvStore {
  sql.exec("CREATE TABLE IF NOT EXISTS bino_convs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, conv TEXT NOT NULL)");
  return {
    load: () =>
      sql
        .exec("SELECT conv FROM bino_convs ORDER BY at DESC")
        .toArray()
        .flatMap((r) => {
          try {
            return [JSON.parse(String(r.conv)) as Conv];
          } catch {
            return [];
          }
        }),
    save(keep) {
      sql.exec("DELETE FROM bino_convs");
      for (const c of keep) sql.exec("INSERT INTO bino_convs (id, at, conv) VALUES (?, ?, ?)", c.id, c.at, JSON.stringify(c));
    },
  };
}

/** The Bino calls the Worker makes, by name. */
export type BinoOp =
  | { op: "list" }
  | { op: "get"; id: string }
  | { op: "start"; text: string; todo?: number; view?: string; app?: string; context: string }
  | { op: "say"; id: string; text: string; view?: string; context: string }
  | { op: "added"; id: string; index: number; todo: number }
  | { op: "setAct"; id: string; index: number; n: number; patch: { error?: string } };

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v ?? null), { status, headers: { "content-type": "application/json" } });
const enc = new TextEncoder();
/** An answer in flight keeps the object awake: an alarm a minute, while one is. */
const AWAKE_MS = 60_000;

export class DovreHub {
  private subs = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private bino?: Promise<Engine>;
  private state: HubState;
  private env: HubEnv;
  /** For tests: the gateway's fetch. */
  fetchFn?: typeof fetch;
  /** The Mac's socket's channel, once its hello passed (rebuilt from the attachment after hibernation). */
  private chans = new WeakMap<HubSocket, Promise<Channel>>();
  /** Calls waiting on the Mac, by id: only while the request that made them is open. */
  private waiting = new Map<string, (a: MacAnswer) => void>();
  private macSql = false;
  /** For tests: the clock. */
  now: () => number = Date.now;

  constructor(state: HubState, env: HubEnv) {
    this.state = state;
    this.env = env;
    // The bridge's keep-alive: answered by the runtime, never waking the object.
    const Pair = (globalThis as { WebSocketRequestResponsePair?: new (a: string, b: string) => unknown }).WebSocketRequestResponsePair;
    if (Pair) state.setWebSocketAutoResponse?.(new Pair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/bridge") return this.upgrade(req);
    if (path === "/live") return this.liveUpgrade(req);
    if (req.method === "GET" && path === "/mac") return json(this.mac());
    if (req.method === "POST" && path === "/mac/call") {
      const b = (await req.json().catch(() => ({}))) as { call?: unknown; ms?: unknown };
      const c = b.call as Call | undefined;
      if (!c || typeof c !== "object" || typeof c.op !== "string") return json({ ok: false, error: "Not a call." } satisfies MacAnswer, 400);
      return json(await this.call(c, typeof b.ms === "number" ? Math.min(Math.max(b.ms, 500), 25_000) : CALL_MS));
    }
    if (req.method === "GET" && path === "/events") return this.events();
    if (req.method === "POST" && path === "/publish") {
      const b = (await req.json().catch(() => ({}))) as { topics?: unknown; synced?: unknown };
      const topics = Array.isArray(b.topics) ? b.topics.filter((t): t is string => typeof t === "string" && t.length <= 120).slice(0, 20) : [];
      const synced = typeof b.synced === "number" && Number.isFinite(b.synced) ? b.synced : undefined;
      if (topics.length || synced) this.publish(topics, synced);
      return json({ ok: true, listeners: this.subs.size + this.pages().length });
    }
    if (req.method === "POST" && path === "/bino") return json(await this.binoOp((await req.json()) as BinoOp));
    return new Response("Not found", { status: 404 });
  }

  /** Keeps the object from being put away while Bino is answering. */
  async alarm(): Promise<void> {
    const b = this.bino && (await this.bino);
    if (b?.list().some((c) => c.thinking)) await this.state.storage.setAlarm(Date.now() + AWAKE_MS);
  }

  /** `synced`: a gather finished then (the sidebar's "Synced", as the local server's events say it). */
  publish(topics: string[], synced?: number): void {
    const data = JSON.stringify({ topics, at: Date.now(), synced });
    const line = enc.encode(`event: change\ndata: ${data}\n\n`);
    for (const w of this.subs) this.write(w, line);
    for (const ws of this.pages()) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  /** Pages' live sockets, open now. */
  private pages(): HubSocket[] {
    return this.state.getWebSockets?.(PAGE) ?? [];
  }
  /** Whether a page is watching: a socket or a stream. */
  private watching(): boolean {
    return this.subs.size > 0 || this.pages().length > 0;
  }

  private liveUpgrade(req: Request): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !this.state.acceptWebSocket) return new Response("Not found", { status: 404 });
    const Pair = (globalThis as { WebSocketPair?: new () => Record<0 | 1, HubSocket> }).WebSocketPair;
    if (!Pair || this.pages().length >= MAX_PAGES) return new Response("Not found", { status: 404 });
    const pair = new Pair();
    this.acceptPage(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** Takes a page's end of a new socket: it only listens (and pings, which the runtime answers). */
  acceptPage(ws: HubSocket): void {
    const first = !this.watching();
    this.state.acceptWebSocket!(ws, [PAGE]);
    ws.serializeAttachment({ page: true });
    if (first) void this.tell({ t: "watch", on: true });
  }

  private write(w: WritableStreamDefaultWriter<Uint8Array>, chunk: Uint8Array) {
    w.write(chunk).catch(() => {
      const had = this.subs.delete(w);
      w.abort().catch(() => {});
      if (had && !this.watching()) void this.tell({ t: "watch", on: false });
    });
  }

  private events(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const first = !this.watching();
    this.subs.add(w);
    if (first) void this.tell({ t: "watch", on: true });
    this.write(w, enc.encode(": open\n\n"));
    const ping = enc.encode("event: ping\ndata: \n\n");
    const t = setInterval(() => {
      if (!this.subs.has(w)) return clearInterval(t);
      this.write(w, ping);
    }, 20_000);
    // Node (tests) shouldn't wait on it; workerd has no unref.
    (t as { unref?: () => void }).unref?.();
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
  }

  private engine(): Promise<Engine> {
    this.bino ??= (async () => {
      const route = hostedBinoRoute(this.env, this.fetchFn, (l) => console.log(l));
      const memory = this.env.DB ? await loadMemory(this.env.DB) : noMemory("No database.");
      return createBino({
        route,
        memory,
        store: sqlConvStore(this.state.storage.sql),
        acts: false,
        // Hosted, the Worker always sends what Bino knows with the message.
        context: async (_c, given) => given ?? "",
        onChange: (c) => this.publish([`bino:${c.id}`, "bino"]),
        log: (l) => console.log(l),
      });
    })();
    return this.bino;
  }

  private async awake(b: Engine) {
    if (!b.list().some((c) => c.thinking)) return;
    const at = await this.state.storage.getAlarm?.();
    if (!at) await this.state.storage.setAlarm(Date.now() + AWAKE_MS);
  }

  private async binoOp(o: BinoOp): Promise<unknown> {
    const b = await this.engine();
    switch (o.op) {
      case "list":
        return b.list();
      case "get":
        return b.get(o.id) ?? null;
      case "start": {
        const c = b.start(String(o.text ?? ""), { todo: o.todo, view: o.view, app: o.app, context: String(o.context ?? "") });
        await this.awake(b);
        return c;
      }
      case "say": {
        const ok = b.say(o.id, String(o.text ?? ""), { view: o.view, context: String(o.context ?? "") });
        await this.awake(b);
        return ok;
      }
      case "added":
        return b.added(o.id, o.index, o.todo);
      case "setAct":
        return b.setAct(o.id, o.index, o.n, { error: o.patch?.error });
    }
    return null;
  }

  // ── The Mac's bridge (src/bridge/wire.ts) ──

  private sql() {
    const sql = this.state.storage.sql;
    if (!this.macSql) {
      sql.exec("CREATE TABLE IF NOT EXISTS mac (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.macSql = true;
    }
    return sql;
  }
  private kept(k: string): string | undefined {
    const row = this.sql().exec("SELECT v FROM mac WHERE k = ?", k).toArray()[0];
    return row ? String(row.v) : undefined;
  }
  private keep(k: string, v: string) {
    this.sql().exec("INSERT INTO mac (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** The Mac's socket, once it said hello. */
  private live(): HubSocket | undefined {
    return (this.state.getWebSockets?.(MAC) ?? []).find((ws) => !!(ws.deserializeAttachment() as Attached | null)?.key);
  }

  mac(): MacView {
    let state: MacState | undefined;
    try {
      const v = this.kept("state");
      state = v ? (JSON.parse(v) as MacState) : undefined;
    } catch {}
    const seen = Number(this.kept("seen")) || undefined;
    return { online: !!this.live(), seen, watching: this.watching(), state };
  }

  private upgrade(req: Request): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !keyOk(this.env.BRIDGE_KEY) || !this.state.acceptWebSocket) return new Response("Not found", { status: 404 });
    const Pair = (globalThis as { WebSocketPair?: new () => Record<0 | 1, HubSocket> }).WebSocketPair;
    if (!Pair) return new Response("Not found", { status: 404 });
    const pair = new Pair();
    this.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** Takes the Mac's end of a new socket and challenges it. */
  accept(ws: HubSocket): void {
    this.state.acceptWebSocket!(ws, [MAC]);
    const challenge = nonce();
    ws.serializeAttachment({ challenge, sent: 0, got: 0, since: this.now() } satisfies Attached);
    ws.send(JSON.stringify({ t: "challenge", nonce: challenge }));
  }

  private chan(ws: HubSocket, a: Attached): Promise<Channel> {
    let c = this.chans.get(ws);
    if (!c) {
      c = channel({ key: a.key!, send: "down", sent: a.sent, got: a.got });
      this.chans.set(ws, c);
    }
    return c;
  }
  private save(ws: HubSocket, a: Attached, ch: Channel) {
    ws.serializeAttachment({ ...a, ...ch.counters() } satisfies Attached);
  }

  private async send(ws: HubSocket, body: Down): Promise<boolean> {
    const a = ws.deserializeAttachment() as Attached | null;
    if (!a?.key) return false;
    const ch = await this.chan(ws, a);
    const frame = await ch.seal(body);
    if (!frame) return false;
    this.save(ws, a, ch);
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }
  private tell(body: Down): Promise<boolean> {
    const ws = this.live();
    return ws ? this.send(ws, body) : Promise.resolve(false);
  }

  /** The Mac's frames, one at a time: a hello is checked before the frame after it is read. */
  private inbox: Promise<unknown> = Promise.resolve();
  webSocketMessage(ws: HubSocket, message: string | ArrayBuffer): Promise<void> {
    const p = this.inbox.then(() => this.onMessage(ws, message));
    this.inbox = p.catch(() => {});
    return p;
  }

  private async onMessage(ws: HubSocket, message: string | ArrayBuffer): Promise<void> {
    // The keep-alive, should the runtime's auto-response not have taken it.
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {}
      return;
    }
    const a = ws.deserializeAttachment() as (Attached & { page?: undefined }) | { page: true } | null;
    // A page says nothing but its keep-alive.
    if (a?.page) return;
    if (!a || typeof message !== "string") return ws.close(4002, "bad frame");
    if (!a.key) {
      let h: unknown;
      try {
        h = JSON.parse(message);
      } catch {}
      const key = this.env.BRIDGE_KEY;
      if (!keyOk(key) || !(await helloOk(key, a.challenge, h, this.now()))) return ws.close(4001, "bad hello");
      const ready: Attached = { ...a, key: await sessionKey(key, a.challenge, (h as { nonce: string }).nonce) };
      ws.serializeAttachment(ready);
      // One Mac: a new hello takes over from the socket before it.
      for (const other of this.state.getWebSockets?.(MAC) ?? []) if (other !== ws) other.close(4000, "replaced");
      this.keep("seen", String(this.now()));
      await this.send(ws, { t: "welcome", watching: this.watching() });
      this.publish(["mac", "snapshot"]);
      return;
    }
    const ch = await this.chan(ws, a);
    const up = parseUp(await ch.open(message));
    if (!up) return ws.close(4002, "bad frame");
    this.save(ws, ws.deserializeAttachment() as Attached, ch);
    if (up.t === "reply") {
      this.waiting.get(up.id)?.(up.ok ? { ok: true, value: up.value } : { ok: false, error: up.error });
    } else if (up.t === "topics") {
      this.publish(up.topics);
    } else if (up.t === "state") {
      const text = JSON.stringify(up.state);
      if (text.length <= MAX_STATE) this.keep("state", text);
      this.keep("seen", String(this.now()));
      this.publish(["mac", "snapshot"]);
    }
  }

  async webSocketClose(ws: HubSocket): Promise<void> {
    // Our end closes too (older compatibility dates don't answer a close by themselves).
    try {
      ws.close(1000, "bye");
    } catch {}
    const a = ws.deserializeAttachment() as (Attached & { page?: undefined }) | { page: true } | null;
    if (a?.page) {
      // The runtime may still count the closing socket.
      if (!this.subs.size && !this.pages().some((p) => p !== ws)) void this.tell({ t: "watch", on: false });
      return;
    }
    if (!a?.key) return;
    this.keep("seen", String(this.now()));
    // A call waiting on this socket won't be answered now.
    if (!this.live() || this.live() === ws) for (const [, done] of this.waiting) done({ ok: false, error: "Your Mac went offline.", offline: true });
    this.publish(["mac", "snapshot"]);
  }
  async webSocketError(ws: HubSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** A call down to the Mac, and its answer (or why not) within `ms`. */
  async call(c: Call, ms = CALL_MS): Promise<MacAnswer> {
    const ws = this.live();
    if (!ws) return { ok: false, error: "Your Mac is offline.", offline: true };
    const id = crypto.randomUUID();
    let t: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<MacAnswer>((res) => {
      this.waiting.set(id, res);
      t = setTimeout(() => res({ ok: false, error: "Your Mac didn't answer in time." }), ms);
    });
    if (!(await this.send(ws, { t: "call", id, call: c }))) {
      this.waiting.delete(id);
      clearTimeout(t);
      return { ok: false, error: "That was too big to send to your Mac." };
    }
    try {
      return await answer;
    } finally {
      this.waiting.delete(id);
      clearTimeout(t);
    }
  }

  /** For tests: resolves when Bino has nothing in flight. */
  async idle(): Promise<void> {
    if (this.bino) await (await this.bino).idle();
  }
}
