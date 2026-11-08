/**
 * AI summaries, a core pack (#390): a short summary on each open PR (at its head commit) and on
 * what each waiting deploy ships, written in the background by a model this machine can ask, kept
 * in the summaries table (store.ts). It reads the newest snapshot on its refresh, queues what's
 * new, and answers the "ai.summary" slot by key; core draws the text. Local only.
 */
import type { Complete } from "../../../ai/llm.ts";
import { deploySummaryKey, prSummaryKey, type Snapshot } from "../../../gather.ts";
import { throttle } from "../../../live.ts";
import { type Pack, type PackContext, PACK_API } from "../../types.ts";
import { createSummaries, deployPrompt, prPrompt, type Summaries } from "./store.ts";

export type SummariesDeps = {
  /** The model that writes them (SUMMARIES picks it in src/index.ts); undefined: none here, so the pack doesn't run. */
  complete?: Complete;
  now?: () => number;
};

/** Queues a summary for every open PR at its head commit and every deploy that ships something. */
export function wantAll(sum: Summaries, s: Snapshot, now: number): void {
  if (s.prs.ok)
    for (const p of [...s.prs.value.review, ...s.prs.value.mine])
      if (p.headSha) sum.want(prSummaryKey(p), () => prPrompt({ ...p, files: p.files }));
  for (const [, c] of s.changelogs)
    if (c.ok && c.value.changes.length) {
      const days = c.value.prodAt ? Math.max(1, Math.round((now - Date.parse(c.value.prodAt)) / 86400e3)) : 0;
      sum.want(deploySummaryKey(c.value), () => deployPrompt({ repo: c.value.repo, days, items: c.value.changes.map((x) => ({ kind: x.kind, title: x.title, author: x.author })) }));
    }
}

export function summariesPack(deps: SummariesDeps): Pack {
  const now = deps.now ?? Date.now;
  /** Made on the first refresh or page, so pages see what was written before a restart. */
  let sum: Summaries | undefined;
  let loading: Promise<Summaries> | undefined;
  const ready = (ctx: PackContext) =>
    (loading ??= (async () => {
      // A finished summary redraws the pages that show it, every 2 s at most.
      const changed = throttle(() => ctx.publish(["snapshot"]), 2000);
      const s = createSummaries(ctx.db, deps.complete!, { onReady: changed });
      await s.load();
      return (sum = s);
    })().catch((e) => {
      loading = undefined;
      throw e;
    }));

  return {
    manifest: {
      api: PACK_API,
      id: "summaries",
      name: "AI summaries",
      description: "A short summary on each PR and deploy, from the PR's own text",
      domain: "general",
      execution: "local-only",
      settings: [
        {
          key: "SUMMARIES",
          label: "Model",
          help: "Which writes them: claude (Haiku through Claude Code), omp (Copilot through omp), copilot (Copilot CLI), agy or codex. Empty: Claude Code when it's here, else omp, else Copilot CLI. Applies on restart.",
        },
      ],
      // Picks up a new gather's PRs and deploys within half a minute; what's queued already is skipped.
      everyMs: 30_000,
    },
    available: () => !!deps.complete,
    refresh: async (ctx) => {
      const s = ctx.snapshot();
      const got = await ready(ctx);
      if (s) wantAll(got, s, now());
    },
    beforePage: async (ctx) => {
      if (!sum) await ready(ctx);
    },
    slots: () => ({
      "ai.summary": ({ key }) => (typeof key === "string" ? sum?.get(key) : undefined),
    }),
  };
}
