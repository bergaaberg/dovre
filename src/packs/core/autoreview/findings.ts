/**
 * Auto review's findings (#555): one row per problem a review reported on an auto PR, in the
 * pack's own table beside its PRs. A finding's post is its line comment on the PR; the row
 * remembers which, so a fix session answers on that thread. A problem a later review raises
 * again stays the finding it was (finding.ts `raisedAgain`), with its status, and takes the new
 * report's words, lines and comment; what a later review doesn't raise again is fixed. One the
 * owner said to fix is fixed only when the code-quality reviewer, shown it, says so by its id: it
 * was never this review's to raise. An owner's own line comment on the diff becomes such a
 * finding (`asked`): its comment is its post, and it carries who asked.
 */
import type { D1 } from "../../../db.ts";
import type { Side } from "../../../reviews/draft.ts";
import { FINDING_STATUSES, FINDING_TAGS, type FindingStatus, type FindingTag, type Found, SEVERITIES, type Severity } from "../../../reviews/finding.ts";

export type Finding = Found & {
  id: string;
  /** The PR's address on the forge. */
  pr: string;
  /** The fix round it was last reported after (0: the first review), and the commit it was reported on then. */
  round: number;
  head: string;
  status: FindingStatus;
  /** How many reviews have raised it. */
  raised: number;
  /** The review it was posted in, and its line comment there once known. */
  review: number | null;
  comment: number | null;
  /** The owner whose line comment it is, for one they asked for; null for a reviewer's. */
  asker: string | null;
  at: number;
  updated: number;
};

export const FINDINGS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS autoreview_findings (id TEXT PRIMARY KEY, pr TEXT NOT NULL, round INTEGER NOT NULL, head TEXT NOT NULL, severity TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', path TEXT NOT NULL, start INTEGER, line INTEGER NOT NULL, side TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, fix TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', review INTEGER, comment INTEGER, raised INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS autoreview_findings_pr ON autoreview_findings (pr)",
];

const made = new WeakSet<object>();
async function ensureSchema(db: D1): Promise<void> {
  if (made.has(db)) return;
  await db.batch(FINDINGS_SCHEMA.map((s) => db.prepare(s)));
  // A table made before `raised` (#555 step 2) or `asker` gains it; one that has it says so, and that's fine.
  await db.prepare("ALTER TABLE autoreview_findings ADD COLUMN raised INTEGER NOT NULL DEFAULT 1").run().catch(() => {});
  await db.prepare("ALTER TABLE autoreview_findings ADD COLUMN asker TEXT").run().catch(() => {});
  made.add(db);
}

/** In a finding's line comment (hidden when rendered): which finding the comment posts. */
const POST = /<!-- dovre:finding ([0-9a-f]{12}) -->/;
export const postMark = (id: string) => `<!-- dovre:finding ${id} -->`;
export const newFindingId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
/** An owner's line comment's finding: its id from the comment's, so taking the comment in again is the same finding. */
export const askId = (comment: number) => comment.toString(16).padStart(12, "0").slice(-12);

/** Which finding each of a review's comments posts, by the mark in its body: finding id to comment id. */
export function postsOf(comments: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of Array.isArray(comments) ? (comments as { id?: unknown; body?: unknown }[]) : []) {
    const id = typeof c?.body === "string" ? POST.exec(c.body)?.[1] : undefined;
    if (id && typeof c.id === "number" && Number.isInteger(c.id) && !out.has(id)) out.set(id, c.id);
  }
  return out;
}

type Raw = { id: string; pr: string; round: number; head: string; severity: string; tags: string; path: string; start: number | null; line: number; side: string; title: string; body: string; fix: string; status: string; review: number | null; comment: number | null; raised: number; asker: string | null; at: number; updated: number };

/** An owner's line comment on the diff, to become a finding (owner.ts `asksOf`). `head`: the commit it was left on, if the forge says. */
export type Ask = { comment: number; by: string; at: number; path: string; line: number; startLine?: number; side: Side; text: string; head?: string };

/** An ask's title: its text's first line that says something. */
const askTitle = (text: string) => (text.split("\n").find((l) => l.trim() && !l.startsWith("```")) ?? text).replace(/\s+/g, " ").trim().slice(0, 150);

/**
 * A finding as a review reported it. `again`: it raises an earlier finding again, whose `id` it
 * carries: "posted" when it went on the PR anew, "left" when the owner had said to ignore it.
 */
export type Reported = Found & { id: string; again?: "posted" | "left" };

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
  raised: r.raised ?? 1,
  asker: r.asker ?? null,
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
     * What a review of `head` reported, all at once. A new problem is kept as open. One raised
     * again stays its earlier row and status: posted anew, it takes this report's severity, words,
     * lines and review, and waits for its new comment; left out, it only counts the review. What
     * was open before and isn't raised again is fixed: the review read the whole diff again. One
     * the owner said to fix is fixed only when it's among `fixed`: the reviewer said so of it.
     */
    async reported(pr: string, o: { round: number; head: string; review?: number; fixed?: string[] }, found: Reported[]): Promise<void> {
      await ensureSchema(db);
      const t = now();
      const again = found.filter((f) => f.again).map((f) => f.id);
      const fixed = (o.fixed ?? []).filter((id) => !again.includes(id));
      const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
      await db.batch([
        db
          .prepare(`UPDATE autoreview_findings SET status = 'fixed', updated = ? WHERE pr = ? AND (status = 'open'${fixed.length ? ` OR (status = 'force-fix' AND id IN (${marks(fixed.length)}))` : ""})${again.length ? ` AND id NOT IN (${marks(again.length)})` : ""}`)
          .bind(t, pr, ...fixed, ...again),
        ...found.map((f) =>
          f.again === "left"
            ? db.prepare("UPDATE autoreview_findings SET raised = raised + 1, updated = ? WHERE pr = ? AND id = ?").bind(t, pr, f.id)
            : f.again
              ? db
                  .prepare("UPDATE autoreview_findings SET round = ?, head = ?, severity = ?, tags = ?, path = ?, start = ?, line = ?, side = ?, title = ?, body = ?, fix = ?, review = ?, comment = NULL, raised = raised + 1, updated = ? WHERE pr = ? AND id = ?")
                  .bind(o.round, o.head, f.severity, JSON.stringify(f.tags), f.path, f.startLine ?? null, f.line, f.side, f.title, f.body, f.fix, o.review ?? null, t, pr, f.id)
              : db
                  .prepare("INSERT INTO autoreview_findings (id, pr, round, head, severity, tags, path, start, line, side, title, body, fix, status, review, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (id) DO NOTHING")
                  .bind(f.id, pr, o.round, o.head, f.severity, JSON.stringify(f.tags), f.path, f.startLine ?? null, f.line, f.side, f.title, f.body, f.fix, o.review ?? null, t, t),
        ),
      ]);
    },
    /** The findings of late, newest first: what the PRs' pages show from memory. */
    async recent(): Promise<Finding[]> {
      await ensureSchema(db);
      const { results } = await db.prepare("SELECT * FROM autoreview_findings ORDER BY updated DESC, rowid DESC LIMIT 2000").all<Raw>();
      return results.map(findingOf);
    },
    /**
     * The owner's word on a finding: fix it, ignore it, or neither after all (open). Only one a
     * review still stands by takes it; false for one that's fixed, folded away, or not this PR's.
     */
    async decide(pr: string, id: string, to: "open" | "force-fix" | "force-ignore"): Promise<boolean> {
      await ensureSchema(db);
      const res = await db.prepare("UPDATE autoreview_findings SET status = ?, updated = ? WHERE pr = ? AND id = ? AND status IN ('open', 'force-fix', 'force-ignore') AND status != ?").bind(to, now(), pr, id, to).run();
      return Number(res.meta?.changes ?? 0) === 1;
    },
    /**
     * Owners' line comments on the diff, each as a finding to fix in their words, posted by their
     * comment. Taking one in again changes nothing: it stays as it is, fixed or not.
     */
    async asked(pr: string, o: { round: number; head: string }, asks: Ask[]): Promise<void> {
      if (!asks.length) return;
      await ensureSchema(db);
      const t = now();
      await db.batch(
        asks.map((a) =>
          db
            .prepare("INSERT INTO autoreview_findings (id, pr, round, head, severity, tags, path, start, line, side, title, body, fix, status, comment, asker, at, updated) VALUES (?, ?, ?, ?, 'high', '[]', ?, ?, ?, ?, ?, ?, '', 'force-fix', ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
            .bind(askId(a.comment), pr, o.round, a.head || o.head, a.path, a.startLine ?? null, a.line, a.side, askTitle(a.text), a.text, a.comment, a.by, t, t),
        ),
      );
    },
    /** Each finding's line comment, once the forge says which: only this PR's, and only where none is kept. */
    async posted(pr: string, posts: Map<string, number>): Promise<void> {
      if (!posts.size) return;
      await ensureSchema(db);
      await db.batch([...posts].map(([id, comment]) => db.prepare("UPDATE autoreview_findings SET comment = ? WHERE pr = ? AND id = ? AND comment IS NULL").bind(comment, pr, id)));
    },
  };
}
