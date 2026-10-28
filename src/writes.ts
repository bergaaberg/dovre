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
  { kind: "pr.dependabot-groups", label: "Add groups to dependabot.yml", group: "Pull requests" },
  { kind: "pr.merge-combined", label: "Merge a green combined Dependabot PR", group: "Pull requests" },
  { kind: "pr.relock-dependabot", label: "Add left-out bumps to a combined PR, lockfiles made again", group: "Pull requests" },
  { kind: "sandbox.pr", label: "Open a draft PR from a sandbox run (pushes its branch)", group: "Pull requests" },
  { kind: "sandbox.pr-ci", label: "Open a draft PR from a sandbox run that changes CI config", group: "Pull requests", floor: "twice" },
  { kind: "auto.pr", label: "Open the draft PR when an auto run (a dovre:auto issue) ends, without asking (CI changes still wait)", group: "Pull requests" },
  { kind: "review.post", label: "Post a review or replies", group: "Pull requests" },
  { kind: "review.reply", label: "Reply on a review thread", group: "Pull requests" },
  { kind: "review.resolve", label: "Resolve or reopen a review thread", group: "Pull requests" },
  { kind: "review.discard", label: "Discard your pending review", group: "Pull requests", floor: "twice" },
  { kind: "issue.assign", label: "Assign me an issue", group: "Issues" },
  { kind: "issue.close", label: "Close an issue", group: "Issues" },
  { kind: "issue.reopen", label: "Reopen an issue", group: "Issues" },
  { kind: "issue.comment", label: "Post a comment", group: "Issues" },
  { kind: "agents.clear", label: "Clear finished agent sessions", group: "Here" },
  { kind: "sandbox.discard", label: "Discard a sandbox run's commits", group: "Here", floor: "twice" },
  { kind: "agents.tools", label: "Give omp or agy the packs' tools (adds Dovre to its MCP config)", group: "Here" },
  { kind: "docker.engine-off", label: "Stop Docker", group: "Here" },
  { kind: "docker.remove", label: "Remove a container", group: "Here", floor: "twice" },
  { kind: "terminal.close", label: "Close a terminal", group: "Here", floor: "twice" },
  { kind: "todo.delete", label: "Delete from My list", group: "Here", floor: "twice" },
  { kind: "bino.forget", label: "Forget something Bino remembers", group: "Here", floor: "twice" },
  { kind: "relay.answer", label: "Answer an MCP server's question", group: "Here", floor: "twice" },
  { kind: "ingest.revoke", label: "Revoke an ingest token", group: "Here", floor: "twice" },
  { kind: "packs.update", label: "Update a pack from dovre-packs", group: "Here", floor: "twice" },
];

const byKind = new Map(WRITES.map((w) => [w.kind, w]));
const PACK_KIND = /^[a-z][a-z0-9-]{0,40}$/;

/** The core's kinds, then each pack's (`<pack id>.<kind>`, grouped under its name). A malformed or repeated one is left out. */
export function writeKinds(packs: { manifest: { id: string; name: string }; writes?: { kind: string; label: string; floor?: "twice" }[] }[]): WriteKind[] {
  const out = [...WRITES];
  const seen = new Set(out.map((w) => w.kind));
  for (const p of packs)
    for (const w of p.writes ?? []) {
      const kind = `${p.manifest.id}.${w.kind}`;
      if (!PACK_KIND.test(w.kind) || seen.has(kind) || typeof w.label !== "string" || !w.label) continue;
      seen.add(kind);
      out.push({ kind, label: w.label.slice(0, 120), group: p.manifest.name, ...(w.floor === "twice" ? { floor: "twice" as const } : {}) });
    }
  return out;
}

/** What I chose, kept in D1, cached a minute (hosted, each isolate reads it again). `kinds`: what may be one click (the core's and the packs'). */
export function writeClicksStore(db: D1, now: () => number = Date.now, kinds: () => WriteKind[] = () => WRITES) {
  const known = () => new Map(kinds().map((w) => [w.kind, w]));
  let kept: { at: number; map: Map<string, Clicks> } | undefined;
  return {
    async get(): Promise<Map<string, Clicks>> {
      if (kept && now() - kept.at < 60_000) return kept.map;
      const { results } = await db.prepare("SELECT kind, clicks FROM write_clicks").all<{ kind: string; clicks: string }>();
      const map = new Map<string, Clicks>();
      const k = known();
      for (const r of results) if (r.clicks === "once" && k.has(r.kind) && !k.get(r.kind)!.floor) map.set(r.kind, "once");
      kept = { at: now(), map };
      return map;
    },
    /** Saves the kinds set to one click; every other kind asks twice. Kinds with a floor are ignored. */
    async set(once: string[]): Promise<void> {
      const k = known();
      const ok = once.filter((x) => k.has(x) && !k.get(x)!.floor);
      await db.prepare("DELETE FROM write_clicks").run();
      for (const k of ok) await db.prepare("INSERT INTO write_clicks (kind, clicks) VALUES (?, 'once')").bind(k).run();
      kept = undefined;
    },
  };
}
export type WriteClicksStore = ReturnType<typeof writeClicksStore>;

/** The request's choices, put there by the app (see app.ts): Confirm reads them while a page is drawn. */
export const CLICKS_VAR = "clicks";

/** Whether this kind of write takes one click on the page being drawn now. Unknown kinds ask twice; the store drops a pack kind with a floor. */
export function oneClickNow(kind: string | undefined): boolean {
  if (!kind || byKind.get(kind)?.floor) return false;
  const c = tryGetContext<{ Variables: { clicks?: Map<string, Clicks> } }>();
  return c?.get(CLICKS_VAR as "clicks")?.get(kind) === "once";
}
