/**
 * What Bino may know from the agents pack, under Bino's rule (src/packs/core/assistant/bino/context.ts): names and
 * states only, never a prompt, a recap or a tool result. Pure: sessions in, text out.
 */
import type { Session } from "../../../sources/claude.ts";

const one = (s: string, max = 100) => s.replace(/\s+/g, " ").trim().slice(0, max);
const titleOf = (a: Session) => one(a.title ?? a.name ?? "untitled");

/** The agents running: repo, title, state. Empty when none are. */
export function agentsForBino(live: Session[]): string {
  return live.length ? `Agents running:\n${live.slice(0, 12).map((a) => `- ${a.repo ?? "?"}: ${titleOf(a)} [${a.status ?? "?"}]`).join("\n")}` : "";
}

/** One of the pack's pages as Bino hears it (src/packs/core/assistant/bino/view.ts). */
export function aboutAgentPage(path: string, sessions: { live: Session[]; recent: Session[] }): string | undefined {
  const sess = /^\/agents\/s\/([\w-]{1,80})$/.exec(path);
  if (sess) {
    const a = [...sessions.live, ...sessions.recent].find((x) => x.sessionId === sess[1]);
    if (!a) return "an agent session's page.";
    return `an agent session: «${one(a.title ?? a.name ?? "untitled", 120)}»${a.repo ? ` in ${a.repo}` : ""}${a.branch ? ` on ${one(a.branch, 80)}` : ""}${a.status ? `, ${a.status}` : ""}.`;
  }
  if (path === "/agents/new") return "the New agent session page.";
  if (path === "/agents") return "the Agents page.";
  if (path === "/worktrees") return "the Worktrees page.";
  return undefined;
}
