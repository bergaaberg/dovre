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
  /** The font for text (code stays Nordwand Mono); unset: Nordwand Mono (#183). */
  font?: Font;
  /** Text size, a step either side of the default (#183). */
  textSize?: TextSize;
  /** Line height: tighter or looser than the default (#183). */
  lineHeight?: LineHeight;
  /** What Bino's button shows: the face a pack draws, if any (unset), or the assistant icon. */
  binoButton?: "icon";
  /** Motion: unset follows the system's reduce-motion setting; "always" animates anyway (data-motion on <html>). */
  motion?: "always";
  /** Links to other sites from the installed app: the system's default browser instead of the app's own (local only, src/open-link.ts). */
  links?: "default";
  /** /stats's panels by id (core's, or `<pack>:<id>`): shown or hidden, and their order. Unset: each where its code puts it. */
  stats?: Record<string, StatPlace>;
  /** How many weeks /stats's weekly charts span (default 12). */
  statsWeeks?: StatsWeeks;
  /** /stats by day instead, over this many days. */
  statsDays?: StatsDays;
};
export type StatPlace = { show: boolean; order: number };
export const STATS_WEEKS = [4, 12, 26] as const;
export type StatsWeeks = (typeof STATS_WEEKS)[number];
export const STATS_DAYS = [14, 28] as const;
export type StatsDays = (typeof STATS_DAYS)[number];
export const THEMES = ["light", "dark", "birch", "polar", "ember"] as const;
export type Theme = (typeof THEMES)[number];
export const ACCENTS = ["heather", "glacier"] as const;
export type Accent = (typeof ACCENTS)[number];
export const FONTS = ["sans", "serif"] as const;
export type Font = (typeof FONTS)[number];
export const TEXT_SIZES = ["small", "large", "larger"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const LINE_HEIGHTS = ["tight", "loose"] as const;
export type LineHeight = (typeof LINE_HEIGHTS)[number];

const HREF = /^\/[\w\-/]{0,80}$/;
const ID = /^[a-z][a-z0-9-]{0,64}$/;
/** A stat's id: core's ("you-weekly"), or a pack's under its id ("linear:cycle"). */
const STAT = /^[a-z][a-z0-9-]{0,64}(:[a-z][a-z0-9-]{0,40})?$/;
const order = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(999, Math.round(v))) : 100);
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
  if (FONTS.includes(v.font as Font)) out.font = v.font as Font;
  if (TEXT_SIZES.includes(v.textSize as TextSize)) out.textSize = v.textSize as TextSize;
  if (LINE_HEIGHTS.includes(v.lineHeight as LineHeight)) out.lineHeight = v.lineHeight as LineHeight;
  if (v.binoButton === "icon") out.binoButton = "icon";
  if (v.motion === "always") out.motion = "always";
  if (v.links === "default") out.links = "default";
  if (v.stats && typeof v.stats === "object" && !Array.isArray(v.stats)) {
    const stats: Record<string, StatPlace> = {};
    for (const [id, p] of Object.entries(v.stats as Record<string, unknown>).slice(0, 200)) {
      const place = p as { show?: unknown; order?: unknown };
      if (!STAT.test(id) || !place || typeof place !== "object" || typeof place.show !== "boolean") continue;
      stats[id] = { show: place.show, order: order(place.order) };
    }
    out.stats = stats;
  }
  if (STATS_WEEKS.includes(v.statsWeeks as StatsWeeks)) out.statsWeeks = v.statsWeeks as StatsWeeks;
  if (STATS_DAYS.includes(v.statsDays as StatsDays)) out.statsDays = v.statsDays as StatsDays;
  return out;
}

/** /stats's panels in my order, hidden ones left out; those I haven't placed keep their code's order, after. */
export function placeStats<T extends { id: string }>(offers: T[], stats: Layout["stats"]): T[] {
  return offers
    .map((o, i) => ({ o, p: stats?.[o.id], i }))
    .filter(({ p }) => p?.show !== false)
    .sort((a, b) => (a.p?.order ?? 500 + a.i) - (b.p?.order ?? 500 + b.i) || a.i - b.i)
    .map(({ o }) => o);
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
 * `order:<id>` per card, `feed` and `pack` the ticked packs (the rest go off), `stat:<id>` (on/off)
 * and `statorder:<id>` per stat, and `statsWeeks` (a number of weeks, or of days as `14d`).
 */
export function layoutFromForm(form: Record<string, unknown>, here: { hrefs: string[]; cards: string[]; feeds: string[]; packs: string[]; /** /stats's panels on offer. */ stats?: string[] }): Layout {
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
  const stats: Record<string, StatPlace> = {};
  for (const id of here.stats ?? []) {
    const show = one(`stat:${id}`);
    const at = one(`statorder:${id}`).trim();
    if (show === "on" || show === "off") stats[id] = { show: show === "on", order: at === "" ? 100 : order(Number(at)) };
  }
  return layoutOf({ tabs, cards, feedOff: here.feeds.filter((id) => !fed.has(id)), packsOff: here.packs.filter((id) => !shown.has(id)), theme: one("theme"), accent: one("accent"), font: one("font"), textSize: one("textSize"), lineHeight: one("lineHeight"), binoButton: one("binoButton"), motion: one("motion"), links: one("links"), stats: here.stats ? stats : undefined, statsWeeks: Number(one("statsWeeks")), statsDays: Number(/^(\d+)d$/.exec(one("statsWeeks"))?.[1]) });
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
