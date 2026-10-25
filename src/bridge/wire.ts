/**
 * The bridge's wire (PLAN D24, WP-N10): the Mac's `pnpm bridge` and the hub Durable Object talk
 * over one WebSocket the Mac opens. Access lets only the bridge's service token reach /bridge;
 * this is the second lock, so a socket that got past Access some other way still can't speak.
 *
 * 1. The hub sends `{t:"challenge", nonce}` (unsigned).
 * 2. The bridge answers `{t:"hello", nonce, at, mac}`: an HMAC-SHA256 under BRIDGE_KEY over both
 *    nonces and the time. The hub checks it (and that `at` is within two minutes).
 * 3. Both derive this socket's key from BRIDGE_KEY and the two nonces. Every frame after is
 *    `{seq, body, mac}`: seq counts up from 1 in each direction, the MAC covers the direction,
 *    seq and body. A bad MAC, a seq out of order or a body that doesn't parse closes the socket.
 *
 * What the bodies carry is checked here too (parseUp / parseDown), by shape and size.
 */

export const PROTOCOL = "dovre-bridge/1";
/** A hello older or newer than this is refused. */
export const HELLO_SKEW_MS = 2 * 60_000;
/** The largest frame either side sends or takes (workerd's own limit is 1 MiB). */
export const MAX_FRAME = 900_000;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/.test(s)) return undefined;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

async function hmacKey(secret: string | Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? enc.encode(secret) : secret;
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const sign = async (key: CryptoKey, text: string) => hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
/** Constant-time, by WebCrypto's own verify. */
const check = async (key: CryptoKey, text: string, mac: unknown) => {
  const bytes = typeof mac === "string" ? unhex(mac) : undefined;
  return !!bytes && bytes.length === 32 && crypto.subtle.verify("HMAC", key, bytes, enc.encode(text));
};

/** A fresh nonce: 16 random bytes as hex. */
export const nonce = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
const NONCE = /^[0-9a-f]{32}$/;

/** BRIDGE_KEY must be long enough to be a key, not a password. */
export const keyOk = (k: string | undefined): k is string => typeof k === "string" && k.trim().length >= 32;

const helloText = (hub: string, mac: string, at: number) => `${PROTOCOL}|hello|${hub}|${mac}|${at}`;
const sessionText = (hub: string, mac: string) => `${PROTOCOL}|session|${hub}|${mac}`;

export type Challenge = { t: "challenge"; nonce: string };
export type Hello = { t: "hello"; nonce: string; at: number; mac: string; version?: string };

/** The bridge's answer to a challenge. */
export async function hello(key: string, challenge: string, o: { now?: number; version?: string } = {}): Promise<Hello> {
  const mine = nonce();
  const at = o.now ?? Date.now();
  return { t: "hello", nonce: mine, at, mac: await sign(await hmacKey(key), helloText(challenge, mine, at)), version: o.version };
}

/** The hub's check of a hello against the challenge it sent. */
export async function helloOk(key: string, challenge: string, h: unknown, now = Date.now()): Promise<boolean> {
  const v = h as Partial<Hello> | null;
  if (!v || v.t !== "hello" || typeof v.nonce !== "string" || !NONCE.test(v.nonce) || typeof v.at !== "number" || !Number.isFinite(v.at)) return false;
  if (Math.abs(now - v.at) > HELLO_SKEW_MS || v.nonce === challenge) return false;
  return check(await hmacKey(key), helloText(challenge, v.nonce, v.at), v.mac);
}

/** This socket's key, as hex (the hub keeps it in the socket's attachment across hibernation). */
export async function sessionKey(key: string, challenge: string, macNonce: string): Promise<string> {
  return sign(await hmacKey(key), sessionText(challenge, macNonce));
}

/** Up: Mac → hub. Down: hub → Mac. */
export type Dir = "up" | "down";
export type Frame = { seq: number; body: unknown; mac: string };

const frameText = (dir: Dir, seq: number, body: string) => `${PROTOCOL}|${dir}|${seq}|${body}`;

/** One side of a socket: signs what it sends, checks what it gets, each in order. */
export type Channel = {
  /** The frame to send, as text; undefined when it would be too big. */
  seal(body: unknown): Promise<string | undefined>;
  /** The body of the next frame, or undefined (bad MAC, out of order, too big: close the socket). */
  open(text: string): Promise<unknown | undefined>;
  /** Where the counters are, for keeping across hibernation. */
  counters(): { sent: number; got: number };
};

export async function channel(o: { key: string; send: Dir; sent?: number; got?: number }): Promise<Channel> {
  const raw = unhex(o.key);
  if (!raw || raw.length !== 32) throw new Error("bridge: not a session key");
  const key = await hmacKey(raw);
  const recv: Dir = o.send === "up" ? "down" : "up";
  let sent = o.sent ?? 0;
  let got = o.got ?? 0;
  // Each side's frames are handled one at a time, in the order asked: a seq is never signed or
  // checked out of turn while another awaits its MAC.
  let sealing: Promise<unknown> = Promise.resolve();
  let opening: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(last: Promise<unknown>, fn: () => Promise<T>): Promise<T> => last.then(fn, fn);
  return {
    seal(body) {
      const p = inTurn(sealing, async () => {
        const text = JSON.stringify(body);
        if (text === undefined || text.length > MAX_FRAME) return undefined;
        const seq = sent + 1;
        const frame = JSON.stringify({ seq, body: text, mac: await sign(key, frameText(o.send, seq, text)) });
        if (frame.length > MAX_FRAME) return undefined;
        sent = seq;
        return frame;
      });
      sealing = p;
      return p;
    },
    open(text) {
      const p = inTurn(opening, async () => {
        if (typeof text !== "string" || text.length > MAX_FRAME) return undefined;
        let f: { seq?: unknown; body?: unknown; mac?: unknown };
        try {
          f = JSON.parse(text);
        } catch {
          return undefined;
        }
        if (!f || f.seq !== got + 1 || typeof f.body !== "string") return undefined;
        if (!(await check(key, frameText(recv, f.seq as number, f.body), f.mac))) return undefined;
        try {
          const body = JSON.parse(f.body);
          got = f.seq as number;
          return body;
        } catch {
          return undefined;
        }
      });
      opening = p;
      return p;
    },
    counters: () => ({ sent, got }),
  };
}

// ── What the frames carry ──

/** A call the Worker makes of the Mac's desk: an op name and its arguments (src/agents/desk.ts checks them). */
export type Call = { op: string; [k: string]: unknown };
/** What the Mac keeps the hub told of (metadata only: never what a turn says). */
export type MacState = { at: number; version?: string; harnesses: string[]; runs: unknown[]; sessions: { live: unknown[]; recent: unknown[] }; workDir?: string };

export type Up =
  | { t: "state"; state: MacState }
  | { t: "topics"; topics: string[] }
  | { t: "reply"; id: string; ok: true; value: unknown }
  | { t: "reply"; id: string; ok: false; error: string };

export type Down = { t: "welcome"; watching: boolean } | { t: "watch"; on: boolean } | { t: "call"; id: string; call: Call };

const ID = /^[0-9a-f-]{8,64}$/;
const TOPIC = /^[\w:.-]{1,120}$/;
const OP = /^[a-z][\w.]{0,40}$/;
const arr = (v: unknown, max: number): unknown[] | undefined => (Array.isArray(v) && v.length <= max ? v : undefined);

/** What the hub takes from the Mac. */
export function parseUp(v: unknown): Up | undefined {
  const b = v as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return undefined;
  if (b.t === "topics") {
    const topics = arr(b.topics, 20)?.filter((t): t is string => typeof t === "string" && TOPIC.test(t));
    return topics?.length ? { t: "topics", topics } : undefined;
  }
  if (b.t === "reply") {
    if (typeof b.id !== "string" || !ID.test(b.id)) return undefined;
    if (b.ok === true) return { t: "reply", id: b.id, ok: true, value: b.value ?? null };
    return { t: "reply", id: b.id, ok: false, error: typeof b.error === "string" ? b.error.slice(0, 500) : "The Mac couldn't do that." };
  }
  if (b.t === "state") {
    const s = b.state as Record<string, unknown> | null;
    if (!s || typeof s !== "object" || typeof s.at !== "number") return undefined;
    const harnesses = arr(s.harnesses, 10)?.filter((h): h is string => typeof h === "string" && /^[a-z]{1,20}$/.test(h));
    const runs = arr(s.runs, 200);
    const ss = s.sessions as Record<string, unknown> | null;
    const live = arr(ss?.live, 200);
    const recent = arr(ss?.recent, 200);
    if (!harnesses || !runs || !live || !recent) return undefined;
    const workDir = typeof s.workDir === "string" && s.workDir.length <= 500 ? s.workDir : undefined;
    return { t: "state", state: { at: s.at, version: typeof s.version === "string" ? s.version.slice(0, 40) : undefined, harnesses, runs, sessions: { live, recent }, ...(workDir ? { workDir } : {}) } };
  }
  return undefined;
}

/** What the Mac takes from the hub. */
export function parseDown(v: unknown): Down | undefined {
  const b = v as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return undefined;
  if (b.t === "welcome" && typeof b.watching === "boolean") return { t: "welcome", watching: b.watching };
  if (b.t === "watch" && typeof b.on === "boolean") return { t: "watch", on: b.on };
  if (b.t === "call" && typeof b.id === "string" && ID.test(b.id)) {
    const c = b.call as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || typeof c.op !== "string" || !OP.test(c.op)) return undefined;
    return { t: "call", id: b.id, call: c as Call };
  }
  return undefined;
}
