/**
 * The owner's word on a finding (#555 step 3), from the PR's page: fix it (it holds the PR back
 * at any severity, and a fix round starts), ignore it (it stops holding the PR back, and isn't
 * posted when a later review raises it again), or neither after all. The level follows on the
 * same commit, with no new review: the reviewer's level under every other cap (the row's `base`),
 * at most 2 while a finding holds the PR back.
 */
import type { D1 } from "../../../db.ts";
import { gates } from "../../../reviews/finding.ts";
import { findingsStore } from "./findings.ts";
import { type PrRow, type PrState, prsStore } from "./store.ts";

export type Decision = "force-fix" | "force-ignore" | "open";
export const DECISIONS: readonly Decision[] = ["force-fix", "force-ignore", "open"];

/** The level with `gating` findings holding the PR back (reviewer.ts `capLevel` caps it the same). */
export const levelWith = (base: number, gating: number) => (gating ? Math.min(base, 2) : base);

/** States a PR rests in after its review, from which the owner's word moves it on. A fix session already on it is left to finish. */
const RESTING: readonly PrState[] = ["yours", "merging", "waiting-ci"];
const DONE: readonly PrState[] = ["merged", "closed"];

const SAID: Record<Decision, string> = { "force-fix": "to be fixed", "force-ignore": "ignored", open: "open again" };

export type Decided = { ok: boolean; message: string; detail?: string };

/** Takes the decision, if the finding still stands on a PR still in the loop; then the level and, where it follows, the PR's next step. */
export async function decideFinding(d: { db: D1; now?: () => number }, o: { pr: string; id: string; to: Decision }): Promise<Decided> {
  const store = prsStore(d.db, d.now);
  const kept = findingsStore(d.db, d.now);
  const row = (await store.all()).find((r) => r.pr === o.pr);
  if (!row) return { ok: false, message: "That isn't a PR Auto review follows." };
  if (DONE.includes(row.state)) return { ok: false, message: `${row.repo}#${row.number} is ${row.state}: its findings stay as they are.` };
  const was = (await kept.of(row.pr)).find((f) => f.id === o.id);
  // My own line comment has no reviewer's report to go back to: open, the next review would take it for fixed.
  if (!was || (was.asker && o.to === "open") || !(await kept.decide(row.pr, o.id, o.to))) return { ok: false, message: "That finding isn't one to decide on any more: it's fixed, or already as you asked." };
  const gating = (await kept.of(row.pr)).filter(gates).length;
  const before = row.level;
  const level = row.base === null ? before : levelWith(row.base, gating);
  if (level !== null && level !== before) await store.relevel(row.pr, level);
  const detail = `${SAID[o.to]}: the ${was.severity} finding on ${was.path}:${was.line}`;
  return { ok: true, message: `Finding ${SAID[o.to]}.${await next(store, row, { to: o.to, before, level, gating })}`, detail };
}

/** Where the PR goes for it, as a sentence led by a space; empty when it stays where it is. */
async function next(store: ReturnType<typeof prsStore>, row: PrRow, r: { to: Decision; before: number | null; level: number | null; gating: number }): Promise<string> {
  // I said fix it: a round for it, past the rounds' limit too, as for my comment. What one PR may cost still holds (fix.ts).
  if (r.to === "force-fix" && RESTING.includes(row.state) && row.head) {
    const moved = await store.move(row.pr, row.state, "fixing", { round: row.round + 1, why: `Round ${row.round + 1}: a fix session for a finding you said to fix.` });
    return moved ? ` Fix round ${row.round + 1} starts for it.` : "";
  }
  // Nothing holds it back now and that takes it to 5: the checks before a merge decide the rest (merge.ts).
  const unstarted = row.state === "fixing" && !row.fix;
  if (!r.gating && r.level !== null && r.level >= 5 && (r.before ?? 0) < 5 && (row.state === "yours" || unstarted)) {
    const moved = await store.move(row.pr, row.state, "merging", { why: "Level 5 now that nothing holds it back. Merging it once the checks before a merge pass." });
    return moved ? " It's at level 5 now, and goes on to the checks before a merge." : "";
  }
  return r.level !== null && r.level !== r.before ? ` It's at level ${r.level} now.` : "";
}
