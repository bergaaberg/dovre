/**
 * Dependabot, a core pack (#407, dovre#108): the open bumps across the owners' repos, security
 * fixes first; combining a repo's bumps into one PR, adding groups to its dependabot.yml, and
 * merging the green combined PRs. Locally, the bumps a combined PR left out can be added in a
 * checkout, lockfiles made again (relock.ts). Each write runs after the redirect, re-checks
 * first and is logged; the write kinds are core's (`pr.*` in src/writes.ts). Only where the forge
 * has Dependabot (GitHub): the entry points leave it out elsewhere.
 */
import type { Context } from "hono";
import { repoIn } from "../../../actions/deploys.ts";
import type { AppEnv } from "../../../env.ts";
import { prTabs } from "../../../pages/parts.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { type Pack, PACK_API } from "../../types.ts";
import { addGroups, combine, loadQueue, MAX_MERGE, mergeCombined } from "./act.ts";
import { dependabotBody, type Job } from "./view.ts";

export type DependabotDeps = {
  /** The forge, to read the queue and write. */
  ghe: Ghe;
  /** Whose repos are mine (REPO_OWNERS): only theirs are read and written. */
  owners: () => string;
  /** Local mode: adds the bumps a combined PR left out, lockfiles made again in a checkout (relock.ts). */
  relock?: (repo: string, number: number) => Promise<{ ok: boolean; message: string; url?: string }>;
  /** After a write: gather again. */
  stale?: () => void;
};

export const HREF = "/dependabot";
type Queue = Awaited<ReturnType<typeof loadQueue>>;

export function dependabotPack(deps: DependabotDeps): Pack {
  let queue: { at: number; value: Queue } | undefined;
  let loading: Promise<Queue> | undefined;
  const load = (fresh = false) => {
    if (!fresh && queue && Date.now() - queue.at < 2 * 60_000) return Promise.resolve(queue.value);
    loading ??= loadQueue(deps.ghe, deps.owners())
      .then((value) => ((queue = { at: Date.now(), value }), value))
      .finally(() => (loading = undefined));
    return loading;
  };
  /** Combining and adding groups run after the redirect; the page shows each running, then what happened, once. */
  const jobs = new Map<string, Job>();
  return {
    manifest: {
      api: PACK_API,
      id: "dependabot",
      name: "Dependabot",
      description: "Dependabot's open bumps across your repos, combined into one PR per repo and merged when green",
      domain: "work",
      execution: "any",
    },
    pages: () => [{ title: "Dependabot", href: HREF, icon: "⇄", about: "Open bumps by repo, combined and merged", also: ["dependabot", "bumps", "dependencies", "combine", "security"] }],
    routes(app, ctx) {
      const after = (job: Promise<unknown>, c: Context<AppEnv>) => {
        const done = job
          .then(() => load(true).catch(() => undefined))
          .finally(() => {
            deps.stale?.();
            ctx.publish(["dependabot", "snapshot"]);
          });
        try {
          c.executionCtx.waitUntil(done);
        } catch {}
      };
      app.get(HREF, async (c) => {
        const shown = [...jobs.values()];
        for (const [k, j] of jobs) if (j.state === "done") jobs.delete(k);
        const org = deps.owners();
        const tabs = prTabs("dependabot", ctx.pageOn("/stacks"), true, ctx.pageOn("/prs"));
        const got = await Promise.race([load().then((value) => ({ ok: true as const, value }), (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) })), new Promise<undefined>((res) => setTimeout(res, 1500))]);
        const body = !got ? dependabotBody({ org, pending: true, jobs: shown, tabs }) : dependabotBody({ org, jobs: shown, relock: !!deps.relock, tabs, ...(got.ok ? got.value : { error: got.error }) });
        return ctx.page(c, { title: "Dependabot · Dovre", current: "/prs", body });
      });
      const write = (what: Job["what"], run: (repo: string, form: Record<string, unknown>) => Promise<{ ok: boolean; message: string; url?: string }>) => async (c: Context<AppEnv>) => {
        const form = await c.req.parseBody();
        const repo = repoIn(deps.owners(), form.repo);
        if (!repo) {
          jobs.set("?", { repo: String(form.repo ?? "").slice(0, 100), what, state: "done", ok: false, message: "That isn't a repo of the owners." });
          return c.redirect(HREF, 303);
        }
        const key = `${what}:${repo}`;
        if (jobs.get(key)?.state !== "running") {
          jobs.set(key, { repo, what, state: "running" });
          after(
            run(repo, form)
              .then((r) => jobs.set(key, { repo, what, state: "done", ok: r.ok, message: r.message, url: r.url }))
              .catch((e) => jobs.set(key, { repo, what, state: "done", ok: false, message: String((e as Error)?.message ?? e) })),
            c,
          );
        }
        return c.redirect(HREF, 303);
      };
      app.post(`${HREF}/combine`, write("combine", (repo) => combine(deps.ghe, ctx.db, repo, { security: queue?.value.repos.find((r) => r.repo === repo)?.prs.filter((p) => p.security).map((p) => p.number) ?? [] })));
      app.post(`${HREF}/groups`, write("groups", (repo) => addGroups(deps.ghe, ctx.db, repo)));
      app.post(
        `${HREF}/relock`,
        write("relock", async (repo, form) => {
          const n = typeof form.number === "string" && /^\d{1,9}$/.test(form.number) ? Number(form.number) : 0;
          if (!deps.relock || ctx.hosted) return { ok: false, message: "Adding left-out bumps runs in local mode only: it needs a checkout." };
          if (!n) return { ok: false, message: "That isn't a combined PR." };
          return deps.relock(repo, n);
        }),
      );
      // Bulk merge of green combined PRs (dovre#108): each re-checked on its own after the redirect; MAX_MERGE at most.
      app.post(`${HREF}/merge`, async (c) => {
        const form = await c.req.parseBody({ all: true });
        const picks = ([] as unknown[]).concat(form.pick ?? []).filter((v): v is string => typeof v === "string").slice(0, MAX_MERGE);
        const key = "merge:combined PRs";
        if (!picks.length) {
          jobs.set(key, { repo: "combined PRs", what: "merge", state: "done", ok: false, message: "Tick one or more combined PRs first." });
          return c.redirect(HREF, 303);
        }
        if (jobs.get(key)?.state === "running") return c.redirect(HREF, 303);
        jobs.set(key, { repo: "combined PRs", what: "merge", state: "running" });
        after(
          (async () => {
            const lines: string[] = [];
            let done = 0;
            for (const p of picks) {
              const at = p.lastIndexOf("#");
              const repo = repoIn(deps.owners(), p.slice(0, at));
              const n = /^\d{1,9}$/.test(p.slice(at + 1)) ? Number(p.slice(at + 1)) : 0;
              if (!repo || !n) {
                lines.push("A PR outside the owners' repos was left alone.");
                continue;
              }
              const r = await mergeCombined(deps.ghe, ctx.db, repo, n);
              if (r.ok) done++;
              else lines.push(r.message);
            }
            jobs.set(key, { repo: "combined PRs", what: "merge", state: "done", ok: done === picks.length, message: `Merged ${done} of ${picks.length}.${lines.length ? ` ${lines.slice(0, 5).join(" ")}` : ""}` });
          })().catch((e) => jobs.set(key, { repo: "combined PRs", what: "merge", state: "done", ok: false, message: String((e as Error)?.message ?? e) })),
          c,
        );
        return c.redirect(HREF, 303);
      });
    },
  };
}
