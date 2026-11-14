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
import type { PackManifest, PackSetting } from "./types.ts";

type Vars = Record<string, string | undefined>;

/** Settings any pack may read: none is a secret. `CODE_DIR` is `ctx.codeDir` too; `U_DB` is where the database file is. */
export const SHARED_ENV: readonly string[] = ["TZ_NAME", "PORT", "CODE_DIR", "U_DB"];

const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The switch a pack is turned off with: `PACK_<ID>`, its id in capitals. */
export const switchKey = (id: string) => `PACK_${id.toUpperCase().replace(/-/g, "_")}`;

const settingsOf = (m: PackManifest) => (Array.isArray(m.settings) ? m.settings.filter((s) => s && typeof s.key === "string" && KEY.test(s.key)) : []);

/** A whole number, as a setting's value holds it. */
const WHOLE = /^-?\d{1,15}$/;
const bound = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);

/**
 * What a setting says about its values (API 2.5), after the checks: its bounds when it's a number,
 * and its default when that's a value it could hold. A secret or a `namesKeys` setting has neither.
 */
export function typedOf(s: PackSetting): { number?: { min?: number; max?: number }; default?: string } {
  if (s.secret || s.namesKeys) return {};
  const choices = Array.isArray(s.choices) ? s.choices.filter((c) => c && typeof c.value === "string").map((c) => c.value) : [];
  const number = s.kind === "number" && !choices.length ? { min: bound(s.min), max: bound(s.max) } : undefined;
  const fits = (v: string) => (number ? wholeIn(number, v) : choices.length ? choices.includes(v) : true);
  const d = typeof s.default === "string" && s.default.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(s.default) ? s.default.trim() : "";
  return { number, default: d && fits(d) ? d : undefined };
}
/** Whether a value is a whole number within these bounds. */
export const wholeIn = (n: { min?: number; max?: number }, v: string) => WHOLE.test(v) && (n.min === undefined || Number(v) >= n.min) && (n.max === undefined || Number(v) <= n.max);

/** A setting's value as its pack reads it (API 2.5): a number that isn't one reads as unset, and unset reads as its default. */
export function settingValue(s: PackSetting, raw: string | undefined): string | undefined {
  const t = typedOf(s);
  if (!t.number && t.default === undefined) return raw;
  const v = raw?.trim() || undefined;
  return (v !== undefined && t.number && !wholeIn(t.number, v) ? undefined : v) ?? t.default;
}

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
  // API 2.5: a setting with a default or a number's bounds reads through them, set or not.
  const typed = new Map(settingsOf(m).filter((s) => { const t = typedOf(s); return !!t.number || t.default !== undefined; }).map((s) => [s.key, s]));
  const read = (target: Vars, key: string) => (typed.has(key) ? settingValue(typed.get(key)!, target[key]) : target[key]);
  const there = (target: Vars, key: string | symbol): key is string => mine(target, key) || (typeof key === "string" && typed.has(key) && read(target, key) !== undefined);
  return new Proxy(all, {
    get(target, key) {
      if (typeof key === "string" && typed.has(key)) return read(target, key);
      if (mine(target, key)) return target[key];
      if (typeof key === "string" && Object.hasOwn(target, key) && target[key] !== undefined) seen(key);
      return undefined;
    },
    has: (target, key) => there(target, key),
    ownKeys: (target) => [...new Set([...Object.keys(target), ...typed.keys()])].filter((k) => there(target, k)),
    getOwnPropertyDescriptor: (target, key) => (there(target, key) ? { value: read(target, key), writable: false, enumerable: true, configurable: true } : undefined),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}
