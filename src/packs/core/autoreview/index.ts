/**
 * Auto review, a core pack (#326): the review half of auto runs. Each auto run's draft PR gets
 * review rounds: a reviewer's level from 1 to 5, fix sessions on the PR's branch from its comments,
 * and a merge at 5, within hard limits. It requires the agents pack, and reads its auto runs only
 * through what that pack shares (`ctx.required("agents", "auto")`), never by importing it.
 * It keeps the PRs (store.ts), reviews each new head commit (round.ts, reviewer.ts), starts fix
 * sessions from the comments (fix.ts, fixer.ts) and shows the levels on the PR's page (view.ts).
 * Level 5 merges where the repo's `.dovre/auto.json` allows it (merge.ts, config.ts). A PR handed
 * to me is a need, rung once per PR and round.
 */
import type { Complete } from "../../../ai/llm.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { writeClicksStore } from "../../../writes.ts";
import { type Pack, type PackContext, PACK_API } from "../../types.ts";
import { fixPass } from "./fix.ts";
import { mergePass } from "./merge.ts";
import { reviewPass } from "./round.ts";
import { type PrRow, prsStore } from "./store.ts";
import { levelFact } from "./view.ts";

export type AutoreviewDeps = {
  /** The forge, to read PRs and post reviews: without it, PRs are kept but not reviewed. */
  github?: { ghe: Pick<Ghe, "rest" | "graphql">; owners: () => string };
  /** The model route the reviewer asks (the assistant's), when one can answer. */
  reviewer?: (ctx: PackContext) => { ask: Complete; model: string } | undefined;
};

export function autoreviewPack(deps: AutoreviewDeps = {}): Pack {
  /** The kept PRs, as the last refresh read them: slots answer from memory. */
  let rows: PrRow[] = [];
  const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
  let byPr = new Map<string, PrRow>();
  const keep = (next: PrRow[]) => {
    rows = next;
    byPr = new Map(rows.map((r) => [key(r.repo, r.number), r]));
  };
  /** Keeps what's new from the agents pack's share, then (`review`) reviews what's due; tells the page once if anything changed. */
  const pass = async (ctx: PackContext, review: boolean) => {
    const auto = ctx.required("agents", "auto");
    if (!auto) return;
    const store = prsStore(ctx.db);
    let changed = false;
    for (const p of await auto.prs()) if (await store.add({ pr: p.pr, issue: p.key, run: p.run })) changed = true;
    const login = ctx.forge()?.login;
    if (review && deps.github && login)
      changed =
        (await reviewPass({
          db: ctx.db,
          ghe: deps.github.ghe,
          owners: deps.github.owners(),
          login,
          auto,
          ask: deps.reviewer?.(ctx),
          model: ctx.env.AUTOREVIEW_MODEL,
          clicks: () => writeClicksStore(ctx.db).get(),
          log: (l) => ctx.log(l),
        })) || changed;
    if (review && deps.github && login)
      changed =
        (await fixPass({ db: ctx.db, ghe: deps.github.ghe, owners: deps.github.owners(), login, auto, clicks: () => writeClicksStore(ctx.db).get(), log: (l) => ctx.log(l) })) || changed;
    if (review && deps.github && login)
      changed =
        (await mergePass({ db: ctx.db, ghe: deps.github.ghe, owners: deps.github.owners(), login, clicks: () => writeClicksStore(ctx.db).get(), log: (l) => ctx.log(l) })) || changed;
    const before = JSON.stringify(rows);
    keep(await store.all());
    if (changed || JSON.stringify(rows) !== before) ctx.publish(["autoreview"]);
  };
  return {
    manifest: {
      api: PACK_API,
      id: "autoreview",
      name: "Auto review",
      description: "Review rounds on auto runs' PRs: a level from 1 to 5, fix sessions from the comments, a merge at 5",
      domain: "general",
      execution: "any",
      requires: ["agents"],
      settings: [{ key: "AUTOREVIEW_MODEL", label: "Reviewer model", help: "The model that reviews auto PRs (opus, sonnet, haiku or a full id). Never the one that wrote the PR: when it's the same, another reviews. Empty: the assistant's." }],
      rings: [{ kind: "autoreview-yours", label: "An auto PR is handed to me", hint: "Auto review stopped on it: a limit, nothing left to fix, or level 5 where it doesn't merge on its own" }],
      // After the agents pack's auto pass, on the same beat.
      everyMs: 2 * 60_000,
      // Hosted, reviews run from the cron: a page's refresh is cut off long before a model answers.
      crons: ["*/5 * * * *"],
    },
    writes: [
      { kind: "review", label: "Post the reviewer's comments on an auto PR, as a Comment review" },
      { kind: "fix", label: "Push a fix session's commits onto an auto PR's branch" },
      { kind: "reply", label: "Reply on an auto PR's review threads from a fix session" },
      { kind: "merge", label: "Merge an auto PR once its review reaches level 5 and CI is green, where the repo's .dovre/auto.json allows it" },
    ],
    async init(ctx) {
      keep(await prsStore(ctx.db).all());
    },
    refresh: (ctx) => pass(ctx, !ctx.hosted),
    scheduled: (_e, ctx) => pass(ctx, true),
    needs: () =>
      rows
        .filter((r) => r.state === "yours")
        .map((r) => ({
          key: `autoreview:${r.pr}:${r.round}`,
          title: `Auto PR ${r.repo}#${r.number} is handed to you${r.level !== null ? ` at level ${r.level}` : ""}`,
          ...(r.why ? { line: r.why.slice(0, 300) } : {}),
          href: `/prs/${r.repo}/${r.number}`,
          tone: "warn" as const,
          at: r.updated,
          ring: "autoreview-yours",
        })),
    slots: () => ({
      "pr.facts": ({ repo, number }) => {
        const r = byPr.get(key(repo, number));
        return r ? [levelFact(r)] : [];
      },
    }),
  };
}
