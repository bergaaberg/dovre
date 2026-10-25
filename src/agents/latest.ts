/**
 * Runs as conversations. Every reply to a session is a run of its own, so lists that show agents
 * keep only the newest run per session (an earlier one is answered by the later one). And Claude
 * Code's cost on a resumed turn is the session's total so far, not the turn's: a turn's own cost
 * is that total less the one before it in the same session. omp counts per turn already.
 * Pure: runs in, runs out.
 */
import type { Run } from "./runner.ts";

/** The newest run of each session, and every run that has no session yet; newest first. */
export function latestRuns(runs: Run[]): Run[] {
  const seen = new Set<string>();
  const out: Run[] = [];
  for (const r of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
    if (r.sessionId) {
      if (seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
    }
    out.push(r);
  }
  return out;
}

/** The run before this one in its session (or, for a fork, in the session it was copied from). */
function before(r: Run, runs: Run[]): Run | undefined {
  const sid = r.forked ? r.resumed : (r.sessionId ?? r.resumed);
  if (!sid) return undefined;
  let best: Run | undefined;
  for (const s of runs) if (s !== r && s.harness === r.harness && s.startedAt < r.startedAt && s.sessionId === sid && (!best || s.startedAt > best.startedAt)) best = s;
  return best;
}

/** What the session has cost so far, as of this run. */
export function sessionCost(r: Run, runs: Run[]): number {
  if (r.harness === "claude" || !r.sessionId) return r.cost;
  return runs.filter((s) => s.sessionId === r.sessionId && s.startedAt <= r.startedAt).reduce((n, s) => n + s.cost, 0);
}

/** What this turn cost by itself. */
export function turnCost(r: Run, runs: Run[]): number {
  if (r.harness !== "claude") return r.cost;
  const prev = before(r, runs);
  return prev && prev.cost > 0 && prev.cost <= r.cost ? r.cost - prev.cost : r.cost;
}
