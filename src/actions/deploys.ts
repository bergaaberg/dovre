/**
 * Deciding on waiting deploys: approve or reject the newest run, or reject the superseded ones
 * behind it. Each re-checks GHE first (the run may have moved on since the page loaded) and
 * logs what it did.
 */
import type { D1 } from "../db.ts";
import { currentActor } from "../actor.ts";
import { owns } from "../owners.ts";
import { type Ghe, newestWaiting, pendingEnvs, reviewDeploy, type Run } from "../sources/ghe.ts";

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

/** A repo in the org, as "<org>/<name>": anything else is refused before it reaches a URL. */
/** `owner/repo` when its owner is one of `owners` (comma-separated, src/owners.ts); null for anything else. */
export function repoIn(owners: string, repo: unknown): string | null {
  return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.split("/").some((p) => p === "." || p === "..") && owns(owners, repo.split("/")[0]!) ? repo : null;
}

export const runId = (v: unknown) => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null);

export async function decide(ghe: Ghe, db: D1, repo: string, run: number, state: "approved" | "rejected"): Promise<{ ok: boolean; message: string }> {
  const target = `${repo} run ${run}`;
  try {
    const envs = await pendingEnvs(ghe, repo, run);
    if (!envs.length) return { ok: false, message: `${target} no longer waits for you.` };
    await reviewDeploy(ghe, repo, run, envs, state, state === "approved" ? "Approved from Dovre" : "Rejected from Dovre");
    await logAction(db, { kind: `deploy.${state}`, target, ok: true });
    return { ok: true, message: `${state === "approved" ? "Approved" : "Rejected"} ${target}.` };
  } catch (e) {
    const error = String((e as Error).message ?? e);
    await logAction(db, { kind: `deploy.${state}`, target, ok: false, error });
    return { ok: false, message: `Couldn't ${state === "approved" ? "approve" : "reject"} ${target}: ${error}` };
  }
}

type RawRun = { id: number; name: string; display_title: string; actor: { login: string }; created_at: string; html_url: string; head_sha: string; head_branch: string };

/** Rejects every waiting run of `workflow` in `repo` except the newest (a page of 100 at a time, a few rounds). */
export async function rejectSuperseded(ghe: Ghe, db: D1, repo: string, workflow: string, rounds = 5): Promise<{ ok: boolean; message: string; ids: number[] }> {
  let done = 0;
  const ids: number[] = [];
  let kept: number | undefined;
  const failed: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const raw = (await ghe.rest<{ workflow_runs: RawRun[] }>(`/repos/${repo}/actions/runs?status=waiting&per_page=100`)).workflow_runs;
    const runs: Run[] = raw.map((r) => ({ id: r.id, name: r.name, title: r.display_title, actor: r.actor.login, createdAt: r.created_at, url: r.html_url, sha: r.head_sha.slice(0, 7), headSha: r.head_sha, branch: r.head_branch }));
    const group = newestWaiting(runs).find((g) => g.top.name === workflow);
    // The newest run is never rejected here: keep the first one seen, even if a newer one arrives meanwhile.
    kept ??= group?.top.id;
    const targets = group ? [group.top, ...group.superseded].filter((r) => r.id !== kept) : [];
    if (!targets.length) break;
    let progressed = false;
    // A few at a time: one by one, twenty runs took twenty seconds.
    for (let i = 0; i < targets.length; i += 6) {
      await Promise.all(
        targets.slice(i, i + 6).map(async (r) => {
          try {
            const envs = await pendingEnvs(ghe, repo, r.id);
            if (!envs.length) return;
            await reviewDeploy(ghe, repo, r.id, envs, "rejected", `Superseded by run ${kept} (rejected from Dovre)`);
            done++;
            ids.push(r.id);
            progressed = true;
          } catch (e) {
            failed.push(`${r.id}: ${String((e as Error).message ?? e)}`);
          }
        }),
      );
    }
    if (!progressed || raw.length < 100) break;
  }
  if (!done && !failed.length) return { ok: false, message: `Nothing superseded in ${repo} · ${workflow}.`, ids };
  await logAction(db, { kind: "deploy.reject-superseded", target: `${repo} · ${workflow}`, detail: `${done} rejected, kept run ${kept}`, ok: !failed.length, error: failed.slice(0, 5).join("; ") || undefined });
  return failed.length
    ? { ok: false, message: `Rejected ${done}; ${failed.length} failed, first: ${failed[0]}`, ids }
    : { ok: true, message: `Rejected ${done} superseded runs in ${repo} · ${workflow}; kept run ${kept}.`, ids };
}
