/** /tracker: my issues by set (tabs), each a row with its labels, linked PRs, sub-issues and age, and what I may do to it. */
import { html } from "hono/html";
import type { Issue } from "../../../forge/types.ts";
import { ago } from "../../../format.ts";
import { Link, safeUrl } from "../../../pages/parts.ts";
import { taskHref } from "../../../pages/work.ts";
import { BulkBar, Confirm, Empty, Gauge, type Html, Item, List, Notice, PageHeader, Panel, Pick, Pill, Tabs } from "../../../ui/kit.ts";
import { ACT_KINDS, type ActKindId, doneText, MAX_COMMENT } from "./act.ts";
import { ISSUE_SETS, type IssuesKept, keyOf, SET_LABEL, type SetId, staleFor } from "./model.ts";

export const HREF = "/tracker";
export const ACT = `${HREF}/act`;
export const COMMENT = `${HREF}/comment`;
export const BULK = `${HREF}/bulk`;
/** How many ticked issues one bulk write takes. */
export const BULK_MAX = 20;
/** What the bulk bar does: its button's value, and the act each ticked issue gets. */
export const BULK_DO = { done: { kind: "close", reason: "completed" }, "not-planned": { kind: "close", reason: "not_planned" }, assign: { kind: "assign" } } as const;
export type BulkDo = keyof typeof BULK_DO;

/**
 * What a row may offer: absent, nothing. `write`: the forge takes writes (assign, close, comment);
 * `me`: who I am; `task`: dev tasks start here (local); `agent`: a new agent session starts on it,
 * given the checkout folder for its repo (none: the new-session form starts in Dovre's own folder).
 */
export type RowActs = { me: string; task: boolean; set: SetId; write: boolean; agent?: (repo: string) => string | undefined };

/** A new agent session's first message about an issue: what it is, where to read it, how its PR closes it. */
export function agentPromptOf(i: Pick<Issue, "repo" | "number" | "title" | "url">): string {
  const k = keyOf(i);
  return `Work on ${k}: ${i.title}\n\nRead the issue first (${i.url}), with its comments and any issue it hangs under. Close it from the PR with "Closes ${k}".`;
}

/** The new-session form, filled in for the issue: nothing starts until I press Start there. */
export const agentHref = (i: Pick<Issue, "repo" | "number" | "title" | "url">, dir?: string) =>
  safeUrl(`/agents/new?${new URLSearchParams({ ...(dir ? { repo: dir } : {}), prompt: agentPromptOf(i) })}`);

const prPill = (p: Issue["prs"][number]) =>
  Pill({ tone: p.state === "MERGED" ? "ok" : undefined, title: `${p.key}: ${p.state.toLowerCase()}`, children: `PR #${p.key.split("#")[1]} ${p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed"}` });

const fieldsOf = (i: Pick<Issue, "repo" | "number">, set: SetId, more: Record<string, string> = {}) => ({ repo: i.repo, number: String(i.number), set, ...more });

function actsOf(i: Issue, a: RowActs): Html {
  const k = keyOf(i);
  const mine = i.assignees.some((x) => x.toLowerCase() === a.me.toLowerCase());
  const writes = a.write
    ? html`${!mine && a.me ? Confirm({ kind: "issue.assign", action: ACT, fields: fieldsOf(i, a.set, { kind: "assign" }), label: "Assign me", question: html`Assign ${k} to you (${a.me}) on the forge?` }) : ""
  }${Confirm({ kind: "issue.close", action: ACT, fields: fieldsOf(i, a.set, { kind: "close", reason: "completed" }), label: "Close as done", question: html`Close ${k} as completed?` })}${Confirm({ kind: "issue.close",
    action: ACT,
    fields: fieldsOf(i, a.set, { kind: "close", reason: "not_planned" }),
    label: "Close as not planned",
    question: html`Close ${k} as not planned?`,
    danger: true,
  })}<form class="issue-comment" method="post" action="${COMMENT}">${Object.entries(fieldsOf(i, a.set)).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}<textarea name="body" rows="2" maxlength="${MAX_COMMENT}" required aria-label="${`Comment on ${k}`}" placeholder="A comment"></textarea><button type="submit">Preview comment</button></form>`
    : "";
  const agent = a.agent ? html`<a class="btn" href="${agentHref(i, a.agent(i.repo))}" title="A new agent session on ${k}: the form opens filled in">Start an agent</a>` : "";
  return html`<details class="issue-acts"><summary>Act on it</summary><div class="issue-acts-body">${agent}${writes}${
    a.task ? html`<a class="btn" href="${taskHref(k, i.repo)}">Start a task</a>` : ""
  }</div></details>`;
}

export function issueRow(i: Issue, o: { staleDays: number; now: number; acts?: RowActs; pick?: boolean }): Html {
  const stale = staleFor(i, o.staleDays, o.now);
  const at = Date.parse(i.updatedAt);
  const facts = [Number.isFinite(at) ? `updated ${ago(at, o.now)}` : "", i.comments ? `${i.comments} ${i.comments === 1 ? "comment" : "comments"}` : "", i.milestone ?? "", i.type ?? ""].filter(Boolean).join(" · ");
  const labels = i.labels.length ? html`<span class="issue-labels">${i.labels.map((l) => Pill({ children: l }))}</span> ` : "";
  const trail = html`<span class="issue-trail">${i.prs.map(prPill)}${
    i.subIssues ? html`<span class="issue-subs" title="${`${i.subIssues.done} of ${i.subIssues.total} sub-issues closed`}">${Gauge({ value: i.subIssues.done, max: i.subIssues.total })}<span>${i.subIssues.done}/${i.subIssues.total}</span></span>` : ""
  }${stale !== undefined ? Pill({ tone: "warn", title: `No change in ${stale} days`, children: `stale ${stale} d` }) : ""}</span>`;
  const lead = html`${o.pick ? Pick({ form: "issues-bulk", value: keyOf(i), label: `Pick ${keyOf(i)}` }) : ""}<span class="issue-ref">${i.repo.split("/")[1] ?? i.repo}#${i.number}</span>`;
  // With actions the row isn't one link (a form can't sit in a link): the title is.
  return o.acts
    ? Item({ lead, title: Link(i.url, i.title), line: html`${labels}${facts}`, trail, more: actsOf(i, o.acts) })
    : Item({ href: safeUrl(i.url), lead, title: i.title, line: html`${labels}${facts}`, trail });
}

const EMPTY: Record<SetId, string> = {
  assigned: "Nothing assigned to you.",
  mentioned: "No open issue mentions you.",
  authored: "You have no open issues.",
  triage: "Nothing waits for triage.",
};

/** What was just done (from the redirect's query), checked: a known kind and a well-formed `repo#n`. */
export type Done = { kind: ActKindId; repo: string; number: number; reason?: string };
export function doneOf(q: { done?: string; ref?: string; reason?: string }): Done | undefined {
  const m = q.ref?.match(/^([\w.-]+\/[\w.-]+)#(\d{1,9})$/);
  if (!m || !(ACT_KINDS as readonly string[]).includes(q.done ?? "")) return undefined;
  return { kind: q.done as ActKindId, repo: m[1]!, number: Number(m[2]), ...(q.reason === "not_planned" ? { reason: "not_planned" } : {}) };
}

function doneNotice(d: Done, set: SetId, acts: boolean): Html {
  const undo = acts && d.kind === "close" ? Confirm({ kind: "issue.reopen", action: ACT, fields: fieldsOf(d, set, { kind: "reopen" }), label: "Reopen", question: html`Reopen ${keyOf(d)}?` }) : "";
  return Notice({ tone: "ok", children: html`${doneText(d)}. ${undo}` });
}

export function trackerBody(o: { kept: IssuesKept | undefined; set: SetId; triage: boolean; staleDays: number; now: number; host: string; newHref?: string; acts?: Omit<RowActs, "set">; done?: Done; bulk?: BulkDone }): Html {
  const sets = o.kept?.sets;
  const shown = ISSUE_SETS.filter((s) => s !== "triage" || o.triage);
  const tabs = Tabs({ label: "Which issues", items: shown.map((s) => ({ href: `${HREF}?set=${s}`, label: SET_LABEL[s], n: sets ? sets[s].length : undefined, current: s === o.set })) });
  const list = sets?.[o.set] ?? [];
  const acts = o.acts ? { ...o.acts, set: o.set } : undefined;
  // Two or more and the forge takes writes: tick several and close or take them at once (dovre#104).
  const pick = !!acts?.write && list.length >= 2;
  const problem = o.kept?.error ? Notice({ tone: "bad", children: html`Issues didn't load from ${o.host}: ${o.kept.error}` }) : "";
  const body = !o.kept
    ? Empty({ title: "Reading your issues…", children: html`<p>This fills in by itself.</p>` })
    : !sets
      ? ""
      : list.length
        ? Panel({ flush: true, children: html`${pick ? bulkBar(o.set) : ""}${List(list.map((i) => issueRow(i, { staleDays: o.staleDays, now: o.now, acts, pick })))}` })
        : Empty({ title: EMPTY[o.set] });
  return html`<div data-live id="tracker">${PageHeader({
    title: "Issues",
    sub: o.kept?.at ? html`From ${o.host}, read ${ago(o.kept.at, o.now)}` : html`From ${o.host}`,
    actions: o.newHref ? html`<a class="btn" href="${o.newHref}">New issue</a>` : "",
    tabs,
  })}${o.done ? doneNotice(o.done, o.set, !!o.acts) : ""}${o.bulk ? bulkNotice(o.bulk) : ""}${problem}${body}</div>`;
}

const bulkBar = (set: SetId) =>
  BulkBar({
    id: "issues-bulk",
    action: BULK,
    label: "Ticked:",
    fields: { set },
    buttons: [
      { name: "do", value: "assign", label: "Assign me", kind: "issue.assign", question: "Assign every ticked issue to you? Each is checked again first." },
      { name: "do", value: "done", label: "Close as done", kind: "issue.close", question: "Close every ticked issue as completed? Each is checked again first." },
      { name: "do", value: "not-planned", label: "Close as not planned", kind: "issue.close", danger: true, question: "Close every ticked issue as not planned?" },
    ],
  });

/** How a bulk write went, from the redirect's query: counts and a few reasons, checked. */
export type BulkDone = { what: BulkDo; done: number; of: number; why: string[] };
export function bulkOf(q: { bulk?: string; done?: string; of?: string; why?: string[] }): BulkDone | undefined {
  if (!q.bulk || !Object.hasOwn(BULK_DO, q.bulk)) return undefined;
  const n = (v?: string) => (/^\d{1,3}$/.test(v ?? "") ? Number(v) : NaN);
  const done = n(q.done), of = n(q.of);
  if (!Number.isFinite(done) || !Number.isFinite(of) || done > of || of > BULK_MAX) return undefined;
  return { what: q.bulk as BulkDo, done, of, why: (q.why ?? []).slice(0, 3).map((w) => w.slice(0, 200)) };
}
const BULK_VERB: Record<BulkDo, string> = { done: "Closed as done", "not-planned": "Closed as not planned", assign: "Assigned you" };
function bulkNotice(b: BulkDone): Html {
  return Notice({ tone: b.done === b.of ? "ok" : "warn", children: html`${BULK_VERB[b.what]}: ${b.done} of ${b.of}.${b.why.map((w) => html` ${w}`)}` });
}

/** The comment's confirm step: the text as it will be posted, then Post. */
export function commentPreview(o: { issue: Issue; body: string; set: SetId }): Html {
  const k = keyOf(o.issue);
  return html`${PageHeader({ title: html`Comment on ${k}`, sub: o.issue.title, crumbs: [{ href: `${HREF}?set=${o.set}`, label: "Issues" }, { label: "Comment" }] })}${Panel({
    title: "It will say",
    children: html`<blockquote class="issue-comment-text">${o.body}</blockquote>${Confirm({ kind: "issue.comment", action: ACT, fields: fieldsOf(o.issue, o.set, { kind: "comment", body: o.body }), label: "Post comment", question: html`Post this on ${k} as you?` })}`,
  })}`;
}

/** A write that was refused or failed, and why; back to the list. */
export function refusedBody(o: { title: string; why: string; set: SetId; tone?: "bad" | "warn" }): Html {
  return html`${PageHeader({ title: o.title, crumbs: [{ href: `${HREF}?set=${o.set}`, label: "Issues" }, { label: "Not done" }] })}${Notice({ tone: o.tone ?? "warn", children: o.why })}<p><a class="btn" href="${`${HREF}?set=${o.set}`}">Back to issues</a></p>`;
}
