/**
 * The forge's weeks, gathered in the background and kept: history (./history.ts) every six hours,
 * kept in data/stats.json locally, and in D1 hosted (`kept`), so a restart or a fresh isolate draws
 * at once. Stats never waits: it draws what's there and fills in over the hub when a gather ends.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { D1 } from "../../../db.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { GATHER_WEEKS, gatherHistory, type History, WEEKS } from "./history.ts";
import { sealText, unsealText } from "../../../seal.ts";

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
/** After a gather failed, the background waits this long to try again (#294: one failing every cron spent ~150 GitHub calls an hour). Gather again goes at once. */
const AFTER_FAIL = 30 * 60e3;

const historyOk = (v: unknown): v is History => !!v && typeof (v as History).at === "number" && Array.isArray((v as History).mine);

export function createHistory(o: { ghe: Ghe; org: () => string; login: () => string | undefined; file?: string; kept?: HistoryKept; now?: () => number; onChange?: () => void; gather?: typeof gatherHistory; log?: (line: string) => void }): HistoryStore {
  const now = o.now ?? Date.now;
  const gather = o.gather ?? gatherHistory;
  const log = o.log ?? ((l: string) => console.error(l));
  let history: History | undefined;
  let historyError: string | undefined;
  let failedAt = 0;
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
    if (!force && historyError && now() - failedAt < AFTER_FAIL) return Promise.resolve();
    if (!force && history && history.login.toLowerCase() === login.toLowerCase() && (history.weeks ?? WEEKS) >= want && (history.days ?? 0) >= wantDays && now() - history.at <= EVERY) return Promise.resolve();
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
          failedAt = now();
          log(`history: the gather failed: ${historyError}`);
        },
      )
      .finally(() => {
        if (gathering === mine) gathering = undefined;
        o.onChange?.();
      });
    return mine.done;
  };
  return {
    view: () => {
      // One kept under another login (GITHUB_USER changed, or a row written before #544) isn't this one's to show.
      const login = o.login();
      const mine = history && login && history.login.toLowerCase() !== login.toLowerCase() ? undefined : history;
      return { history: mine, historyError, gathering: !!gathering && now() - gathering.since < LOST };
    },
    refresh(force = false, reach?: { weeks?: number; days?: number }) {
      if (reach) {
        want = GATHER_WEEKS(reach.weeks);
        wantDays = reach.days ?? 0;
      }
      return loaded ? loaded.then(() => start(force)) : start(force);
    },
  };
}

/** People with a history of their own in one isolate: the oldest goes first. */
export const HISTORIES_MAX = 20;

/**
 * A history per person (#544). Hosted, a person with a snapshot of their own (src/hosted/people.ts)
 * sees their own weeks on Stats, gathered when they look and kept apart; everyone else, and the
 * cron, the instance's. One store for all showed each person whoever had looked last, and
 * gathered again every time someone else did.
 */
export function historyPerPerson(o: { /** The instance's. */ shared: HistoryStore; /** The login of the person asking, when their snapshot is their own. */ own: () => string | undefined; make: (login: string) => HistoryStore }): HistoryStore {
  const mine = new Map<string, HistoryStore>();
  const pick = (): HistoryStore => {
    const login = o.own()?.trim();
    if (!login) return o.shared;
    const key = login.toLowerCase();
    const s = mine.get(key) ?? o.make(login);
    mine.delete(key);
    mine.set(key, s);
    for (const old of mine.keys()) {
      if (mine.size <= HISTORIES_MAX) break;
      mine.delete(old);
    }
    return s;
  };
  return { view: () => pick().view(), refresh: (force, reach) => pick().refresh(force, reach) };
}

/** A person's kept history goes this long after it was last gathered. */
const PERSON_KEPT_MS = 30 * 86_400_000;

/**
 * A history kept in D1, for hosted: a fresh isolate draws the last one. The instance's is the
 * `settings` row "history"; a person's own (`login`) is "history:<login>", and each write of one
 * drops people's rows not gathered for a month.
 */
export function d1HistoryKept(db: D1, login?: string, /** Seal the row with this secret (a person's weeks, #544): a cockpit's export carries it. */ secret?: string): HistoryKept {
  const ALL = "history";
  const KEY = login?.trim() ? `${ALL}:${login.trim().toLowerCase()}` : ALL;
  return {
    async load() {
      const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>();
      if (!row) return undefined;
      // A row that doesn't open (from before it was sealed, or another key) is none: the next gather replaces it.
      const text = secret ? await unsealText(secret, KEY, row.value) : row.value;
      return text ? JSON.parse(text) : undefined;
    },
    async save(h) {
      const text = secret ? await sealText(secret, KEY, JSON.stringify(h)) : JSON.stringify(h);
      // D1 rows top out at 2 MB; one bigger isn't kept (the next isolate gathers).
      if (text.length > 1_500_000) throw new Error(`${text.length} bytes, too big to keep`);
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(KEY, text, new Date(h.at).toISOString()).run();
      if (KEY !== ALL) await db.prepare("DELETE FROM settings WHERE key LIKE ? AND at < ?").bind(`${ALL}:%`, new Date(h.at - PERSON_KEPT_MS).toISOString()).run();
    },
  };
}
