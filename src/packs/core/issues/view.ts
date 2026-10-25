/** /tracker: my issues by set (tabs), each a row with its labels, linked PRs, sub-issues and age. */
import { html } from "hono/html";
import type { Issue } from "../../../forge/types.ts";
import { ago } from "../../../format.ts";
import { safeUrl } from "../../../pages/parts.ts";
import { Empty, Gauge, type Html, Item, List, Notice, PageHeader, Panel, Pill, Tabs } from "../../../ui/kit.ts";
import { ISSUE_SETS, type IssuesKept, SET_LABEL, type SetId, staleFor } from "./model.ts";

export const HREF = "/tracker";

const prPill = (p: Issue["prs"][number]) =>
  Pill({ tone: p.state === "MERGED" ? "ok" : undefined, title: `${p.key}: ${p.state.toLowerCase()}`, children: `PR #${p.key.split("#")[1]} ${p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed"}` });

export function issueRow(i: Issue, o: { staleDays: number; now: number }): Html {
  const stale = staleFor(i, o.staleDays, o.now);
  const at = Date.parse(i.updatedAt);
  const facts = [Number.isFinite(at) ? `updated ${ago(at, o.now)}` : "", i.comments ? `${i.comments} ${i.comments === 1 ? "comment" : "comments"}` : "", i.milestone ?? "", i.type ?? ""].filter(Boolean).join(" · ");
  const labels = i.labels.length ? html`<span class="issue-labels">${i.labels.map((l) => Pill({ children: l }))}</span> ` : "";
  const trail = html`<span class="issue-trail">${i.prs.map(prPill)}${
    i.subIssues ? html`<span class="issue-subs" title="${`${i.subIssues.done} of ${i.subIssues.total} sub-issues closed`}">${Gauge({ value: i.subIssues.done, max: i.subIssues.total })}<span>${i.subIssues.done}/${i.subIssues.total}</span></span>` : ""
  }${stale !== undefined ? Pill({ tone: "warn", title: `No change in ${stale} days`, children: `stale ${stale} d` }) : ""}</span>`;
  return Item({ href: safeUrl(i.url), lead: html`<span class="issue-ref">${i.repo.split("/")[1] ?? i.repo}#${i.number}</span>`, title: i.title, line: html`${labels}${facts}`, trail });
}

const EMPTY: Record<SetId, string> = {
  assigned: "Nothing assigned to you.",
  mentioned: "No open issue mentions you.",
  authored: "You have no open issues.",
  triage: "Nothing waits for triage.",
};

export function trackerBody(o: { kept: IssuesKept | undefined; set: SetId; triage: boolean; staleDays: number; now: number; host: string; newHref?: string }): Html {
  const sets = o.kept?.sets;
  const shown = ISSUE_SETS.filter((s) => s !== "triage" || o.triage);
  const tabs = Tabs({ label: "Which issues", items: shown.map((s) => ({ href: `${HREF}?set=${s}`, label: SET_LABEL[s], n: sets ? sets[s].length : undefined, current: s === o.set })) });
  const list = sets?.[o.set] ?? [];
  const problem = o.kept?.error ? Notice({ tone: "bad", children: html`Issues didn't load from ${o.host}: ${o.kept.error}` }) : "";
  const body = !o.kept
    ? Empty({ title: "Reading your issues…", children: html`<p>This fills in by itself.</p>` })
    : !sets
      ? ""
      : list.length
        ? Panel({ flush: true, children: List(list.map((i) => issueRow(i, o))) })
        : Empty({ title: EMPTY[o.set] });
  return html`<div data-live id="tracker">${PageHeader({
    title: "Issues",
    sub: o.kept?.at ? html`From ${o.host}, read ${ago(o.kept.at, o.now)}` : html`From ${o.host}`,
    actions: o.newHref ? html`<a class="btn" href="${o.newHref}">New issue</a>` : "",
    tabs,
  })}${problem}${body}</div>`;
}
