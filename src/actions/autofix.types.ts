/**
 * What a fix session takes and answers (#326), apart from src/actions/autofix.ts so the pack door
 * can name them without loading it. The agents pack hands them on in its `auto` share.
 */

/**
 * A fix session (#326): a sandbox run from an auto PR's head commit, whose commits go onto the PR's
 * branch. `key` is the auto run's issue; `budget` is capped at Settings' `runUsd` again.
 */
export type AutoFixAsk = { key: string; pr: string; repo: string; head: string; prompt: string; model: string; budget: number };

/** Its commits on the PR's branch now (`head`); none made (`none` says why); not ended yet (`wait`); or a failure to hand on. */
export type AutoFixLanded =
  | { head: string; commits: number; said: string; cost: number }
  | { none: string; said: string; cost: number }
  | { wait: string }
  | { error: string; cost?: number };

/** A fix session's agent turns at most (`--max-turns`). */
export const FIX_TURNS = 60;
