/**
 * Auto review, a core pack (#326): the review half of auto runs. Each auto run's draft PR gets
 * review rounds: a reviewer's findings and its level from 1 to 5, fix sessions on the PR's branch
 * for the critical and high findings, and a merge at 5, within hard limits. It requires the agents pack, and reads its auto runs only
 * through what that pack shares (its `auto` share, read with `autoOf`), importing only the
 * share's type and reader (../agents/share.ts).
 * It keeps the PRs (store.ts) and each review's findings as records (findings.ts, #555), reviews
 * each new head commit (round.ts, reviewer.ts), starts fix sessions from the findings that must be
 * fixed (fix.ts, fixer.ts) and shows the levels on the PR's page (view.ts).
 * Level 5 merges where the repo's `.dovre/auto.json` allows it (merge.ts, config.ts). A PR handed
 * to me is a need, rung once per PR and round. On the PR's page I say of a finding to fix it or
 * to ignore it (decide.ts, #555 step 3).
 */
import { repoIn, runId } from "../../../actions/deploys.ts";
import type { Complete } from "../../../ai/llm.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { writeClicksStore } from "../../../writes.ts";
import { type Pack, type PackContext, PACK_API } from "../../types.ts";
import { autoOf } from "../agents/share.ts";
import { DECISIONS, type Decision, decideFinding } from "./decide.ts";
import { type Finding, findingsStore } from "./findings.ts";
import { fixPass } from "./fix.ts";
import { mergePass } from "./merge.ts";
import { reviewPass } from "./round.ts";
import { type PrRow, prsStore } from "./store.ts";
import { DECIDE_HREF, findingsFact, levelFact } from "./view.ts";

type AutoreviewDeps = {
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
  /** Each kept PR's findings, as the last refresh read them, by the PR's address. */
  let found = new Map<string, Finding[]>();
  /** What my last word on a finding did, by PR: on its page for a little while (the page redraws itself when it's told, so not just once). */
  const flash = new Map<string, { ok: boolean; message: string; at: number }>();
  const FLASH_MS = 30_000;
  const keep = (next: PrRow[], findings: Finding[]) => {
    rows = next;
    byPr = new Map(rows.map((r) => [key(r.repo, r.number), r]));
    found = new Map();
    for (const f of findings) found.set(f.pr, [...(found.get(f.pr) ?? []), f]);
    // As reported: the oldest first.
    for (const list of found.values()) list.sort((a, b) => a.at - b.at);
  };
  const read = async (ctx: PackContext) => keep(await prsStore(ctx.db).all(), await findingsStore(ctx.db).recent());
  /** Keeps what's new from the agents pack's share, then (`review`) reviews what's due; tells the page once if anything changed. */
  const pass = async (ctx: PackContext, review: boolean) => {
    const auto = autoOf(ctx);
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
    const before = JSON.stringify([rows, [...found]]);
    await read(ctx);
    if (changed || JSON.stringify([rows, [...found]]) !== before) ctx.publish(["autoreview"]);
  };
  return {
    manifest: {
      api: PACK_API,
      id: "autoreview",
      name: "Auto review",
      description: "Review rounds on auto runs' PRs: findings and a level from 1 to 5, fix sessions for the critical and high ones, a merge at 5",
      domain: "general",
      answers: ["agents:many", "catch:agents"],
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
      { kind: "review", label: "Post the reviewer's findings on an auto PR, as a Comment review" },
      { kind: "fix", label: "Push a fix session's commits onto an auto PR's branch" },
      { kind: "reply", label: "Reply on an auto PR's review threads from a fix session" },
      { kind: "merge", label: "Merge an auto PR once its review reaches level 5 and CI is green, where the repo's .dovre/auto.json allows it" },
      { kind: "decide", label: "Say of a finding on an auto PR to fix it or to ignore it" },
    ],
    init: read,
    refresh: (ctx) => pass(ctx, !ctx.hosted),
    scheduled: (_e, ctx) => pass(ctx, true),
    needs: (ctx) =>
      rows
        .filter((r) => r.state === "yours")
        .map((r) => ({
          key: `autoreview:${r.pr}:${r.round}`,
          title: `Auto PR ${r.repo}#${r.number} is handed to you${r.level !== null ? ` at level ${r.level}` : ""}`,
          ...(r.why ? { line: r.why.slice(0, 300) } : {}),
          href: ctx.pageOn("/prs") ? `/prs/${r.repo}/${r.number}` : r.pr,
          tone: "warn" as const,
          at: r.updated,
          ring: "autoreview-yours",
        })),
    slots: () => ({
      "pr.facts": ({ repo, number }) => {
        const r = byPr.get(key(repo, number));
        if (!r) return [];
        const told = flash.get(r.pr);
        const said = told && Date.now() - told.at < FLASH_MS ? told : undefined;
        if (told && !said) flash.delete(r.pr);
        const findings = findingsFact(found.get(r.pr) ?? [], { repo: r.repo, number: r.number, live: r.state !== "merged" && r.state !== "closed", ...(said ? { flash: { ok: said.ok, message: said.message } } : {}) });
        return findings ? [levelFact(r), findings] : [levelFact(r)];
      },
    }),
    routes(app, ctx) {
      // My word on a finding, from the PR's page: checked against the PRs and findings kept, never the form's say-so.
      app.post(DECIDE_HREF, async (c) => {
        const form = await c.req.parseBody();
        const repo = repoIn(deps.github?.owners() ?? "", form.repo);
        const number = runId(form.number);
        const id = typeof form.id === "string" && /^[0-9a-f]{12}$/.test(form.id) ? form.id : "";
        const to = (DECISIONS as readonly unknown[]).includes(form.to) ? (form.to as Decision) : undefined;
        const row = repo && number ? byPr.get(key(repo, number)) ?? (await prsStore(ctx.db).all()).find((r) => key(r.repo, r.number) === key(repo, number)) : undefined;
        if (!row || !id || !to) return c.text("That isn't a finding on a PR Auto review follows.", 400);
        const r = await decideFinding({ db: ctx.db }, { pr: row.pr, id, to });
        if (r.detail) await ctx.logged({ kind: "decide", target: `${row.repo}#${row.number}`, detail: r.detail, ok: r.ok });
        flash.set(row.pr, { ok: r.ok, message: r.message, at: Date.now() });
        await read(ctx);
        ctx.publish(["autoreview"]);
        return c.redirect(ctx.pageOn("/prs") ? `/prs/${row.repo}/${row.number}` : "/", 303);
      });
    },
  };
}
