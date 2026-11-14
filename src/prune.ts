/**
 * The logs' keep-for (#541): tables that get a row per write or run and that nothing else ends.
 * Once a day, rows older than their keep-for go. What decides anything reads far less than what's
 * kept: the day's caps read 24 hours (`auto_spend`, `pack_ai_calls`), the reviews list 30 days.
 *
 * Left alone on purpose: a run or a fix session that still holds a slot or a hold (whatever its
 * age), and `auto_runs` rows that are queued, waiting or refused (a refused row is what keeps an
 * unchanged issue from being refused again each pass).
 *
 * The time of the last prune is the `settings` row "pruned", so isolates that come and go (and a
 * local restart) prune once a day between them, not once each.
 */
import type { D1 } from "./db.ts";

const DAY = 86_400_000;
/** Days each log is kept. */
export const KEEP_DAYS = {
  /** Every write Dovre made: the Actions page shows the newest 200; a year is the audit. */
  actions: 365,
  /** Agent reviews by run: the list reads 30 days, a review's own page reads its row. */
  agent_reviews: 180,
  /** A finished unattended run's row (done or stuck). */
  auto_runs: 180,
  /** What each run cost: the day's cap reads 24 hours. */
  auto_spend: 90,
  /** An ended fix session. */
  auto_fixes: 90,
  /** What each pack's model call cost: the day's budget reads today. */
  pack_ai_calls: 90,
  /** Summaries by commit: one that's still wanted is written again. */
  summaries: 90,
} as const;

const KEY = "pruned";

/** The deletes, as of `at` (ms). Each names its own time column: ISO text or ms, as the table has it. */
export function pruneStatements(db: D1, at: number): ReturnType<D1["prepare"]>[] {
  const ms = (days: number) => at - days * DAY;
  const iso = (days: number) => new Date(ms(days)).toISOString();
  return [
    db.prepare("DELETE FROM actions WHERE at < ?").bind(iso(KEEP_DAYS.actions)),
    db.prepare("DELETE FROM agent_reviews WHERE started_at < ? AND status != 'running'").bind(ms(KEEP_DAYS.agent_reviews)),
    db.prepare("DELETE FROM auto_runs WHERE updated < ? AND state IN ('done', 'stuck')").bind(ms(KEEP_DAYS.auto_runs)),
    db.prepare("DELETE FROM auto_spend WHERE at < ?").bind(ms(KEEP_DAYS.auto_spend)),
    db.prepare("DELETE FROM auto_fixes WHERE updated < ? AND state = 'ended'").bind(ms(KEEP_DAYS.auto_fixes)),
    db.prepare("DELETE FROM pack_ai_calls WHERE at < ? AND (state IS NULL OR state != 'running')").bind(iso(KEEP_DAYS.pack_ai_calls)),
    db.prepare("DELETE FROM summaries WHERE at < ?").bind(iso(KEEP_DAYS.summaries)),
  ];
}

export type Pruner = {
  /** Prunes if a day has passed since the last one (any isolate's). Never throws; true when it pruned. */
  due(db: D1): Promise<boolean>;
};

export function createPruner(now: () => number = Date.now, log: (line: string) => void = (l) => console.error(l)): Pruner {
  /** The last prune this isolate knows of: within a day of it, nothing is read. */
  let known = 0;
  let running: Promise<boolean> | undefined;
  async function run(db: D1): Promise<boolean> {
    const t = now();
    try {
      const row = await db.prepare("SELECT at FROM settings WHERE key = ?").bind(KEY).first<{ at: string }>();
      const last = row ? Date.parse(row.at) : 0;
      if (Number.isFinite(last) && t - last < DAY) {
        known = last;
        return false;
      }
      // The mark goes with the deletes: one batch, so a prune that failed is tried again.
      await db.batch([...pruneStatements(db, t), db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, '', ?)").bind(KEY, new Date(t).toISOString())]);
      known = t;
      return true;
    } catch (e) {
      // Tried again in an hour, not on every tick.
      known = t - DAY + 3_600_000;
      log(`prune: couldn't drop old log rows: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }
  return {
    due(db) {
      if (now() - known < DAY) return Promise.resolve(false);
      running ??= run(db).finally(() => (running = undefined));
      return running;
    },
  };
}
