/**
 * How I've arranged Dovre (WP-N4): the phone's tabs and their order, where each Today card sits (or
 * that it's hidden), which packs' events reach the feed, and packs hidden altogether. Kept in the
 * settings table under "layout", so it's the same hosted and here, and applies at once (no restart).
 * Unset parts keep the defaults: the tabs the menu marks, each card where its code puts it.
 */
import type { D1 } from "./db.ts";
import type { NavItem } from "./html.ts";

export type Column = "left" | "right";
export type CardPlace = { col: Column | "off"; order: number };
export type Layout = {
  /** The phone's tabs after Today, in order (hrefs, three at most). Unset: the menu's own marks; empty: no bar. */
  tabs?: string[];
  /** Today's cards by id: where each sits, or "off". */
  cards?: Record<string, CardPlace>;
  /** Packs whose events stay out of the feed. */
  feedOff?: string[];
  /** Packs hidden altogether: menu, Today, feed, search, Bino, their pages; their refresh doesn't run. */
  packsOff?: string[];
  /** Light, dark or another theme whatever the system says; unset follows the system. */
  theme?: Theme;
  /** An accent besides fjord's blue (the default), each checked in both themes (WP-N5). */
  accent?: Accent;
  /** What Bino's button shows: my avatar when a pack draws one (unset), or the assistant icon. */
  binoButton?: "icon";
};
export const THEMES = ["light", "dark", "birch", "polar", "ember"] as const;
export type Theme = (typeof THEMES)[number];
export const ACCENTS = ["heather", "glacier"] as const;
export type Accent = (typeof ACCENTS)[number];

const HREF = /^\/[\w\-/]{0,80}$/;
const ID = /^[a-z][a-z0-9-]{0,64}$/;
const ids = (v: unknown, ok: RegExp, max: number) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && ok.test(x)))].slice(0, max) : undefined);

/** Read strictly: an old or edited row can't set anything this file doesn't know. */
export function layoutOf(raw: unknown): Layout {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Layout = {};
  const tabs = ids(v.tabs, HREF, 3);
  if (tabs) out.tabs = tabs.filter((h) => h !== "/");
  if (v.cards && typeof v.cards === "object") {
    const cards: Record<string, CardPlace> = {};
    for (const [id, p] of Object.entries(v.cards as Record<string, unknown>).slice(0, 100)) {
      const place = p as { col?: unknown; order?: unknown };
      if (!ID.test(id) || !place || typeof place !== "object") continue;
      if (place.col !== "left" && place.col !== "right" && place.col !== "off") continue;
      const order = typeof place.order === "number" && Number.isFinite(place.order) ? Math.max(0, Math.min(999, Math.round(place.order))) : 100;
      cards[id] = { col: place.col, order };
    }
    out.cards = cards;
  }
  const feedOff = ids(v.feedOff, ID, 50);
  if (feedOff) out.feedOff = feedOff;
  // cratesOff: what a layout saved before WP-M4 called it.
  const packsOff = ids(v.packsOff ?? v.cratesOff, ID, 50);
  if (packsOff) out.packsOff = packsOff;
  if (THEMES.includes(v.theme as Theme)) out.theme = v.theme as Theme;
  if (ACCENTS.includes(v.accent as Accent)) out.accent = v.accent as Accent;
  if (v.binoButton === "icon") out.binoButton = "icon";
  return out;
}

/** The phone's tabs as I've set them: those hrefs marked, in my order; the rest unmarked. Unset: the menu as it is. */
export function withTabs(nav: NavItem[], tabs: string[] | undefined): NavItem[] {
  if (!tabs) return nav;
  return nav.map((p) => {
    const at = tabs.indexOf(p.href);
    return at < 0 ? (p.tab ? { ...p, tab: false } : p) : { ...p, tab: true, tabAt: at };
  });
}

/** A card on Today: its id, a name for Settings, where its code puts it, and what it draws. */
export type Slot<T> = { id: string; label: string; col: Column; order: number; render: T };

/** Today's cards in their columns, by my layout where it says, else where their code puts them. */
export function placeCards<T>(slots: Slot<T>[], cards: Layout["cards"]): Record<Column, Slot<T>[]> {
  const out: Record<Column, Slot<T>[]> = { left: [], right: [] };
  slots.forEach((s, i) => {
    const p = cards?.[s.id];
    if (p?.col === "off") return;
    out[p?.col ?? s.col].push({ ...s, order: (p?.order ?? s.order) * 1000 + i });
  });
  for (const col of [out.left, out.right]) col.sort((a, b) => a.order - b.order);
  return out;
}

/**
 * The Layout form, read against what's here: `tab1..3` hrefs from the menu, `col:<id>` and
 * `order:<id>` per card, `feed` and `pack` the ticked packs (the rest go off).
 */
export function layoutFromForm(form: Record<string, unknown>, here: { hrefs: string[]; cards: string[]; feeds: string[]; packs: string[] }): Layout {
  const one = (k: string) => (typeof form[k] === "string" ? String(form[k]) : "");
  const many = (k: string) => (Array.isArray(form[k]) ? (form[k] as unknown[]) : form[k] === undefined ? [] : [form[k]]).filter((x): x is string => typeof x === "string");
  const tabs = [...new Set(["tab1", "tab2", "tab3"].map(one).filter((h) => h !== "/" && here.hrefs.includes(h)))];
  const cards: Record<string, CardPlace> = {};
  for (const id of here.cards) {
    const col = one(`col:${id}`);
    const order = Number(one(`order:${id}`));
    if (col === "left" || col === "right" || col === "off") cards[id] = { col, order: Number.isFinite(order) && one(`order:${id}`).trim() !== "" ? Math.max(0, Math.min(999, Math.round(order))) : 100 };
  }
  const fed = new Set(many("feed"));
  const shown = new Set(many("pack"));
  return layoutOf({ tabs, cards, feedOff: here.feeds.filter((id) => !fed.has(id)), packsOff: here.packs.filter((id) => !shown.has(id)), theme: one("theme"), accent: one("accent"), binoButton: one("binoButton") });
}

/**
 * The layout from the database, kept in memory: pages read it without waiting, and it's read again
 * in the background once it's older than `ttlMs` (hosted, another isolate may have saved since).
 */
export function layoutStore(db: D1, o: { ttlMs?: number; now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 30_000;
  let kept: Layout = {};
  let at = 0;
  let reading: Promise<void> | undefined;
  const read = (): Promise<void> =>
    (reading ??= db
      .prepare("SELECT value FROM settings WHERE key = 'layout'")
      .first<{ value: string }>()
      .then((row) => {
        try {
          kept = layoutOf(JSON.parse(row?.value ?? "{}"));
        } catch {
          kept = {};
        }
        at = now();
      })
      .catch(() => {
        at = now();
      })
      .finally(() => {
        reading = undefined;
      }));
  const ready = read();
  return {
    ready,
    get(): Layout {
      if (now() - at > ttl) void read();
      return kept;
    },
    async save(l: Layout): Promise<void> {
      await reading; // A read begun before this write mustn't land after it.
      const clean = layoutOf(l);
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('layout', ?, ?)").bind(JSON.stringify(clean), new Date(now()).toISOString()).run();
      kept = clean;
      at = now();
    },
    async reset(): Promise<void> {
      await reading;
      await db.prepare("DELETE FROM settings WHERE key = 'layout'").run();
      kept = {};
      at = now();
    },
  };
}
export type LayoutStore = ReturnType<typeof layoutStore>;

/** A layout that doesn't change and writes nothing (the demo). */
export function fixedLayout(fixed: Layout): LayoutStore {
  const kept = layoutOf(fixed);
  return {
    ready: Promise.resolve(),
    get: () => kept,
    save: async () => {},
    reset: async () => {},
  };
}
