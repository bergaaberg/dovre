/** The section pages: pull requests, movement. (Agents and worktrees are the agents pack's.) */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import type { Snapshot } from "../gather.ts";
import { byPerson, type Move, type Pr } from "../sources/ghe.ts";
import { applyPrQuery, choicesOf, CIS, DEFAULT_QUERY, prHref, type PrQuery, SORTS, STATES, type View, viewCounts, VIEWS } from "./prlist.ts";
import { Empty, Item, List, PageHeader, Panel, Tabs } from "../ui/kit.ts";
import { type AgentOf, prCard, type PrSlots, type SummaryOf } from "./inline.ts";
import { Ago, failed, prTabs, safeUrl } from "./parts.ts";
import { type ForgeView, forgeCan, GITHUB_VIEW } from "../forge/types.ts";

const live = "";

export function prsPage(frame: Frame, s: Snapshot, summary: SummaryOf, agent?: AgentOf, slots?: PrSlots, forge: ForgeView = GITHUB_VIEW, q: PrQuery = DEFAULT_QUERY) {
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
  const body = html`${PageHeader({ title: "Pull requests", sub: `${p.review.length} to review · ${p.mine.length} open`, tabs: prTabs("list", forgeCan(forge, "stacks"), forgeCan(forge, "dependabot")) })}
${failed("Pull requests", s.prs)}
<div data-live id="prs-views" class="pr-views">${views}</div>
${form}
<div data-live id="prs">
${panel("Review requested", lists.review, true, "No reviews asked of you")}
${panel("Mine", lists.mine, false, "No open PRs")}
</div>`;
  return shell({ title: "Pull requests · Dovre", frame, current: "/prs", body, head: live });
}

function moveItem(m: Move, s: Snapshot, showActor: boolean) {
  const title = m.title ?? (m.ref ? s.refs.get(m.ref)?.title : undefined);
  const num = m.ref ? `#${m.ref.split("#")[1]} ` : "";
  return Item({
    href: safeUrl(m.url),
    title: html`${showActor ? html`<strong>${m.actor}</strong> ` : ""}${m.verb} ${num}${title ?? ""}`,
    line: m.repo.replace(`${s.org}/`, ""),
    trail: Ago(m.at),
    quiet: m.bot,
  });
}

export function movementPage(frame: Frame, s: Snapshot, view: string) {
  const moves = s.moves.ok ? s.moves.value : [];
  const humans = moves.filter((m) => !m.bot && m.actor !== s.login);
  const bots = moves.filter((m) => m.bot);
  const mine = moves.filter((m) => m.actor === s.login);
  const tabs = Tabs({
    label: "Views",
    items: [
      { href: "/movement", label: "People", n: humans.length, current: view === "people" },
      { href: "/movement?view=timeline", label: "Timeline", n: humans.length, current: view === "timeline" },
      { href: "/movement?view=me", label: "Me", n: mine.length, current: view === "me" },
      { href: "/movement?view=bots", label: "Bots", n: bots.length, current: view === "bots" },
    ],
  });
  let content;
  if (view === "people")
    content = byPerson(humans).map((p) =>
      Panel({ id: `p-${p.who}`, title: p.who, meta: `${p.moves.length} · ${p.repos.map((r) => r.replace(`${s.org}/`, "")).join(", ")}`, flush: true, children: List(p.moves.map((m) => moveItem(m, s, false))) }),
    );
  else {
    const list = view === "bots" ? bots : view === "me" ? mine : humans;
    content = Panel({ flush: true, children: list.length ? List(list.map((m) => moveItem(m, s, view !== "me"))) : Empty({ title: "Nothing in the last 24 hours" }) });
  }
  const body = html`${PageHeader({ title: "Movement", sub: `What happened in ${s.org} in the last 24 hours.`, tabs })}${failed("Movement", s.moves)}<div data-live id="movement">${content}</div>`;
  return shell({ title: "Movement · Dovre", frame, current: "/movement", body, head: live });
}
