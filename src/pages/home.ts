/**
 * Today (design C, the morning view): a briefing, the horizon of the last 24 hours, then two
 * columns of cards (ready to ship, my list; my pull requests, operations; the packs', agents among them)
 * beside a live log of what's moving, docked at the right (src/home/feed.ts). Lists are short: what
 * needs me first, the rest counted and a link away. Every row opens in place.
 */
import { html } from "hono/html";
import { type Snapshot, prSummaryKey } from "../gather.ts";
import { eyebrow, glance, greeting, lede } from "../home/brief.ts";
import { type FeedEvent, feedOf, mergeFeeds } from "../home/feed.ts";
import { horizon } from "../home/horizon.ts";
import type { Need } from "../home/needs.ts";
import { KIND_LABEL } from "../home/needs.ts";
import { type Frame, shell } from "../html.ts";
import { type Deploy, type Pr, prKeyOfUrl, prNeeds } from "../sources/ghe.ts";
import { Card, Confirm, type Html, Item } from "../ui/kit.ts";
import { type ForgeView, forgeCan, GITHUB_VIEW } from "../forge/types.ts";
import type { Off } from "../packs/registry.ts";
import { type Column, type Layout, type Slot, placeCards } from "../layout.ts";
import type { Bit, Glance, Lane, RefRule, TodayCard } from "../packs/types.ts";
import { type AgentOf, changelogBlock, prAnchor, prBody, type SummaryOf } from "./inline.ts";
import { Ago, Chev, harnessTag, Link, mineByKey, safeUrl, st, trunc } from "./parts.ts";
import { currentGreeting, currentTz } from "../when.ts";

const hm = (at: number | string, tz = currentTz()) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(typeof at === "string" ? Date.parse(at) : at);
const short = (repo: string, org: string) => repo.replace(`${org}/`, "");


/** A need as a list row (other pages). */
export const needItem = (n: Need) =>
  Item({ href: safeUrl(n.href), lead: html`<span class="kind${n.tone === "neutral" ? "" : ` ${n.tone}`}">${KIND_LABEL[n.kind]}</span>`, title: n.title, line: n.line ? trunc(n.line, 220) : undefined, trail: Ago(n.at) });

function bits(sentence: Bit[]) {
  return sentence.map((b) =>
    typeof b === "string" ? b : b.code ? html`<code>${b.code}</code>` : html`<a href="${safeUrl(b.href)}"${b.tone ? html` class="${b.tone}"` : ""}>${b.text}</a>`,
  );
}


// ── Ready to ship ─────────────────────────────────────────────────────────────

function deployRow(d: Deploy, s: Snapshot, summary: SummaryOf, ghe: string, rules?: RefRule[], approve = true) {
  const log = s.changelogs.get(d.id);
  const live = !!(log?.ok && log.value.prodSha && !log.value.changes.length);
  const shipsPrs = log?.ok ? log.value.changes.filter((c) => c.pr && c.kind !== "deps").length : 0;
  const fields = { repo: d.repo, run: String(d.id) };
  const repo = short(d.repo, s.org);
  const env = d.envs.map((e) => e.name).join(", ");
  const decide = !approve ? html`<div class="buttons">${Link(d.url, "Open ↗", "btn ghost")}</div>` : html`<div class="buttons">${
    live
      ? Confirm({ kind: "deploy.reject", action: "/deploys/reject", fields, label: "Reject leftover run", danger: true, question: html`This commit is already live in ${env}. Reject the run so it stops waiting?` })
      : Confirm({ kind: "deploy.approve", action: "/deploys/approve", fields, label: `Approve deploy to ${env}`, question: html`Ship <strong>${repo}</strong> <code>${d.sha}</code> to ${env}?` })
  }${live ? "" : Confirm({ kind: "deploy.reject", action: "/deploys/reject", fields, label: "Reject", danger: true, question: html`Reject <strong>${repo}</strong> <code>${d.sha}</code>? The run ends without deploying.` })}${
    d.superseded.length
      ? Confirm({ kind: "deploy.reject-superseded", action: "/deploys/reject-superseded", fields: { repo: d.repo, workflow: d.name }, label: `Reject ${d.superseded.length}${d.more ? "+" : ""} superseded runs`, danger: true, question: html`Reject the older waiting runs of <strong>${d.name}</strong> in ${repo}? They end as rejected. This one stays waiting.` })
      : ""
  }${Link(d.url, "Run ↗", "btn ghost")}</div>`;
  return html`<li class="row has-quick">
<details id="dep-${d.id}">
<summary><span class="row-k">${repo} <span class="sha">${d.sha}</span></span><span class="row-t">${d.title}</span><span class="row-m">${live ? st("mute", "Already live") : st("warn", html`Waiting ${Ago(d.createdAt)}`)}${
    log?.ok && log.value.changes.length ? html`<span>${log.value.commits} commits${shipsPrs ? ` · ${shipsPrs} PRs` : ""}</span>` : ""
  }${d.superseded.length ? html`<span>${d.superseded.length}${d.more ? "+" : ""} superseded</span>` : ""}<span>by ${d.actor}</span></span>${Chev}</summary>
<div class="expand">${changelogBlock(log, { summary, ghe, rules })}${decide}</div>
</details>
${approve ? html`<div class="quick">${
    live
      ? Confirm({ kind: "deploy.reject", action: "/deploys/reject", fields, label: "Reject", danger: true, question: html`Already live: reject this leftover run?` })
      : Confirm({ kind: "deploy.approve", action: "/deploys/approve", fields, label: "Approve", question: html`Ship <strong>${repo}</strong> <code>${d.sha}</code> to ${env}?` })
  }</div>` : ""}
</li>`;
}

function shipCard(s: Snapshot, summary: SummaryOf, ghe: string, rules?: RefRule[], approve = true) {
  const deploys = s.deploys.ok ? s.deploys.value : [];
  const oldest = deploys.reduce((m, d) => Math.min(m, Date.parse(d.createdAt)), Infinity);
  const releases = (s.moves.ok ? s.moves.value : []).filter((m) => m.verb === "released").slice(0, 8);
  return html`<section class="card" id="ship" aria-labelledby="ship-h">
<div class="card-h"><h2 id="ship-h">Ready to ship</h2><p>${deploys.length ? html`${deploys.length} waiting · oldest ${Ago(oldest)}` : "nothing waiting"}</p></div>
${!s.deploys.ok ? html`<p class="notes bad">Deploys didn't load: ${s.deploys.error}</p>` : ""}
<ul class="rows">${deploys.length ? deploys.map((d) => deployRow(d, s, summary, ghe, rules, approve)) : html`<li class="row"><p class="empty">Nothing waits for prod.</p></li>`}</ul>
${releases.length ? html`<h3 class="sub-h">Released since yesterday <span class="cnt">${releases.length}</span></h3><ul class="shipped">${releases.map((m) => html`<li><time>${hm(m.at)}</time><b>${short(m.repo, s.org)}</b><span class="tag">${Link(m.url, m.title ?? "release")}</span></li>`)}</ul>` : ""}
</section>`;
}

// ── My pull requests ──────────────────────────────────────────────────────────

function prState(p: Pr) {
  if (p.checks === "FAILURE" || p.checks === "ERROR") return st("bad", "Build failing");
  if (p.review === "CHANGES_REQUESTED") return st("bad", "Changes requested");
  if (prNeeds(p)[0]?.startsWith("approved")) return st("ok", "Ready to merge");
  if (p.openThreads) return st("warn", `${p.openThreads} open ${p.openThreads === 1 ? "thread" : "threads"}`);
  if (p.checks === "PENDING" || p.checks === "EXPECTED") return st("mute", "Checks running");
  return st("mute", p.review === "APPROVED" ? "Approved" : "Awaiting review");
}

function prRow(p: Pr, s: Snapshot, summary: SummaryOf, showAuthor = false, agent?: AgentOf, forge?: ForgeView) {
  const sum = summary(prSummaryKey(p));
  return html`<li class="row"><details id="${prAnchor(p)}"><summary><span class="row-k">${short(p.repo, s.org)}#${p.number}${showAuthor ? html` <span class="sha">${p.author}</span>` : ""}</span><span class="row-t">${p.title}</span>${
    sum?.state === "ready" ? html`<span class="row-x">${sum.text}</span>` : ""
  }<span class="row-m">${prState(p)}${p.draft ? html`<span>Draft</span>` : ""}<span>${Ago(p.updatedAt)}</span></span>${Chev}</summary><div class="expand">${prBody(p, { summary, agent, forge })}</div></details></li>`;
}

/** Mine first where I'm needed: red, changes asked, threads, ready to merge; then the freshest. */
export function prOrder(prs: Pr[]): Pr[] {
  const weight = (p: Pr) => (p.checks === "FAILURE" || p.checks === "ERROR" ? 0 : p.review === "CHANGES_REQUESTED" ? 1 : p.openThreads ? 2 : prNeeds(p)[0]?.startsWith("approved") ? 3 : p.draft ? 5 : 4);
  return [...prs].sort((a, b) => weight(a) - weight(b) || b.updatedAt.localeCompare(a.updatedAt));
}

/** My open PRs counted by what they wait on (once each, by the first that holds); drafts counted apart. */
export function prStats(mine: Pr[]): { failing: number; changes: number; threads: number; ready: number; drafts: number } {
  const n = { failing: 0, changes: 0, threads: 0, ready: 0, drafts: 0 };
  for (const p of mine) {
    if (p.draft) n.drafts++;
    if (p.checks === "FAILURE" || p.checks === "ERROR") n.failing++;
    else if (p.review === "CHANGES_REQUESTED") n.changes++;
    else if (p.openThreads) n.threads++;
    else if (prNeeds(p)[0]?.startsWith("approved")) n.ready++;
  }
  return n;
}

/** The card stays short: five rows at most, up to three asking for my review, mine filling the rest. */
const SHOW = 5;
const SHOW_REVIEW = 3;

function prsCard(s: Snapshot, summary: SummaryOf, agent?: AgentOf, forge?: ForgeView) {
  const mine = s.prs.ok ? prOrder(s.prs.value.mine) : [];
  const review = s.prs.ok ? s.prs.value.review : [];
  const n = prStats(mine);
  const showReview = Math.min(review.length, SHOW_REVIEW);
  const showMine = SHOW - showReview;
  const more = Math.max(0, mine.length - showMine) + Math.max(0, review.length - showReview);
  return html`<section class="card" id="prs" aria-labelledby="prs-h">
<div class="card-h"><h2 id="prs-h">Pull requests</h2><p>${mine.length} open</p></div>
${!s.prs.ok ? html`<p class="notes bad">Pull requests didn't load: ${s.prs.error}</p>` : ""}
${mine.length ? html`<p class="stat-row">${n.failing ? st("bad", `${n.failing} failing`) : ""}${n.changes ? st("bad", `${n.changes} changes asked`) : ""}${n.threads ? st("warn", `${n.threads} with open threads`) : ""}${n.ready ? st("ok", `${n.ready} ready to merge`) : ""}${n.drafts ? st("mute", `${n.drafts} draft${n.drafts === 1 ? "" : "s"}`) : ""}</p>` : ""}
${review.length ? html`<h3 class="sub-h">Asking for your review <span class="cnt">${review.length}</span></h3><ul class="rows">${review.slice(0, showReview).map((p) => prRow(p, s, summary, true, agent, forge))}</ul><h3 class="sub-h">Yours</h3>` : ""}
<ul class="rows">${mine.slice(0, showMine).map((p) => prRow(p, s, summary, false, agent, forge))}${!mine.length ? html`<li class="row"><p class="empty">No open PRs.</p></li>` : ""}</ul>
<div class="card-f"><span>${more ? html`<a href="/prs">${more} more</a>` : ""}</span><a href="/prs">All ${mine.length + review.length}</a></div>
</section>`;
}

// ── What's moving (docked at the right) ───────────────────────

/** One event: when, a dot in its colour, who did what to what, and where. */
function feedRow(e: FeedEvent, org: string, now: number) {
  return html`<li class="fe${e.mine ? " mine" : ""}" data-key="${e.key}"><time>${now - e.at < 20 * 3600e3 ? hm(e.at) : day(e.at)}</time><div class="fe-b"><p class="fe-l">${st(e.tone, "")}<strong>${e.who}</strong> ${e.what}${e.title ? html` ${e.href ? Link(e.href, trunc(e.title, 110)) : trunc(e.title, 110)}` : ""}</p><p class="fe-m">${e.repo ? short(e.repo, org) : ""}${e.repo ? " · " : ""}${Ago(e.at)}</p></div></li>`;
}

const day = (at: number, tz = currentTz()) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(at);

/**
 * `apps`: the packs' events (src/home/feed.ts packFeedOf). With `only`, the panel is those alone
 * (hosted: the org's GitHub says nothing about my own apps); else they join the org's.
 */
function feedPanel(s: Snapshot, now: number, apps?: { events: FeedEvent[]; only: boolean }) {
  if (apps?.only) {
    return html`<aside class="card feed" id="feed" aria-labelledby="feed-h">
<div class="card-h"><h2 id="feed-h">What's happening</h2><p>in my apps, last 7 days</p></div>
<ol class="feed-list" id="feed-list" data-keep-scroll>${apps.events.length ? apps.events.map((e) => feedRow(e, s.org, now)) : html`<li class="fe"><p class="empty">Quiet so far.</p></li>`}</ol>
</aside>`;
  }
  const events = mergeFeeds(feedOf(s, now), apps?.events.filter((e) => now - e.at < 24 * 3600e3) ?? []);
  return html`<aside class="card feed" id="feed" aria-labelledby="feed-h">
<div class="card-h"><h2 id="feed-h">What's moving</h2><p>last 24 h</p></div>
${!s.moves.ok ? html`<p class="notes bad">Movement didn't load: ${s.moves.error}</p>` : ""}
<ol class="feed-list" id="feed-list" data-keep-scroll>${events.length ? events.map((e) => feedRow(e, s.org, now)) : html`<li class="fe"><p class="empty">Quiet so far.</p></li>`}</ol>
<div class="card-f"><span>People and bots, by person</span><a href="/movement">Moved</a></div>
</aside>`;
}

const legend = (lanes: Lane[]) => html`<ul class="legend">
<li><svg viewBox="0 0 12 12" aria-hidden="true"><line class="lg-mine" x1="2" y1="11" x2="2" y2="1" stroke-width="1.3"/><path class="lg-mine" d="M2 1 9 3.6 2 6.2Z"/></svg>Your merges</li>
<li><svg viewBox="0 0 12 12" aria-hidden="true"><line class="lg-team" x1="2" y1="11" x2="2" y2="1" stroke-width="1.3"/><path class="lg-team" d="M2 1 9 3.6 2 6.2Z"/></svg>Team merges</li>
<li><svg viewBox="0 0 12 12" aria-hidden="true"><path class="lg-rel" d="M6 1 11 6 6 11 1 6Z"/></svg>Released</li>
<li><svg viewBox="0 0 12 12" aria-hidden="true"><path class="lg-wait" d="M6 1.5 10.5 6 6 10.5 1.5 6Z"/></svg>Waiting for prod</li>
${lanes.filter((l) => l.legend).slice(0, 3).map((l) => html`<li><svg viewBox="0 0 12 12" aria-hidden="true"><circle class="lg-mark" cx="6" cy="6" r="4.5"/></svg>${l.legend}</li>`)}
</ul>`;

/** Packs that failed or ran out of time: named, never silently missing (a source that fails shows as failed). */
function packsFailed(failed: Off[]): Html {
  return Card({ id: "packs-failed", title: "Didn't answer", meta: html`<span class="bad">${failed.length}</span>`, children: html`<ul class="list">${failed.map((f) => html`<li><b>${f.name}</b> ${f.why}</li>`)}</ul>` });
}

/** Today's own cards, where they sit unless I move them (Settings → Layout); packs' cards come after. */
export const CORE_CARDS = [
  { id: "ship", label: "What ships", col: "left", order: 20 },
  { id: "todo", label: "My list", col: "left", order: 30 },
  { id: "actions", label: "What Dovre did", col: "left", order: 40 },
  { id: "prs", label: "Pull requests", col: "right", order: 10 },
] as const satisfies readonly { id: string; label: string; col: Column; order: number }[];
type CoreCard = (typeof CORE_CARDS)[number]["id"];
/** A pack card's place by default: after the core's, in the packs' own order. */
export const packOrder = (order: number | undefined) => Math.min(999, 100 + Math.max(0, order ?? 100));

export function homePage(frame: Frame, s: Snapshot, summary: SummaryOf, opts: { /** What the packs add to the briefing: numbers, sentences, horizon rows. */ apps?: { glance: Glance[]; brief: Bit[][]; lanes: Lane[] }; /** Dovre's own packs: their cards sit among the core's by their own order. */ own?: string[]; ghe?: string; /** The forge: what it can't do (approve deploys, Dovre's viewer) isn't offered. */ forge?: ForgeView; /** The packs' kinds of reference. */ rules?: RefRule[]; now?: number; agent?: AgentOf; /** My list's card (src/pages/todo.ts). */ todo?: Html; /** What Dovre did for me (src/pages/actions.ts). */ actions?: Html; /** The packs' `today.hero` slot (the avatar in its scene). */ avatar?: Html | ""; /** The packs' cards, and the packs that didn't answer in time or failed (src/packs/). */ packs?: { cards: TodayCard[]; failed: Off[] }; /** Topics besides "snapshot" that change Today: each pack publishes under its id. */ topics?: string[]; /** The packs' events for the feed; `only` shows them alone (hosted). */ feed?: { events: FeedEvent[]; only: boolean }; /** Where I've put each card (src/layout.ts). */ cards?: Layout["cards"] } = {}) {
  const now = opts.now ?? Date.now();
  const g = glance(s);
  const apps = opts.apps ?? { glance: [], brief: [], lanes: [] };
  const own = (id: string) => (opts.own ?? []).some((c) => id.startsWith(`${c}-`));
  const core: Record<CoreCard, Html | "" | undefined> = {
    ship: shipCard(s, summary, opts.ghe ?? "github.com", opts.rules, forgeCan(opts.forge ?? GITHUB_VIEW, "deployApproval")),
    todo: opts.todo,
    actions: opts.actions,
    prs: prsCard(s, summary, opts.agent, opts.forge),
  };
  const slots: Slot<Html>[] = [
    ...CORE_CARDS.flatMap((c) => (core[c.id] ? [{ ...c, render: core[c.id] as Html }] : [])),
    ...(opts.packs?.cards ?? []).map((c) => ({ id: c.id, label: c.id, col: c.column === "left" ? ("left" as const) : ("right" as const), order: own(c.id) ? Math.max(0, Math.min(999, c.order ?? 100)) : packOrder(c.order), render: c.render })),
  ];
  const cols = placeCards(slots, opts.cards);
  const tz = frame.tz ?? currentTz();
  const lang = frame.greeting ?? currentGreeting();
  const body = html`<div data-live id="today">
<section class="brief" aria-labelledby="greet">
<div><p class="eyebrow">${eyebrow(now, tz)}</p><h1 id="greet">${greeting(now, { tz, lang })}, ${s.name}.</h1><p class="lede">${lede(s, apps.brief).map((sentence, i) => html`${i ? " " : ""}${bits(sentence)}`)}</p></div>
${opts.avatar ?? ""}<dl class="glance" aria-label="Last 24 hours"><div><dt>Merged</dt><dd>${g.merged}</dd></div><div><dt>Released</dt><dd>${g.released}</dd></div>${apps.glance.slice(0, 4).map((x) => html`<div><dt>${x.label}</dt><dd>${x.value}</dd></div>`)}</dl>
</section>
<section class="horizon" aria-labelledby="hz-h"><div class="hz-head"><h2 id="hz-h">The last 24 hours</h2>${legend(apps.lanes)}</div>
${horizon({ moves: s.moves.ok ? s.moves.value : [], deploys: s.deploys.ok ? s.deploys.value : [], lanes: apps.lanes, me: s.login, now, tz })}
</section>
<div class="today-main">
<div class="today-cols">
<div class="today-col">
${cols.left.map((c) => c.render)}
</div>
<div class="today-col">
${cols.right.map((c) => c.render)}
${opts.packs?.failed.length ? packsFailed(opts.packs.failed) : ""}
</div>
</div>
${feedPanel(s, now, opts.feed)}
</div>
</div>`;
  const topics = ["snapshot", ...(opts.topics ?? [])].join(" ");
  return shell({ title: "Dovre", frame, current: "/", body, head: html`<meta name="u-topics" content="${topics}">` });
}
