/**
 * Issues, a core pack (#36): my open issues from the forge — assigned to me, mentioning me, opened by
 * me, and triage in chosen repos — at /tracker (core's /issues sends me here when it's on). Read in the
 * background on the pack's schedule; the page draws from memory. On only where the forge has issues
 * (`Forge.issues`, src/forge/types.ts), so a forge pack that brings `issues()` gets it too.
 */
import type { Context } from "hono";
import { html } from "hono/html";
import { logAction } from "../../../actions/deploys.ts";
import type { AppEnv } from "../../../env.ts";
import type { IssueAct } from "../../../forge/types.ts";
import type { Forge } from "../../../forge/types.ts";
import { type Pack, PACK_API, type PackContext } from "../../types.ts";
import { safeUrl } from "../../../pages/parts.ts";
import type { FindItem, PackNeed } from "../../types.ts";
import { ACT_SHOWN_MS, binoLine, cameIn, freshOf, type IssuesKept, keyOf, SET_LABEL, setOf, staleDaysOf, triageReposOf, withActs } from "./model.ts";
import { actOf, doneText, refusal } from "./act.ts";
import { ACT, BULK, BULK_DO, BULK_MAX, type BulkDo, bulkOf, COMMENT, commentPreview, doneOf, HREF, refusedBody, trackerBody } from "./view.ts";

export const ISSUES_PACK_ID = "tracker";

export type IssuesDeps = {
  forge: Pick<Forge, "host" | "can" | "issues" | "viewer" | "issue" | "issueAct">;
  /** The owners' list (OWNERS), as the gather uses it. */
  owners: () => string;
  /** Who I am, once the gather knows; else the forge is asked. */
  login?: () => string | undefined;
  /** Where "New issue" goes; none on hosted. */
  newHref?: string;
  /** Rows offer "Start a task" (the dev-task flow, local only). */
  tasks?: boolean;
  /**
   * Rows offer "Start an agent": a new agent session on the issue (where agents run here). Called
   * once a page, it gives the lookup from a repo to its checkout folder under CODE_DIR.
   */
  agents?: () => (repo: string) => string | undefined;
  now?: () => number;
};

export function issuesPack(o: IssuesDeps): Pack & { kept(): IssuesKept | undefined } {
  const now = o.now ?? Date.now;
  let kept: IssuesKept | undefined;
  /** When each issue came into the assigned and mentioned sets (model.ts cameIn). */
  let came: Map<string, number> | undefined;
  const fresh = () => freshOf(kept?.sets, came ?? new Map(), now());
  const read = async (ctx: PackContext) => {
    const issues = o.forge.issues;
    if (!issues) return;
    try {
      const login = o.login?.() || (await o.forge.viewer()).login;
      const sets = await issues(login, o.owners(), { triage: triageReposOf(ctx.env.ISSUES_TRIAGE_REPOS) });
      recent = recent.filter((r) => now() - r.at < ACT_SHOWN_MS);
      const shown = withActs(sets, recent.map((r) => r.act));
      came = cameIn(came, shown, now());
      // What I did myself isn't news to me.
      for (const r of recent) if (r.act.kind === "assign") came.set(`assigned:${keyOf(r.act)}`, 0);
      kept = { at: now(), sets: shown, login };
    } catch (e) {
      kept = { at: now(), sets: kept?.sets, error: String((e as Error)?.message ?? e).slice(0, 300) };
      ctx.log(`issues: ${kept.error}`);
    }
    ctx.publish([ISSUES_PACK_ID]);
  };
  const canAct = () => !!o.forge.issue && !!o.forge.issueAct;
  const me = () => o.login?.() || kept?.login || "";
  /** Writes of the last few minutes: search lags behind them, so each read shows them on top (model.ts withActs). */
  let recent: { act: IssueAct; at: number }[] = [];
  const applied = (a: IssueAct) => {
    recent = [...recent.filter((r) => now() - r.at < ACT_SHOWN_MS), { act: a, at: now() }];
    if (kept?.sets) kept = { ...kept, sets: withActs(kept.sets, [a]) };
    if (a.kind === "assign") came?.set(`assigned:${keyOf(a)}`, 0);
  };
  return {
    kept: () => kept,
    manifest: {
      api: PACK_API,
      id: ISSUES_PACK_ID,
      name: "Issues",
      description: "My open issues: assigned, mentioning me, opened by me, and triage",
      domain: "work",
      everyMs: 5 * 60_000,
      settings: [
        { key: "ISSUES_TRIAGE_REPOS", label: "Repos to triage", help: "owner/repo, comma-separated: their open issues with no assignee and no label" },
        { key: "ISSUES_STALE_DAYS", label: "Stale after (days)", help: "An issue with no change for this long is marked stale (default 14)" },
      ],
      rings: [
        { kind: "assigned", label: "An issue is assigned to me" },
        { kind: "mentioned", label: "An issue mentions me", hint: "Also where notifications don't reach (a GitHub App token)" },
      ],
    },
    // The forge reading issues is enough: `can: issues` is core's GitHub forms (New work), which a read-only forge lacks.
    available: () => !!o.forge.issues,
    refresh: read,
    nav: () => [{ href: HREF, title: "Issues", icon: "ticket", group: "Plan" }],
    pages: () => [{ title: "Issues", href: HREF, icon: "◎", about: "My open issues: assigned, mentioned, opened, triage", also: ["issues", "assigned", "mentions", "triage", "backlog"] }],
    glance: () => (kept?.sets ? [{ label: "Issues", value: kept.sets.assigned.length }] : []),
    brief() {
      const n = new Set(fresh().map((f) => keyOf(f.issue))).size;
      return n ? [{ text: `${n} new ${n === 1 ? "issue" : "issues"} for you`, href: HREF }] : [];
    },
    needs: (): PackNeed[] =>
      fresh().map(({ set, issue, at }) => ({
        key: `issues:${set}:${keyOf(issue)}`,
        title: `${set === "assigned" ? "Assigned to you" : "You're mentioned"}: ${keyOf(issue)} ${issue.title}`.slice(0, 200),
        href: safeUrl(issue.url),
        tone: "accent",
        rank: 3,
        at,
        ring: set,
        label: "Issue",
      })),
    finds(): FindItem[] {
      const sets = kept?.sets;
      if (!sets) return [];
      const seen = new Set<string>();
      return (["assigned", "mentioned", "authored"] as const).flatMap((s) =>
        sets[s].flatMap((i) => {
          const k = keyOf(i);
          if (seen.has(k)) return [];
          seen.add(k);
          return [{ title: i.title, sub: `${k} · ${SET_LABEL[s].toLowerCase()}`, href: safeUrl(i.url), also: [k, `#${i.number}`, ...i.labels] }];
        }),
      );
    },
    bino: (ctx) => binoLine(kept?.sets, fresh(), triageReposOf(ctx.env.ISSUES_TRIAGE_REPOS).length > 0),
    about: (_ctx, path) => (path.startsWith(HREF) && kept?.sets ? `My open issues page: ${kept.sets.assigned.length} assigned, ${kept.sets.mentioned.length} mentioning me` : undefined),
    routes(app, ctx) {
      const with_ = async (c: Context<AppEnv>, status: number, title: string, body: ReturnType<typeof trackerBody>) => {
        const res = await ctx.page(c, { title, current: HREF, body });
        return new Response(res.body, { status, headers: res.headers });
      };
      const formOf = async (c: Context<AppEnv>) => (await c.req.parseBody()) as Record<string, unknown>;
      const setIn = (f: Record<string, unknown>) => setOf(typeof f.set === "string" ? f.set : undefined);

      // The comment's confirm step: checked like the write, then shown as it will be posted.
      app.post(COMMENT, async (c) => {
        const f = await formOf(c);
        const set = setIn(f);
        if (!canAct()) return c.notFound();
        const asked = actOf({ ...f, kind: "comment" }, o.owners(), me());
        if (!asked.ok) return with_(c, 400, "Not done", refusedBody({ title: "Not posted", why: asked.error, set }));
        const a = asked.act as Extract<IssueAct, { kind: "comment" }>;
        const issue = await o.forge.issue!(a.repo, a.number).catch(() => undefined);
        const no = refusal(issue, a);
        if (no || !issue) return with_(c, 409, "Not done", refusedBody({ title: "Not posted", why: no ?? "", set }));
        return with_(c, 200, `Comment on ${a.repo}#${a.number}`, commentPreview({ issue, body: a.body, set }));
      });

      // Every write: the owners' repo (refused before any URL), re-read now, still allowed, then written and logged.
      const write = async (a: IssueAct): Promise<{ ok: true } | { ok: false; why: string; status: number }> => {
        const target = `${a.repo}#${a.number}`;
        const kind = `issues.${a.kind}`;
        try {
          const no = refusal(await o.forge.issue!(a.repo, a.number), a);
          if (no) {
            await logAction(ctx.db, { kind, target, ok: false, error: no });
            return { ok: false, why: `${target}: ${no}`, status: 409 };
          }
          await o.forge.issueAct!(a);
          await logAction(ctx.db, { kind, target, detail: a.kind === "close" ? a.reason : undefined, ok: true });
        } catch (e) {
          const error = String((e as Error)?.message ?? e).slice(0, 300);
          await logAction(ctx.db, { kind, target, ok: false, error }).catch(() => {});
          return { ok: false, why: `${o.forge.host} said: ${error}`, status: 502 };
        }
        applied(a);
        ctx.log(doneText(a.kind === "close" ? { ...a, reason: a.reason } : a));
        return { ok: true };
      };

      app.post(ACT, async (c) => {
        const f = await formOf(c);
        const set = setIn(f);
        if (!canAct()) return c.notFound();
        const asked = actOf(f, o.owners(), me());
        if (!asked.ok) return with_(c, 400, "Not done", refusedBody({ title: "Not done", why: asked.error, set }));
        const a = asked.act;
        const r = await write(a);
        if (!r.ok) return with_(c, r.status, "Not done", refusedBody({ title: "Not done", why: r.why, set, ...(r.status === 502 ? { tone: "bad" as const } : {}) }));
        ctx.publish([ISSUES_PACK_ID]);
        void read(ctx);
        const target = `${a.repo}#${a.number}`;
        const q = new URLSearchParams({ set, done: a.kind, ref: target, ...(a.kind === "close" ? { reason: a.reason } : {}) });
        return c.redirect(`${HREF}?${q}`, 303);
      });

      // Bulk (dovre#104): each ticked issue checked and written on its own, as ACT does; BULK_MAX at most.
      app.post(BULK, async (c) => {
        const f = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
        const set = setIn({ set: Array.isArray(f.set) ? f.set[0] : f.set });
        if (!canAct()) return c.notFound();
        const what = typeof f.do === "string" && Object.hasOwn(BULK_DO, f.do) ? (f.do as BulkDo) : undefined;
        const picks = ([] as unknown[]).concat(f.pick ?? []).filter((v): v is string => typeof v === "string").slice(0, BULK_MAX);
        if (!what || !picks.length) return with_(c, 400, "Not done", refusedBody({ title: "Not done", why: "Tick one or more issues first.", set }));
        let done = 0;
        const why: string[] = [];
        for (const p of picks) {
          const m = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(p);
          const asked = m ? actOf({ ...BULK_DO[what], repo: m[1], number: m[2] }, o.owners(), me()) : ({ ok: false, error: "Not an issue." } as const);
          if (!asked.ok) {
            why.push(`${p.slice(0, 80)}: ${asked.error}`);
            continue;
          }
          const r = await write(asked.act);
          if (r.ok) done++;
          else why.push(r.why);
        }
        if (done) {
          ctx.publish([ISSUES_PACK_ID]);
          void read(ctx);
        }
        const q = new URLSearchParams({ set, bulk: what, done: String(done), of: String(picks.length) });
        for (const w of why.slice(0, 3)) q.append("why", w.slice(0, 200));
        return c.redirect(`${HREF}?${q}`, 303);
      });

      app.get(HREF, (c) =>
        ctx.page(c, {
          title: "Issues",
          current: HREF,
          head: html`<meta name="u-topics" content="${ISSUES_PACK_ID}">`,
          body: trackerBody({
            kept,
            set: setOf(c.req.query("set")),
            triage: triageReposOf(ctx.env.ISSUES_TRIAGE_REPOS).length > 0,
            staleDays: staleDaysOf(ctx.env.ISSUES_STALE_DAYS),
            now: now(),
            host: o.forge.host,
            newHref: o.newHref,
            acts: canAct() || o.agents ? { me: me(), task: !!o.tasks && canAct(), write: canAct(), agent: o.agents?.() } : undefined,
            done: doneOf({ done: c.req.query("done"), ref: c.req.query("ref"), reason: c.req.query("reason") }),
            bulk: bulkOf({ bulk: c.req.query("bulk"), done: c.req.query("done"), of: c.req.query("of"), why: c.req.queries("why") }),
          }),
        }),
      );
    },
  };
}
