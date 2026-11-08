/**
 * The forge's weeks, gathered in the background and kept: history (./history.ts) every six hours,
 * kept in data/stats.json locally so a restart draws at once. Stats never waits: it draws what's
 * there and fills in over the hub when a gather ends.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ghe } from "../../../sources/ghe.ts";
import { GATHER_WEEKS, gatherHistory, type History, WEEKS } from "./history.ts";

export type HistoryView = { history?: History; historyError?: string; gathering: boolean };

export type HistoryStore = {
  view(): HistoryView;
  /**
   * Gathers again when it's due (or `force`); returns at once. `reach`: how many weeks, or days,
   * Stats shows now (Settings → Layout); kept for the background gathers, and a reach the
   * kept history doesn't have is gathered at once.
   */
  refresh(force?: boolean, reach?: { weeks?: number; days?: number }): void;
};

const EVERY = 6 * 3600e3;

export function createHistory(o: { ghe: Ghe; org: () => string; login: () => string | undefined; file?: string; now?: () => number; onChange?: () => void; gather?: typeof gatherHistory }): HistoryStore {
  const now = o.now ?? Date.now;
  const gather = o.gather ?? gatherHistory;
  let history: History | undefined;
  let historyError: string | undefined;
  let gathering = false;
  if (o.file) {
    try {
      const v = JSON.parse(readFileSync(o.file, "utf8"));
      if (v && typeof v.at === "number" && Array.isArray(v.mine)) history = v as History;
    } catch {}
  }
  // What a gather reaches back: as far as the kept one did, until the page says otherwise.
  let want = GATHER_WEEKS(history?.weeks);
  let wantDays = history?.days ?? 0;
  const keep = () => {
    if (!o.file || !history) return;
    try {
      writeFileSync(o.file + ".tmp", JSON.stringify(history));
      renameSync(o.file + ".tmp", o.file);
    } catch {}
  };
  return {
    view: () => ({ history, historyError, gathering }),
    refresh(force = false, reach?: { weeks?: number; days?: number }) {
      if (reach) {
        want = GATHER_WEEKS(reach.weeks);
        wantDays = reach.days ?? 0;
      }
      const login = o.login();
      // GitHub's quota nearly gone (#253): only a gather I asked for.
      if (!login || gathering || (!force && o.ghe.calls?.low())) return;
      if (!force && history && history.login === login && (history.weeks ?? WEEKS) >= want && (history.days ?? 0) >= wantDays && now() - history.at <= EVERY) return;
      gathering = true;
      gather(o.ghe, o.org(), login, now(), want, wantDays)
        .then(
          (h) => {
            history = h;
            historyError = undefined;
            keep();
          },
          (e) => {
            historyError = String((e as Error)?.message ?? e).slice(0, 300);
          },
        )
        .finally(() => {
          gathering = false;
          o.onChange?.();
        });
    },
  };
}
