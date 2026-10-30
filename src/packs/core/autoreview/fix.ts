/**
 * One fix pass (#326 step 4): each PR in a fix round gets a fix session from the review's open
 * comments, started through the agents pack's share (a sandbox run from the reviewed head commit,
 * within auto runs' limits). Once it ends, its commits go onto the PR's branch, it replies on each
 * thread (`autoreview.reply`) and the PR goes back to review, whose next pass reads the new head.
 * Nothing committed, or anything it can't do safely: the PR is handed to me.
 */
import { postReplies } from "../../../actions/reviews.ts";
import type { D1 } from "../../../db.ts";
import { owns } from "../../../owners.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import type { Clicks } from "../../../writes.ts";
import type { AutoShare } from "../../types.ts";
import { fixPrompt, type OpenComment, repliesOf, taggedOf } from "./fixer.ts";
import { CLAIM_MS, PR_ROUNDS_USD } from "./round.ts";
import { type PrRow, prsStore } from "./store.ts";

/** A fix round with less than this left of the PR's budget isn't started. */
const MIN_BUDGET = 0.5;
/** An auto run's branch (src/agents/sandbox.ts `sandboxBranch`): the only kind a fix pushes to. */
const BRANCH = /^sandbox\/[\w-]{1,64}$/;

export type FixDeps = {
  db: D1;
  ghe: Pick<Ghe, "rest">;
  owners: string;
  auto: AutoShare;
  clicks: () => Promise<Map<string, Clicks>>;
  log: (line: string) => void;
  now?: () => number;
};

type RawPr = { state: string; merged?: boolean; html_url?: string; head: { sha: string; ref: string } };
type RawComment = { id: number; path?: string; line?: number | null; original_line?: number | null; body?: string };

const issueOf = (key: string) => {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim() && !l.startsWith("```")) ?? "").trim().slice(0, 300);

/** Follows every PR in a fix round; true when a row changed. Never throws for one PR's trouble. */
export async function fixPass(d: FixDeps): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  let changed = false;
  for (const row of await store.all()) {
    if (row.state !== "fixing") continue;
    try {
      if (await fixOne(d, row)) changed = true;
    } catch (e) {
      d.log(`autoreview: ${row.pr}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      await store.release(row.pr).catch(() => {});
    }
  }
  return changed;
}

async function fixOne(d: FixDeps, row: PrRow): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  const hand = (why: string, cost?: number) => store.move(row.pr, "fixing", "yours", { why: `Round ${row.round}: ${why}`, ...(cost ? { cost } : {}) });
  const wait = async (why: string) => {
    const w = `Round ${row.round}: ${why}`;
    if (row.why === w) return false;
    await store.release(row.pr, { why: w });
    return true;
  };
  const owner = row.repo.split("/")[0] ?? "";
  if (!owns(d.owners, owner)) return hand(`${owner} isn't one of the owners Dovre follows.`);
  const pr = await d.ghe.rest<RawPr>(`/repos/${row.repo}/pulls/${row.number}`);
  // Merged or closed meanwhile: a fix session's work, if any, isn't pushed.
  if (pr.merged) return store.move(row.pr, "fixing", "merged", { why: "Merged on GitHub." });
  if (pr.state !== "open") return store.move(row.pr, "fixing", "closed", { why: "Closed on GitHub." });
  if (!row.fix) {
    // Someone pushed since the review: that's what gets reviewed now.
    if (pr.head.sha !== row.head) return store.move(row.pr, "fixing", "reviewing", { why: "New commits since the review: reviewing those." });
    if (!BRANCH.test(pr.head.ref)) return hand(`its branch ${pr.head.ref.slice(0, 100)} isn't an auto run's, so no fix session pushes to it.`);
    if ((await d.clicks()).get("autoreview.fix") === "twice") return wait("Settings → Writes asks twice before a fix session pushes, so none starts on its own.");
    if (!row.review || !row.head) return hand("its review's comments couldn't be found.");
    const limits = await d.auto.limits(row.repo);
    const left = PR_ROUNDS_USD * limits.runUsd - row.cost;
    if (left < MIN_BUDGET) return hand(`it has cost $${row.cost.toFixed(2)}, nearly the cap for one PR.`);
    if (!(await store.claim(row.pr, "fixing", CLAIM_MS))) return false;
    const at = issueOf(row.issue);
    const [raw, issue, runs] = await Promise.all([
      d.ghe.rest<RawComment[]>(`/repos/${row.repo}/pulls/${row.number}/reviews/${row.review}/comments?per_page=100`),
      at ? d.ghe.rest<{ title?: string; body?: string | null }>(`/repos/${at.repo}/issues/${at.number}`) : Promise.resolve(undefined),
      d.ghe.rest<{ check_runs?: { name?: string; status?: string; conclusion?: string | null }[] }>(`/repos/${row.repo}/commits/${row.head}/check-runs?per_page=100`).catch(() => undefined),
    ]);
    const comments: OpenComment[] = (Array.isArray(raw) ? raw : [])
      .filter((c) => Number.isInteger(c?.id) && typeof c.body === "string")
      .map((c) => ({ id: c.id, path: String(c.path ?? ""), line: c.line ?? c.original_line ?? null, ...taggedOf(c.body!) }));
    const failing = (runs?.check_runs ?? []).filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion ?? "")).map((r) => String(r.name ?? "a check").slice(0, 100));
    const prompt = fixPrompt({ repo: row.repo, number: row.number, issue: { ref: row.issue, title: issue?.title ?? "(the issue couldn't be read)", body: issue?.body ?? "" }, comments, failing, round: row.round });
    const r = await d.auto.fix({ key: row.issue, pr: row.pr, repo: row.repo, head: row.head, prompt, model: row.author ?? "", budget: Math.min(limits.runUsd, left) });
    if ("error" in r) return hand(`its fix session couldn't start: ${r.error}`);
    if ("wait" in r) {
      await store.release(row.pr, { why: `Round ${row.round}: ${r.wait}` });
      return row.why !== `Round ${row.round}: ${r.wait}`;
    }
    await store.fixing(row.pr, r.run);
    await store.release(row.pr, { why: `Round ${row.round}: a fix session is working on it.` });
    return true;
  }

  // A fix session is on it: once it ended, its commits go onto the branch.
  const run = await d.auto.run(row.fix);
  if (!run) return wait("waiting to hear from the machine running its fix session.");
  if (run.status === "running") return wait("a fix session is working on it.");
  if (!row.head) return hand("the commit it fixed isn't known.");
  if (!(await store.claim(row.pr, "fixing", CLAIM_MS))) return false;
  const landed = await d.auto.land(row.fix, { repo: row.repo, branch: pr.head.ref, base: row.head, pr: { number: row.number, url: pr.html_url ?? row.pr }, kind: "autoreview.fix" });
  if ("wait" in landed) {
    await store.release(row.pr, { why: `Round ${row.round}: ${landed.wait}` });
    return row.why !== `Round ${row.round}: ${landed.wait}`;
  }
  if ("error" in landed) return hand(`its fix session's commits weren't pushed: ${landed.error}`, landed.cost);
  if ("none" in landed) {
    const said = firstLine(landed.said);
    return hand(`${landed.none}${said ? ` Its last word: ${said}` : ""}`, landed.cost);
  }
  // Its replies on each thread, unless replies ask twice on Settings → Writes.
  let replied = "";
  const ids = await commentIds(d, row);
  const replies = repliesOf(landed.said, ids);
  if (replies.length && (await d.clicks()).get("autoreview.reply") !== "twice") {
    const posted = await postReplies(d.ghe as Ghe, d.db, row.repo, row.number, { reviewed: landed.head, draft: { kind: "triage", replies, comment: "" }, kind: "autoreview.reply" });
    replied = posted.ok ? `, replied on ${replies.length} thread${replies.length === 1 ? "" : "s"}` : `; its replies didn't post (${posted.message.slice(0, 200)})`;
  }
  return store.move(row.pr, "fixing", "reviewing", { why: `Round ${row.round}: pushed ${landed.head.slice(0, 7)}${replied}; reviewing it.`, cost: landed.cost });
}

/** The ids of the review's comments: only those get replies. */
async function commentIds(d: FixDeps, row: PrRow): Promise<number[]> {
  const raw = await d.ghe.rest<RawComment[]>(`/repos/${row.repo}/pulls/${row.number}/reviews/${row.review}/comments?per_page=100`).catch(() => []);
  return (Array.isArray(raw) ? raw : []).map((c) => c.id).filter((id) => Number.isInteger(id));
}
