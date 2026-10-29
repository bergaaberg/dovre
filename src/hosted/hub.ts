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
 * - The bridge (PLAN D24, WP-N10, H7): a WebSocket each machine opens (src/bridge/wire.ts), taken
 *   with the hibernation API so an idle socket costs nothing (keep-alive pings are answered
 *   without waking the object). Each signs with its own key, derived from BRIDGE_KEY. The object
 *   keeps only each machine's metadata (runs, sessions, harnesses, when it was last seen); calls
 *   the Worker makes go down that machine's socket and their answers back to that request, never
 *   kept. It tells the machines when a page is watching, so they stream only then. A machine
 *   revoked (POST /mac/revoke) is shut out until its tokens run out. Each keeps who paired it, when
 *   its token said (Team T4); the agents desk shows a machine only to them (src/bridge/remote.ts).
 *
 * - Export (GET /export): every table it keeps, for a hosted cockpit's export of its data.
 *
 * Only the Worker reaches it, through its binding, after Cloudflare Access let the request in
 * (src/worker.ts, src/app.ts): it has no route of its own. The instance's worker.ts exports it
 * (`export { DovreHub } from "dovre/hosted/hub.ts"`) and binds it as HUB.
 */
import { createBino, type ConvStore, type Conv, type Engine } from "../packs/core/assistant/bino/bino.ts";
import { apiKeyRouteOf, gatewayRouteOf, openRouterRouteOf } from "../packs/core/assistant/bino/gateway.ts";
import { loadMemory, noMemory } from "../packs/core/assistant/bino/memory.ts";
import { type LookupsBinding, lookupsVia } from "./lookups.ts";
import type { D1 } from "../db.ts";
import { DAY_MS, frameKind, KEEP_DAYS } from "../sent.ts";
import { type Call, type Channel, channel, type Down, helloOk, keyOk, LEGACY_MACHINE, machineKey, machineOk, type MacState, nonce, parseUp, sessionKey } from "../bridge/wire.ts";

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
    /** `databaseSize`: the storage's size in bytes, as Cloudflare bills it. */
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }; readonly databaseSize?: number };
    setAlarm(at: number): Promise<void> | void;
    getAlarm?(): Promise<number | null> | number | null;
  };
  acceptWebSocket?(ws: HubSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): HubSocket[];
  setWebSocketAutoResponse?(pair?: unknown): void;
};

/** What a socket keeps across hibernation: its machine and challenge, and once the hello passed, its key and counters. */
type Attached = { challenge: string; machine?: string; owner?: string; key?: string; sent: number; got: number; since: number };

/** A machine as pages see it: online or when it was last, its metadata, and who paired it (T4: theirs alone; none, everyone's). */
export type MachineView = { id: string; name?: string; online: boolean; seen?: number; owner?: string; state?: MacState };
/** The machines (H7), and whether a page is watching. */
export type MacView = { watching: boolean; machines: MachineView[] };
/** What the hub heard from each machine (#145): its frames, counted per day by kind. */
export type ReceivedDay = { day: number; machine: string; name: string; kind: string; count: number; bytes: number };

/** The worker names the machine on a /bridge upgrade it verified (src/worker.ts `bridgeIn`); only the worker reaches the hub. */
export const MACHINE_HEADER = "x-dovre-machine";
/** And who paired it, when its token said (Team T4). */
export const OWNER_HEADER = "x-dovre-owner";
/** A call's answer: the Mac's, or why there isn't one. */
export type MacAnswer = { ok: true; value: unknown } | { ok: false; error: string; offline?: boolean };

const MAC = "mac";
/** Pages' live sockets (H5). */
const PAGE = "page";
/** The most pages that may watch at once (tabs and phones): past it, the newest is turned away and falls back to /events. */
const MAX_PAGES = 64;
/** The longest a revoke holds a machine out (its last token's lifetime is far shorter). */
const REVOKE_MAX_MS = 24 * 60 * 60_000;
/** How long a call waits for the Mac (start a turn, read a session). */
const CALL_MS = 10_000;
/** The most a state may weigh here (sessions' and runs' metadata). */
const MAX_STATE = 512_000;

export type HubEnv = {
  DB: D1;
  CF_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
  AI_GATEWAY?: string;
  /** The name of the Anthropic key stored in the gateway, when it isn't `default`. */
  AI_GATEWAY_KEY_ALIAS?: string;
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
  /** The Worker's lookups for Bino (src/hosted/lookups.ts): a service binding to itself. */
  BINO_LOOKUPS?: LookupsBinding;
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
    cfGateway: { accountId: str(env.CF_ACCOUNT_ID), apiToken: str(env.CF_AIG_TOKEN), gateway: str(env.AI_GATEWAY) ?? "dovre", apiKey: str(env.ANTHROPIC_API_KEY), keyAlias: str(env.AI_GATEWAY_KEY_ALIAS), fetchFn },
    model,
    reflectModel,
    log,
  });
  if (via === "off") return { ...route, ready: false, ask: undefined, why: "Bino is off (BINO_VIA=off)." };
  return route;
}

/** Bino's conversations in the object's SQLite: one row each, rewritten whole on a change (a dozen, and the pinned ones). */
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
  | { op: "stop"; id: string }
  | { op: "retry"; id: string; context: string }
  | { op: "rename"; id: string; title: string }
  | { op: "pin"; id: string; on: boolean }
  | { op: "remove"; id: string }
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
  private waiting = new Map<string, { machine: string; op: string; done: (a: MacAnswer) => void }>();
  private macSql = false;
  private sentSql = false;
  private prunedDay = 0;
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
    if (req.method === "GET" && path === "/sent") return json(this.received());
    if (req.method === "POST" && path === "/mac/call") {
      const b = (await req.json().catch(() => ({}))) as { call?: unknown; ms?: unknown; machine?: unknown };
      const c = b.call as Call | undefined;
      if (!c || typeof c !== "object" || typeof c.op !== "string") return json({ ok: false, error: "Not a call." } satisfies MacAnswer, 400);
      return json(await this.call(c, typeof b.ms === "number" ? Math.min(Math.max(b.ms, 500), 25_000) : CALL_MS, typeof b.machine === "string" ? b.machine : undefined));
    }
    if (req.method === "POST" && path === "/mac/revoke") {
      const b = (await req.json().catch(() => ({}))) as { machine?: unknown; until?: unknown };
      if (!machineOk(b.machine) || typeof b.until !== "number" || !Number.isFinite(b.until)) return json({ ok: false }, 400);
      this.revoke(b.machine, b.until);
      return json({ ok: true });
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
    if (req.method === "GET" && path === "/export") return json(this.dump());
    // For hosted Dovre's fair-use data count, asked through the tenant script like /export.
    if (req.method === "GET" && path === "/size") {
      const bytes = this.state.storage.sql.databaseSize;
      return json({ bytes: typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null });
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Everything this object keeps, table by table (GET /export): Bino's conversations and the Mac's
   * metadata. For a cockpit's export (hosted Dovre's control plane asks through its tenant script).
   * Cloudflare's own tables (`_cf_…`) and SQLite's are left out.
   */
  dump(): { tables: Record<string, Record<string, unknown>[]> } {
    const sql = this.state.storage.sql;
    const names = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
      .toArray()
      .map((r) => String(r.name));
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const n of names) tables[n] = sql.exec(`SELECT * FROM "${n.replace(/"/g, '""')}"`).toArray();
    return { tables };
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
        ...(this.env.BINO_LOOKUPS ? { lookups: lookupsVia(this.env.BINO_LOOKUPS) } : {}),
        // Hosted, the Worker always sends what Bino knows with the message.
        context: async (_c, given) => given ?? "",
        onChange: (c) => this.publish([`bino:${c.id}`, "bino"]),
        onDraft: (c) => this.publish([`bino:${c.id}`]),
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
      case "stop":
        return b.stop(String(o.id ?? ""));
      case "retry": {
        const ok = b.retry(String(o.id ?? ""), { context: String(o.context ?? "") });
        await this.awake(b);
        return ok;
      }
      case "rename":
        return b.rename(String(o.id ?? ""), String(o.title ?? ""));
      case "pin":
        return b.pin(String(o.id ?? ""), o.on === true);
      case "remove":
        return b.remove(String(o.id ?? ""));
      case "added":
        return b.added(o.id, o.index, o.todo);
      case "setAct":
        return b.setAct(o.id, o.index, o.n, { error: o.patch?.error });
    }
    return null;
  }

  // ── The machines' bridge (src/bridge/wire.ts) ──

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
  /** A machine's own row: `mac`'s are the rows from before there were several. */
  private static k(what: "state" | "seen" | "revoked" | "owner", machine: string) {
    return machine === LEGACY_MACHINE ? what : `${what}:${machine}`;
  }

  /** Every socket a machine holds that said hello (one, but a new one may be taking over). */
  private machineSockets(machine?: string): HubSocket[] {
    return (this.state.getWebSockets?.(machine ? `${MAC}:${machine}` : MAC) ?? []).filter((ws) => !!(ws.deserializeAttachment() as Attached | null)?.key);
  }
  /** A machine's socket, once it said hello. */
  private live(machine: string): HubSocket | undefined {
    return this.machineSockets(machine)[0];
  }
  private static machineOf(a: Attached | null | undefined): string {
    return a?.machine ?? LEGACY_MACHINE;
  }

  /** What a machine last said of itself. */
  private stateOf(machine: string): MacState | undefined {
    try {
      const v = this.kept(DovreHub.k("state", machine));
      return v ? (JSON.parse(v) as MacState) : undefined;
    } catch {
      return undefined;
    }
  }

  /** How a machine is named to people: `mac` is "Your Mac", another by its own name. */
  private label(machine: string): string {
    if (machine === LEGACY_MACHINE) return "Your Mac";
    const name = this.stateOf(machine)?.name;
    return name ? `"${name}"` : "That machine";
  }

  /** Every machine that has been here (and not revoked since), online first, then the most recently seen. */
  mac(): MacView {
    const ids = this.sql()
      .exec("SELECT k FROM mac WHERE k = 'seen' OR k LIKE 'seen:%'")
      .toArray()
      .map((r) => (String(r.k) === "seen" ? LEGACY_MACHINE : String(r.k).slice("seen:".length)))
      .filter(machineOk);
    const machines = ids
      .map((id): MachineView => {
        const state = this.stateOf(id);
        const owner = this.kept(DovreHub.k("owner", id));
        return { id, name: state?.name, online: !!this.live(id), seen: Number(this.kept(DovreHub.k("seen", id))) || undefined, ...(owner ? { owner } : {}), state };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || (b.seen ?? 0) - (a.seen ?? 0));
    return { watching: this.watching(), machines };
  }

  /** Whether a machine was revoked and its tokens may still be good. */
  private revoked(machine: string): boolean {
    const until = Number(this.kept(DovreHub.k("revoked", machine)));
    if (!until) return false;
    if (until > this.now()) return true;
    this.sql().exec("DELETE FROM mac WHERE k = ?", DovreHub.k("revoked", machine));
    return false;
  }

  /**
   * A machine unpaired (POST /mac/revoke): its socket closes now, what it said goes, and it can't
   * open another until `until` (when the last token it was given runs out).
   */
  /** A frame from a machine, counted in its hour (#145). Days past KEEP_DAYS go at the first frame of a new day. */
  private heard(machine: string, kind: string, bytes: number) {
    const sql = this.sql();
    if (!this.sentSql) {
      sql.exec("CREATE TABLE IF NOT EXISTS sent (hour INTEGER NOT NULL, machine TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (hour, machine, kind))");
      this.sentSql = true;
    }
    const at = this.now();
    const hour = at - (at % 3600_000);
    const day = at - (at % DAY_MS);
    if (this.prunedDay !== day) {
      sql.exec("DELETE FROM sent WHERE hour < ?", at - KEEP_DAYS * DAY_MS);
      this.prunedDay = day;
    }
    sql.exec("INSERT INTO sent (hour, machine, kind, count, bytes) VALUES (?, ?, ?, 1, ?) ON CONFLICT(hour, machine, kind) DO UPDATE SET count = count + 1, bytes = bytes + excluded.bytes", hour, machine, kind, bytes);
  }

  /** The last KEEP_DAYS days of what machines sent here, per day, machine and kind, newest first. */
  received(): ReceivedDay[] {
    const sql = this.sql();
    if (!sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sent'").toArray().length) return [];
    const since = this.now() - KEEP_DAYS * DAY_MS;
    return sql
      .exec("SELECT hour - (hour % ?) AS day, machine, kind, SUM(count) AS count, SUM(bytes) AS bytes FROM sent WHERE hour >= ? GROUP BY day, machine, kind ORDER BY day DESC, machine, kind", DAY_MS, since)
      .toArray()
      .map((r) => {
        const machine = String(r.machine);
        return { day: Number(r.day), machine, name: this.stateOf(machine)?.name ?? (machine === LEGACY_MACHINE ? "Your Mac" : machine), kind: String(r.kind), count: Number(r.count), bytes: Number(r.bytes) };
      });
  }

  revoke(machine: string, until: number): void {
    if (!machineOk(machine)) return;
    this.keep(DovreHub.k("revoked", machine), String(Math.min(Math.max(until, this.now()), this.now() + REVOKE_MAX_MS)));
    this.sql().exec("DELETE FROM mac WHERE k = ? OR k = ? OR k = ?", DovreHub.k("state", machine), DovreHub.k("seen", machine), DovreHub.k("owner", machine));
    for (const ws of this.state.getWebSockets?.(`${MAC}:${machine}`) ?? []) ws.close(4004, "revoked");
    this.fail(machine, `${machine === LEGACY_MACHINE ? "Your Mac" : "That machine"} was removed.`);
    this.publish(["mac", "snapshot"]);
  }

  private upgrade(req: Request): Response {
    const machine = req.headers.get(MACHINE_HEADER) ?? "";
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !keyOk(this.env.BRIDGE_KEY) || !this.state.acceptWebSocket || !machineOk(machine) || this.revoked(machine)) return new Response("Not found", { status: 404 });
    const Pair = (globalThis as { WebSocketPair?: new () => Record<0 | 1, HubSocket> }).WebSocketPair;
    if (!Pair) return new Response("Not found", { status: 404 });
    const pair = new Pair();
    this.accept(pair[1], machine, req.headers.get(OWNER_HEADER) ?? undefined);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** Takes a machine's end of a new socket (and who paired it, if its token said) and challenges it. */
  accept(ws: HubSocket, machine: string = LEGACY_MACHINE, owner?: string): void {
    this.state.acceptWebSocket!(ws, [MAC, `${MAC}:${machine}`]);
    const challenge = nonce();
    ws.serializeAttachment({ challenge, machine, ...(owner ? { owner } : {}), sent: 0, got: 0, since: this.now() } satisfies Attached);
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
  /** Tells every machine online (whether a page is watching). */
  private async tell(body: Down): Promise<void> {
    await Promise.all(this.machineSockets().map((ws) => this.send(ws, body)));
  }

  /** The machines' frames, one at a time: a hello is checked before the frame after it is read. */
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
    const machine = DovreHub.machineOf(a);
    if (!a.key) {
      let h: unknown;
      try {
        h = JSON.parse(message);
      } catch {}
      const root = this.env.BRIDGE_KEY;
      if (!keyOk(root) || !machineOk(machine) || this.revoked(machine)) return ws.close(4001, "bad hello");
      const key = await machineKey(root, machine);
      if (!(await helloOk(key, a.challenge, h, this.now()))) return ws.close(4001, "bad hello");
      const ready: Attached = { ...a, machine, key: await sessionKey(key, a.challenge, (h as { nonce: string }).nonce) };
      ws.serializeAttachment(ready);
      // One socket a machine: a new hello takes over from the one before.
      for (const other of this.state.getWebSockets?.(`${MAC}:${machine}`) ?? []) if (other !== ws) other.close(4000, "replaced");
      this.keep(DovreHub.k("seen", machine), String(this.now()));
      // Whose it is, as its newest token said: none makes it everyone's (a self-hosted bridge).
      if (a.owner) this.keep(DovreHub.k("owner", machine), a.owner);
      else this.sql().exec("DELETE FROM mac WHERE k = ?", DovreHub.k("owner", machine));
      this.heard(machine, "hello", message.length);
      await this.send(ws, { t: "welcome", watching: this.watching() });
      this.publish(["mac", "snapshot"]);
      return;
    }
    const ch = await this.chan(ws, a);
    const up = parseUp(await ch.open(message));
    if (!up) return ws.close(4002, "bad frame");
    this.heard(machine, frameKind(up.t, up.t === "reply" ? this.waiting.get(up.id)?.op : undefined), message.length);
    this.save(ws, ws.deserializeAttachment() as Attached, ch);
    if (up.t === "reply") {
      const w = this.waiting.get(up.id);
      // Only the machine the call went to answers it.
      if (w?.machine === machine) w.done(up.ok ? { ok: true, value: up.value } : { ok: false, error: up.error });
    } else if (up.t === "topics") {
      this.publish(up.topics);
    } else if (up.t === "state") {
      const text = JSON.stringify(up.state);
      if (text.length <= MAX_STATE) this.keep(DovreHub.k("state", machine), text);
      this.keep(DovreHub.k("seen", machine), String(this.now()));
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
    const machine = DovreHub.machineOf(a);
    // Revoked: its rows are gone, and stay so.
    if (!this.revoked(machine)) this.keep(DovreHub.k("seen", machine), String(this.now()));
    // A call waiting on this socket won't be answered now.
    const live = this.live(machine);
    if (!live || live === ws) this.fail(machine, `${this.label(machine)} went offline.`);
    this.publish(["mac", "snapshot"]);
  }
  async webSocketError(ws: HubSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Every call waiting on `machine` ends, saying why. */
  private fail(machine: string, error: string) {
    for (const [, w] of this.waiting) if (w.machine === machine) w.done({ ok: false, error, offline: true });
  }

  /**
   * A call down to a machine, and its answer (or why not) within `ms`. Without `machine`, the one
   * online, when only one is.
   */
  async call(c: Call, ms = CALL_MS, machine?: string): Promise<MacAnswer> {
    if (machine === undefined) {
      const online = this.mac().machines.filter((m) => m.online);
      if (online.length > 1) return { ok: false, error: "Say which machine." };
      machine = online[0]?.id;
      if (!machine) {
        const known = this.mac().machines;
        return { ok: false, error: known.length === 1 ? `${this.label(known[0]!.id)} is offline.` : "No machine is online.", offline: true };
      }
    }
    if (!machineOk(machine)) return { ok: false, error: "No such machine." };
    const ws = this.live(machine);
    if (!ws) return { ok: false, error: `${this.label(machine)} is offline.`, offline: true };
    const id = crypto.randomUUID();
    let t: ReturnType<typeof setTimeout> | undefined;
    const label = this.label(machine);
    const answer = new Promise<MacAnswer>((res) => {
      this.waiting.set(id, { machine: machine!, op: c.op, done: res });
      t = setTimeout(() => res({ ok: false, error: `${label} didn't answer in time.` }), ms);
    });
    if (!(await this.send(ws, { t: "call", id, call: c }))) {
      this.waiting.delete(id);
      clearTimeout(t);
      // Gone while the frame was being sealed: that's offline, not too big.
      if (this.live(machine) !== ws) return { ok: false, error: `${label} went offline.`, offline: true };
      return { ok: false, error: `That was too big to send to ${label === "Your Mac" ? "your Mac" : label}.` };
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
