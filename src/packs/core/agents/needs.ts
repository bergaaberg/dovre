/**
 * Agents that need me, as the pack's needs (Today, notifications): a session waiting for a
 * permission answer rings; one idle after a reply is listed but doesn't ring (that's every turn).
 * Pure: sessions in, needs out.
 */
import type { Session } from "../../../sources/claude.ts";
import type { PackNeed } from "../../types.ts";

export function agentNeeds(live: Session[]): PackNeed[] {
  const out: PackNeed[] = [];
  for (const a of live)
    if (a.status === "idle" || a.status === "waiting")
      out.push({
        key: `${a.sessionId}:${a.status}:${a.statusSince ?? a.lastAt ?? ""}`,
        ring: a.status === "waiting" ? "agent-ask" : undefined,
        rank: a.status === "waiting" ? 0 : 1,
        at: a.statusSince ?? (Date.parse(a.lastAt ?? "") || 0),
        title: `${a.title ?? a.name ?? a.sessionId.slice(0, 8)} ${a.status === "waiting" ? `needs your OK${a.waitingFor ? `: ${a.waitingFor}` : ""}` : "is waiting for you"}`,
        line: a.summary ?? a.lastPrompt,
        href: `/agents/s/${a.sessionId}`,
        tone: "warn",
        label: "Agent",
      });
  return out;
}
