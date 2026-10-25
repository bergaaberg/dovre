/**
 * Things shown in place instead of linking out: a PR opened inline (summary, size, checks,
 * reviews, description) and what a deploy ships. GHE is one "Open ↗" away, in a new tab.
 */
import { html } from "hono/html";
import type { Summary } from "../ai/summaries.ts";
import { deploySummaryKey, prSummaryKey, type Result } from "../gather.ts";
import { type Changelog, groupChanges, KIND_TITLE } from "../sources/changelog.ts";
import type { Pr } from "../sources/ghe.ts";
import { type Child, type Html, KeyValues, Notice, Pill } from "../ui/kit.ts";
import type { PrSlotArg, RefRule } from "../packs/types.ts";
import { appRefs } from "../todo/links.ts";
import { markdown } from "../ui/markdown.ts";
import { Ago, Link, prPills, safeUrl } from "./parts.ts";
import { type ForgeView, forgeCan, GITHUB_VIEW } from "../forge/types.ts";

export type SummaryOf = (key: string) => Summary | undefined;
/** The agent-review block for a PR card (src/pages/reviews.ts), when agents can run here. */
export type AgentOf = (p: Pr) => Html | "";

export const prAnchor = (p: { repo: string; number: number }) => `pr-${p.repo.replace(/[^\w-]/g, "-")}-${p.number}`;

/** The line that says what a change is, or that it's being worked out. */
export function aiLine(s: Summary | undefined): Html | "" {
  if (!s) return "";
  if (s.state === "pending") return html`<p class="ai pending">Writing a summary…</p>`;
  if (s.state === "failed") return html`<p class="ai failed" title="${s.error}">No summary: ${s.error.slice(0, 120)}</p>`;
  return html`<p class="ai"><span class="spark">Summary</span>${s.text}</p>`;
}

/** Where a PR's changes are: the top folders by lines touched. */
export function areas(files: Pr["files"], depth = 2, top = 4): { area: string; lines: number; files: number }[] {
  const m = new Map<string, { lines: number; files: number }>();
  for (const f of files) {
    const parts = f.path.split("/");
    const area = parts.length > depth ? parts.slice(0, depth).join("/") + "/" : parts.slice(0, -1).join("/") + "/" || "/";
    const a = m.get(area) ?? { lines: 0, files: 0 };
    a.lines += f.additions + f.deletions;
    a.files++;
    m.set(area, a);
  }
  return [...m.entries()].map(([area, v]) => ({ area: area === "/" ? "(root)" : area, ...v })).sort((a, b) => b.lines - a.lines).slice(0, top);
}

const REVIEW_TONE: Record<string, "ok" | "bad" | undefined> = { APPROVED: "ok", CHANGES_REQUESTED: "bad" };
const REVIEW_WORD: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };

function checksLine(runs: Pr["runs"]): Child {
  if (!runs.length) return html`<span class="t3">none reported</span>`;
  const by = (st: string) => runs.filter((r) => r.state === st);
  const bad = by("bad");
  const pending = by("pending");
  return html`${bad.length ? html`${Pill({ tone: "bad", children: `${bad.length} failing` })} ${bad.slice(0, 4).map((r) => html`${Link(r.url, r.name)} `)}` : ""}${pending.length ? Pill({ tone: "warn", children: `${pending.length} running` }) : ""} ${Pill({ tone: "ok", children: `${by("ok").length} passed` })}${by("skipped").length ? html` <span class="t3">${by("skipped").length} skipped</span>` : ""}`;
}

/** What a PR opened in place shows: the summary, who reviewed, checks, where it changes things, the description. */
/** What packs put on a PR (the "pr.lead" and "pr.facts" slots: atlas's tier and docs). */
export type PrSlots = { lead(pr: PrSlotArg): Child[]; facts(pr: PrSlotArg): [Child, Child][] };

export function prBody(p: Pr, opts: { summary: SummaryOf; agent?: AgentOf; slots?: PrSlots; /** The forge: without Dovre's viewer, the PR opens on the forge. */ forge?: ForgeView }): Html {
  const forge = opts.forge ?? GITHUB_VIEW;
  const sum = opts.summary(prSummaryKey(p));
  const where = areas(p.files);
  const reviewers: Child[] = [
    ...p.reviews.map((r) => Pill({ tone: REVIEW_TONE[r.state], children: `${r.login} ${REVIEW_WORD[r.state] ?? r.state.toLowerCase()}` })),
    ...p.requested.map((r) => Pill({ children: `${r} asked` })),
  ];
  return html`${aiLine(sum)}
${KeyValues([
  ["Reviews", reviewers.length ? html`<span class="pills">${reviewers}</span>` : html`<span class="t3">nobody yet</span>`],
  ["Checks", checksLine(p.runs)],
  ...(p.openThreads ? ([["Threads", Pill({ tone: "warn", children: `${p.openThreads} unresolved` })]] as [Child, Child][]) : []),
  ["Touches", where.length ? html`${where.map((a) => html`<span class="area"><code>${a.area}</code> <span class="t3">${a.files} ${a.files === 1 ? "file" : "files"}, ${a.lines} lines</span></span>`)}` : html`<span class="t3">no files</span>`],
  ...(p.labels.length ? ([["Labels", html`<span class="pills">${p.labels.map((l) => Pill({ children: l }))}</span>`]] as [Child, Child][]) : []),
  ...(opts.slots?.facts(p) ?? []),
])}
${p.body.trim() ? html`<div class="description">${markdown(p.body)}</div>` : html`<p class="t3">No description.</p>`}
${opts.agent?.(p) ?? ""}
<div class="buttons">${
    forgeCan(forge, "viewer")
      ? html`<a class="btn primary" href="${safeUrl(`/prs/${p.repo}/${p.number}`)}">Open</a><a class="btn" href="${safeUrl(`/prs/${p.repo}/${p.number}/files`)}">Files</a>${Link(p.url, html`Open on ${forge.name} ↗`, "btn ghost")}`
      : Link(p.url, html`Open on ${forge.name} ↗`, "btn primary")
  }</div>`;
}

/** A PR as a list row that opens in place. */
export function prCard(p: Pr, opts: { org: string; summary: SummaryOf; agent?: AgentOf; showAuthor?: boolean; open?: boolean; slots?: PrSlots; forge?: ForgeView }): Html {
  const short = p.repo.replace(`${opts.org}/`, "");
  const sum = opts.summary(prSummaryKey(p));
  return html`<li><details class="thread pr" id="${prAnchor(p)}"${opts.open ? html` open` : ""}>
<summary class="item"><span class="lead"><span class="repo-tag">${short}</span>${opts.slots?.lead(p) ?? ""}</span><span class="main"><span class="title"><strong>#${p.number} ${p.title}</strong> ${prPills(p)}</span><span class="line">${opts.showAuthor ? html`${p.author} · ` : ""}${p.branch} · <span class="ok">+${p.additions}</span> <span class="bad">−${p.deletions}</span> in ${p.files.length} files</span>${
    sum?.state === "ready" ? html`<span class="clamp ai-clamp">${sum.text}</span>` : ""
  }</span><span class="trail">${Ago(p.updatedAt)}</span></summary>
<div class="thread-body">${prBody(p, opts)}</div></details></li>`;
}

/** What a waiting deploy ships, under its row. */
export function changelogBlock(r: Result<Changelog> | undefined, opts: { summary: SummaryOf; /** The packs' kinds of reference (a ticket key…), linked beside each change. */ rules?: RefRule[]; ghe: string }): Html | "" {
  if (!r) return "";
  if (!r.ok) return Notice({ tone: "warn", children: html`Couldn't work out what this ships: ${r.error}` });
  const c = r.value;
  if (!c.prodSha) return html`<p class="t3">No successful ${c.env} deploy found to compare with.</p>`;
  if (!c.changes.length) return Notice({ children: html`<strong>Already live.</strong> This commit is what ${c.env} runs now (deployed ${c.prodAt ? html`${Ago(c.prodAt)} ago` : "before"}), so approving changes nothing. It's a leftover run: reject it.` });
  const prs = c.changes.filter((x) => x.pr && x.kind !== "deps").length;
  const bumps = c.changes.filter((x) => x.kind === "deps").length;
  const groups = groupChanges(c.changes);
  /** Each reference the commit message names once, as a link. */
  const refs = (text: string) => {
    const seen = new Set<string>();
    return appRefs(text, opts.rules).flatMap(({ ref }) => (ref.kind !== "app" || seen.has(ref.text) || !seen.add(ref.text) ? [] : [html` ${Link(ref.url, ref.text, "ref-key")}`]));
  };
  const row = (x: (typeof c.changes)[number]) =>
    html`<li>${x.pr ? Link(`https://${opts.ghe}/${c.repo}/pull/${x.pr}`, `#${x.pr}`, "num") : html`<code class="num">${x.sha}</code>`} <span>${x.title}</span> <span class="t3">${x.author.replace(/\[bot\]$/, "")}</span>${refs(x.text)}</li>`;
  return html`<div class="changelog">
<p class="ships"><strong>Ships ${c.commits} ${c.commits === 1 ? "commit" : "commits"}${prs ? ` · ${prs} ${prs === 1 ? "PR" : "PRs"}` : ""}${bumps ? ` + ${bumps} dependency ${bumps === 1 ? "bump" : "bumps"}` : ""}</strong> <span class="t2">since ${c.env} at <code>${c.prodSha.slice(0, 7)}</code> (${c.prodAt ? Ago(c.prodAt) : "?"} ago) · <span class="ok">+${c.additions}</span> <span class="bad">−${c.deletions}</span> in ${c.files} files</span> ${Link(c.compareUrl, "Compare ↗")}</p>
${aiLine(opts.summary(deploySummaryKey(c)))}
${groups.map((g) =>
  g.kind === "deps"
    ? html`<details class="fold-deps"><summary>${KIND_TITLE[g.kind]} <span class="t3">${g.changes.length}</span></summary><ul class="changes">${g.changes.map(row)}</ul></details>`
    : html`<h4 class="change-kind">${KIND_TITLE[g.kind]} <span class="t3">${g.changes.length}</span></h4><ul class="changes">${g.changes.map(row)}</ul>`,
)}
</div>`;
}
