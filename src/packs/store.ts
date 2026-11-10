/**
 * `ctx.store.kv` (API 1.33, #476): a pack's own small state, kept in Dovre's database under the
 * pack's id, so it outlives a restart and (hosted) is the same in every isolate. JSON values by
 * key; core fills in whose they are, so a pack reads and writes only its own. Not for rows a pack
 * queries: that's a table.
 */
import type { D1 } from "../db.ts";
import type { PackKv } from "./types.ts";

/** A key: letters, digits and `_ . : / -`, 200 at most. */
const KEY = /^[\w.:/-]{1,200}$/;
/** The most one value's JSON may be, in characters. */
export const KV_VALUE_MAX = 256_000;
/** The most one pack keeps: keys, and characters of JSON in all. */
export const KV_KEYS_MAX = 1000;
export const KV_PACK_MAX = 4_000_000;

const keyOf = (key: unknown): string => {
  if (typeof key !== "string" || !KEY.test(key)) throw new TypeError(`ctx.store.kv: key ${JSON.stringify(key)?.slice(0, 80)} isn't one (letters, digits, _ . : / -, 200 at most)`);
  return key;
};
const prefixOf = (prefix: unknown): string => (prefix === undefined || prefix === "" ? "" : keyOf(prefix));
/** The value as JSON, and when it runs out; throws on what can't be kept, since that's the pack's own code. */
function rowOf(key: string, value: unknown, o: { ttlMs?: number } | undefined, now: number): { json: string; expires: number | null } {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new TypeError(`ctx.store.kv: ${key}'s value isn't JSON`);
  if (json.length > KV_VALUE_MAX) throw new RangeError(`ctx.store.kv: ${key}'s value is ${json.length} characters of JSON (${KV_VALUE_MAX} is the most)`);
  const ttl = o?.ttlMs;
  if (ttl !== undefined && !(typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0)) throw new TypeError(`ctx.store.kv: ${key}'s ttlMs isn't a time`);
  return { json, expires: ttl === undefined ? null : Math.floor(now + ttl) };
}
const full = (key: string, keys: number, size: number, adding: number) => {
  if (keys >= KV_KEYS_MAX) throw new RangeError(`ctx.store.kv: ${key} not kept: ${KV_KEYS_MAX} keys is the most a pack keeps`);
  if (size + adding > KV_PACK_MAX) throw new RangeError(`ctx.store.kv: ${key} not kept: ${KV_PACK_MAX} characters of JSON is the most a pack keeps`);
};

/** A pack's kv in the database, under its id. */
export function kvFor(id: string, db: D1, now: () => number = Date.now): PackKv {
  return {
    async get<T = unknown>(key: string) {
      const row = await db.prepare("SELECT value FROM pack_kv WHERE pack = ? AND key = ? AND (expires IS NULL OR expires > ?)").bind(id, keyOf(key), now()).first<{ value: string }>();
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    async set(key, value, o) {
      const at = now();
      const { json, expires } = rowOf(keyOf(key), value, o, at);
      await db.prepare("DELETE FROM pack_kv WHERE pack = ? AND expires IS NOT NULL AND expires <= ?").bind(id, at).run();
      const has = await db.prepare("SELECT COUNT(*) AS keys, COALESCE(SUM(length(value)), 0) AS size FROM pack_kv WHERE pack = ? AND key <> ?").bind(id, key).first<{ keys: number; size: number }>();
      full(key, has?.keys ?? 0, has?.size ?? 0, json.length);
      await db.prepare("INSERT INTO pack_kv (pack, key, value, at, expires) VALUES (?, ?, ?, ?, ?) ON CONFLICT (pack, key) DO UPDATE SET value = excluded.value, at = excluded.at, expires = excluded.expires").bind(id, key, json, at, expires).run();
    },
    async delete(key) {
      await db.prepare("DELETE FROM pack_kv WHERE pack = ? AND key = ?").bind(id, keyOf(key)).run();
    },
    async list(prefix) {
      const p = prefixOf(prefix);
      const { results } = await db.prepare("SELECT key FROM pack_kv WHERE pack = ? AND substr(key, 1, ?) = ? AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT ?").bind(id, p.length, p, now(), KV_KEYS_MAX).all<{ key: string }>();
      return results.map((r) => r.key);
    },
  };
}

/** The same in memory, with the same checks: where there's no database (a test's context). Gone with the process. */
export function kvInMemory(now: () => number = Date.now): PackKv {
  const all = new Map<string, { json: string; expires: number | null }>();
  const live = (key: string) => {
    const row = all.get(key);
    if (row && row.expires !== null && row.expires <= now()) all.delete(key);
    return all.get(key);
  };
  return {
    async get<T = unknown>(key: string) {
      const row = live(keyOf(key));
      return row ? (JSON.parse(row.json) as T) : undefined;
    },
    async set(key, value, o) {
      const row = rowOf(keyOf(key), value, o, now());
      const others = [...all.keys()].filter((k) => k !== key && live(k));
      full(key, others.length, others.reduce((n, k) => n + all.get(k)!.json.length, 0), row.json.length);
      all.set(key, row);
    },
    async delete(key) {
      all.delete(keyOf(key));
    },
    async list(prefix) {
      const p = prefixOf(prefix);
      return [...all.keys()].filter((k) => k.startsWith(p) && live(k)).sort();
    },
  };
}
