/**
 * What the agents pack shares with the packs that require it (#326): its auto runs, for Auto
 * review, and fix sessions on their PRs within auto runs' limits (src/actions/autofix.ts). The
 * shape is core's (AutoShare in src/packs/types.ts), so neither pack imports the other.
 */
import type { Desk } from "../../../agents/desk.ts";
import { autoStore, loadAutoSettings, repoOn } from "../../../agents/auto.ts";
import { landFix, saidOf, startFix } from "../../../actions/autofix.ts";
import type { D1 } from "../../../db.ts";
import type { AutoShare } from "../../types.ts";

export function autoShare(db: D1, desk: Desk, o: { owners: () => string; tz?: string; now?: () => number } = { owners: () => "" }): AutoShare {
  const deps = () => ({ db, desk, owners: o.owners(), ...(o.tz ? { tz: o.tz } : {}), ...(o.now ? { now: o.now } : {}) });
  return {
    async prs() {
      const rows = await autoStore(db).all();
      return rows.filter((r) => r.state === "done" && r.pr).map((r) => ({ key: r.key, repo: r.repo, number: r.number, title: r.title, pr: r.pr!, run: r.run, cost: r.cost, updated: r.updated }));
    },
    async run(id) {
      const r = await desk.run(id).catch(() => undefined);
      if (!r) return undefined;
      const said = saidOf(r);
      return { id: r.id, status: r.status, cost: r.cost, model: r.model, ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}), ...(said ? { said } : {}) };
    },
    async limits(repo) {
      const s = await loadAutoSettings(db);
      return { on: repoOn(s, repo), runUsd: s.runUsd, dayUsd: s.dayUsd, minutes: s.minutes };
    },
    fix: (a) => startFix(deps(), a),
    land: (run, to) => landFix(deps(), run, to),
  };
}
