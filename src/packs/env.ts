/**
 * A pack's view of the instance's settings (#475). A pack's env is meant to be its own: the keys in
 * its manifest's `settings`, the keys a `namesKeys` setting names, its `PACK_<ID>` switch, and a few
 * shared, harmless ones. From API 1.41 that's all it holds: any other key reads as unset, and a
 * read of one that is set is noted (once a key) for the pack's card on the Packs page, so a pack
 * that lacks a setting in its manifest can be told. Until 1.41 every key came back, with the note.
 *
 * A view, not a copy: a key saved on Settings shows up without a restart. Read-only: the settings
 * are every pack's, so a pack can't set or remove one through it.
 */
import type { PackManifest } from "./types.ts";

type Vars = Record<string, string | undefined>;

/** Settings any pack may read: none is a secret. `CODE_DIR` is `ctx.codeDir` too; `U_DB` is where the database file is. */
export const SHARED_ENV: readonly string[] = ["TZ_NAME", "PORT", "CODE_DIR", "U_DB"];

const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The switch a pack is turned off with: `PACK_<ID>`, its id in capitals. */
export const switchKey = (id: string) => `PACK_${id.toUpperCase().replace(/-/g, "_")}`;

const settingsOf = (m: PackManifest) => (Array.isArray(m.settings) ? m.settings.filter((s) => s && typeof s.key === "string" && KEY.test(s.key)) : []);

/** The keys a pack's env always holds: its settings, its switch, the shared few. */
export function ownKeys(m: PackManifest): Set<string> {
  return new Set([...settingsOf(m).map((s) => s.key), switchKey(m.id), ...SHARED_ENV]);
}

/** A name a setting's value may give: a setting's key, or one in the case an app's own variables are written in. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** No more than this many names from one value. */
const MAX_NAMED = 100;

/** The names in a `namesKeys` setting's value: its entries (commas or spaces between), each up to its first `@`, `=` or `:`. */
export function namesIn(value: string | undefined): string[] {
  const names = (value ?? "").split(/[\s,]+/).map((e) => e.split(/[@=:]/, 1)[0]!).filter((n) => NAME.test(n));
  return [...new Set(names)].slice(0, MAX_NAMED);
}

/** The keys a pack's `namesKeys` settings name right now (API 1.36): read again each time, as Settings can change them. A secret setting names none. */
export function namedKeys(m: PackManifest, all: Vars): string[] {
  return [...new Set(settingsOf(m).flatMap((s) => (s.namesKeys === true && !s.secret ? namesIn(all[s.key]) : [])))];
}

/** What packs read beyond their own keys, kept in memory: a pack's id → the keys, in the order first read. */
export type EnvReads = { note(id: string, key: string): boolean; of(id: string): string[] };

/**
 * The Worker's bindings as this pack gets them (#484): the ones its manifest names
 * (`requiredBindings`, `bindings`) and no other. Another reads as missing, and `seen(name)` is
 * called when one that is there was asked for. Read-only, like `packEnv`.
 */
export function packBindings(m: PackManifest, all: Record<string, unknown>, seen: (name: string) => void): Record<string, unknown> {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : []);
  const own = new Set([...names(m.requiredBindings), ...names(m.bindings)]);
  const mine = (target: Record<string, unknown>, key: string | symbol): key is string => typeof key === "string" && own.has(key) && Object.hasOwn(target, key);
  return new Proxy(all, {
    get(target, key) {
      if (mine(target, key)) return target[key];
      if (typeof key === "string" && Object.hasOwn(target, key) && target[key] !== undefined) seen(key);
      return undefined;
    },
    has: (target, key) => mine(target, key),
    ownKeys: (target) => Object.keys(target).filter((k) => mine(target, k)),
    getOwnPropertyDescriptor: (target, key) => (mine(target, key) ? { value: target[key], writable: false, enumerable: true, configurable: true } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

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
 * The instance's settings as this pack reads them: its own keys only (API 1.41). Any other key reads
 * as unset, and `seen(key)` is called when one that is set was asked for. Only names are noted, never
 * a value. A spread or `Object.keys` lists its own keys that are set.
 */
export function packEnv(m: PackManifest, all: Vars, seen: (key: string) => void): Vars {
  const own = ownKeys(m);
  const mine = (target: Vars, key: string | symbol): key is string => typeof key === "string" && Object.hasOwn(target, key) && (own.has(key) || namedKeys(m, target).includes(key));
  return new Proxy(all, {
    get(target, key) {
      if (mine(target, key)) return target[key];
      if (typeof key === "string" && Object.hasOwn(target, key) && target[key] !== undefined) seen(key);
      return undefined;
    },
    has: (target, key) => mine(target, key),
    ownKeys: (target) => Object.keys(target).filter((k) => mine(target, k)),
    getOwnPropertyDescriptor: (target, key) => (mine(target, key) ? { value: target[key], writable: false, enumerable: true, configurable: true } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}
