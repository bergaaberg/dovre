/**
 * What the agents pack offers Ctrl K search: its pages, and its sessions, runs started here and
 * worktrees as rows in search's own groups (`kind`: agents, code), and "Start an agent" under Do
 * (`kind`: actions). Pure: sessions, runs, worktrees in.
 */
import type { Run } from "../../../agents/runner.ts";
import type { Worktree } from "../../../sources/worktrees.ts";
import type { Page } from "../../../search/search.ts";
import type { Session } from "../../../sources/claude.ts";
import type { FindItem } from "../../types.ts";

const line = (t: unknown, n = 120) => String(t ?? "").split("\n")[0]!.trim().slice(0, n);

export function agentPages(hosted: boolean): Page[] {
  return [
    { title: "Agents", href: "/agents", icon: "✦", about: "Sessions in terminals and here", also: ["sessions", "claude", "omp", "copilot", "ai", "clear"] },
    { title: "New agent session", href: "/agents/new", icon: "✦", about: "Start Claude Code or omp", also: ["start", "agent", "session"] },
    ...(hosted ? [] : [{ title: "Worktrees", href: "/worktrees", icon: "⑂", about: "Worktrees beside their repos", also: ["branches", "checkouts"] }]),
  ];
}

/** Sessions (live and ended), runs here whose session isn't listed yet, and worktrees. */
export function agentFinds(sessions: { live: Session[]; recent: Session[] }, runs: Run[], worktrees: Worktree[]): FindItem[] {
  const all = [...sessions.live, ...sessions.recent];
  const seen = new Set(all.map((x) => x.sessionId));
  return [
    { kind: "actions", icon: "✦", title: "Start an agent", href: "/agents/new", also: ["new session", "agent", "claude", "omp"] },
    ...all.map((a): FindItem => ({
      kind: "agents",
      icon: "✦",
      title: line(a.title ?? a.name ?? a.lastPrompt ?? a.sessionId.slice(0, 8)),
      sub: `${a.repo ?? ""}${a.live ? (a.status === "busy" ? " · working" : a.status === "waiting" ? " · needs your OK" : " · waiting for you") : " · ended"}`,
      href: `/agents/s/${a.sessionId}`,
      also: [a.repo ?? "", a.branch ?? "", a.name ?? "", line(a.lastPrompt, 100)],
    })),
    ...runs
      .filter((r) => !r.sessionId || !seen.has(r.sessionId))
      .map((r): FindItem => ({ kind: "agents", icon: "✦", title: line(r.prompt), sub: `${r.repo} · ${r.status === "running" ? "working here" : r.status}`, href: r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.id}`, also: [r.repo] })),
    ...worktrees.map((w): FindItem => ({ kind: "code", icon: "⑂", title: w.name, sub: `worktree of ${w.main}${w.branch ? ` · ${w.branch}` : ""}`, href: `/code/${encodeURIComponent(w.name)}`, also: [w.main, w.branch ?? ""] })),
  ];
}
