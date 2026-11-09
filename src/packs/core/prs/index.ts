/**
 * Pull requests, a core pack (#409): /prs lists my PRs and the ones asking for my review, in views,
 * filtered and sorted as each viewer left them (a cookie). Where the forge has Dovre's viewer
 * (GitHub), a PR opens here too: its conversation, its files, and my own review of it, kept until I
 * post it (routes.ts). It reads the gathered snapshot (`prs`); the gather stays core. The write
 * kinds (`review.*`) are core's, in src/writes.ts.
 */
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Checkout } from "../../../checkouts.ts";
import { type ForgeView, forgeCan, GITHUB_VIEW } from "../../../forge/types.ts";
import type { Kept } from "../../../kept.ts";
import type { CheckJob } from "../../../reviews/check.ts";
import { draftOf } from "../../../reviews/draft.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import type { Git } from "../../../viewer/code.ts";
import { type AiSummary, type Pack, PACK_API, type PrSlotArg } from "../../types.ts";
import { parsePrQuery, PRS_COOKIE, PRS_KEYS, prQueryString } from "./list.ts";
import { prsBody } from "./listview.ts";
import { createPrRoutes } from "./routes.ts";
import { PRS } from "./view.ts";

type PrsDeps = {
  /** The forge, to read a PR and post my review. */
  ghe: Ghe;
  /** Whose repos are mine (REPO_OWNERS): only their PRs open here. */
  owners: () => string;
  /** The forge's name and what it can do: without `viewer`, a PR opens on the forge. Default: GitHub. */
  forge?: ForgeView;
  /** Kept forge answers (data/catalog.json), so a PR seen before draws at once after a restart. */
  kept?: Kept;
  /**
   * A model to check my review with before I post it (Bino's route), while it's ready. `start`
   * runs the job apart from the request and publishes `topic` when its cards are in; it rejects
   * only when it couldn't start.
   */
  checker?: () => { model: string; start(job: CheckJob, topic: string, publish: (topics: string[]) => void): Promise<void> } | undefined;
  /** After posting my review: gather again, so the lists show it. */
  stale?: () => void;
  /** For tests: the checkouts and the git that reads them. */
  checkouts?: () => Checkout[];
  git?: Git;
};

export function prsPack(deps: PrsDeps): Pack {
  const forge = deps.forge ?? GITHUB_VIEW;
  return {
    manifest: {
      api: PACK_API,
      id: "prs",
      name: "Pull requests",
      description: "Your PRs and the ones asking for your review, each opened here with its files and your own review of it",
      domain: "work",
      via: "forge",
      roles: ["dev", "lead"],
      execution: "any",
    },
    nav: (ctx) => {
      const s = ctx.snapshot();
      const p = s?.prs.ok ? s.prs.value : undefined;
      return [{ href: PRS, title: "Pull requests", short: "PRs", icon: "pr", group: "Code", order: 10, count: p ? p.mine.length + p.review.length : 0, hot: !!p && p.review.length > 0 }];
    },
    pages: () => [{ title: "Pull requests", href: PRS, icon: "⇄", about: "Asking for your review, and yours", also: ["pr", "prs", "reviews", "pull"] }],
    routes(app, ctx) {
      const summary = (key: string) => ctx.fill("ai.summary", { key }).find((x): x is AiSummary => !!x && (x.state === "pending" || (x.state === "ready" && typeof x.text === "string") || (x.state === "failed" && typeof x.error === "string")));
      const agentOf = (p: PrSlotArg) => {
        const out = ctx.fill("pr.agent", p).filter((x) => x !== "");
        return out.length ? html`${out}` : "";
      };
      app.get(PRS, async (c) => {
        // The view, filters and sort (dovre#157): from the link, else as this viewer left them (a cookie).
        const url = new URL(c.req.url);
        const keep = { httpOnly: true, sameSite: "Lax" as const, path: PRS, maxAge: 400 * 86400, secure: url.protocol === "https:" };
        if (url.searchParams.has("reset")) {
          deleteCookie(c, PRS_COOKIE, { path: PRS });
          return c.redirect(PRS, 303);
        }
        const asked = PRS_KEYS.some((k) => url.searchParams.has(k));
        const q = parsePrQuery(asked ? url.searchParams : new URLSearchParams(getCookie(c, PRS_COOKIE) ?? ""));
        if (asked) {
          const str = prQueryString(q);
          if (str) setCookie(c, PRS_COOKIE, str, keep);
          else deleteCookie(c, PRS_COOKIE, { path: PRS });
          // An all-defaults form goes back to the plain address; anything else stays a link to share.
          if (url.search.slice(1) !== str) return c.redirect(str ? `${PRS}?${str}` : PRS, 303);
        }
        const s = await ctx.gathered();
        // Nothing gathered yet: the page that fills itself in.
        if (!s) return ctx.page(c, { title: "Pull requests · Dovre", current: PRS, body: "" });
        const slots = { lead: (p: PrSlotArg) => ctx.fill("pr.lead", p), facts: (p: PrSlotArg) => ctx.fill("pr.facts", p).flat() };
        const body = prsBody(s, summary, agentOf, slots, forge, q, { dependabot: ctx.pageOn("/dependabot"), stacks: ctx.pageOn("/stacks") });
        return ctx.page(c, { title: "Pull requests · Dovre", current: PRS, body });
      });
      // Stacks' and Dependabot's pages are their packs' (#407, #408), at the top level since.
      app.get(`${PRS}/stacks`, (c) => c.redirect("/stacks", 301));
      app.get(`${PRS}/dependabot`, (c) => c.redirect("/dependabot", 301));
      if (!forgeCan(forge, "viewer")) return;
      app.route(
        "/",
        createPrRoutes({
          ghe: deps.ghe,
          page: (c, o) => ctx.page(c, o),
          owners: deps.owners,
          codeDir: ctx.codeDir,
          publish: (topics) => ctx.publish(topics),
          kept: deps.kept,
          checkouts: deps.checkouts,
          git: deps.git,
          db: ctx.db,
          login: async () => (await ctx.gathered())?.login ?? "",
          stale: deps.stale,
          facts: (p) => ctx.fill("pr.facts", p).flat(),
          fileSlot: (f) => html`${ctx.fill("pr.file", f)}`,
          agentFor: async (repo, n) => {
            const s = ctx.snapshot() ?? (await ctx.gathered());
            const p = s?.prs.ok ? [...s.prs.value.mine, ...s.prs.value.review].find((x) => x.repo === repo && x.number === n) : undefined;
            return p ? agentOf(p) : "";
          },
          // A pack's answer, read again as a draft: only a review's own shape goes in.
          agentDraft: async (repo, n) => {
            for (const got of ctx.fill("review.draft", { repo, number: n })) {
              const draft = got && typeof got.sha === "string" ? draftOf("review", got.draft) : null;
              if (draft?.kind === "review") return { sha: got!.sha, draft };
            }
            return undefined;
          },
          // Where it sits in a stack: the stacks pack's line (#408), from memory.
          stackFor: async (repo, n) => ctx.fill("pr.stack", { repo, number: n }).find((x) => !!x) || undefined,
          checker: () => {
            const ck = deps.checker?.();
            return ck ? { model: ck.model, start: (job, topic) => ck.start(job, topic, (t) => ctx.publish(t)) } : undefined;
          },
        }),
      );
    },
  };
}
