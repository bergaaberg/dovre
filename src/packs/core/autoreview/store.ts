/**
 * Auto review's own table in Dovre's database (#326): one row per auto PR, made idempotently on
 * first use and prefixed with the pack's id, so the pack needs no core migration. A row moves
 * only from the state it was seen in, as auto runs' rows do.
 */
import type { D1 } from "../../../db.ts";

export type PrState = "reviewing" | "fixing" | "waiting-ci" | "merging" | "merged" | "closed" | "yours";

/** One round's level, on the commit it reviewed. */
export type LevelAt = { round: number; head: string; level: number; at: number };

export type PrRow = {
  /** The PR's address on the forge. */
  pr: string;
  repo: string;
  number: number;
  /** The auto run's issue key (owner/repo#n, lowercase). */
  issue: string;
  /** The auto run that wrote it, and its model once known: the reviewer's must differ. */
  run: string | null;
  author: string | null;
  round: number;
  /** The head commit last reviewed, and the review posted on it (its comments are what a fix session answers). */
  head: string | null;
  review: number | null;
  /** The fix session working on it now (its run on the agents pack's machine), while fixing. */
  fix: string | null;
  /** The level now, 1 to 5; null before the first review. */
  level: number | null;
  /** Every round's level, oldest first. */
  levels: LevelAt[];
  /** What review and fix rounds have cost, in dollars. */
  cost: number;
  state: PrState;
  /** Why it's in that state, for me. */
  why: string | null;
  /** Owners' words on the PR up to this time (ms) are taken in: by a fix round, or by its being handed to me. */
  heard: number;
  /** When a pass took it to review (one at a time across isolates); null when none has it. */
  claim: number | null;
  at: number;
  updated: number;
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS autoreview_prs (pr TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, issue TEXT NOT NULL, run TEXT, author TEXT, round INTEGER NOT NULL DEFAULT 0, head TEXT, review INTEGER, fix TEXT, level INTEGER, levels TEXT NOT NULL DEFAULT '[]', cost REAL NOT NULL DEFAULT 0, state TEXT NOT NULL, why TEXT, claim INTEGER, heard INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS autoreview_prs_state ON autoreview_prs (state)",
];

const made = new WeakSet<object>();

/** Makes the table once per database handle. */
export async function ensureSchema(db: D1): Promise<void> {
  if (made.has(db)) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  // A table made before `heard` (#326 step 6) gains it; one that has it says so, and that's fine.
  await db.prepare("ALTER TABLE autoreview_prs ADD COLUMN heard INTEGER NOT NULL DEFAULT 0").run().catch(() => {});
  made.add(db);
}

/** owner/repo and the number from a PR's address (https://host/owner/repo/pull/7). */
export function prOf(url: string): { repo: string; number: number } | undefined {
  const m = /^https:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}

type Raw = Omit<PrRow, "levels"> & { levels: string };

const levelsOf = (s: string): LevelAt[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as LevelAt[]).filter((x) => x && Number.isInteger(x.level)) : [];
  } catch {
    return [];
  }
};

export function prsStore(db: D1, now: () => number = Date.now) {
  return {
    async all(): Promise<PrRow[]> {
      await ensureSchema(db);
      const { results } = await db.prepare("SELECT * FROM autoreview_prs ORDER BY at DESC LIMIT 200").all<Raw>();
      return results.map((r) => ({ ...r, levels: levelsOf(r.levels) }));
    },
    /** A new auto PR, waiting for its first review; one already kept stays as it is. False when it was. */
    async add(r: { pr: string; issue: string; run?: string | null }): Promise<boolean> {
      const at = prOf(r.pr);
      if (!at) return false;
      await ensureSchema(db);
      const t = now();
      const res = await db
        .prepare("INSERT INTO autoreview_prs (pr, repo, number, issue, run, state, heard, at, updated) VALUES (?, ?, ?, ?, ?, 'reviewing', ?, ?, ?) ON CONFLICT (pr) DO NOTHING")
        .bind(r.pr, at.repo, at.number, r.issue, r.run ?? null, t, t, t)
        .run();
      return Number(res.meta?.changes ?? 0) === 1;
    },
    /** A round's level on `head`: kept as the level now and added to the history, only from the state it was seen in. */
    async level(pr: string, from: PrState, l: { head: string; level: number; cost?: number; review?: number }): Promise<boolean> {
      await ensureSchema(db);
      const row = await db.prepare("SELECT round, levels FROM autoreview_prs WHERE pr = ? AND state = ?").bind(pr, from).first<{ round: number; levels: string }>();
      if (!row) return false;
      const level = Math.min(5, Math.max(1, Math.trunc(l.level)));
      const levels = [...levelsOf(row.levels), { round: row.round, head: l.head, level, at: now() }];
      const res = await db
        .prepare("UPDATE autoreview_prs SET head = ?, review = ?, level = ?, levels = ?, cost = cost + ?, claim = NULL, updated = ? WHERE pr = ? AND state = ? AND round = ?")
        .bind(l.head, l.review ?? null, level, JSON.stringify(levels), l.cost ?? 0, now(), pr, from, row.round)
        .run();
      return Number(res.meta?.changes ?? 0) === 1;
    },
    /**
     * Takes a row in `from` to review, unless another pass has it (a claim newer than `staleMs`):
     * false when it does. `level`, `move` and `release` let it go.
     */
    async claim(pr: string, from: PrState, staleMs: number): Promise<boolean> {
      await ensureSchema(db);
      const t = now();
      const res = await db.prepare("UPDATE autoreview_prs SET claim = ? WHERE pr = ? AND state = ? AND (claim IS NULL OR claim < ?)").bind(t, pr, from, t - staleMs).run();
      return Number(res.meta?.changes ?? 0) === 1;
    },
    /** Lets a claim go, adding what the pass cost (a review that didn't post still cost it) and why it's where it is. */
    async release(pr: string, o: { cost?: number; why?: string | null } = {}): Promise<void> {
      await ensureSchema(db);
      await db.prepare("UPDATE autoreview_prs SET claim = NULL, cost = cost + ?, why = COALESCE(?, why), updated = ? WHERE pr = ?").bind(o.cost ?? 0, o.why ?? null, now(), pr).run();
    },
    /** Owners' words up to `at` are in a fix round now; never moves back. */
    async heard(pr: string, at: number): Promise<void> {
      await ensureSchema(db);
      await db.prepare("UPDATE autoreview_prs SET heard = MAX(heard, ?) WHERE pr = ?").bind(at, pr).run();
    },
    /** The author's model, once its run says. */
    async author(pr: string, model: string): Promise<void> {
      await ensureSchema(db);
      await db.prepare("UPDATE autoreview_prs SET author = ? WHERE pr = ? AND author IS NULL").bind(model, pr).run();
    },
    /** The fix session started on it, while it's fixing. */
    async fixing(pr: string, run: string): Promise<boolean> {
      await ensureSchema(db);
      const res = await db.prepare("UPDATE autoreview_prs SET fix = ?, updated = ? WHERE pr = ? AND state = 'fixing' AND fix IS NULL").bind(run, now(), pr).run();
      return Number(res.meta?.changes ?? 0) === 1;
    },
    /**
     * Moves a row on, only from the state it was seen in: false when another pass moved it first.
     * Its fix session is let go (a row fixing has one only while it stays fixing); `cost` is added.
     * Handed to me, what owners said so far is taken in: only what's said after starts a round.
     */
    async move(pr: string, from: PrState, to: PrState, set: { why?: string | null; round?: number; cost?: number } = {}): Promise<boolean> {
      await ensureSchema(db);
      const res = await db
        .prepare("UPDATE autoreview_prs SET state = ?, why = ?, round = COALESCE(?, round), cost = cost + ?, fix = NULL, claim = NULL, heard = CASE WHEN ? = 'yours' THEN MAX(heard, ?) ELSE heard END, updated = ? WHERE pr = ? AND state = ?")
        .bind(to, set.why ?? null, set.round ?? null, set.cost ?? 0, to, now(), now(), pr, from)
        .run();
      return Number(res.meta?.changes ?? 0) === 1;
    },
  };
}
