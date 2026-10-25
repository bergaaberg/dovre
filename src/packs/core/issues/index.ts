/**
 * Issues, a core pack (#36): my open issues from the forge — assigned to me, mentioning me, opened by
 * me, and triage in chosen repos — at /tracker (core's /issues sends me here when it's on). Read in the
 * background on the pack's schedule; the page draws from memory. On only where the forge has issues
 * (src/forge/types.ts), so a forge pack that brings `issues()` gets it too.
 */
import { html } from "hono/html";
import { type Forge, forgeCan } from "../../../forge/types.ts";
import { type Pack, PACK_API, type PackContext } from "../../types.ts";
import { safeUrl } from "../../../pages/parts.ts";
import type { FindItem, PackNeed } from "../../types.ts";
import { binoLine, cameIn, freshOf, type IssuesKept, keyOf, SET_LABEL, setOf, staleDaysOf, triageReposOf } from "./model.ts";
import { HREF, trackerBody } from "./view.ts";

export const ISSUES_PACK_ID = "tracker";

export type IssuesDeps = {
  forge: Pick<Forge, "host" | "can" | "issues" | "viewer">;
  /** The owners' list (OWNERS), as the gather uses it. */
  owners: () => string;
  /** Who I am, once the gather knows; else the forge is asked. */
  login?: () => string | undefined;
  /** Where "New issue" goes; none on hosted. */
  newHref?: string;
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
      came = cameIn(came, sets, now());
      kept = { at: now(), sets };
    } catch (e) {
      kept = { at: now(), sets: kept?.sets, error: String((e as Error)?.message ?? e).slice(0, 300) };
      ctx.log(`issues: ${kept.error}`);
    }
    ctx.publish([ISSUES_PACK_ID]);
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
    available: () => !!o.forge.issues && forgeCan(o.forge, "issues"),
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
          }),
        }),
      );
    },
  };
}
