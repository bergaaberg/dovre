/**
 * One review pass (#326 step 3): every auto PR being reviewed whose head the reviewer hasn't read
 * gets one review of that exact commit, posted as a Comment review (`autoreview.review`), and its
 * level kept. A PR merged or closed meanwhile, or outside my owners, leaves the loop. A model call
 * takes a while, so hosted it runs from the cron, not a page's refresh.
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

export type ReviewDeps = {
  db: D1;
  ghe: Pick<Ghe, "rest">;
  owners: string;
  /** Who I am on the forge: the PRs are mine. */
  login: string;
  auto: AutoShare;
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
  let changed = false;
  let done = 0;
  for (const row of await store.all()) {
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

/** One PR: "reviewed" when a review posted, "moved" when it left the loop or waits on something, undefined when nothing changed. */
async function reviewOne(d: ReviewDeps, row: PrRow): Promise<"reviewed" | "moved" | undefined> {
  const store = prsStore(d.db, d.now);
  const owner = row.repo.split("/")[0] ?? "";
  // Never a URL outside my owners.
  if (!owns(d.owners, owner)) return (await store.move(row.pr, "reviewing", "yours", { why: `${owner} isn't one of the owners Dovre follows.` })) ? "moved" : undefined;
  const pr = await d.ghe.rest<RawPr>(`/repos/${row.repo}/pulls/${row.number}`);
  if (pr.merged) return (await store.move(row.pr, "reviewing", "merged", { why: "Merged on GitHub." })) ? "moved" : undefined;
  if (pr.state !== "open") return (await store.move(row.pr, "reviewing", "yours", { why: "Closed on GitHub." })) ? "moved" : undefined;
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
  if (!(await store.claim(row.pr, "reviewing", CLAIM_MS))) return undefined;
  const model = reviewerModel(author ?? "", { set: d.model, route: d.ask.model });
  const issueAt = issueOf(row.issue);
  const [files, issue, ci] = await Promise.all([
    loadPrFiles(d.ghe as Ghe, row.repo, row.number),
    issueAt ? d.ghe.rest<{ title?: string; body?: string | null }>(`/repos/${issueAt.repo}/issues/${issueAt.number}`) : Promise.resolve(undefined),
    ciOf(d.ghe, row.repo, head),
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
  await store.level(row.pr, "reviewing", { head, level: capped.level, cost: reply.cost });
  await store.release(row.pr, { why: `Level ${capped.level} from ${model}: ${tagCounts(v.comments) || "no comments"}${capped.why.length ? `; capped because ${capped.why[0]}` : ""}.` });
  return "reviewed";
}
