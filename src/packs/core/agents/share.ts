/**
 * What the agents pack shares with the packs that require it (#326): its auto runs, read-only,
 * for Auto review. The shape is core's (AutoShare in src/packs/types.ts), so neither pack imports
 * the other.
 */
import type { Desk } from "../../../agents/desk.ts";
import { autoStore } from "../../../agents/auto.ts";
import type { D1 } from "../../../db.ts";
import type { AutoShare } from "../../types.ts";

export function autoShare(db: D1, desk: Pick<Desk, "run">): AutoShare {
  return {
    async prs() {
      const rows = await autoStore(db).all();
      return rows.filter((r) => r.state === "done" && r.pr).map((r) => ({ key: r.key, repo: r.repo, number: r.number, title: r.title, pr: r.pr!, run: r.run, cost: r.cost, updated: r.updated }));
    },
    async run(id) {
      const r = await desk.run(id).catch(() => undefined);
      return r ? { id: r.id, status: r.status, cost: r.cost, model: r.model, ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}) } : undefined;
    },
  };
}
