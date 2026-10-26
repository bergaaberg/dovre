/**
 * Writes' clicks (dovre#104): each kind of write asks twice (a Confirm) unless I set it to one click
 * on Settings. A kind with a floor of "twice" (deleting, ending things, answering an MCP server)
 * always asks. Only the clicks change: every write still re-checks, is logged, and refuses repos
 * outside REPO_OWNERS on the server, whatever the page showed.
 */
import { tryGetContext } from "hono/context-storage";
import type { D1 } from "./db.ts";

export type Clicks = "once" | "twice";
export type WriteKind = { kind: string; label: string; group: string; floor?: "twice" };

export const WRITES: WriteKind[] = [
  { kind: "deploy.approve", label: "Approve a waiting deploy", group: "Deploys" },
  { kind: "deploy.reject", label: "Reject a waiting deploy", group: "Deploys" },
  { kind: "deploy.reject-superseded", label: "Reject the superseded deploys", group: "Deploys" },
  { kind: "pr.retarget", label: "Retarget a stacked PR", group: "Pull requests" },
  { kind: "pr.combine-dependabot", label: "Combine Dependabot PRs", group: "Pull requests" },
  { kind: "review.post", label: "Post a review or replies", group: "Pull requests" },
  { kind: "issue.assign", label: "Assign me an issue", group: "Issues" },
  { kind: "issue.close", label: "Close an issue", group: "Issues" },
  { kind: "issue.reopen", label: "Reopen an issue", group: "Issues" },
  { kind: "issue.comment", label: "Post a comment", group: "Issues" },
  { kind: "agents.clear", label: "Clear finished agent sessions", group: "Here" },
  { kind: "docker.engine-off", label: "Stop Docker", group: "Here" },
  { kind: "docker.remove", label: "Remove a container", group: "Here", floor: "twice" },
  { kind: "terminal.close", label: "Close a terminal", group: "Here", floor: "twice" },
  { kind: "todo.delete", label: "Delete from My list", group: "Here", floor: "twice" },
  { kind: "bino.forget", label: "Forget something Bino remembers", group: "Here", floor: "twice" },
  { kind: "relay.answer", label: "Answer an MCP server's question", group: "Here", floor: "twice" },
  { kind: "ingest.revoke", label: "Revoke an ingest token", group: "Here", floor: "twice" },
];

const byKind = new Map(WRITES.map((w) => [w.kind, w]));

/** What I chose, kept in D1, cached a minute (hosted, each isolate reads it again). */
export function writeClicksStore(db: D1, now: () => number = Date.now) {
  let kept: { at: number; map: Map<string, Clicks> } | undefined;
  return {
    async get(): Promise<Map<string, Clicks>> {
      if (kept && now() - kept.at < 60_000) return kept.map;
      const { results } = await db.prepare("SELECT kind, clicks FROM write_clicks").all<{ kind: string; clicks: string }>();
      const map = new Map<string, Clicks>();
      for (const r of results) if (r.clicks === "once" && byKind.has(r.kind) && !byKind.get(r.kind)!.floor) map.set(r.kind, "once");
      kept = { at: now(), map };
      return map;
    },
    /** Saves the kinds set to one click; every other kind asks twice. Kinds with a floor are ignored. */
    async set(once: string[]): Promise<void> {
      const ok = once.filter((k) => byKind.has(k) && !byKind.get(k)!.floor);
      await db.prepare("DELETE FROM write_clicks").run();
      for (const k of ok) await db.prepare("INSERT INTO write_clicks (kind, clicks) VALUES (?, 'once')").bind(k).run();
      kept = undefined;
    },
  };
}
export type WriteClicksStore = ReturnType<typeof writeClicksStore>;

/** The request's choices, put there by the app (see app.ts): Confirm reads them while a page is drawn. */
export const CLICKS_VAR = "clicks";

/** Whether this kind of write takes one click on the page being drawn now. Unknown kinds ask twice. */
export function oneClickNow(kind: string | undefined): boolean {
  if (!kind || byKind.get(kind)?.floor) return false;
  const c = tryGetContext<{ Variables: { clicks?: Map<string, Clicks> } }>();
  return c?.get(CLICKS_VAR as "clicks")?.get(kind) === "once";
}
