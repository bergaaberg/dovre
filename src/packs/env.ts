/**
 * A pack's view of the instance's settings (#475). A pack's env is meant to be its own: the keys in
 * its manifest's `settings`, its `PACK_<ID>` switch, and a few shared, harmless ones. This is the
 * audit step: every key is still returned, and a read of a set key the pack didn't declare is noted
 * (once a key) for its card on the Packs page. Filtering comes after the notes have run for a while.
 *
 * A view, not a copy: a key saved on Settings shows up without a restart.
 */
import type { PackManifest } from "./types.ts";

type Vars = Record<string, string | undefined>;

/** Settings any pack may read: none is a secret. `CODE_DIR` is `ctx.codeDir` too. */
export const SHARED_ENV: readonly string[] = ["TZ_NAME", "PORT", "CODE_DIR"];

/** Noted in place of a key when a pack lists them all (a spread, `Object.keys`). */
export const EVERY_KEY = "every key";

const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The switch a pack is turned off with: `PACK_<ID>`, its id in capitals. */
export const switchKey = (id: string) => `PACK_${id.toUpperCase().replace(/-/g, "_")}`;

/** The keys a pack's env is meant to hold. */
export function ownKeys(m: PackManifest): Set<string> {
  const settings = Array.isArray(m.settings) ? m.settings : [];
  return new Set([...settings.flatMap((s) => (s && typeof s.key === "string" && KEY.test(s.key) ? [s.key] : [])), switchKey(m.id), ...SHARED_ENV]);
}

/** What packs read beyond their own keys, kept in memory: a pack's id → the keys, in the order first read. */
export type EnvReads = { note(id: string, key: string): boolean; of(id: string): string[] };

export function envReads(): EnvReads {
  const by = new Map<string, Set<string>>();
  return {
    note(id, key) {
      const set = by.get(id) ?? by.set(id, new Set()).get(id)!;
      if (set.has(key)) return false;
      set.add(key);
      return true;
    },
    of: (id) => [...(by.get(id) ?? [])],
  };
}

/**
 * The instance's settings as this pack reads them: all of them for now, with `seen(key)` called for
 * each read of a key that is set and isn't the pack's. Only names are noted, never a value.
 */
export function packEnv(m: PackManifest, all: Vars, seen: (key: string) => void): Vars {
  const own = ownKeys(m);
  // A spread lists the keys and then reads each: "every key" says it, and naming them all after it says nothing more.
  let listed = false;
  return new Proxy(all, {
    get(target, key, receiver) {
      if (!listed && typeof key === "string" && target[key] !== undefined && !own.has(key)) seen(key);
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      if (!listed) seen(EVERY_KEY);
      listed = true;
      return Reflect.ownKeys(target);
    },
  });
}
