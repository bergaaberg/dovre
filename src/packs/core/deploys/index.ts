/**
 * Deploys, a core pack (#406): the runs waiting for my approval, with their changelogs and what's
 * in prod ("deploy.prod"), approved or rejected from here (one by one, ticked, or the superseded
 * ones behind the newest), and the log of what I decided. It reads the gathered snapshot
 * (`deploys`); the gather stays core. Each decision re-checks the run first and is logged; the
 * write kinds are core's (`deploy.*` in src/writes.ts).
 */
import { html } from "hono/html";
import { recentActions, repoIn, runId } from "../../../actions/deploys.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { Empty } from "../../../ui/kit.ts";
import { type AiSummary, type Pack, PACK_API } from "../../types.ts";
import { decide, rejectSuperseded } from "./act.ts";
import { deploysBody } from "./view.ts";

export type DeploysDeps = {
  /** The forge, to decide on a run. */
  ghe: Ghe;
  /** Whose repos are mine (REPO_OWNERS): a run of anyone else's is refused. */
  owners: () => string;
  /** The forge approves deploys from here (GitHub); else the page only lists them. */
  approve: boolean;
  /** After a decision: gather again, so the run shows it. */
  stale?: () => void;
};

const HREF = "/deploys";
type Flash = { ok: boolean; message: string };

export function deploysPack(deps: DeploysDeps): Pack {
  /** What the last decision said, shown once. */
  let flash: Flash | undefined;
  /** Runs decided here that the snapshot may not know yet: drawn as decided until a gather after the decision lands. */
  const decided = new Map<number, { state: "approved" | "rejected"; at: number }>();
  return {
    manifest: {
      api: PACK_API,
      id: "deploys",
      name: "Deploys",
      description: "Runs waiting for your approval, approved or rejected from here, and what you decided",
      domain: "work",
      execution: "any",
    },
    nav: (ctx) => {
      const s = ctx.snapshot();
      const n = s?.deploys.ok ? s.deploys.value.length : 0;
      return [{ href: HREF, title: "Deploys", icon: "rocket", group: "Code", order: 20, count: n, hot: n > 0 }];
    },
    pages: () => [{ title: "Deploys", href: HREF, icon: "⇡", about: "Waiting for prod, and what ships", also: ["release", "prod", "approve", "ship", "utrulling"] }],
    routes(app, ctx) {
      app.get(HREF, async (c) => {
        // No waiting on the gather a decision started: what was decided shows from `decided`, and the page swaps when the gather lands.
        const s = ctx.snapshot() ?? (await ctx.gathered());
        if (!s) return ctx.page(c, { title: "Deploys · Dovre", current: HREF, body: Empty({ title: "Nothing gathered yet" }) });
        for (const [id, d] of decided) if ((s.began ?? s.at) > d.at || Date.now() - d.at > 10 * 60_000) decided.delete(id);
        const shown = flash;
        flash = undefined;
        // Only deploy decisions here; everything else is on Today's Actions card and /actions.
        const log = (await recentActions(ctx.db, 200)).filter((a) => a.kind.startsWith("deploy.")).slice(0, 20);
        const summary = (key: string) => ctx.fill("ai.summary", { key }).find((x): x is AiSummary => !!x && (x.state === "pending" || (x.state === "ready" && typeof x.text === "string") || (x.state === "failed" && typeof x.error === "string")));
        // What's in prod for each repo: the packs' line ("deploy.prod").
        const prodLine = (repo: string) => html`${ctx.fill("deploy.prod", { repo })}`;
        const body = deploysBody(s, { log, flash: shown, decided, summary, rules: ctx.refs(), ghe: deps.ghe.host, prodLine, approve: deps.approve });
        return ctx.page(c, { title: "Deploys · Dovre", current: HREF, body });
      });
      const back = () => {
        deps.stale?.();
        return HREF;
      };
      for (const state of ["approved", "rejected"] as const) {
        app.post(`${HREF}/${state === "approved" ? "approve" : "reject"}`, async (c) => {
          if (!deps.approve) return c.notFound();
          const form = await c.req.parseBody();
          const repo = repoIn(deps.owners(), form.repo);
          const run = runId(form.run);
          flash = repo && run ? await decide(deps.ghe, ctx.db, repo, run, state) : { ok: false, message: "That isn't a run in the org." };
          if (flash.ok && run) decided.set(run, { state, at: Date.now() });
          return c.redirect(back(), 303);
        });
      }
      // Bulk (dovre#104): each ticked run decided on its own, checked again and logged; 20 at most.
      app.post(`${HREF}/bulk`, async (c) => {
        if (!deps.approve) return c.notFound();
        const form = await c.req.parseBody({ all: true });
        const state = form.state === "approved" || form.state === "rejected" ? form.state : null;
        const picks = ([] as unknown[]).concat(form.pick ?? []).filter((v): v is string => typeof v === "string").slice(0, 20);
        if (!state || !picks.length) {
          flash = { ok: false, message: "Tick one or more runs first." };
          return c.redirect(back(), 303);
        }
        let done = 0;
        const failed: string[] = [];
        for (const p of picks) {
          const at = p.lastIndexOf("#");
          const repo = repoIn(deps.owners(), p.slice(0, at));
          const run = runId(p.slice(at + 1));
          if (!repo || !run) {
            failed.push("a run outside the org");
            continue;
          }
          const r = await decide(deps.ghe, ctx.db, repo, run, state);
          if (r.ok) (done++, decided.set(run, { state, at: Date.now() }));
          else failed.push(r.message);
        }
        flash = { ok: !failed.length, message: `${state === "approved" ? "Approved" : "Rejected"} ${done} of ${picks.length}.${failed.length ? ` ${failed.join(" ")}` : ""}` };
        return c.redirect(back(), 303);
      });
      app.post(`${HREF}/reject-superseded`, async (c) => {
        if (!deps.approve) return c.notFound();
        const form = await c.req.parseBody();
        const repo = repoIn(deps.owners(), form.repo);
        const workflow = typeof form.workflow === "string" && form.workflow.length < 200 ? form.workflow : null;
        try {
          const r = repo && workflow ? await rejectSuperseded(deps.ghe, ctx.db, repo, workflow) : { ok: false, message: "That isn't a workflow in the org.", ids: [] };
          for (const id of r.ids) decided.set(id, { state: "rejected", at: Date.now() });
          flash = { ok: r.ok, message: r.message };
        } catch (e) {
          flash = { ok: false, message: String((e as Error).message ?? e) };
        }
        return c.redirect(back(), 303);
      });
    },
  };
}
