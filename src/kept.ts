/**
 * GHE answers cached by key: in memory, and (with `kept`) in a JSON file between runs, so pages
 * answer at once after a restart. The issue composer, the viewer and stacks share it.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** A cache of loads by key, kept in memory and (with `kept`) on disk; see the function below. */
export function memoize(opts: { ttlMs?: number; now?: () => number; kept?: Kept } = {}) {
  const ttl = opts.ttlMs ?? 10 * 60e3;
  const now = opts.now ?? Date.now;
  /** `last`: the newest value that loaded, drawn while a newer one loads. */
  const memo = new Map<string, { at: number; value: Promise<unknown>; last?: { at: number; value: unknown }; loading?: boolean }>();
  const loadInto = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const value = load();
    const entry = memo.get(key);
    memo.set(key, { at: now(), value, last: entry?.last, loading: true });
    value.then(
      (v) => {
        const e = memo.get(key);
        if (e?.value !== value) return;
        e.loading = false;
        e.last = { at: now(), value: v };
        opts.kept?.set(key, e.last);
      },
      () => {
        const e = memo.get(key);
        if (e?.value !== value) return;
        // A failure isn't kept: what loaded before stays, and the next call tries again.
        if (e.last) memo.set(key, { at: e.last.at, value: Promise.resolve(e.last.value), last: e.last });
        else memo.delete(key);
      },
    );
    return value;
  };
  /**
   * A value within `ttlMs` is reused. An older one (in memory, or kept on disk from an earlier
   * run) is answered at once and loaded again in the background, so a page never waits on GHE for
   * something it has seen before. `fresh`: wait for a new load (before a write, which re-checks).
   */
  return <T>(key: string, load: () => Promise<T>, o: { fresh?: boolean } = {}): Promise<T> => {
    if (o.fresh) return loadInto(key, load);
    let hit = memo.get(key);
    if (!hit) {
      const k = opts.kept?.get(key);
      if (k) memo.set(key, (hit = { at: k.at, value: Promise.resolve(k.value), last: k }));
    }
    if (!hit) return loadInto(key, load);
    if (now() - hit.at >= ttl && !hit.loading) {
      const old = hit.last;
      const next = loadInto(key, load);
      if (old) {
        next.catch(() => undefined);
        return Promise.resolve(old.value as T);
      }
      return next;
    }
    return (hit.last && hit.loading ? Promise.resolve(hit.last.value) : hit.value) as Promise<T>;
  };
}

/** Where cached GHE answers are kept between runs. */
export type Kept = { get(key: string): { at: number; value: unknown } | undefined; set(key: string, v: { at: number; value: unknown }): void };

/** A JSON file of kept answers (data/, never committed), written a moment after the last change. Older than a week is dropped. */
export function keptFile(file: string, now: () => number = Date.now): Kept {
  let all: Record<string, { at: number; value: unknown }> = {};
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (doc && typeof doc === "object") all = doc;
  } catch {}
  for (const [k, v] of Object.entries(all)) if (!v || typeof v.at !== "number" || now() - v.at > 7 * 86_400_000) delete all[k];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    get: (key) => all[key],
    set(key, v) {
      all[key] = v;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          writeFileSync(`${file}.tmp`, JSON.stringify(all));
          renameSync(`${file}.tmp`, file);
        } catch (e) {
          console.error("couldn't keep the cache:", (e as Error).message);
        }
      }, 500);
      timer.unref?.();
    },
  };
}
