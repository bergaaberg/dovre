/**
 * One review pass (#326): every auto PR being reviewed whose head the reviewers haven't read gets one
 * review of that exact commit once its CI has settled: a panel (#555; code quality always, a
 * specialist when the diff calls for one), each a model call with the diff and the changed files,
 * their findings folded into one list. It's posted as a Comment review
 * (`autoreview.review`), its findings kept as records (findings.ts; one an earlier review raised
 * stays that finding) and its level kept. Then the
 * decide step: critical and high findings start a fix round (fix.ts), within the limits; medium
 * and low are only reported; otherwise, or past a limit, the PR is handed to me. What an
 * owner says on the PR (owner.ts) caps the level at 2 and starts a round, even on a PR handed to
 * me: that's me asking. A PR
 * merged or closed meanwhile, or outside my owners, leaves the loop. A model call takes a while,
 * so hosted it runs from the cron, not a page's refresh.
 */
import { postReview } from "../../../actions/reviews.ts";
import type { Complete } from "../../../ai/llm.ts";
import type { D1 } from "../../../db.ts";
import { owns } from "../../../owners.ts";
import { loadContext } from "../../../reviews/context.ts";
import { foldFound, type Found, gates, raisedAgain } from "../../../reviews/finding.ts";
import { panelFor, type Seat, type Specialist, TOPIC } from "../../../reviews/panel.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { loadPrFiles } from "../../../sources/prview.ts";
import type { Clicks } from "../../../writes.ts";
import type { AutoShare } from "../agents/share.ts";
import { AUTO_CONFIG, loadAutoConfig } from "./config.ts";
import { findingsStore, newFindingId, postsOf } from "./findings.ts";
import { type Heard, heardLine, heardOpen, ownerSays } from "./owner.ts";
import { type PrRow, prsStore } from "./store.ts";
import { capLevel, ciOf, findingCounts, MAX_FINDINGS, opinionOf, reviewDraft, reviewerModel, reviewPrompt, reviewSystem, type Sat, unreviewedOf, verdictOf } from "./reviewer.ts";

/** How long a reviewer may take; a panel's reviewers answer side by side. */
const REVIEW_MS = 180_000;
/** A claim older than this was a pass that went away: another may take the PR. */
export const CLAIM_MS = REVIEW_MS + 120_000;
/** At most this many reviews a pass, so one pass stays inside a cron run. */
const PER_PASS = 3;
/** How long a review waits for CI that's still running on the head commit; then it reviews anyway (and the level is capped). */
export const CI_WAIT_MS = 30 * 60_000;
/** Fix rounds per PR; then it's handed to me. */
export const MAX_ROUNDS = 3;
/**
 * What one PR may cost in all, in fix rounds' budgets (`runUsd`). Reviews count towards it: past
 * it no fix round starts, and only code quality reviews (one call, not a panel's).
 */
export const PR_ROUNDS_USD = 3;
/** A PR handed to me is looked at again this often: merged or closed since, or an owner's comment to act on. */
const SETTLE_MS = 10 * 60_000;

export type ReviewDeps = {
  db: D1;
  ghe: Pick<Ghe, "rest" | "graphql">;
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

type RawPr = { state: string; merged?: boolean; draft?: boolean; title?: string; body?: string | null; head: { sha: string }; base?: { sha: string } };

/** "Round 2: a fix session for 2 owner comments.": how an owner-started round says why. */
const ownerRound = (round: number, h: Heard) => `Round ${round}: a fix session for ${heardLine(h)}.`;

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

/**
 * A PR handed to me: merged or closed since, it leaves what needs me. An owner's comment since it
 * was handed over starts a fix round (on new commits, a review first); the cap on what one PR may
 * cost still holds there. Else it's looked at again later.
 */
async function settle(d: ReviewDeps, row: PrRow): Promise<boolean> {
  const store = prsStore(d.db, d.now);
  const pr = await d.ghe.rest<RawPr>(`/repos/${row.repo}/pulls/${row.number}`);
  if (pr.merged) return store.move(row.pr, "yours", "merged", { why: "Merged on GitHub." });
  if (pr.state !== "open") return store.move(row.pr, "yours", "closed", { why: "Closed on GitHub." });
  const heard = await ownerSays(d, row, row.heard);
  if (heard.refused) {
    // Said once; what's refused isn't asked about again.
    await store.heard(row.pr, (d.now ?? Date.now)());
    await store.release(row.pr, { why: heard.refused });
    return row.why !== heard.refused;
  }
  if (heard.said.length) {
    if (!row.head || pr.head.sha !== row.head) return store.move(row.pr, "yours", "reviewing", { why: `${heardLine(heard)} since it was handed over, on new commits: reviewing those first.` });
    return store.move(row.pr, "yours", "fixing", { round: row.round + 1, why: ownerRound(row.round + 1, heard) });
  }
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
  const [files, issue, config, heard, limits] = await Promise.all([
    loadPrFiles(d.ghe as Ghe, row.repo, row.number),
    issueAt ? d.ghe.rest<{ title?: string; body?: string | null }>(`/repos/${issueAt.repo}/issues/${issueAt.number}`) : Promise.resolve(undefined),
    loadAutoConfig(d.ghe, row.repo, pr.base?.sha ?? ""),
    ownerSays(d, row, row.heard),
    d.auto.limits(row.repo).catch(() => undefined),
  ]);
  const user = reviewPrompt(
    { repo: issueAt?.repo ?? row.repo, number: issueAt?.number ?? 0, title: issue?.title ?? "(the issue couldn't be read)", body: issue?.body ?? "" },
    { repo: row.repo, number: row.number, title: pr.title ?? "", body: pr.body ?? "" },
    files,
    await loadContext(d.ghe, row.repo, head, files),
  );
  // Who reviews: code quality, and the specialists this diff calls for while the PR is inside what it may cost.
  const called = panelFor(files).filter((s): s is Seat & { who: Specialist } => s.who !== "quality");
  const cap = limits ? PR_ROUNDS_USD * limits.runUsd : Infinity;
  const spent = called.length > 0 && row.cost >= cap;
  const sitting = spent ? [] : called;
  const panel = ["quality" as const, ...sitting.map((s) => s.who)];
  const ask = (who: (typeof panel)[number]) =>
    d.ask!.ask({ system: reviewSystem(who, panel), user, model, signal: AbortSignal.timeout(REVIEW_MS) }).then(
      (r) => ({ ...r, failed: "" }),
      (e) => ({ text: "", cost: 0, failed: String((e as Error)?.message ?? e).slice(0, 200) || "no answer" }),
    );
  const [main, ...others] = await Promise.all(panel.map(ask));
  const cost = [main!, ...others].reduce((n, r) => n + r.cost, 0);
  if (main!.failed) {
    await store.release(row.pr, { cost, why: `The reviewer didn't answer: ${main!.failed}. It tries again on the next pass.` });
    return "moved";
  }
  const v = verdictOf(main!.text, files);
  // An answer Dovre can't read isn't tried again on its own: that would spend on every pass.
  if (!v) {
    await store.release(row.pr, { cost });
    return (await store.move(row.pr, "reviewing", "yours", { why: "The reviewer answered, but not with a level Dovre could read." })) ? "moved" : undefined;
  }
  // Each specialist: what it made of the diff, or why this commit went without it.
  const theirs: Found[][] = [];
  const sat: Sat[] = called.map((seat, i) => {
    if (spent) return { ...seat, missing: `this PR has cost $${row.cost.toFixed(2)}, the cap for one PR` };
    const r = others[i]!;
    if (r.failed) return { ...seat, missing: "its reviewer didn't answer" };
    const o = opinionOf(r.text, files, seat.who);
    if (!o) return { ...seat, missing: "its reviewer's answer couldn't be read" };
    theirs.push(o.findings);
    return { ...seat, summary: o.summary };
  });
  const open = heardOpen(heard);
  // A problem an earlier review raised stays the finding it was, with what the owner said about it.
  const kept = findingsStore(d.db, d.now);
  const found = foldFound([v.findings, ...theirs]).slice(0, MAX_FINDINGS);
  const again = raisedAgain(found, await kept.of(row.pr));
  const all = found.map((f, i) => {
    const was = again.get(i);
    return was ? { ...f, id: was.id, status: was.status, raised: was.raised + 1 } : { ...f, id: newFindingId(), status: "open" as const, raised: 1 };
  });
  // One the owner said to ignore isn't posted again, and doesn't hold the PR back.
  const findings = all.filter((f) => f.status !== "force-ignore");
  const gating = all.filter(gates).length;
  const unreviewed = unreviewedOf(sat);
  const facts = { ci, files, ...(config.sizeLimit ? { sizeLimit: config.sizeLimit } : {}), ...(open ? { owner: open } : {}), ...(unreviewed.length ? { unreviewed } : {}) };
  const capped = capLevel(v.level, { ...facts, gating });
  // What it would be with no finding holding it back: the level once the owner says to ignore those (decide.ts).
  const base = capLevel(v.level, { ...facts, gating: 0 }).level;
  const posted = await postReview(d.ghe as Ghe, d.db, row.repo, row.number, { reviewed: head, me: d.login, draft: reviewDraft({ ...v, findings }, capped, { model, head, ignored: all.length - findings.length, panel: sat }), verdict: "comment", by: "auto", kind: "autoreview.review" });
  if (!posted.ok) {
    // New commits since it read, most often: the next pass reviews the new head.
    await store.release(row.pr, { cost, why: posted.message });
    return "moved";
  }
  await kept.reported(
    row.pr,
    { round: row.round, head, ...(posted.id ? { review: posted.id } : {}) },
    all.map(({ status, raised, ...f }) => ({ ...f, ...(raised > 1 ? { again: status === "force-ignore" ? ("left" as const) : ("posted" as const) } : {}) })),
  );
  // Which line comment posts each finding. Not known now: a fix round asks again (fix.ts).
  if (posted.id && findings.length)
    await d.ghe
      .rest<unknown>(`/repos/${row.repo}/pulls/${row.number}/reviews/${posted.id}/comments?per_page=100`)
      .then((comments) => kept.posted(row.pr, postsOf(comments)))
      .catch(() => {});
  await store.level(row.pr, "reviewing", { head, level: capped.level, base, cost, ...(posted.id ? { review: posted.id } : {}) });
  const too = sat.filter((p) => !p.missing).map((p) => TOPIC[p.who]);
  const said = `Level ${capped.level} from ${model}${too.length ? ` (reviewed for ${too.join(", ")} too)` : ""}: ${findingCounts(findings).toLowerCase()}${capped.why.length ? `; capped because ${capped.why[0]}` : ""}.`;
  await decide(d, { ...row, cost: row.cost + cost }, { level: capped.level, fixable: gating, ci, said, merge: config.merge, heard, ...(posted.id ? { review: posted.id } : {}) });
  return "reviewed";
}

/**
 * After a review, on that exact commit: level 5 merges (merge.ts) when the repo's `.dovre/auto.json`
 * says so; a fix round when a finding must be fixed (`fixable`) and the limits allow one; else the PR is
 * handed to me, saying why. An owner's comment is something to fix, and past the rounds' limit
 * or without progress it still gets its round: I asked. What one PR may cost still caps it.
 */
async function decide(d: ReviewDeps, row: PrRow, r: { level: number; fixable: number; ci: string; said: string; merge: boolean; heard: Heard; review?: number }): Promise<void> {
  const store = prsStore(d.db, d.now);
  const hand = (why: string) => store.move(row.pr, "reviewing", "yours", { why: `${r.said} ${why}` });
  if (r.heard.refused) return void (await hand(r.heard.refused));
  const mine = r.heard.said.length;
  if (r.level >= 5) {
    if (!r.merge) return void (await hand(`Mergeable as is. Automerge is off for this repo (\`${AUTO_CONFIG}\`), so it's yours to merge.`));
    return void (await store.move(row.pr, "reviewing", "merging", { why: `${r.said} Merging it once the checks before a merge pass.` }));
  }
  const red = r.ci === "red";
  if (!r.fixable && !red && !mine) return void (await hand("Nothing for a fix session to do: over to you."));
  if (!r.review && !mine) return void (await hand("Its review's comments couldn't be found for a fix session."));
  if (row.round >= MAX_ROUNDS && !mine) return void (await hand(`${MAX_ROUNDS} fix rounds done, and it's still at level ${r.level}.`));
  const levels = [...row.levels.map((l) => l.level), r.level];
  if (!mine && levels.length >= 3 && r.level <= levels[levels.length - 3]!) return void (await hand("Its level hasn't gone up in two rounds."));
  const limits = await d.auto.limits(row.repo);
  const cap = PR_ROUNDS_USD * limits.runUsd;
  if (row.cost >= cap) return void (await hand(`It has cost $${row.cost.toFixed(2)}, the cap for one PR ($${cap.toFixed(2)}).`));
  const what = [mine ? heardLine(r.heard) : "", r.fixable ? `${r.fixable} finding${r.fixable === 1 ? "" : "s"}` : "", red ? "CI failing" : ""].filter(Boolean).join(", ");
  await store.move(row.pr, "reviewing", "fixing", { round: row.round + 1, why: `${r.said} Round ${row.round + 1}: a fix session for ${what}.` });
}
