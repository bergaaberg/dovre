/** The pull requests page. (Moved is the movement pack's; agents and worktrees the agents pack's.) */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import type { Snapshot } from "../gather.ts";
import type { Pr } from "../sources/ghe.ts";
import { applyPrQuery, choicesOf, CIS, DEFAULT_QUERY, prHref, type PrQuery, SORTS, STATES, type View, viewCounts, VIEWS } from "./prlist.ts";
import { Empty, List, PageHeader, Panel, Tabs } from "../ui/kit.ts";
import { type AgentOf, prCard, type PrSlots, type SummaryOf } from "./inline.ts";
import { failed, prTabs } from "./parts.ts";
import { type ForgeView, forgeCan, GITHUB_VIEW } from "../forge/types.ts";

const live = "";

export function prsPage(frame: Frame, s: Snapshot, summary: SummaryOf, agent?: AgentOf, slots?: PrSlots, forge: ForgeView = GITHUB_VIEW, q: PrQuery = DEFAULT_QUERY, /** `dependabot: false`: its pack is off here, so no tab. */ on: { dependabot?: boolean } = {}) {
  const p = s.prs.ok ? s.prs.value : { mine: [], review: [] };
  const lists = applyPrQuery(p, q);
  const counts = viewCounts(p, q);
  const filtered = !!(q.repo || q.author || q.state || q.ci);
  const views = Tabs({ label: "Views", items: (Object.keys(VIEWS) as View[]).map((v) => ({ href: prHref({ ...q, view: v }), label: VIEWS[v], n: counts[v], current: q.view === v })) });
  const select = (field: string, label: string, options: [string, string][], value: string | undefined, any: string) =>
    html`<label class="field"><span class="label">${label}</span><select name="${field}">${any ? html`<option value="">${any}</option>` : ""}${options.map(([v, l]) => html`<option value="${v}"${v === value ? html` selected` : ""}>${l}</option>`)}</select></label>`;
  const c = choicesOf(p);
  const keepRepo = q.repo && !c.repos.includes(q.repo) ? [q.repo] : [];
  const keepAuthor = q.author && !c.authors.includes(q.author) ? [q.author] : [];
  const form = html`<form method="get" action="/prs" class="pr-filter" data-autofilter>${q.view !== "all" ? html`<input type="hidden" name="view" value="${q.view}">` : ""}<div class="fields">
${select("sort", "Sort", Object.entries(SORTS), q.sort, "")}
${select("repo", "Repo", [...c.repos, ...keepRepo].map((r) => [r, r.replace(`${s.org}/`, "")]), q.repo, "Any repo")}
${select("author", "Author", [...c.authors, ...keepAuthor].map((a) => [a, a]), q.author, "Anyone")}
${select("state", "State", Object.entries(STATES), q.state, "Any state")}
${select("ci", "CI", Object.entries(CIS), q.ci, "Any")}
<div class="field buttons"><button type="submit" class="sm">Apply</button>${filtered || q.view !== "all" || q.sort !== "attention" ? html`<a class="btn sm" href="/prs?reset=1">Reset</a>` : ""}</div>
</div></form>`;
  const panel = (title: string, list: Pr[] | null, showAuthor: boolean, empty: string) =>
    list === null ? "" : Panel({ title, meta: String(list.length), flush: true, children: list.length ? List(list.map((x) => prCard(x, { org: s.org, summary, agent, showAuthor, slots, forge }))) : Empty({ title: filtered || q.view !== "all" ? "None match" : empty }) });
  const body = html`${PageHeader({ title: "Pull requests", sub: `${p.review.length} to review · ${p.mine.length} open`, tabs: prTabs("list", forgeCan(forge, "stacks"), forgeCan(forge, "dependabot") && on.dependabot !== false) })}
${failed("Pull requests", s.prs)}
<div data-live id="prs-views" class="pr-views">${views}</div>
${form}
<div data-live id="prs">
${panel("Review requested", lists.review, true, "No reviews asked of you")}
${panel("Mine", lists.mine, false, "No open PRs")}
</div>`;
  return shell({ title: "Pull requests · Dovre", frame, current: "/prs", body, head: live });
}
