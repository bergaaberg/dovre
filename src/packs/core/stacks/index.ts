/**
 * Stacks, a core pack (#408): every stack of PRs around my PRs and my review requests, bottom
 * first, problems first (model.ts), read by walking each chain (source.ts); a PR whose base
 * merged can be retargeted onto the default branch from here (act.ts: re-checked first, logged,
 * the write kind core's `pr.retarget`). It tells the viewer where a PR sits ("pr.stack"). Only
 * where the forge has stacks (GitHub): the entry points leave it out elsewhere.
 */
import { html } from "hono/html";
import { repoIn, runId } from "../../../actions/deploys.ts";
import type { Kept } from "../../../kept.ts";
import { settle, within } from "../../../pages/later.ts";
import { prTabs } from "../../../pages/parts.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { type Pack, PACK_API } from "../../types.ts";
import { branchName, retarget } from "./act.ts";
import { type StackPr, stacksOf, waitText } from "./model.ts";
import { createStacks } from "./source.ts";
import { stacksBody } from "./view.ts";

export type StacksDeps = {
  /** The forge, to walk the chains and retarget. */
  ghe: Ghe;
  /** Whose repos are mine (REPO_OWNERS): only theirs are read and written. */
  owners: () => string;
  /** Kept forge answers (data/catalog.json), so a walk after a restart is cheap. */
  kept?: Kept;
};

const HREF = "/stacks";

export function stacksPack(deps: StacksDeps): Pack {
  let source: ReturnType<typeof createStacks> | undefined;
  const sourceOf = () => (source ??= createStacks(deps.ghe, deps.owners(), { kept: deps.kept }));
  /** The last walk, for the viewer's line: a slot answers from memory, never waits. */
  let last: StackPr[] | undefined;
  const load = (login: string, o?: { fresh?: boolean }) => sourceOf().load(login, o).then((prs) => ((last = prs), prs));
  let flash: { ok: boolean; message: string } | undefined;
  return {
    manifest: {
      api: PACK_API,
      id: "stacks",
      name: "Stacks",
      description: "Stacked PRs around yours and your review requests, bottom first, retargeted when a base merges",
      domain: "work",
      execution: "any",
    },
    pages: () => [{ title: "Stacks", href: HREF, icon: "≡", about: "Stacked PRs, bottom first", also: ["stacked", "chain", "retarget"] }],
    slots: (ctx) => ({
      "pr.stack": (a) => {
        const login = ctx.snapshot()?.login;
        // Not walked yet: start it, and the line shows on a later visit.
        if (!last && login) void load(login).catch(() => undefined);
        for (const st of last ? stacksOf(last) : []) {
          const node = st.nodes.find((x) => x.pr.repo === a.repo && x.pr.number === a.number);
          if (node && st.nodes.length > 1) return html`<a href="${HREF}">${node.position} of ${st.nodes.length} in a stack</a>${node.waits ? ` · ${waitText(node.waits)}` : ""}`;
        }
        return "";
      },
    }),
    routes(app, ctx) {
      app.get(HREF, async (c) => {
        const s = await ctx.gathered();
        const me = s?.login ?? "";
        const shown = flash;
        flash = undefined;
        const base = { org: deps.owners(), me, forge: ctx.forge()?.name ?? "GitHub", tabs: prTabs("stacks", true, ctx.pageOn("/dependabot")) };
        // A first read walks every chain (seconds): the page says so and fills itself in.
        const got = s ? await within(settle(load(me))) : undefined;
        if (!got) return ctx.page(c, { title: "Stacks · Dovre", current: "/prs", body: stacksBody({ ...base, pending: true }) });
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        return ctx.page(c, { title: "Stacks · Dovre", current: "/prs", body: stacksBody({ ...base, flash: shown, ...(got.ok ? { stacks: stacksOf(got.value, { since }) } : { error: got.error }) }) });
      });
      app.post(`${HREF}/retarget`, async (c) => {
        const form = await c.req.parseBody();
        const repo = repoIn(deps.owners(), form.repo);
        const number = runId(form.number);
        const from = branchName(form.from);
        const r = repo && number && from ? await retarget(deps.ghe, ctx.db, repo, number, from) : { ok: false, message: "That isn't a PR in the org." };
        flash = r;
        const login = ctx.snapshot()?.login;
        if (r.ok && login) void load(login, { fresh: true }).catch(() => undefined);
        return c.redirect(HREF, 303);
      });
    },
  };
}
