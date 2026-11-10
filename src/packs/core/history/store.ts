/**
 * The forge's weeks, gathered in the background and kept: history (./history.ts) every six hours,
 * kept in data/stats.json locally, and in D1 hosted (`kept`), so a restart or a fresh isolate draws
 * at once. Stats never waits: it draws what's there and fills in over the hub when a gather ends.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { D1 } from "../../../db.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { GATHER_WEEKS, gatherHistory, type History, WEEKS } from "./history.ts";

export type HistoryView = { history?: History; historyError?: string; gathering: boolean };

export type HistoryStore = {
  view(): HistoryView;
  /**
   * Gathers again when it's due (or `force`). `reach`: how many weeks, or days, Stats shows now
   * (Settings → Layout); kept for the background gathers, and a reach the kept history doesn't
   * have is gathered at once. Resolves when that gather (or the one in flight) ends, so a caller
   * that must outlive it (hosted, the cron) can wait; a page needn't.
   */
  refresh(force?: boolean, reach?: { weeks?: number; days?: number }): Promise<void>;
};

/** Where a history is kept besides memory, read once at the start (hosted: a D1 row). */
export type HistoryKept = { load(): Promise<unknown>; save(h: History): Promise<void> };

const EVERY = 6 * 3600e3;
/** A gather this old is taken as lost (hosted, a request that ended took its fetches along), and may start again. */
const LOST = 5 * 60e3;

const historyOk = (v: unknown): v is History => !!v && typeof (v as History).at === "number" && Array.isArray((v as History).mine);

export function createHistory(o: { ghe: Ghe; org: () => string; login: () => string | undefined; file?: string; kept?: HistoryKept; now?: () => number; onChange?: () => void; gather?: typeof gatherHistory; log?: (line: string) => void }): HistoryStore {
  const now = o.now ?? Date.now;
  const gather = o.gather ?? gatherHistory;
  const log = o.log ?? ((l: string) => console.error(l));
  let history: History | undefined;
  let historyError: string | undefined;
  /** When the gather in flight started, and its end. */
  let gathering: { since: number; done: Promise<void> } | undefined;
  if (o.file) {
    try {
      const v = JSON.parse(readFileSync(o.file, "utf8"));
      if (historyOk(v)) history = v;
    } catch {}
  }
  // What a gather reaches back: as far as the kept one did, until the page says otherwise.
  let want = GATHER_WEEKS(history?.weeks);
  let wantDays = history?.days ?? 0;
  // The kept one, read once; a gather it would make needless waits on it.
  const loaded: Promise<void> | undefined = o.kept
    ? o.kept.load().then(
        (v) => {
          if (!historyOk(v) || (history && history.at >= v.at)) return;
          history = v;
          want = Math.max(want, GATHER_WEEKS(v.weeks));
          wantDays = Math.max(wantDays, v.days ?? 0);
          o.onChange?.();
        },
        (e) => log(`history: couldn't read the kept one: ${(e as Error)?.message ?? e}`),
      )
    : undefined;
  const keep = async () => {
    if (!history) return;
    if (o.kept) await o.kept.save(history).catch((e) => log(`history: couldn't keep it: ${(e as Error)?.message ?? e}`));
    if (!o.file) return;
    try {
      writeFileSync(o.file + ".tmp", JSON.stringify(history));
      renameSync(o.file + ".tmp", o.file);
    } catch {}
  };
  const start = (force: boolean): Promise<void> => {
    const login = o.login();
    // GitHub's quota nearly gone (#253): only a gather I asked for.
    if (!login || (!force && o.ghe.calls?.low())) return Promise.resolve();
    if (gathering && now() - gathering.since < LOST) return gathering.done;
    if (!force && history && history.login === login && (history.weeks ?? WEEKS) >= want && (history.days ?? 0) >= wantDays && now() - history.at <= EVERY) return Promise.resolve();
    const mine: { since: number; done: Promise<void> } = { since: now(), done: Promise.resolve() };
    gathering = mine;
    mine.done = gather(o.ghe, o.org(), login, now(), want, wantDays)
      .then(
        async (h) => {
          history = h;
          historyError = undefined;
          await keep();
        },
        (e) => {
          historyError = String((e as Error)?.message ?? e).slice(0, 300);
        },
      )
      .finally(() => {
        if (gathering === mine) gathering = undefined;
        o.onChange?.();
      });
    return mine.done;
  };
  return {
    view: () => ({ history, historyError, gathering: !!gathering && now() - gathering.since < LOST }),
    refresh(force = false, reach?: { weeks?: number; days?: number }) {
      if (reach) {
        want = GATHER_WEEKS(reach.weeks);
        wantDays = reach.days ?? 0;
      }
      return loaded ? loaded.then(() => start(force)) : start(force);
    },
  };
}

/** A history kept in D1 (the `settings` row "history"), for hosted: a fresh isolate draws the last one. */
export function d1HistoryKept(db: D1): HistoryKept {
  const KEY = "history";
  return {
    async load() {
      const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>();
      return row ? JSON.parse(row.value) : undefined;
    },
    async save(h) {
      const text = JSON.stringify(h);
      // D1 rows top out at 2 MB; one bigger isn't kept (the next isolate gathers).
      if (text.length > 1_500_000) throw new Error(`${text.length} bytes, too big to keep`);
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(KEY, text, new Date(h.at).toISOString()).run();
    },
  };
}
