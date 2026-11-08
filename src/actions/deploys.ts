/**
 * The writes' log (the `actions` table) and the checks every write makes on what a form names: a
 * repo of the owners, a run's id. Deciding on deploys is the deploys pack's (src/packs/core/deploys/).
 */
import type { D1 } from "../db.ts";
import { currentActor } from "../actor.ts";
import { owns } from "../owners.ts";

export type Logged = { id: number; at: string; kind: string; target: string; detail: string | null; ok: number; error: string | null; actor?: string | null };

/** Logs a write, with the person whose POST it was (hosted) when there is one. */
export async function logAction(db: D1, a: { kind: string; target: string; detail?: string; ok: boolean; error?: string }) {
  await db
    .prepare("INSERT INTO actions (at, kind, target, detail, ok, error, actor) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), a.kind, a.target, a.detail ?? null, a.ok ? 1 : 0, a.error ?? null, currentActor()?.email ?? null)
    .run();
}

export async function recentActions(db: D1, limit = 20): Promise<Logged[]> {
  return (await db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").bind(limit).all<Logged>()).results;
}

/** The newest `limit` writes of one kind. */
export async function actionsOf(db: D1, kind: string, limit = 50): Promise<Logged[]> {
  return (await db.prepare("SELECT * FROM actions WHERE kind = ? ORDER BY id DESC LIMIT ?").bind(kind, limit).all<Logged>()).results;
}

/** A repo in the org, as "<org>/<name>": anything else is refused before it reaches a URL. */
/** `owner/repo` when its owner is one of `owners` (comma-separated, src/owners.ts); null for anything else. */
export function repoIn(owners: string, repo: unknown): string | null {
  return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.split("/").some((p) => p === "." || p === "..") && owns(owners, repo.split("/")[0]!) ? repo : null;
}

export const runId = (v: unknown) => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null);
