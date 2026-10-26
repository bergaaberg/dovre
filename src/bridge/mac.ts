/**
 * The bridge's socket, from the Mac (PLAN D24, WP-N10): dials the hub through Access, answers its
 * challenge, then speaks in signed frames (src/bridge/wire.ts). What it sends depends on whether a
 * page is watching (the hub says):
 *
 * - always: the state (src/bridge/serve.ts `stateOf`) when a turn starts or ends, or a call it
 *   answered changed something; and answers to calls;
 * - only while watched: `run:<id>` topics for a turn that's working (at most once a second per
 *   run), and the sessions read again every 15 s, sent when they changed.
 *
 * Unwatched and idle, nothing but a "ping" every 45 s, which the hub's runtime answers without
 * waking the object. A dropped socket (the Mac slept, the network went) is dialled again, backing
 * off up to a minute.
 */
import type { Desk } from "../agents/desk.ts";
import type { Run } from "../agents/runner.ts";
import type { Session } from "../sources/claude.ts";
import { answerCall, stateOf } from "./serve.ts";
import { type Channel, channel, hello, parseDown, sessionKey, type Up } from "./wire.ts";

/** As much of a WebSocket as this uses (the global one in Node, or a test's). */
export type BridgeSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type BridgeOpts = {
  /** wss://<hosted>/bridge */
  url: string;
  key: string;
  /**
   * What it signs in with, asked again on every dial: the Access service token's headers
   * (CF-Access-Client-Id, CF-Access-Client-Secret), or a fresh issuer JWT (H6) in
   * Cf-Access-Jwt-Assertion. A failure is a dial that failed: tried again, backing off.
   */
  headers: Record<string, string> | (() => Promise<Record<string, string>>);
  /** This machine's name for itself (its hostname), for pages to tell machines apart. */
  name?: string;
  desk: Desk;
  /** The agents' sessions, read again (metadata, as the snapshot holds them). */
  sessions: () => Promise<{ live: Session[]; recent: Session[] }>;
  version?: string;
  /** For tests: how a socket is opened. */
  dial?: (url: string, headers: Record<string, string>) => BridgeSocket;
  log?: (line: string) => void;
  /** The hub closed the socket as revoked (4004: the machine was unpaired): the bridge has stopped. */
  onRevoked?: () => void;
  /** For tests: shorter waits. */
  timing?: Partial<typeof TIMING>;
};

export const TIMING = { pingMs: 45_000, sessionsMs: 15_000, topicMs: 1000, stateMs: 500, backoffMs: 1000, maxBackoffMs: 60_000 };

export type Bridge = {
  /** A run changed (the runner's onChange). */
  changed(run: Run): void;
  /** Topics a page should hear now (a message queued, say), when one is watching. */
  topics(t: string[]): void;
  status(): { connected: boolean; watching: boolean };
  stop(): void;
};

const OPEN = 1;

export function startBridge(o: BridgeOpts): Bridge {
  const t = { ...TIMING, ...o.timing };
  const log = o.log ?? (() => {});
  const dial = o.dial ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as BridgeSocket);
  let ws: BridgeSocket | undefined;
  let ch: Channel | undefined;
  let watching = false;
  let stopped = false;
  let backoff = t.backoffMs;
  let lastState = "";
  let missed = 0;
  let pingT: ReturnType<typeof setInterval> | undefined;
  let sessionsT: ReturnType<typeof setInterval> | undefined;
  let reconnectT: ReturnType<typeof setTimeout> | undefined;
  let stateT: ReturnType<typeof setTimeout> | undefined;
  const topicT = new Map<string, ReturnType<typeof setTimeout>>();
  const statusOf = new Map<string, Run["status"]>();

  const send = async (body: Up) => {
    const sock = ws;
    const c = ch;
    if (!sock || !c || sock.readyState !== OPEN) return;
    const frame = await c.seal(body);
    if (!frame) return log(`bridge: a ${body.t} too big to send`);
    if (ws === sock && sock.readyState === OPEN) sock.send(frame);
  };

  const pushState = async (force = false) => {
    if (!ch) return;
    const state = stateOf(o.desk, await o.sessions().catch(() => ({ live: [], recent: [] })), { version: o.version, name: o.name });
    const key = JSON.stringify({ ...state, at: 0 });
    if (!force && key === lastState) return;
    lastState = key;
    await send({ t: "state", state });
  };
  /** A state soon: several changes together go as one. */
  const stateSoon = () => {
    if (stateT) return;
    stateT = setTimeout(() => {
      stateT = undefined;
      void pushState();
    }, t.stateMs);
  };

  const watch = (on: boolean) => {
    watching = on;
    if (sessionsT) clearInterval(sessionsT);
    sessionsT = undefined;
    if (on) {
      void pushState();
      sessionsT = setInterval(() => void pushState(), t.sessionsMs);
    }
  };

  const cleanup = () => {
    if (pingT) clearInterval(pingT);
    if (sessionsT) clearInterval(sessionsT);
    if (stateT) clearTimeout(stateT);
    for (const x of topicT.values()) clearTimeout(x);
    topicT.clear();
    pingT = sessionsT = stateT = undefined;
    ch = undefined;
    watching = false;
    lastState = "";
  };

  const again = () => {
    cleanup();
    ws = undefined;
    if (stopped || reconnectT) return;
    const wait = Math.min(backoff, t.maxBackoffMs) * (0.8 + Math.random() * 0.4);
    backoff = Math.min(backoff * 2, t.maxBackoffMs);
    reconnectT = setTimeout(() => {
      reconnectT = undefined;
      void connect();
    }, wait);
  };

  const onMessage = async (sock: BridgeSocket, data: unknown) => {
    if (typeof data !== "string") return;
    if (data === "pong") {
      missed = 0;
      return;
    }
    if (!ch) {
      let m: { t?: string; nonce?: string } = {};
      try {
        m = JSON.parse(data);
      } catch {}
      if (m.t !== "challenge" || typeof m.nonce !== "string") return sock.close(4002, "expected a challenge");
      const h = await hello(o.key, m.nonce, { version: o.version });
      ch = await channel({ key: await sessionKey(o.key, m.nonce, h.nonce), send: "up" });
      sock.send(JSON.stringify(h));
      return;
    }
    const d = parseDown(await ch.open(data));
    if (!d) {
      log("bridge: a frame that didn't check out; dialling again");
      return sock.close(4002, "bad frame");
    }
    if (d.t === "welcome") {
      backoff = t.backoffMs;
      log(`bridge: connected${d.watching ? ", watched" : ""}`);
      watch(d.watching);
      if (!d.watching) void pushState(true);
    } else if (d.t === "watch") watch(d.on);
    else if (d.t === "call") {
      try {
        const value = await answerCall(o.desk, d.call);
        await send({ t: "reply", id: d.id, ok: true, value: value ?? null });
      } catch (e) {
        await send({ t: "reply", id: d.id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) });
      }
      // An action may have changed what lists show (a run started, a session cleared away).
      if (d.call.op !== "view" && d.call.op !== "repos" && d.call.op !== "run" && d.call.op !== "session") stateSoon();
    }
  };

  async function connect() {
    if (stopped) return;
    let sock: BridgeSocket;
    try {
      const headers = typeof o.headers === "function" ? await o.headers() : o.headers;
      if (stopped) return;
      sock = dial(o.url, headers);
    } catch (e) {
      log(`bridge: couldn't dial: ${(e as Error)?.message ?? e}`);
      return again();
    }
    ws = sock;
    // Frames are handled one at a time, in order.
    let chain: Promise<unknown> = Promise.resolve();
    sock.onmessage = (ev) => {
      chain = chain.then(() => onMessage(sock, ev.data)).catch((e) => log(`bridge: ${(e as Error)?.message ?? e}`));
    };
    sock.onopen = () => {
      missed = 0;
      pingT = setInterval(() => {
        // Two pings unanswered: the socket is gone though nobody said so (the Mac slept).
        if (++missed > 2) return sock.close(4003, "no pong");
        if (sock.readyState === OPEN) sock.send("ping");
      }, t.pingMs);
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      log(`bridge: closed${ev?.code ? ` (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})` : ""}`);
      // Unpaired: dialling again would only be refused again.
      if (ev?.code === 4004) {
        stopped = true;
        cleanup();
        ws = undefined;
        return o.onRevoked?.();
      }
      again();
    };
    sock.onerror = () => {};
  }

  void connect();

  return {
    changed(run) {
      const was = statusOf.get(run.id);
      statusOf.set(run.id, run.status);
      const denied = run.events.some((e) => e.t === "denied");
      // Starting, ending, a call denied: lists change (sent watched or not).
      if (was !== run.status || (denied && run.status !== "running")) stateSoon();
      if (!watching || run.status !== "running" || topicT.has(run.id)) return;
      topicT.set(
        run.id,
        setTimeout(() => {
          topicT.delete(run.id);
          void send({ t: "topics", topics: [`run:${run.id}`, ...(run.sessionId ? [`run:${run.sessionId}`] : []), ...(run.resumed ? [`run:${run.resumed}`] : [])] });
        }, t.topicMs),
      );
    },
    topics(list) {
      if (watching && list.length) void send({ t: "topics", topics: list.slice(0, 20) });
    },
    status: () => ({ connected: !!ch && ws?.readyState === OPEN, watching }),
    stop() {
      stopped = true;
      if (reconnectT) clearTimeout(reconnectT);
      cleanup();
      ws?.close(1000, "bye");
      ws = undefined;
    },
  };
}
