/**
 * "Since I last looked" (#421 step 4): what happened in my apps since I last had Today open, a line
 * a pack, from the packs' feed (src/home/feed.ts packFeedOf) and their needs. No model.
 *
 * When I last looked is a visit, not a page load: Today's own live swaps fetch it again, and a
 * reload a minute later mustn't empty the card. A visit ends after an hour away (or at most 12 h
 * on), and the next one shows what came after it. The visits are kept per person in the settings
 * table (`today-seen:<email>` hosted, `today-seen` locally).
 */
import type { D1 } from "../db.ts";
import { dtf } from "../when.ts";
import { hourOf } from "../format.ts";
import type { FeedEvent } from "./feed.ts";
import type { Need } from "./needs.ts";

const MIN = 60e3;
const DAY = 24 * 60 * MIN;
/** Away this long, and the next open of Today is a new visit. */
export const VISIT_GAP = 60 * MIN;
/** A visit (a tab left open, its live swaps) lasts this long at most. */
export const VISIT_MAX = 12 * 60 * MIN;
/** Within a visit, when I'm still here is written down at most this often. */
const WRITE_EVERY = 5 * MIN;
/** The feed keeps a week: further back than that there's nothing to say. */
const FURTHEST = 7 * DAY;

/** `prev`: when the visit before this one ended; `start`, `last`: this visit's first and latest open. */
export type Visits = { prev?: number; start: number; last: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** Whatever was stored, as visits, or nothing when it isn't. */
export function visitsOf(raw: unknown): Visits | undefined {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const start = num(o.start);
  const last = num(o.last);
  if (!start || !last || last < start) return undefined;
  const prev = num(o.prev);
  return { ...(prev && prev <= start ? { prev } : {}), start, last };
}

/**
 * Opening Today now: the visits after it, whether they're worth writing, and since when the card
 * counts. The very first visit counts the day before it ("since yesterday").
 */
export function openToday(v: Visits | undefined, now: number): { visits: Visits; write: boolean; since: number } {
  const floor = (at: number) => Math.max(at, now - FURTHEST);
  if (!v || v.last > now + MIN) return { visits: { start: now, last: now }, write: true, since: floor(now - DAY) };
  if (now - v.last > VISIT_GAP || now - v.start > VISIT_MAX) return { visits: { prev: v.last, start: now, last: now }, write: true, since: floor(v.last) };
  return { visits: { ...v, last: Math.max(v.last, now) }, write: now - v.last >= WRITE_EVERY, since: floor(v.prev ?? v.start - DAY) };
}

const keyOf = (viewer: string | undefined) => (viewer ? `today-seen:${viewer}` : "today-seen");

/** Each person's visits to Today. A store that can't be read or written counts the last day. */
export function visitsStore(db: D1, now: () => number = Date.now) {
  return {
    /** Today is open for `viewer`: since when its card counts. */
    async open(viewer?: string): Promise<number> {
      const t = now();
      const key = keyOf(viewer);
      let v: Visits | undefined;
      try {
        const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
        v = row ? visitsOf(JSON.parse(row.value)) : undefined;
      } catch {
        return t - DAY;
      }
      const next = openToday(v, t);
      if (next.write) await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(key, JSON.stringify(next.visits), new Date(t).toISOString()).run().catch(() => undefined);
      return next.since;
    },
  };
}
export type VisitsStore = ReturnType<typeof visitsStore>;

/** A pack's line: what its events said, counted (most first), and how many of its needs are new. */
export type SinceRow = { id: string; name: string; href?: string; tone?: "bad" | "warn"; bits: { n: number; what: string }[]; more: number; needs: number; at: number };

/**
 * The packs' events and needs since `since`, a row a pack, the pack with the newest first. My own
 * events are left out (I know about them); so are a pack's that isn't in `packs` (not shown here).
 */
export function sinceRows(events: FeedEvent[], needs: Need[], packs: { id: string; name: string; href?: string }[], since: number, max = 3): SinceRow[] {
  const rows = new Map<string, SinceRow & { counts: Map<string, number> }>();
  const rowOf = (id: string | undefined) => {
    const p = id ? packs.find((x) => x.id === id) : undefined;
    if (!p) return undefined;
    let r = rows.get(p.id);
    if (!r) rows.set(p.id, (r = { id: p.id, name: p.name, ...(p.href ? { href: p.href } : {}), bits: [], more: 0, needs: 0, at: 0, counts: new Map() }));
    return r;
  };
  for (const e of events) {
    if (e.mine || !(e.at > since)) continue;
    const r = rowOf(e.pack);
    if (!r) continue;
    r.counts.set(e.what, (r.counts.get(e.what) ?? 0) + 1);
    r.at = Math.max(r.at, e.at);
    if (e.tone === "bad") r.tone = "bad";
    else if (e.tone === "warn" && r.tone !== "bad") r.tone = "warn";
  }
  for (const n of needs) {
    if (n.kind !== "pack" || !(n.at > since)) continue;
    const r = rowOf(n.pack);
    if (!r) continue;
    r.needs++;
    r.at = Math.max(r.at, n.at);
  }
  return [...rows.values()]
    .sort((a, b) => b.at - a.at)
    .map(({ counts, ...r }) => {
      const all = [...counts].map(([what, n]) => ({ n, what })).sort((a, b) => b.n - a.n);
      return { ...r, bits: all.slice(0, max), more: all.slice(max).reduce((s, b) => s + b.n, 0) };
    });
}

const dayOf = (at: number, zone: string) => dtf("en-CA", { timeZone: zone }).format(at);

/** Since when, for the card's head: "since 09:12", "since yesterday 18:40", "since 12 Nov". */
export function sinceLabel(since: number, now: number, zone: string): string {
  if (dayOf(since, zone) === dayOf(now, zone)) return `since ${hourOf(since, zone)}`;
  if (dayOf(since, zone) === dayOf(now - DAY, zone) || dayOf(since + DAY, zone) === dayOf(now, zone)) return `since yesterday ${hourOf(since, zone)}`;
  return `since ${dtf("en-GB", { timeZone: zone, day: "numeric", month: "short" }).format(since)}`;
}
