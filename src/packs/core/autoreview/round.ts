/**
 * One review pass (#326): every auto PR being reviewed whose head the reviewer hasn't read gets one
 * review of that exact commit once its CI has settled, posted as a Comment review
 * (`autoreview.review`), and its level kept. Then the decide step: comments to fix start a fix
 * round (fix.ts), within the limits; otherwise, or past a limit, the PR is handed to me. A PR
 * merged or closed meanwhile, or outside my owners, leaves the loop. A model call takes a while,
 * so hosted it runs from the cron, not a page's refresh.
 */
import { postReview } from "../../../actions/reviews.ts";
import type { Complete } from "../../../ai/llm.ts";
import type { D1 } from "../../../db.ts";
import { owns } from "../../../owners.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { loadPrFiles } from "../../../sources/prview.ts";
import type { Clicks } from "../../../writes.ts";
import type { AutoShare } from "../../types.ts";
import { type PrRow, prsStore } from "./store.ts";
import { AUTOREVIEW_SYSTEM, capLevel, ciOf, reviewDraft, reviewerModel, reviewPrompt, tagCounts, verdictOf } from "./reviewer.ts";

/** How long the reviewer may take. */
export const REVIEW_MS = 180_000;
/** A claim older than this was a pass that went away: another may take the PR. */
export const CLAIM_MS = REVIEW_MS + 120_000;
/** At most this many reviews a pass, so one pass stays inside a cron run. */
export const PER_PASS = 3;
/** How long a review waits for CI that's still running on the head commit; then it reviews anyway (and the level is capped). */
export const CI_WAIT_MS = 30 * 60_000;
/** Fix rounds per PR; then it's handed to me. */
export const MAX_ROUNDS = 3;
/** What one PR may cost in all, in fix rounds' budgets (`runUsd`). */
export const PR_ROUNDS_USD = 3;
/** A PR handed to me is looked at again this often, to see it merged or closed. */
const SETTLE_MS = 30 * 60_000;

export type ReviewDeps = {
  db: D1;
  ghe: Pick<Ghe, "rest">;
  owners: string;
  /** Who I am on the forge: the PRs are mine. */
  login: string;
  auto: Pick<AutoShare, "run" | "limits">;
  /** The model route, or undefined when none can answer now. */
  ask?: { ask: Complete; model: string };
  /** The model set for Auto review (AUTOREVIEW_MODEL), if any. */
  model?: string;
  clicks: () => Promise<Map<string, Clicks>>;
  log: (line: string) => void;
  now?: () => number;
};

type RawPr = { state: string; merged?: boolean; draft?: boolean; title?: string; body?: string | null; head: { sha: string } };

const issueOf = (key: string) => {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

/** Reviews what's due; true when a row changed (the page is told). Never throws for one PR's trouble. */
export async function reviewPass(d: ReviewDeps): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  const now = d.now ?? Date.now;
  let changed = false;
  let done = 0;
  let settled = 0;
  for (const row of await store.all()) {
    if (row.state === "yours" && settled < 5 && now() - row.updated > SETTLE_MS && owns(d.owners, row.repo.split("/")[0] ?? "")) {
      settled++;
      if (await settle(d, row).catch(() => false)) changed = true;
      continue;
    }
    if (row.state !== "reviewing" || done >= PER_PASS) continue;
    try {
      const r = await reviewOne(d, row);
      if (r) changed = true;
      if (r === "reviewed") done++;
    } catch (e) {
      d.log(`autoreview: ${row.pr}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      await store.release(row.pr).catch(() => {});
    }
  }
  return changed;
}

/** A PR handed to me: merged or closed since, it leaves what needs me; else looked at again later. */
async function settle(d: ReviewDeps, row: PrRow): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  const pr = await d.ghe.rest<RawPr>(`/repos/${row.repo}/pulls/${row.number}`);
  if (pr.merged) return store.move(row.pr, "yours", "merged", { why: "Merged on GitHub." });
  if (pr.state !== "open") return store.move(row.pr, "yours", "closed", { why: "Closed on GitHub." });
  await store.release(row.pr);
  return false;
}

/** One PR: "reviewed" when a review posted, "moved" when it left the loop or waits on something, undefined when nothing changed. */
async function reviewOne(d: ReviewDeps, row: PrRow): Promise<"reviewed" | "moved" | undefined> {
  const store = prsStore(d.db, d.now);
  const owner = row.repo.split("/")[0] ?? "";
  // Never a URL outside my owners.
  if (!owns(d.owners, owner)) return (await store.move(row.pr, "reviewing", "yours", { why: `${owner} isn't one of the owners Dovre follows.` })) ? "moved" : undefined;
  const pr = await d.ghe.rest<RawPr>(`/repos/${row.repo}/pulls/${row.number}`);
  if (pr.merged) return (await store.move(row.pr, "reviewing", "merged", { why: "Merged on GitHub." })) ? "moved" : undefined;
  if (pr.state !== "open") return (await store.move(row.pr, "reviewing", "closed", { why: "Closed on GitHub." })) ? "moved" : undefined;
  const head = pr.head.sha;
  // One review per head commit.
  if (row.head === head) return undefined;
  const wait = async (why: string) => {
    if (row.why === why) return undefined;
    await store.release(row.pr, { why });
    return "moved" as const;
  };
  if (!d.ask) return wait("No model can answer now (the assistant's route is off or not set up).");
  if ((await d.clicks()).get("autoreview.review") === "twice") return wait("Settings → Writes asks twice before Auto review posts, so it doesn't review on its own.");
  // The reviewer is never the author's model: wait until the run says which it was.
  let author = row.author;
  if (!author && row.run) {
    const run = await d.auto.run(row.run);
    if (!run) return wait("Waiting for the machine that ran it to say which model wrote it.");
    author = run.model;
    await store.author(row.pr, author);
  }
  // CI still running: the review waits for it a while, so its level isn't capped for that alone.
  const ci = await ciOf(d.ghe, row.repo, head);
  const ciWhy = `Waiting for CI on ${head.slice(0, 7)} before reviewing it.`;
  if (ci === "pending" && !(row.why === ciWhy && (d.now ?? Date.now)() - row.updated > CI_WAIT_MS)) return wait(ciWhy);
  if (!(await store.claim(row.pr, "reviewing", CLAIM_MS))) return undefined;
  const model = reviewerModel(author ?? "", { set: d.model, route: d.ask.model });
  const issueAt = issueOf(row.issue);
  const [files, issue] = await Promise.all([
    loadPrFiles(d.ghe as Ghe, row.repo, row.number),
    issueAt ? d.ghe.rest<{ title?: string; body?: string | null }>(`/repos/${issueAt.repo}/issues/${issueAt.number}`) : Promise.resolve(undefined),
  ]);
  const user = reviewPrompt(
    { repo: issueAt?.repo ?? row.repo, number: issueAt?.number ?? 0, title: issue?.title ?? "(the issue couldn't be read)", body: issue?.body ?? "" },
    { repo: row.repo, number: row.number, title: pr.title ?? "", body: pr.body ?? "" },
    files,
  );
  let reply: { text: string; cost: number };
  try {
    reply = await d.ask.ask({ system: AUTOREVIEW_SYSTEM, user, model, signal: AbortSignal.timeout(REVIEW_MS) });
  } catch (e) {
    await store.release(row.pr, { why: `The reviewer didn't answer: ${String((e as Error)?.message ?? e).slice(0, 200)}. It tries again on the next pass.` });
    return "moved";
  }
  const v = verdictOf(reply.text, files);
  // An answer Dovre can't read isn't tried again on its own: that would spend on every pass.
  if (!v) {
    await store.release(row.pr, { cost: reply.cost });
    return (await store.move(row.pr, "reviewing", "yours", { why: "The reviewer answered, but not with a level Dovre could read." })) ? "moved" : undefined;
  }
  const capped = capLevel(v.level, { ci, files, blockers: v.comments.filter((c) => c.tag === "blocker").length });
  const posted = await postReview(d.ghe as Ghe, d.db, row.repo, row.number, { reviewed: head, me: d.login, draft: reviewDraft(v, capped, { model, head }), verdict: "comment", by: "auto", kind: "autoreview.review" });
  if (!posted.ok) {
    // New commits since it read, most often: the next pass reviews the new head.
    await store.release(row.pr, { cost: reply.cost, why: posted.message });
    return "moved";
  }
  await store.level(row.pr, "reviewing", { head, level: capped.level, cost: reply.cost, ...(posted.id ? { review: posted.id } : {}) });
  const said = `Level ${capped.level} from ${model}: ${tagCounts(v.comments) || "no comments"}${capped.why.length ? `; capped because ${capped.why[0]}` : ""}.`;
  await decide(d, { ...row, cost: row.cost + reply.cost }, { level: capped.level, fixable: v.comments.filter((c) => c.tag !== "nit").length, ci, said, review: posted.id });
  return "reviewed";
}

/**
 * After a review, on that exact commit: a fix round when there's something to fix and the limits
 * allow one; else the PR is handed to me, saying why. Level 5 is handed to me too, to merge, until
 * Auto review merges on its own.
 */
async function decide(d: ReviewDeps, row: PrRow, r: { level: number; fixable: number; ci: string; said: string; review?: number }): Promise<void> {
  const store = prsStore(d.db, d.now);
  const hand = (why: string) => store.move(row.pr, "reviewing", "yours", { why: `${r.said} ${why}` });
  if (r.level >= 5) return void (await hand("Mergeable as is: over to you to merge."));
  const red = r.ci === "red";
  if (!r.fixable && !red) return void (await hand("Nothing for a fix session to do: over to you."));
  if (!r.review) return void (await hand("Its review's comments couldn't be found for a fix session."));
  if (row.round >= MAX_ROUNDS) return void (await hand(`${MAX_ROUNDS} fix rounds done, and it's still at level ${r.level}.`));
  const levels = [...row.levels.map((l) => l.level), r.level];
  if (levels.length >= 3 && r.level <= levels[levels.length - 3]!) return void (await hand("Its level hasn't gone up in two rounds."));
  const limits = await d.auto.limits(row.repo);
  const cap = PR_ROUNDS_USD * limits.runUsd;
  if (row.cost >= cap) return void (await hand(`It has cost $${row.cost.toFixed(2)}, the cap for one PR ($${cap.toFixed(2)}).`));
  const what = [r.fixable ? `${r.fixable} comment${r.fixable === 1 ? "" : "s"}` : "", red ? "CI failing" : ""].filter(Boolean).join(" and ");
  await store.move(row.pr, "reviewing", "fixing", { round: row.round + 1, why: `${r.said} Round ${row.round + 1}: a fix session for ${what}.` });
}
