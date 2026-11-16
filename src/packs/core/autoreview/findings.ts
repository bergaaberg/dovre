/**
 * Auto review's findings (#555): one row per problem a review reported on an auto PR, in the
 * pack's own table beside its PRs. A finding's post is its line comment on the PR; the row
 * remembers which, so a fix session answers on that thread. A later review of newer commits
 * closes what was still open before it: what it raises is open now.
 */
import type { D1 } from "../../../db.ts";
import type { Side } from "../../../reviews/draft.ts";
import { FINDING_STATUSES, FINDING_TAGS, type FindingStatus, type FindingTag, type Found, SEVERITIES, type Severity } from "../../../reviews/finding.ts";

export type Finding = Found & {
  id: string;
  /** The PR's address on the forge. */
  pr: string;
  /** The fix round it was reported after (0: the first review), and the commit it was reported on. */
  round: number;
  head: string;
  status: FindingStatus;
  /** The review it was posted in, and its line comment there once known. */
  review: number | null;
  comment: number | null;
  at: number;
  updated: number;
};

export const FINDINGS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS autoreview_findings (id TEXT PRIMARY KEY, pr TEXT NOT NULL, round INTEGER NOT NULL, head TEXT NOT NULL, severity TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', path TEXT NOT NULL, start INTEGER, line INTEGER NOT NULL, side TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, fix TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', review INTEGER, comment INTEGER, at INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS autoreview_findings_pr ON autoreview_findings (pr)",
];

const made = new WeakSet<object>();
async function ensureSchema(db: D1): Promise<void> {
  if (made.has(db)) return;
  await db.batch(FINDINGS_SCHEMA.map((s) => db.prepare(s)));
  made.add(db);
}

/** In a finding's line comment (hidden when rendered): which finding the comment posts. */
const POST = /<!-- dovre:finding ([0-9a-f]{12}) -->/;
export const postMark = (id: string) => `<!-- dovre:finding ${id} -->`;
export const newFindingId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/** Which finding each of a review's comments posts, by the mark in its body: finding id to comment id. */
export function postsOf(comments: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of Array.isArray(comments) ? (comments as { id?: unknown; body?: unknown }[]) : []) {
    const id = typeof c?.body === "string" ? POST.exec(c.body)?.[1] : undefined;
    if (id && typeof c.id === "number" && Number.isInteger(c.id) && !out.has(id)) out.set(id, c.id);
  }
  return out;
}

type Raw = { id: string; pr: string; round: number; head: string; severity: string; tags: string; path: string; start: number | null; line: number; side: string; title: string; body: string; fix: string; status: string; review: number | null; comment: number | null; at: number; updated: number };

const tagsOf = (s: string): FindingTag[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((t): t is FindingTag => (FINDING_TAGS as readonly unknown[]).includes(t)) : [];
  } catch {
    return [];
  }
};

/** A row as a finding; anything the lists don't know reads as the mildest (low, open). */
const findingOf = (r: Raw): Finding => ({
  id: r.id,
  pr: r.pr,
  round: r.round,
  head: r.head,
  severity: (SEVERITIES as readonly string[]).includes(r.severity) ? (r.severity as Severity) : "low",
  tags: tagsOf(r.tags),
  path: r.path,
  line: r.line,
  ...(r.start ? { startLine: r.start } : {}),
  side: (r.side === "LEFT" ? "LEFT" : "RIGHT") as Side,
  title: r.title,
  body: r.body,
  fix: r.fix,
  status: (FINDING_STATUSES as readonly string[]).includes(r.status) ? (r.status as FindingStatus) : "open",
  review: r.review,
  comment: r.comment,
  at: r.at,
  updated: r.updated,
});

export function findingsStore(db: D1, now: () => number = Date.now) {
  return {
    /** A PR's findings, oldest first. */
    async of(pr: string): Promise<Finding[]> {
      await ensureSchema(db);
      const { results } = await db.prepare("SELECT * FROM autoreview_findings WHERE pr = ? ORDER BY at, rowid LIMIT 500").bind(pr).all<Raw>();
      return results.map(findingOf);
    },
    /**
     * What a review of `head` reported, kept as open; what was still open from reviews before it
     * is fixed now (the new review read the whole diff again and raises what's left), all at once.
     */
    async reported(pr: string, o: { round: number; head: string; review?: number }, found: (Found & { id: string })[]): Promise<void> {
      await ensureSchema(db);
      const t = now();
      await db.batch([
        db.prepare("UPDATE autoreview_findings SET status = 'fixed', updated = ? WHERE pr = ? AND status = 'open'").bind(t, pr),
        ...found.map((f) =>
          db
            .prepare("INSERT INTO autoreview_findings (id, pr, round, head, severity, tags, path, start, line, side, title, body, fix, status, review, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (id) DO NOTHING")
            .bind(f.id, pr, o.round, o.head, f.severity, JSON.stringify(f.tags), f.path, f.startLine ?? null, f.line, f.side, f.title, f.body, f.fix, o.review ?? null, t, t),
        ),
      ]);
    },
    /** Each finding's line comment, once the forge says which: only this PR's, and only where none is kept. */
    async posted(pr: string, posts: Map<string, number>): Promise<void> {
      if (!posts.size) return;
      await ensureSchema(db);
      await db.batch([...posts].map(([id, comment]) => db.prepare("UPDATE autoreview_findings SET comment = ? WHERE pr = ? AND id = ? AND comment IS NULL").bind(comment, pr, id)));
    },
  };
}
