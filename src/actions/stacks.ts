/**
 * Retargeting a stacked PR whose base PR merged: it still points at the merged branch, and moves
 * onto the repo's default branch. Re-checks GHE first (still open, still on that branch, and a PR
 * from that branch really merged), then changes the base, and logs either way.
 */
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";
import { logAction } from "./deploys.ts";

type RawPr = { state: string; base: { ref: string; repo: { default_branch: string } } };
type RawListed = { number: number; merged_at: string | null };

/** A branch name as a PR's base can have it: no spaces, no `..`, nothing that rewrites a URL. */
export const branchName = (v: unknown): string | null => (typeof v === "string" && v.length < 250 && /^[\w./-]+$/.test(v) && !v.includes("..") ? v : null);

export async function retarget(ghe: Ghe, db: D1, repo: string, number: number, from: string): Promise<{ ok: boolean; message: string }> {
  const target = `${repo}#${number}`;
  const fail = async (message: string, error?: string) => {
    if (error) await logAction(db, { kind: "pr.retarget", target, detail: from, ok: false, error });
    return { ok: false, message };
  };
  try {
    const pr = await ghe.rest<RawPr>(`/repos/${repo}/pulls/${number}`);
    if (pr.state !== "open") return fail(`${target} isn't open any more: left alone.`);
    const onto = pr.base.repo.default_branch;
    if (pr.base.ref !== from) return fail(`${target} targets ${pr.base.ref} now, not ${from}: left alone.`);
    if (from === onto) return fail(`${target} already targets ${onto}.`);
    const owner = repo.split("/")[0]!;
    const below = await ghe.rest<RawListed[]>(`/repos/${repo}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${from}`)}&per_page=10`);
    const merged = below.find((p) => p.merged_at);
    if (!merged) return fail(`No PR from ${from} has merged: ${target} stays on it.`);
    await ghe.rest(`/repos/${repo}/pulls/${number}`, { method: "PATCH", body: { base: onto } });
    await logAction(db, { kind: "pr.retarget", target, detail: `${from} → ${onto} (#${merged.number} merged)`, ok: true });
    return { ok: true, message: `Retargeted ${target} onto ${onto}.` };
  } catch (e) {
    const error = String((e as Error).message ?? e);
    return fail(`Couldn't retarget ${target}: ${error}`, error);
  }
}
