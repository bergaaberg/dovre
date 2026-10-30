/**
 * Auto review, a core pack (#326): the review half of auto runs. Each auto run's draft PR gets
 * review rounds: a reviewer's level from 1 to 5, fix sessions on the PR's branch from its comments,
 * and a merge at 5, within hard limits. It requires the agents pack, and reads its auto runs only
 * through what that pack shares (`ctx.required("agents", "auto")`), never by importing it.
 * This step keeps the PRs (store.ts) and shows their levels on the PR's page (view.ts); the
 * reviewer, fix sessions and merging come in #326's later steps.
 */
import { type Pack, PACK_API } from "../../types.ts";
import { type PrRow, prsStore } from "./store.ts";
import { levelFact } from "./view.ts";

export function autoreviewPack(): Pack {
  /** The kept PRs, as the last refresh read them: slots answer from memory. */
  let rows: PrRow[] = [];
  const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
  let byPr = new Map<string, PrRow>();
  const keep = (next: PrRow[]) => {
    rows = next;
    byPr = new Map(rows.map((r) => [key(r.repo, r.number), r]));
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
      // After the agents pack's auto pass, on the same beat.
      everyMs: 2 * 60_000,
    },
    writes: [
      { kind: "review", label: "Post the reviewer's comments on an auto PR, as a Comment review" },
      { kind: "reply", label: "Reply on an auto PR's review threads from a fix session" },
      { kind: "merge", label: "Merge an auto PR once its review reaches level 5 and CI is green" },
    ],
    async init(ctx) {
      keep(await prsStore(ctx.db).all());
    },
    async refresh(ctx) {
      const auto = ctx.required("agents", "auto");
      if (!auto) return;
      const store = prsStore(ctx.db);
      let added = false;
      for (const p of await auto.prs()) if (await store.add({ pr: p.pr, issue: p.key })) added = true;
      const before = JSON.stringify(rows);
      keep(await store.all());
      if (added || JSON.stringify(rows) !== before) ctx.publish(["autoreview"]);
    },
    slots: () => ({
      "pr.facts": ({ repo, number }) => {
        const r = byPr.get(key(repo, number));
        return r ? [levelFact(r)] : [];
      },
    }),
  };
}
