/**
 * Automerge (#326 step 5): a PR whose review of its head commit reached level 5, in a repo whose
 * `.dovre/auto.json` (at the base commit) says `merge: true`, is merged by Auto review. It's a
 * verified write (`autoreview.merge`): right before merging it re-checks
 *
 * - the head is still the commit reviewed (and the merge is pinned to it: GitHub refuses it otherwise);
 * - CI is green on it (still running: `waiting-ci`, checked again on the next pass);
 * - GitHub says it can merge (no conflicts);
 * - no `dovre:hold` label (it waits while it's there), and no comment from me since the review
 *   (it's handed to me: I said something);
 * - the repo still allows it, and Settings → Writes doesn't ask twice for it.
 *
 * Then: the draft marked ready, a squash merge, and a comment on the issue with the levels so far.
 */
import { logAction } from "../../../actions/deploys.ts";
import type { D1 } from "../../../db.ts";
import { owns, ownersOf } from "../../../owners.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import type { Clicks } from "../../../writes.ts";
import { loadAutoConfig } from "./config.ts";
import { ciOf } from "./reviewer.ts";
import { CLAIM_MS } from "./round.ts";
import { type PrRow, type PrState, prsStore } from "./store.ts";

/** The label that holds a PR back from merging while it's on. */
export const HOLD_LABEL = "dovre:hold";

export type MergeDeps = {
  db: D1;
  ghe: Pick<Ghe, "rest" | "graphql">;
  owners: string;
  /** Who I am on the forge. */
  login: string;
  clicks: () => Promise<Map<string, Clicks>>;
  log: (line: string) => void;
  now?: () => number;
};

type RawPr = {
  state: string;
  merged?: boolean;
  draft?: boolean;
  node_id?: string;
  html_url?: string;
  mergeable?: boolean | null;
  labels?: { name?: string }[];
  head: { sha: string };
  base: { sha: string };
};
type Said = { id?: number; user?: { login?: string } | null; created_at?: string; submitted_at?: string; pull_request_review_id?: number | null };

const issueOf = (key: string) => {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

/** Follows every PR on its way to merging; true when a row changed. Never throws for one PR's trouble. */
export async function mergePass(d: MergeDeps): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  let changed = false;
  for (const row of await store.all()) {
    if (row.state !== "merging" && row.state !== "waiting-ci") continue;
    try {
      if (await mergeOne(d, row)) changed = true;
    } catch (e) {
      d.log(`autoreview: ${row.pr}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      await store.release(row.pr).catch(() => {});
    }
  }
  return changed;
}

/** Whether an owner (me, or one of REPO_OWNERS) said anything on the PR after its last review, other than that review itself. */
async function ownerSpoke(d: MergeDeps, row: PrRow, since: number): Promise<string | undefined> {
  const owners = new Set([d.login, ...ownersOf(d.owners)].map((o) => o.toLowerCase()));
  const iso = new Date(since).toISOString();
  const base = `/repos/${row.repo}`;
  const [comments, lines, reviews] = await Promise.all([
    d.ghe.rest<Said[]>(`${base}/issues/${row.number}/comments?since=${iso}&per_page=100`),
    d.ghe.rest<Said[]>(`${base}/pulls/${row.number}/comments?since=${iso}&per_page=100`),
    d.ghe.rest<Said[]>(`${base}/pulls/${row.number}/reviews?per_page=100`),
  ]);
  const after = (at: string | undefined) => !!at && Date.parse(at) > since;
  const mine = (s: Said) => owners.has(String(s.user?.login ?? "").toLowerCase());
  const said = [
    ...(Array.isArray(comments) ? comments : []).filter((c) => after(c.created_at)),
    ...(Array.isArray(lines) ? lines : []).filter((c) => after(c.created_at) && c.pull_request_review_id !== row.review),
    ...(Array.isArray(reviews) ? reviews : []).filter((r) => after(r.submitted_at) && r.id !== row.review),
  ].find(mine);
  return said ? String(said.user?.login) : undefined;
}

async function mergeOne(d: MergeDeps, row: PrRow): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  const from: PrState = row.state;
  const hand = (why: string) => store.move(row.pr, from, "yours", { why: `Level 5, not merged: ${why}` });
  const wait = async (why: string, to: PrState = from) => {
    if (to !== from) return store.move(row.pr, from, to, { why });
    if (row.why === why) return false;
    await store.release(row.pr, { why });
    return true;
  };
  const owner = row.repo.split("/")[0] ?? "";
  if (!owns(d.owners, owner)) return hand(`${owner} isn't one of the owners Dovre follows.`);
  const pr = await d.ghe.rest<RawPr>(`/repos/${row.repo}/pulls/${row.number}`);
  if (pr.merged) return store.move(row.pr, from, "merged", { why: "Merged on GitHub." });
  if (pr.state !== "open") return store.move(row.pr, from, "closed", { why: "Closed on GitHub." });
  // No carried-over score: new commits are reviewed afresh.
  if (!row.head || pr.head.sha !== row.head) return store.move(row.pr, from, "reviewing", { why: "New commits since its level-5 review: reviewing those." });
  const reviewed = row.levels[row.levels.length - 1];
  if (row.level !== 5 || !reviewed || reviewed.head !== row.head) return hand("its level 5 isn't on its head commit.");
  if ((pr.labels ?? []).some((l) => l.name === HOLD_LABEL)) return wait(`Held: labelled ${HOLD_LABEL}. It merges once the label comes off.`);
  if (!(await loadAutoConfig(d.ghe, row.repo, pr.base.sha)).merge) return hand("automerge is off for this repo now.");
  if ((await d.clicks()).get("autoreview.merge") === "twice") return hand("Settings → Writes asks twice before Auto review merges.");
  const spoke = await ownerSpoke(d, row, reviewed.at);
  if (spoke) return hand(`${spoke} commented on it after its review, so it's yours.`);
  const ci = await ciOf(d.ghe, row.repo, row.head);
  if (ci === "pending") return wait(`Waiting for CI on ${row.head.slice(0, 7)} before merging.`, "waiting-ci");
  if (ci === "red") return hand("CI failed on it after its review.");
  if (ci === "none") return hand("no CI ran on it, and automerge needs green CI.");
  if (pr.mergeable === false) return hand("it conflicts with its base branch.");
  if (pr.mergeable !== true) return wait("GitHub is still working out whether it can merge.");
  if (!(await store.claim(row.pr, from, CLAIM_MS))) return false;
  const target = `${row.repo}#${row.number}`;
  const fail = async (what: string, e: unknown) => {
    const error = `${what}: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
    await logAction(d.db, { kind: "autoreview.merge", target, ok: false, error }).catch(() => {});
    return hand(error);
  };
  if (pr.draft) {
    try {
      await d.ghe.graphql(`mutation{markPullRequestReadyForReview(input:{pullRequestId:${JSON.stringify(String(pr.node_id ?? ""))}}){pullRequest{isDraft}}}`);
    } catch (e) {
      return fail("Couldn't mark it ready", e);
    }
  }
  try {
    // Pinned to the reviewed commit: GitHub refuses the merge if the head moved meanwhile.
    await d.ghe.rest(`/repos/${row.repo}/pulls/${row.number}/merge`, { method: "PUT", body: { merge_method: "squash", sha: row.head } });
  } catch (e) {
    return fail("GitHub didn't merge it", e);
  }
  await logAction(d.db, { kind: "autoreview.merge", target, detail: `${row.head.slice(0, 7)} at level 5`, ok: true }).catch(() => {});
  await store.move(row.pr, from, "merged", { why: `Merged by Auto review at level 5, after ${row.round} fix round${row.round === 1 ? "" : "s"}.` });
  await issueComment(d, row, pr.html_url ?? row.pr);
  return true;
}

/** On the issue it was for: the PR, and how its levels went. Only in my repos; logged. */
async function issueComment(d: MergeDeps, row: PrRow, url: string): Promise<void> {
  const at = issueOf(row.issue);
  if (!at || !owns(d.owners, at.repo.split("/")[0] ?? "")) return;
  const levels = row.levels.map((l) => `${l.level} (${l.head.slice(0, 7)})`).join(" → ");
  const body = `Auto review merged ${url} at level 5, after ${row.round} fix round${row.round === 1 ? "" : "s"}.\n\nLevels by round: ${levels}.`;
  const target = `${at.repo}#${at.number}`;
  try {
    await d.ghe.rest(`/repos/${at.repo}/issues/${at.number}/comments`, { method: "POST", body: { body } });
    await logAction(d.db, { kind: "autoreview.merge", target, detail: "comment", ok: true }).catch(() => {});
  } catch (e) {
    await logAction(d.db, { kind: "autoreview.merge", target, detail: "comment", ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => {});
  }
}
