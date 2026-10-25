/** Which agent run reviewed which PR, at which commit (migrations/0004_agent_reviews.sql). */
import type { D1 } from "../db.ts";
import type { HarnessId, Run } from "../agents/runner.ts";
import type { ReviewKind } from "./agent.ts";

export type AgentReview = {
  runId: string;
  kind: ReviewKind;
  pr: string;
  headSha: string;
  harness: HarnessId;
  sessionId?: string;
  status: Run["status"];
  startedAt: number;
  endedAt?: number;
  /** Its draft went to GHE (WP-A20): when, what (counts and verdict, never the text), and where. */
  posted?: { at: number; what: string; url?: string };
};

type Row = {
  run_id: string;
  kind: string;
  pr: string;
  head_sha: string;
  harness: string;
  session_id: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  posted_at?: number | null;
  posted?: string | null;
  posted_url?: string | null;
};

const of = (r: Row): AgentReview => ({
  runId: r.run_id,
  kind: r.kind === "triage" ? "triage" : "review",
  pr: r.pr,
  headSha: r.head_sha,
  harness: r.harness === "omp" ? "omp" : "claude",
  sessionId: r.session_id ?? undefined,
  status: (["running", "done", "failed", "stopped"].includes(r.status) ? r.status : "stopped") as Run["status"],
  startedAt: Number(r.started_at),
  endedAt: r.ended_at === null ? undefined : Number(r.ended_at),
  ...(r.posted_at ? { posted: { at: Number(r.posted_at), what: r.posted ?? "", url: r.posted_url ?? undefined } } : {}),
});

export async function reviewOf(db: D1, runId: string): Promise<AgentReview | undefined> {
  const row = await db.prepare("SELECT * FROM agent_reviews WHERE run_id = ?").bind(runId).first<Row>();
  return row ? of(row) : undefined;
}

export async function markPosted(db: D1, runId: string, p: { at: number; what: string; url?: string }) {
  await db.prepare("UPDATE agent_reviews SET posted_at = ?, posted = ?, posted_url = ? WHERE run_id = ?").bind(p.at, p.what, p.url ?? null, runId).run();
}

export async function recordReview(db: D1, r: AgentReview) {
  await db
    .prepare("INSERT INTO agent_reviews (run_id, kind, pr, head_sha, harness, session_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(r.runId, r.kind, r.pr, r.headSha, r.harness, r.sessionId ?? null, r.status, r.startedAt, r.endedAt ?? null)
    .run();
}

export async function updateReview(db: D1, runId: string, u: { status: Run["status"]; sessionId?: string; endedAt?: number }) {
  await db.prepare("UPDATE agent_reviews SET status = ?, session_id = COALESCE(?, session_id), ended_at = COALESCE(?, ended_at) WHERE run_id = ?").bind(u.status, u.sessionId ?? null, u.endedAt ?? null, runId).run();
}

/** The newest review of each kind per PR, from the last 30 days. */
export async function latestReviews(db: D1, now = Date.now()): Promise<Map<string, AgentReview>> {
  const rows = (await db.prepare("SELECT * FROM agent_reviews WHERE started_at > ? ORDER BY started_at DESC").bind(now - 30 * 86_400_000).all<Row>()).results;
  const out = new Map<string, AgentReview>();
  for (const r of rows.map(of)) if (!out.has(`${r.kind}:${r.pr}`)) out.set(`${r.kind}:${r.pr}`, r);
  return out;
}

/**
 * Brings stored rows up to date with the runner: a run that ended or learnt its session. A row
 * still "running" whose run this process doesn't know ended with the last server (runs are its
 * children), so it's marked stopped.
 */
export async function syncReviews(db: D1, reviews: Map<string, AgentReview>, runOf: (id: string) => Run | undefined, now = Date.now()) {
  for (const r of reviews.values()) {
    if (r.status !== "running") continue;
    const run = runOf(r.runId);
    const status = run ? run.status : "stopped";
    const sessionId = run?.sessionId ?? r.sessionId;
    if (status === r.status && sessionId === r.sessionId) continue;
    const endedAt = status === "running" ? undefined : (run?.endedAt ?? now);
    await updateReview(db, r.runId, { status, sessionId, endedAt });
    Object.assign(r, { status, sessionId, endedAt });
  }
}
