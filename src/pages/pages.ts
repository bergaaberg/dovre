/** The section pages: pull requests, movement. (Agents and worktrees are the agents pack's.) */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import type { Snapshot } from "../gather.ts";
import { byPerson, type Move } from "../sources/ghe.ts";
import { Empty, Item, List, PageHeader, Panel, Tabs } from "../ui/kit.ts";
import { type AgentOf, prCard, type PrSlots, type SummaryOf } from "./inline.ts";
import { Ago, failed, prTabs, safeUrl } from "./parts.ts";
import { type ForgeView, forgeCan, GITHUB_VIEW } from "../forge/types.ts";

const live = "";

export function prsPage(frame: Frame, s: Snapshot, summary: SummaryOf, agent?: AgentOf, slots?: PrSlots, forge: ForgeView = GITHUB_VIEW) {
  const p = s.prs.ok ? s.prs.value : { mine: [], review: [] };
  const body = html`${PageHeader({ title: "Pull requests", sub: `${p.review.length} to review · ${p.mine.length} open`, tabs: prTabs("list", forgeCan(forge, "stacks")) })}
${failed("Pull requests", s.prs)}
<div data-live id="prs">
${Panel({ title: "Review requested", meta: String(p.review.length), flush: true, children: p.review.length ? List(p.review.map((x) => prCard(x, { org: s.org, summary, agent, showAuthor: true, slots, forge }))) : Empty({ title: "No reviews asked of you" }) })}
${Panel({ title: "Mine", meta: String(p.mine.length), flush: true, children: p.mine.length ? List(p.mine.map((x) => prCard(x, { org: s.org, summary, agent, slots, forge }))) : Empty({ title: "No open PRs" }) })}
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
