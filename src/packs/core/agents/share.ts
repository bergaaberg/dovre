/**
 * What the agents pack shares with the packs that require it (#326): its auto runs, for Auto
 * review, and fix sessions on their PRs within auto runs' limits (src/actions/autofix.ts).
 *
 * The `auto` share is this pack's own (#478): core passes it along without knowing its shape. Its
 * type lives here, with `autoOf`, the reader that narrows what `ctx.required` hands back. A pack
 * that reads it imports those two from this file and nothing else of the pack.
 */
import type { Desk } from "../../../agents/desk.ts";
import { autoStore, loadAutoSettings, repoOn } from "../../../agents/auto.ts";
import { landFix, saidOf, startFix } from "../../../actions/autofix.ts";
import type { AutoFixAsk, AutoFixLanded } from "../../../actions/autofix.types.ts";
import type { D1 } from "../../../db.ts";
import type { PackContext } from "../../types.ts";

export type { AutoFixAsk, AutoFixLanded };

/** An auto run that ended in a draft PR (I OK'd it, or it opened on its own); it may have closed since. */
export type AutoPr = { key: string; repo: string; number: number; title: string; pr: string; run: string | null; cost: number; updated: number };

/** A run as its machine reports it now. `said`: the agent's last word, once it has one. */
export type AutoRunResult = { id: string; status: "running" | "done" | "failed" | "stopped"; cost: number; model: string; endedAt?: number; said?: string };

/** Settings' limits for auto runs, which fix sessions share: whether auto runs are on for a repo, and the dollar and minute caps. */
export type AutoLimits = { on: boolean; runUsd: number; dayUsd: number; minutes: number };

/** The agents pack's auto runs (#207), as Auto review reads and extends them. */
export type AutoShare = {
  /** The auto runs that ended in a draft PR, newest first. */
  prs(): Promise<AutoPr[]>;
  /** A run's result, or undefined when no machine has it now. */
  run(id: string): Promise<AutoRunResult | undefined>;
  /** Settings' limits, for `repo`. */
  limits(repo: string): Promise<AutoLimits>;
  /**
   * Starts a fix session within auto runs' limits: the at-once slot it shares with them, the day's
   * cap, quiet hours, Settings' minutes and at most `FIX_TURNS` agent turns. `wait`: not now, and why.
   */
  fix(a: AutoFixAsk): Promise<{ run: string } | { wait: string } | { error: string }>;
  /**
   * A fix session that ended: its commits pushed onto `branch` (never forced), checked to be what
   * it made from `base`, and logged under `kind`. Commits that change CI config aren't pushed.
   */
  land(run: string, to: { repo: string; branch: string; base: string; pr: { number: number; url: string }; kind: string }): Promise<AutoFixLanded>;
};

/** The share's name, and the pack that shares it. */
export const AUTO_SHARE = { pack: "agents", name: "auto" } as const;

const CALLS = ["prs", "run", "limits", "fix", "land"] as const;

/** The `auto` share as a pack that requires or uses agents reads it: undefined while it's off, or when what came back isn't this shape. */
export function autoOf(ctx: Pick<PackContext, "required">): AutoShare | undefined {
  const got = ctx.required(AUTO_SHARE.pack, AUTO_SHARE.name);
  if (!got || typeof got !== "object") return undefined;
  return CALLS.every((k) => typeof (got as Record<string, unknown>)[k] === "function") ? (got as AutoShare) : undefined;
}

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
