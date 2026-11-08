/**
 * History, a core pack (#387): the forge's weeks on /stats. My merged PRs and reviews given, how
 * long my PRs wait, the org's merges and releases, how often main is red, and the open PRs by
 * age. Gathered in two queries every six hours (store.ts), sooner when Stats asks for a longer
 * reach or I press Gather again; kept in data/stats.json locally. Only where the forge gathers
 * stats (GitHub): the entry points leave it out elsewhere.
 */
import { type Pack, type PackContext, PACK_API } from "../../types.ts";
import type { HistoryStore } from "./store.ts";
import { historyStats } from "./view.ts";

export type HistoryDeps = {
  /** Made on first use, with a way to tell open Stats pages a gather ended. */
  history: (changed: () => void) => HistoryStore;
  /** The forge's name, for "from GitHub" (default GitHub). */
  forge?: string;
  now?: () => number;
};

export function historyPack({ history, forge = "GitHub", now = Date.now }: HistoryDeps): Pack {
  let store: HistoryStore | undefined;
  // Made on first use, whichever hook comes first (an entry that never inits, like the demo, still draws).
  const storeOf = (ctx: PackContext) => (store ??= history(() => ctx.publish(["stats"])));
  return {
    manifest: {
      api: PACK_API,
      id: "history",
      name: "History",
      description: `Your PRs and reviews, and the org's merges, releases and red main, week by week from ${forge}`,
      domain: "work",
      execution: "any",
      everyMs: 60 * 60_000,
    },
    async refresh(ctx, o) {
      storeOf(ctx).refresh(o?.asked === true);
    },
    stats(ctx, o) {
      const s = storeOf(ctx);
      // A visit gathers when it's due, or at once for a reach the kept history lacks; never waits.
      s.refresh(false, o);
      return historyStats(s.view(), { now: now(), weeks: o.weeks, days: o.days, forge, viewer: ctx.pageOn("/prs") });
    },
  };
}
