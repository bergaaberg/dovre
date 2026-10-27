/**
 * The Stats page's numbers, gathered in the background and kept: forge history (src/stats/history.ts)
 * every six hours, kept in data/stats.json so a restart draws at once; agent spend
 * (src/stats/spend.ts) read again when the page asks and it's older than ten minutes. The page
 * never waits: it draws what's there and fills in over the hub when a gather ends.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ghe } from "../sources/ghe.ts";
import { GATHER_WEEKS, gatherHistory, type History, WEEKS } from "./history.ts";
import type { Spend, SpendDay } from "./spend.ts";

export type StatsView = { history?: History; historyError?: string; gathering: boolean; spend?: SpendDay[]; spendAt?: number; /** Agent spend is read here (false: hosted, no transcripts); unset counts as yes. */ spends?: boolean };

export type Stats = {
  view(): StatsView;
  /**
   * Gathers again when it's due (or `force`); returns at once. `reach`: how many weeks, or days,
   * Stats shows now (Settings → Layout); kept for the background gathers, and a reach the
   * kept history doesn't have is gathered at once.
   */
  refresh(force?: boolean, reach?: { weeks?: number; days?: number }): void;
};

const EVERY = 6 * 3600e3;

export function createStats(o: { ghe: Ghe; org: string; login: () => string | undefined; /** The forge gathers stats (default yes): when not, refresh reads only spend. */ github?: () => boolean; spend?: Spend; file?: string; now?: () => number; onChange?: () => void; gather?: typeof gatherHistory }): Stats {
  const now = o.now ?? Date.now;
  const gather = o.gather ?? gatherHistory;
  let history: History | undefined;
  let historyError: string | undefined;
  let gathering = false;
  let spend: SpendDay[] | undefined;
  let spendAt = 0;
  let reading = false;
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
    view: () => ({ history, historyError, gathering, spend, spendAt, spends: !!o.spend }),
    refresh(force = false, reach?: { weeks?: number; days?: number }) {
      if (reach) {
        want = GATHER_WEEKS(reach.weeks);
        wantDays = reach.days ?? 0;
      }
      const login = o.login();
      if (login && (o.github?.() ?? true) && !gathering && (force || !history || history.login !== login || (history.weeks ?? WEEKS) < want || (history.days ?? 0) < wantDays || now() - history.at > EVERY)) {
        gathering = true;
        gather(o.ghe, o.org, login, now(), want, wantDays).then(
          (h) => {
            history = h;
            historyError = undefined;
            keep();
          },
          (e) => {
            historyError = String((e as Error)?.message ?? e).slice(0, 300);
          },
        ).finally(() => {
          gathering = false;
          o.onChange?.();
        });
      }
      if (o.spend && !reading && (force || now() - spendAt > 10 * 60e3)) {
        reading = true;
        o.spend.days().then(
          (d) => {
            spend = d;
            spendAt = now();
          },
          () => {},
        ).finally(() => {
          reading = false;
          o.onChange?.();
        });
      }
    },
  };
}
