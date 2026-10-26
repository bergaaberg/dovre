/**
 * Keys settings (dovre#87): how far j/k scroll, and which groups of shortcuts are on. Kept per
 * person in the settings table (`keys:<email>` hosted, `keys` locally), read into each page's
 * frame, and handed to the page script in a meta tag (src/html.ts, src/ui/app.js.ts).
 */
import type { D1 } from "./db.ts";

export const KEY_GROUPS = [
  { id: "hints", label: "Hints", keys: "f, F" },
  { id: "moving", label: "Moving", keys: "j/k, d/u, gg, G, J/K, ]/[, o" },
  { id: "going", label: "Going to", keys: "g and a letter, H/L" },
  { id: "page", label: "This page", keys: "r, yy, g i, /, a" },
  { id: "docks", label: "Panels", keys: "B for Bino, and the packs' letters" },
] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number]["id"];

/** How far one press of j or k scrolls, in pixels. */
export const SCROLL_STEPS = [
  { px: 40, label: "Slow" },
  { px: 70, label: "Normal" },
  { px: 140, label: "Fast" },
  { px: 280, label: "Very fast" },
] as const;
export const DEFAULT_SCROLL = 70;

export type KeyPrefs = { scroll: number; off: KeyGroup[] };
export const DEFAULT_KEYS: KeyPrefs = { scroll: DEFAULT_SCROLL, off: [] };

const isGroup = (g: unknown): g is KeyGroup => KEY_GROUPS.some((k) => k.id === g);

/** Whatever was stored or posted, made safe: a step from the list, known groups only. */
export function cleanKeys(raw: unknown): KeyPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as { scroll?: unknown; off?: unknown };
  const n = Number(o.scroll);
  const scroll = SCROLL_STEPS.some((s) => s.px === n) ? n : DEFAULT_SCROLL;
  const off = [...new Set(Array.isArray(o.off) ? o.off.filter(isGroup) : [])];
  return { scroll, off };
}

export const isDefaultKeys = (k: KeyPrefs) => k.scroll === DEFAULT_SCROLL && !k.off.length;

const keyOf = (viewer: string | undefined) => (viewer ? `keys:${viewer}` : "keys");

/** Each person's choice, cached a minute per person (hosted, each isolate reads it again). */
export function keyPrefsStore(db: D1, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; prefs: KeyPrefs }>();
  return {
    async get(viewer?: string): Promise<KeyPrefs> {
      const key = keyOf(viewer);
      const hit = kept.get(key);
      if (hit && now() - hit.at < 60_000) return hit.prefs;
      const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
      let prefs = DEFAULT_KEYS;
      try {
        if (row) prefs = cleanKeys(JSON.parse(row.value));
      } catch {}
      if (kept.size > 200) kept.clear();
      kept.set(key, { at: now(), prefs });
      return prefs;
    },
    async set(viewer: string | undefined, raw: unknown): Promise<KeyPrefs> {
      const prefs = cleanKeys(raw);
      const key = keyOf(viewer);
      if (isDefaultKeys(prefs)) await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
      else await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(key, JSON.stringify(prefs), new Date(now()).toISOString()).run();
      kept.delete(key);
      return prefs;
    },
  };
}
export type KeyPrefsStore = ReturnType<typeof keyPrefsStore>;
