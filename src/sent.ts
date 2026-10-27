/**
 * What Dovre sends home (#145): every call to Dovre's own services goes through here, and is
 * recorded, whether it got through or not. A call is one row (when, host, path, purpose, size, and the names of
 * the fields it sent, never their values). The bridge's frames are counted per hour by kind, since
 * a busy machine sends hundreds a day.
 *
 * Portable: the Mac's bridge (src/bridge/), the hub (src/hosted/hub.ts) and the pages use it. The
 * file the bridge keeps is src/bridge/sentfile.ts. test/sent.test.ts fails on a call that skips it.
 */

/** One call home. */
export type SentCall = { k: "call"; at: number; host: string; path: string; method: string; purpose: string; status?: number; bytes: number; fields: string[] };
/** Frames of one kind to one host within one hour (`hour` is the hour's start). */
export type SentFrames = { k: "frames"; hour: number; host: string; kind: string; count: number; bytes: number };
export type SentLine = SentCall | SentFrames;

/** How long a record is kept. */
export const KEEP_DAYS = 30;
export const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

/** Where a record goes: the bridge's file, the hub's table, or a test's array. */
export type Ledger = {
  call(c: Omit<SentCall, "k">): void;
  frame(host: string, kind: string, bytes: number, at?: number): void;
};

const NAME = /^[\w.-]{1,60}$/;
const KIND = /^[\w:.-]{1,60}$/;
const enc = new TextEncoder();
export const bytesOf = (s: string | undefined) => (s ? enc.encode(s).length : 0);

/** The names of a JSON body's top-level fields, never their values; anything else, none. */
export function fieldsOf(body: string | undefined): string[] {
  if (!body) return [];
  try {
    const v = JSON.parse(body) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    return Object.keys(v).filter((k) => NAME.test(k)).sort().slice(0, 20);
  } catch {
    return [];
  }
}

const partsOf = (url: string): { host: string; path: string } => {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: "?", path: "?" };
  }
};

type Init = { method?: string; headers?: Record<string, string>; body?: string };

/** A fetch that records each call home with its answer (or none, when it failed). Without `f`, the global fetch. */
export function recorded<I extends Init, R extends { status: number }>(ledger: Ledger | undefined, purpose: string, f?: (url: string, init: I) => Promise<R>): (url: string, init: I) => Promise<R> {
  const go = f ?? ((url: string, init: I) => fetch(url, init) as unknown as Promise<R>);
  return async (url, init) => {
    const { host, path } = partsOf(url);
    const row = { at: Date.now(), host, path, method: (init.method ?? "GET").toUpperCase(), purpose, bytes: bytesOf(init.body), fields: fieldsOf(init.body) };
    try {
      const res = await go(url, init);
      ledger?.call({ ...row, status: res.status });
      return res;
    } catch (e) {
      ledger?.call(row);
      throw e;
    }
  };
}

/** A socket opened home, recorded as a call: the names of the headers it signs in with, never their values. */
export function recordedDial<S>(ledger: Ledger | undefined, purpose: string, dial: (url: string, headers: Record<string, string>) => S): (url: string, headers: Record<string, string>) => S {
  return (url, headers) => {
    const { host, path } = partsOf(url);
    ledger?.call({ at: Date.now(), host, path, method: "GET", purpose, bytes: 0, fields: Object.keys(headers).filter((k) => NAME.test(k)).sort() });
    return dial(url, headers);
  };
}

/** Frames counted in memory, handed over a few at a time (`take`), so a file or table gets one line an hour a kind. */
export function tally() {
  const held = new Map<string, SentFrames>();
  return {
    add(host: string, kind: string, bytes: number, at = Date.now()) {
      const hour = at - (at % HOUR_MS);
      const key = `${hour} ${host} ${kind}`;
      const t = held.get(key) ?? { k: "frames" as const, hour, host, kind, count: 0, bytes: 0 };
      t.count++;
      t.bytes += bytes;
      held.set(key, t);
    },
    take(): SentFrames[] {
      const out = [...held.values()];
      held.clear();
      return out;
    },
    size: () => held.size,
  };
}

/** A line as written, or nothing when it isn't one. */
export function lineOf(v: unknown): SentLine | undefined {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return undefined;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const str = (x: unknown, max = 200) => typeof x === "string" && x.length > 0 && x.length <= max;
  if (o.k === "call") {
    if (!num(o.at) || !str(o.host) || !str(o.path, 500) || !str(o.method, 10) || !str(o.purpose, 60) || !num(o.bytes)) return undefined;
    const fields = Array.isArray(o.fields) ? o.fields.filter((f): f is string => typeof f === "string" && NAME.test(f)).slice(0, 20) : [];
    return { k: "call", at: o.at as number, host: o.host as string, path: o.path as string, method: o.method as string, purpose: o.purpose as string, ...(num(o.status) ? { status: o.status as number } : {}), bytes: o.bytes as number, fields };
  }
  if (o.k === "frames") {
    if (!num(o.hour) || !str(o.host) || typeof o.kind !== "string" || !KIND.test(o.kind) || !num(o.count) || !num(o.bytes)) return undefined;
    return { k: "frames", hour: o.hour as number, host: o.host as string, kind: o.kind, count: o.count as number, bytes: o.bytes as number };
  }
  return undefined;
}

/** A JSON-lines file's lines, the bad ones left out. */
export function parseLines(text: string): SentLine[] {
  const out: SentLine[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const line = lineOf(JSON.parse(l));
      if (line) out.push(line);
    } catch {}
  }
  return out;
}

/** One day's frames of one kind to one host, summed. */
export type FrameDay = { day: number; host: string; kind: string; count: number; bytes: number };
export type SentRecord = { calls: SentCall[]; frames: FrameDay[] };

/** The last KEEP_DAYS days: calls newest first, frames summed per day, newest day first. */
export function recordOf(lines: SentLine[], now = Date.now(), maxCalls = 500): SentRecord {
  const since = now - KEEP_DAYS * DAY_MS;
  const calls = lines.filter((l): l is SentCall => l.k === "call" && l.at >= since).sort((a, b) => b.at - a.at).slice(0, maxCalls);
  const days = new Map<string, FrameDay>();
  for (const l of lines) {
    if (l.k !== "frames" || l.hour < since) continue;
    const day = l.hour - (l.hour % DAY_MS);
    const key = `${day} ${l.host} ${l.kind}`;
    const d = days.get(key) ?? { day, host: l.host, kind: l.kind, count: 0, bytes: 0 };
    d.count += l.count;
    d.bytes += l.bytes;
    days.set(key, d);
  }
  const frames = [...days.values()].sort((a, b) => b.day - a.day || a.host.localeCompare(b.host) || a.kind.localeCompare(b.kind));
  return { calls, frames };
}

/** A frame's kind as counted: its type, and the call a reply answers. */
export const frameKind = (t: string, op?: string) => (op && NAME.test(op) ? `${t}:${op}` : t);

/** Every call Dovre can make to Dovre's own services, and why: the same list as dovre.dev's docs. */
export type CatalogEntry = { id: string; who: string; what: string; to: string; sends: string; when: string; recorded: string };
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "bridge.token",
    who: "The bridge on your machine",
    what: "Trades its refresh token for a short-lived sign-in token",
    to: "The server it was paired with (https://dovre.dev for Dovre Cloud): POST /bridge/token",
    sends: "grant_type, refresh_token",
    when: "Before a connect, when the last sign-in token is under a minute from running out",
    recorded: "On the machine, each call",
  },
  {
    id: "bridge.connect",
    who: "The bridge on your machine",
    what: "Opens its socket to your cockpit",
    to: "Your cockpit's /bridge (<handle>.dovre.dev on Dovre Cloud, your own host self-hosted)",
    sends: "A sign-in header (its name is listed; never its value)",
    when: "On start, and after a dropped connection",
    recorded: "On the machine, each call",
  },
  {
    id: "bridge.frames",
    who: "The bridge on your machine",
    what: "Sends sealed frames over that socket",
    to: "Your cockpit's /bridge",
    sends: "hello (version), state (agents, runs and sessions: metadata only, never what a turn says), topics (which lists changed), reply (the answer to a call you made from the cockpit), ping",
    when: "While connected",
    recorded: "On the machine and in the cockpit, counted per hour",
  },
  {
    id: "bridge.login",
    who: "dovre bridge login / logout",
    what: "Pairs this machine with a code you type in the cockpit, or unpairs it",
    to: "The server you pair with: POST /bridge/device, /bridge/token, /bridge/revoke",
    sends: "handle, machine name, the device code, then the refresh token to revoke",
    when: "Only when you run the command",
    recorded: "On the machine, each call",
  },
  {
    id: "signin.keys",
    who: "A hosted cockpit signing you in",
    what: "Fetches the public keys that sign your sign-in tokens",
    to: "Your sign-in issuer (Cloudflare Access, or https://dovre.dev on Dovre Cloud)",
    sends: "Nothing: a plain GET of public keys",
    when: "When the cached keys run out",
    recorded: "Listed here; nothing of yours is sent",
  },
];
