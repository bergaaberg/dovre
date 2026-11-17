/**
 * Today, arranged (#94): what Bino's layout card works on. What can be arranged now (Today's cards,
 * the phone's tabs, Stats' panels, as Settings → Layout shows them), a proposal applied to it, and
 * the Layout form fields that say the result. Nothing here writes: the card's press posts those
 * fields to /settings/layout, the layout's own route (src/routes/settings.ts `arrange`).
 *
 * A proposal names ids; only those here now count, and the first mention of each wins. A part the
 * proposal leaves out stays as it is; a card it doesn't name keeps its column, after the named ones.
 */
import type { LayoutView } from "./pages/layout.ts";

export type Arrangement = Pick<LayoutView, "pages" | "tabs" | "cards" | "stats">;
type Col = LayoutView["cards"][number]["col"];
/** Where things go, by id: what the card's press puts in place, and what Undo puts back. Only the parts a proposal touches. */
export type Placement = { tabs?: string[]; cards?: Record<string, { col: Col; order: number }>; stats?: Record<string, { show: boolean; order: number }> };
/** What Bino proposes: each column's cards in order, cards to hide, the phone's tabs (hrefs), and Stats' panels to show first. */
export type Proposal = { left?: string[]; right?: string[]; off?: string[]; phone?: string[]; stats?: string[] };

const byOrder = <T extends { order: number }>(xs: T[]) => xs.map((x, i) => ({ x, i })).sort((a, b) => a.x.order - b.x.order || a.i - b.i).map(({ x }) => x);
const touchesCards = (p: Proposal) => !!(p.left || p.right || p.off);

/** `now` with the proposal applied. */
export function arranged(now: Arrangement, p: Proposal): Arrangement {
  let { cards, stats, tabs } = now;
  if (touchesCards(p)) {
    const known = new Set(now.cards.map((c) => c.id));
    const seen = new Set<string>();
    const pick = (ids: string[] = []) => ids.filter((id) => known.has(id) && !seen.has(id) && !!seen.add(id));
    const named = { left: pick(p.left), right: pick(p.right), off: pick(p.off) };
    const colOf = (c: Arrangement["cards"][number]): Col => (named.left.includes(c.id) ? "left" : named.right.includes(c.id) ? "right" : named.off.includes(c.id) ? "off" : c.col);
    const order = new Map<string, number>();
    for (const col of ["left", "right"] as const) {
      const rest = byOrder(now.cards).filter((c) => c.col === col && !seen.has(c.id)).map((c) => c.id);
      [...named[col], ...rest].forEach((id, k) => order.set(id, (k + 1) * 10));
    }
    cards = now.cards.map((c) => ({ ...c, col: colOf(c), order: order.get(c.id) ?? c.order }));
  }
  if (p.stats) {
    const known = new Set(now.stats.map((s) => s.id));
    const first = [...new Set(p.stats.filter((id) => known.has(id)))];
    if (first.length) {
      const order = new Map([...first, ...byOrder(now.stats).map((s) => s.id).filter((id) => !first.includes(id))].map((id, k) => [id, (k + 1) * 10]));
      stats = now.stats.map((s) => ({ ...s, show: first.includes(s.id) || s.show, order: order.get(s.id)! }));
    }
  }
  if (p.phone) {
    const hrefs = new Set(now.pages.map((x) => x.href));
    const t = [...new Set(p.phone.filter((h) => hrefs.has(h)))].slice(0, 3);
    if (t.length) tabs = t;
  }
  return { ...now, cards, stats, tabs };
}

/** The parts of `a` that `p` touches, as a Placement. */
export function placementOf(a: Arrangement, p: Proposal | Placement): Placement {
  const cardsToo = "cards" in p ? !!p.cards : touchesCards(p as Proposal);
  const statsToo = !!p.stats;
  const tabsToo = "tabs" in p ? !!p.tabs : !!(p as Proposal).phone;
  return {
    ...(tabsToo ? { tabs: [...a.tabs] } : {}),
    ...(cardsToo ? { cards: Object.fromEntries(a.cards.map((c) => [c.id, { col: c.col, order: c.order }])) } : {}),
    ...(statsToo ? { stats: Object.fromEntries(a.stats.map((s) => [s.id, { show: s.show, order: s.order }])) } : {}),
  };
}

/** `now` with a Placement put in, for the ids and pages still here. */
export function withPlacement(now: Arrangement, pl: Placement): Arrangement {
  const hrefs = new Set(now.pages.map((x) => x.href));
  const tabs = pl.tabs ? pl.tabs.filter((h) => hrefs.has(h)).slice(0, 3) : now.tabs;
  return {
    ...now,
    tabs,
    cards: now.cards.map((c) => (pl.cards?.[c.id] ? { ...c, ...pl.cards[c.id] } : c)),
    stats: now.stats.map((s) => (pl.stats?.[s.id] ? { ...s, ...pl.stats[s.id] } : s)),
  };
}

/** Whether `a` already has everything `pl` says (ids no longer here don't count). */
export function holds(a: Arrangement, pl: Placement): boolean {
  const want = withPlacement(a, pl);
  return JSON.stringify(placementOf(a, pl)) === JSON.stringify(placementOf(want, pl));
}

/** The Layout form's fields for the tabs, the cards and the stats of `a` (the rest of the form is the caller's). */
export function arrangementFields(a: Arrangement): [string, string][] {
  return [
    ...[0, 1, 2].map((i): [string, string] => [`tab${i + 1}`, a.tabs[i] ?? ""]),
    ...a.cards.flatMap((c): [string, string][] => [[`col:${c.id}`, c.col], [`order:${c.id}`, String(c.order)]]),
    ...a.stats.flatMap((s): [string, string][] => [[`stat:${s.id}`, s.show ? "on" : "off"], [`statorder:${s.id}`, String(s.order)]]),
  ];
}

/** Today's columns and what's hidden, by name in order: what the card shows. */
export function columnsOf(a: Arrangement): { left: string[]; right: string[]; off: string[] } {
  const of = (col: Col) => byOrder(a.cards.filter((c) => c.col === col)).map((c) => c.label);
  return { left: of("left"), right: of("right"), off: of("off") };
}

/** Stats' shown panels by name, in order. */
export const statsShown = (a: Arrangement) => byOrder(a.stats.filter((s) => s.show)).map((s) => s.label);

/** The phone's bar by name: Today, then the tabs. */
export const phoneOf = (a: Arrangement) => ["Today", ...a.tabs.map((h) => a.pages.find((p) => p.href === h)?.title ?? h)];

/** A Placement kept as JSON (a card's `was`), read strictly: anything else is none. */
export function placementFrom(raw: string): Placement | undefined {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Placement = {};
    if (Array.isArray(v.tabs)) out.tabs = v.tabs.filter((h): h is string => typeof h === "string").slice(0, 3);
    const rec = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.entries(x as Record<string, Record<string, unknown>>).filter(([, p]) => p && typeof p === "object" && typeof p.order === "number") : undefined);
    const cards = rec(v.cards)?.filter(([, p]) => p.col === "left" || p.col === "right" || p.col === "off");
    if (cards) out.cards = Object.fromEntries(cards.map(([id, p]) => [id, { col: p.col as Col, order: p.order as number }]));
    const stats = rec(v.stats)?.filter(([, p]) => typeof p.show === "boolean");
    if (stats) out.stats = Object.fromEntries(stats.map(([id, p]) => [id, { show: p.show as boolean, order: p.order as number }]));
    return out.tabs || out.cards || out.stats ? out : undefined;
  } catch {
    return undefined;
  }
}
