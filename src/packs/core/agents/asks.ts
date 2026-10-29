/**
 * Agents started here that stopped on a tool they need my OK for, for the bar on every page (the
 * pack's `banner`). Per session only its newest run counts: a later turn, allowed or not, answers it.
 * Pure: runs in, what to ask out.
 */
import type { Run } from "../../../agents/runner.ts";

/** An agent started here that stopped on a tool it needs my OK for: answered from any page. */
export type AgentAsk = { sid: string; repo: string; title: string; specs: string[]; details: string[]; mode: string; model: string; effort?: string };

export function agentAsksOf(runs: Run[], hidden: (sid: string) => boolean = () => false): AgentAsk[] {
  // A later turn on the session (continued, or a fork of it) answers it.
  const answered = (r: Run) => runs.some((s) => s !== r && s.startedAt > r.startedAt && (s.sessionId === r.sessionId || s.resumed === r.sessionId));
  const out: AgentAsk[] = [];
  for (const r of runs) {
    if (r.status === "running" || !r.sessionId || hidden(r.sessionId) || answered(r)) continue;
    // A call refused though it was allowed isn't asked again: Allow wouldn't help (the session page says why).
    const denied = r.events.filter((e): e is Extract<Run["events"][number], { t: "denied" }> => e.t === "denied" && !r.allowed.includes(e.spec));
    if (!denied.length) continue;
    const specs = [...new Set(denied.map((d) => d.spec))];
    out.push({ sid: r.sessionId, repo: r.repo, title: r.prompt.split("\n")[0]!.slice(0, 100), specs, details: [...new Set(denied.map((d) => d.detail || d.spec))], mode: r.mode, model: r.model, ...(r.effort ? { effort: r.effort } : {}) });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}
