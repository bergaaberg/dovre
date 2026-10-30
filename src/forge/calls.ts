/**
 * GitHub calls, counted (#253): each call by its quota bucket (core, graphql, search) and its call
 * site (the path with names and numbers taken out), an hour at a time, and the quota each bucket
 * has left as GitHub's last answer said. Counts are kept in D1 (`forge_calls`), so every hosted
 * isolate's add up; what this one counted since its last flush is added on top. No URLs, queries
 * or bodies are kept: a site is a template like `GET /repos/:repo/actions/runs`.
 */
import type { D1 } from "../db.ts";

const HOUR = 3600_000;
/** Hours of counts kept in D1. */
const KEEP_HOURS = 7 * 24;
/** Counts reach D1 at most this often (each flush is one batch). */
const FLUSH_MS = 30_000;

export type Quota = { bucket: string; remaining: number; limit: number; /** When it fills again (ms). */ reset: number; /** When GitHub said so (ms). */ at: number };
export type CallCount = { hour: number; bucket: string; site: string; n: number };
export type CallsView = { quota: Quota[]; counts: CallCount[]; now: number };

/** A bucket is low below a tenth of its limit (500 of core's 5000), and not once it has filled again. */
export const isLow = (q: Quota | undefined, now: number) => !!q && q.reset > now && q.remaining < Math.max(1, Math.ceil(q.limit / 10));

/** Added to a call site when GitHub answered 304 Not Modified, which costs no quota. */
export const NOT_MODIFIED = " (304)";

/** The call site of a REST path: names, numbers, refs and file paths taken out, the query dropped. */
export function siteOf(method: string, path: string): string {
  const p = (path.split("?")[0] ?? "")
    .replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/:repo")
    .replace(/^\/(users|orgs)\/[^/]+/, "/$1/:owner")
    .replace(/\/events\/orgs\/[^/]+$/, "/events/orgs/:owner")
    .replace(/\/contents(\/.*)?$/, (_m, rest) => (rest ? "/contents/:path" : "/contents"))
    .replace(/\/compare\/.*$/, "/compare/:range")
    .replace(/\/git\/(refs?)\/.+$/, "/git/$1/:ref")
    .replace(/\/(labels|assignees)\/[^/]+$/, "/$1/:name")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
  return `${method.toUpperCase()} ${p}`;
}

/** A GraphQL query's call site: its first field, as `alias:field` with numbers off the alias (`r:repository`). */
export function graphqlSiteOf(query: string): string {
  const m = /\{\s*(\w+)\s*(?::\s*(\w+))?/.exec(query);
  if (!m) return "graphql";
  const first = m[2] ? `${m[1]!.replace(/\d+$/, "")}:${m[2]}` : m[1]!;
  return `graphql ${first}`;
}

/** The bucket GitHub named (`x-ratelimit-resource`), else the one the path is in. */
const bucketOf = (headers: Headers | undefined, site: string) =>
  headers?.get("x-ratelimit-resource")?.trim().toLowerCase().slice(0, 32) || (site.startsWith("graphql") ? "graphql" : site.startsWith("GET /search/") ? "search" : "core");

function quotaOf(headers: Headers | undefined, bucket: string, at: number): Quota | undefined {
  const num = (k: string) => {
    const v = headers?.get(k);
    const n = v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const remaining = num("x-ratelimit-remaining");
  const limit = num("x-ratelimit-limit");
  const reset = num("x-ratelimit-reset");
  if (remaining === undefined || limit === undefined || reset === undefined) return undefined;
  return { bucket, remaining, limit, reset: reset * 1000, at };
}

export type Calls = {
  /** One call made: its site, and the answer's headers (where the quota is). */
  record(site: string, headers?: Headers): void;
  /** Each bucket's quota as the last answer here said. */
  quota(): Quota[];
  /** Core or GraphQL is low: skip what can wait. */
  low(): boolean;
  /** Writes what was counted since the last flush; `force`, even if one went out lately. Never throws. */
  flush(db: D1, force?: boolean): Promise<void>;
  /** The counts and quota there are: D1's (every isolate's) and this one's not yet flushed. */
  view(db?: D1): Promise<CallsView>;
};

export function createCalls(now: () => number = Date.now): Calls {
  const quotas = new Map<string, Quota>();
  /** Counted and not yet in D1: `hour bucket site` → n. */
  let pending = new Map<string, CallCount>();
  let fresh = new Set<string>();
  let flushed = 0;
  let flushing: Promise<void> | undefined;

  const pendingCounts = () => [...pending.values()];

  async function write(db: D1): Promise<void> {
    const rows = pending;
    const qs = [...fresh].map((b) => quotas.get(b)!).filter(Boolean);
    pending = new Map();
    fresh = new Set();
    if (!rows.size && !qs.length) return;
    try {
      await db.batch([
        ...[...rows.values()].map((r) =>
          db.prepare("INSERT INTO forge_calls (hour, bucket, site, n) VALUES (?, ?, ?, ?) ON CONFLICT (hour, bucket, site) DO UPDATE SET n = n + excluded.n").bind(r.hour, r.bucket, r.site, r.n),
        ),
        ...qs.map((q) =>
          db
            .prepare("INSERT INTO forge_quota (bucket, remaining, lim, reset, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bucket) DO UPDATE SET remaining = excluded.remaining, lim = excluded.lim, reset = excluded.reset, at = excluded.at WHERE excluded.at >= forge_quota.at")
            .bind(q.bucket, q.remaining, q.limit, q.reset, q.at),
        ),
        db.prepare("DELETE FROM forge_calls WHERE hour < ?").bind(now() - KEEP_HOURS * HOUR),
      ]);
    } catch (e) {
      // Not lost: counted again with what comes next.
      for (const r of rows.values()) add(r);
      for (const q of qs) fresh.add(q.bucket);
      console.error("forge calls: couldn't keep the counts:", (e as Error)?.message ?? e);
    }
  }

  function add(r: CallCount) {
    const k = `${r.hour} ${r.bucket} ${r.site}`;
    const was = pending.get(k);
    if (was) was.n += r.n;
    else pending.set(k, { ...r });
  }

  return {
    record(site, headers) {
      const at = now();
      const bucket = bucketOf(headers, site);
      // A 304 still says how much quota is left, but it's counted apart: it didn't spend any.
      add({ hour: Math.floor(at / HOUR) * HOUR, bucket: site.endsWith(NOT_MODIFIED) ? "not modified" : bucket, site: site.slice(0, 160), n: 1 });
      const q = quotaOf(headers, bucket, at);
      if (q) {
        quotas.set(bucket, q);
        fresh.add(bucket);
      }
    },
    quota: () => [...quotas.values()],
    low() {
      const t = now();
      return isLow(quotas.get("core"), t) || isLow(quotas.get("graphql"), t);
    },
    flush(db, force = false) {
      if (flushing) return flushing;
      if (!force && now() - flushed < FLUSH_MS) return Promise.resolve();
      if (!pending.size && !fresh.size) return Promise.resolve();
      flushed = now();
      const p = write(db).finally(() => {
        if (flushing === p) flushing = undefined;
      });
      flushing = p;
      return p;
    },
    async view(db) {
      const t = now();
      const counts = new Map<string, CallCount>();
      const quota = new Map<string, Quota>();
      if (db) {
        try {
          const c = await db.prepare("SELECT hour, bucket, site, n FROM forge_calls WHERE hour >= ?").bind(t - 24 * HOUR).all<CallCount>();
          for (const r of c.results ?? []) counts.set(`${r.hour} ${r.bucket} ${r.site}`, { hour: Number(r.hour), bucket: r.bucket, site: r.site, n: Number(r.n) });
          const q = await db.prepare("SELECT bucket, remaining, lim, reset, at FROM forge_quota").all<{ bucket: string; remaining: number; lim: number; reset: number; at: number }>();
          for (const r of q.results ?? []) quota.set(r.bucket, { bucket: r.bucket, remaining: Number(r.remaining), limit: Number(r.lim), reset: Number(r.reset), at: Number(r.at) });
        } catch {}
      }
      for (const r of pendingCounts()) {
        const k = `${r.hour} ${r.bucket} ${r.site}`;
        const was = counts.get(k);
        counts.set(k, was ? { ...was, n: was.n + r.n } : { ...r });
      }
      for (const q of quotas.values()) if (!quota.has(q.bucket) || quota.get(q.bucket)!.at <= q.at) quota.set(q.bucket, q);
      return { quota: [...quota.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)), counts: [...counts.values()], now: t };
    },
  };
}
