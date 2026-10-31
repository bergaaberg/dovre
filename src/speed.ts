/**
 * Page speed (#294): every page load, counted by route an hour at a time, as the server and the
 * page measured it. `server` is the app's time from request to response (hosted, a Worker's clock
 * only moves on I/O, so it's waiting on D1, the hub and APIs, not CPU); `page` is the browser's,
 * from the click to the page's load event, Access and the network included. `call` is every other
 * request (JSON, scripts, POSTs, streams opening), the server's time, so a page script asking in a
 * loop shows up by count. Counts are kept in D1
 * (`page_speed`), so every hosted isolate's add up; no URLs: a route is the pattern it matched.
 */
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { D1 } from "./db.ts";
import type { AppEnv } from "./env.ts";

const HOUR = 3600_000;
/** Hours of counts kept in D1. */
const KEEP_HOURS = 7 * 24;
/** Counts reach D1 at most this often (each flush is one batch). */
const FLUSH_MS = 30_000;
/** The buckets' upper edges (ms); the last bucket is everything slower. */
export const EDGES = [100, 250, 500, 1000, 2000, 4000] as const;

export type Side = "server" | "page" | "call";
export type SpeedRow = { hour: number; side: Side; route: string; n: number; /** Their total, ms. */ ms: number; /** Loads per bucket, EDGES.length + 1 of them. */ b: number[] };
export type SpeedView = { rows: SpeedRow[]; now: number };

/** A route as the client says it: a pattern Dovre registered, nothing else. */
export const routeOk = (r: unknown): r is string => typeof r === "string" && /^\/[\w\-\/:.*]{0,120}$/.test(r);

const bucketOf = (ms: number) => {
  const i = EDGES.findIndex((e) => ms < e);
  return i === -1 ? EDGES.length : i;
};

/** The load time below which `q` (0–1) of the loads were: a bucket's upper edge, or undefined past the last. */
export function quantile(b: number[], q: number): number | undefined {
  const n = b.reduce((a, x) => a + x, 0);
  if (!n) return undefined;
  let seen = 0;
  for (let i = 0; i < b.length; i++) {
    seen += b[i]!;
    if (seen >= q * n) return EDGES[i];
  }
  return undefined;
}

/** The rows from `since` on (an hour's start), added up by side and route. */
export function byRoute(rows: SpeedRow[], since: number): Map<string, Partial<Record<Side, SpeedRow>>> {
  const out = new Map<string, Partial<Record<Side, SpeedRow>>>();
  for (const r of rows) {
    if (r.hour < since) continue;
    const at = out.get(r.route) ?? {};
    const was = at[r.side];
    at[r.side] = was ? { ...was, n: was.n + r.n, ms: was.ms + r.ms, b: was.b.map((x, i) => x + (r.b[i] ?? 0)) } : { ...r, b: [...r.b] };
    out.set(r.route, at);
  }
  return out;
}

export type Speed = {
  record(side: Side, route: string, ms: number): void;
  /** Writes what was counted since the last flush; `force`, even if one went out lately. Never throws. */
  flush(db: D1, force?: boolean): Promise<void>;
  /** The counts there are: D1's (every isolate's) and this one's not yet flushed. */
  view(db?: D1): Promise<SpeedView>;
};

const COLS = EDGES.map((_, i) => `b${i}`).concat(`b${EDGES.length}`);

export function createSpeed(now: () => number = Date.now): Speed {
  let pending = new Map<string, SpeedRow>();
  let flushed = 0;
  let flushing: Promise<void> | undefined;

  function add(r: SpeedRow) {
    const k = `${r.hour} ${r.side} ${r.route}`;
    const was = pending.get(k);
    if (!was) pending.set(k, { ...r, b: [...r.b] });
    else {
      was.n += r.n;
      was.ms += r.ms;
      r.b.forEach((x, i) => (was.b[i] = (was.b[i] ?? 0) + x));
    }
  }

  async function write(db: D1): Promise<void> {
    const rows = pending;
    pending = new Map();
    if (!rows.size) return;
    try {
      await db.batch([
        ...[...rows.values()].map((r) =>
          db
            .prepare(`INSERT INTO page_speed (hour, side, route, n, ms, ${COLS.join(", ")}) VALUES (?, ?, ?, ?, ?, ${COLS.map(() => "?").join(", ")}) ON CONFLICT (hour, side, route) DO UPDATE SET n = n + excluded.n, ms = ms + excluded.ms, ${COLS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`)
            .bind(r.hour, r.side, r.route, r.n, Math.round(r.ms), ...r.b),
        ),
        db.prepare("DELETE FROM page_speed WHERE hour < ?").bind(now() - KEEP_HOURS * HOUR),
      ]);
    } catch (e) {
      // Not lost: counted again with what comes next.
      for (const r of rows.values()) add(r);
      console.error("page speed: couldn't keep the counts:", (e as Error)?.message ?? e);
    }
  }

  return {
    record(side, route, ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      const b = COLS.map(() => 0);
      b[bucketOf(ms)] = 1;
      add({ hour: Math.floor(now() / HOUR) * HOUR, side, route: route.slice(0, 120), n: 1, ms, b });
    },
    flush(db, force = false) {
      if (flushing) return flushing;
      if (!force && now() - flushed < FLUSH_MS) return Promise.resolve();
      if (!pending.size) return Promise.resolve();
      flushed = now();
      const p = write(db).finally(() => {
        if (flushing === p) flushing = undefined;
      });
      return (flushing = p);
    },
    async view(db) {
      const kept: SpeedRow[] = [];
      if (db) {
        try {
          const { results } = await db.prepare(`SELECT hour, side, route, n, ms, ${COLS.join(", ")} FROM page_speed WHERE hour >= ?`).bind(now() - KEEP_HOURS * HOUR).all<Record<string, number | string>>();
          for (const r of results) kept.push({ hour: Number(r.hour), side: r.side as Side, route: String(r.route), n: Number(r.n), ms: Number(r.ms), b: COLS.map((c) => Number(r[c]) || 0) });
        } catch {}
      }
      return { rows: [...kept, ...[...pending.values()].map((r) => ({ ...r, b: [...r.b] }))], now: now() };
    },
  };
}

/** Time a page waited on something (the gather), for its Server-Timing header. */
export const WAITED = "speedWaited" as const;

/**
 * Counts each page's server time (a GET answered with HTML), and says it in `Server-Timing`: `app`
 * (the whole), `gather` (what it waited on the snapshot), and the route, which the page sends back
 * with its own time (POST /perf). Every other request is counted as a `call`.
 */
export function speedLog(speed: Speed): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const t0 = performance.now();
    await next();
    const took = performance.now() - t0;
    let route = "";
    try {
      route = routePath(c);
    } catch {}
    if (!routeOk(route)) route = "/*";
    const page = c.req.method === "GET" && !!c.res.headers.get("content-type")?.startsWith("text/html");
    speed.record(page ? "server" : "call", route, took);
    if (!page) return;
    const waited = Number(c.get(WAITED)) || 0;
    try {
      c.res.headers.append("Server-Timing", [`app;dur=${Math.round(took)}`, ...(waited ? [`gather;dur=${Math.round(waited)}`] : []), `route;desc=${JSON.stringify(route)}`].join(", "));
    } catch {}
  };
}
