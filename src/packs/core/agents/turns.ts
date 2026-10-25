/**
 * Agent turns as news (PLAN WP-H9d4): a turn started here that just ended rings when it stopped
 * on a tool it was refused ("agent-ask"), or when a long one finished or failed ("agent-done").
 * An ordinary reply doesn't ring. And how many agents work and wait, for the avatar. Pure.
 */
import type { Run } from "../../../agents/runner.ts";
import type { Session } from "../../../sources/claude.ts";
import type { AvatarFeed, PackNote } from "../../types.ts";

/** What a turn that just ended rings, if anything; `longMs`: how long counts as long (Settings → Notifications). */
export function turnNote(r: Run, longMs: number, now = Date.now()): PackNote | undefined {
  if (r.status === "running") return undefined;
  const denied = r.events.some((e) => e.t === "denied");
  const long = (r.endedAt ?? now) - r.startedAt >= longMs;
  const href = r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.id}`;
  const body = r.prompt.split("\n")[0]!.slice(0, 120);
  const tag = `run:${r.id}`;
  if (denied) return { kind: "agent-ask", title: `Agent needs your OK in ${r.repo}`, body, href, tag };
  if (long && r.status !== "stopped") return { kind: "agent-done", title: r.status === "done" ? `Agent finished in ${r.repo}` : `Agent failed in ${r.repo}`, body, href, tag };
  return undefined;
}

/** Follows turns' states: `ended(r)` is true once, when a turn seen running isn't any more. */
export function turnWatch(): { ended(r: Run): boolean } {
  const was = new Map<string, Run["status"]>();
  return {
    ended(r) {
      const before = was.get(r.id);
      was.set(r.id, r.status);
      return before === "running" && r.status !== "running";
    },
  };
}

const state = (x: Session) => (x.status ?? "").replace(/^probably-/, "");

/** Agents working (a turn here and its session count once) and agents waiting for an answer in a terminal. */
export function agentActivity(live: Session[], runs: Run[]): Required<Pick<AvatarFeed, "working" | "asking">> {
  const running = runs.filter((r) => r.status === "running");
  const sids = new Set(running.map((r) => r.sessionId).filter(Boolean));
  return {
    working: live.filter((x) => state(x) === "busy" && !sids.has(x.sessionId)).length + running.length,
    asking: live.filter((x) => state(x) === "waiting").length,
  };
}
