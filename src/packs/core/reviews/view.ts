/**
 * Agent code review on a PR (WP-A3), what the pack draws: the block on the PR card (start one;
 * running; the report), the confirm page that shows what will run, and the draft to go through
 * before it's posted. The routes are in index.ts.
 */
import { html } from "hono/html";
import type { HarnessId } from "../../../agents/runner.ts";
import { type Draft, type LineComment, MAX_BODY, MAX_SUMMARY, splitDraft, type Verdict, VERDICT_LABEL, VERDICTS } from "../../../reviews/draft.ts";
import type { Pr } from "../../../sources/ghe.ts";
import type { PrFile, Thread } from "../../../sources/prview.ts";
import { type DiffLine, fileViews, placeDrafts } from "../../../viewer/diff.ts";
import { fileView } from "../../../pages/viewer.ts";
import { type Child, Confirm, type Html, KeyValues, Notice, PageHeader, Panel, Pill } from "../../../ui/kit.ts";
import { Reading } from "../../../pages/later.ts";
import { markdown } from "../../../ui/markdown.ts";
import { modelSelect } from "../../../pages/models.ts";
import { Ago, harnessTag, HARNESS_NAME, Link, safeUrl } from "../../../pages/parts.ts";
import { KIND_LABEL, prKey, type ReviewKind, SKILL } from "./agent.ts";
import type { AgentReview } from "./store.ts";

const startHref = (p: Pr, kind: ReviewKind) => safeUrl(`/reviews/agent?pr=${encodeURIComponent(prKey(p))}&kind=${kind}`);
export const sessionHref = (r: AgentReview) => safeUrl(r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.runId}`);

/** The block on a PR card. `report`: the agent's last message, once it's done. */
export function agentBlock(p: Pr, kind: ReviewKind, r: AgentReview | undefined, report: string | undefined, forge: string): Html {
  const start = (label: string) => html`<a class="btn" href="${startHref(p, kind)}">${label}</a>`;
  if (!r) return html`<div class="agent-review"><div class="buttons">${start(`${KIND_LABEL[kind]}…`)}</div></div>`;
  const what = kind === "review" ? "Agent review" : "Agent assessment";
  const older = r.headSha !== p.headSha ? html` <span class="t3">(for an older commit)</span>` : "";
  const open = html`<a href="${sessionHref(r)}">Open the session</a>`;
  if (r.status === "running")
    return html`<div class="agent-review"><p class="agent-review-h"><span class="spark">${what}</span> running, for ${Ago(r.startedAt)} ${harnessTag(r.harness)} · ${open}</p></div>`;
  const ended = r.endedAt ?? r.startedAt;
  const head = html`<p class="agent-review-h"><span class="spark">${what}</span> ${r.status === "done" ? html`done · ${Ago(ended)}` : r.status === "failed" ? "failed" : "stopped"}${older} ${harnessTag(r.harness)} · ${open}</p>`;
  const split = r.status === "done" && report?.trim() ? splitDraft(kind, report) : undefined;
  const body = split?.text ? html`<details class="agent-report"${older ? "" : html` open`}><summary>The ${kind === "review" ? "report" : "assessment"}</summary><div class="agent-report-body">${markdown(split.text, { headingOffset: 3 })}</div></details>` : "";
  const again = start(r.status === "done" ? (kind === "review" ? "Review again…" : "Assess again…") : "Try again…");
  const posted = r.posted ? html`<p class="hint">Posted ${r.posted.what ? html`(${r.posted.what}) ` : ""}${Ago(r.posted.at)}${r.posted.url ? html` · ${Link(r.posted.url, `Open on ${forge}`)}` : ""}</p>` : "";
  const draft = r.posted || !split ? "" : split.draft ? (older ? html`<span class="hint">The draft is for an older commit: review again to post one.</span>` : html`<a class="btn primary" href="${draftHref(r)}">Go through the draft…</a>`) : split.broken ? html`<span class="hint">The draft at the end of the ${kind === "review" ? "report" : "assessment"} couldn't be read.</span>` : "";
  return html`<div class="agent-review">${head}${body}${posted}<div class="buttons">${draft}${again}</div></div>`;
}

export const draftHref = (r: AgentReview) => safeUrl(`/reviews/draft?run=${encodeURIComponent(r.runId)}`);
const RUN_ID = /^[\w-]{1,80}$/;

/** The PR a review was of, from its key ("ACME/people#7"); its card in the snapshot when there is one. */
export const prOfKey = (key: string) => {
  const m = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(key);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

/** Each card as the form left it: kept or dropped, and its text. With no form yet, all kept, as the agent wrote them. */
function cardsOf(d: Draft, form?: Record<string, unknown>): { keep: boolean; body: string }[] {
  const items = d.kind === "review" ? d.comments : d.replies;
  return items.map((c, i) => ({ keep: form ? form[`keep_${i}`] === "on" : true, body: form && typeof form[`body_${i}`] === "string" ? String(form[`body_${i}`]) : c.body }));
}

const rows = (s: string, min = 3, max = 14) => Math.min(max, Math.max(min, s.split("\n").length + 1));
const whereOf = (c: LineComment) => `${c.path}:${c.startLine ? `${c.startLine}–` : ""}${c.line}${c.side === "LEFT" ? " (removed)" : ""}`;

/** The diff on the draft page: the files and open threads at the reviewed commit, still reading, or why not. */
export type DraftDiff = { ok: true; files: PrFile[]; threads: Thread[] } | { ok: false; why: string } | "reading";

export type DraftView = {
  diff?: DraftDiff;
  r: AgentReview;
  pr: { repo: string; number: number; url: string; title?: string; author?: string };
  base: Draft;
  form?: Record<string, unknown>;
  verdict: Verdict;
  /** After Preview: what would go, or why it can't. */
  preview?: { draft: Draft; notes: string[]; nonce: string } | { problem: string };
  flash?: { ok: boolean; message: string };
};

/** The line comments as cards: in the diff at their lines when it's read, the rest apart (they go into the summary). */
function lineCards(comments: LineComment[], card: (i: number, label: Html) => Html, diff: DraftDiff | undefined, sha: string, forge: string): Html | "" {
  const one = (i: number) => card(i, html`<code class="draft-where">${whereOf(comments[i]!)}</code>`);
  const all = comments.map((_, i) => i);
  const list = (title: string, idx: number[], hint?: Child) => (idx.length ? html`<p class="draft-h">${title}</p>${hint ? html`<p class="hint">${hint}</p>` : ""}${idx.map(one)}` : "");
  if (diff === "reading") return html`${Reading({ text: `Reading the diff from ${forge}…` })}${list("Line comments", all)}`;
  if (!diff || !diff.ok) return list("Line comments", all, diff?.why);
  const views = fileViews(diff.files, diff.threads);
  const off = placeDrafts(views, comments);
  const extra = (l: DiffLine) => (l.kind !== "hunk" && l.kind !== "note" && l.drafts?.length ? html`<tr class="d-drafts"><td colspan="3">${l.drafts.map(one)}</td></tr>` : "");
  return html`<p class="draft-h">The diff</p><p class="hint">The agent's comments sit at their lines, with the open review threads.</p>${views.map((fv) => fileView(fv, { sha, present: false, extra }))}${list("Not on the diff", off, "These go at the end of the summary.")}`;
}

/** The draft as cards I change or drop, and after Preview, exactly what goes with its Post. */
export function draftPage(forge: string, v: DraftView): Html {
  const { r, pr, base } = v;
  const review = base.kind === "review";
  const cards = cardsOf(base, v.form);
  const text = (name: string, was: string) => (v.form && typeof v.form[name] === "string" ? String(v.form[name]) : was);
  const card = (i: number, label: Html) => html`<div class="draft-card">
<div class="draft-card-h">${label}<label class="check"><input type="checkbox" name="keep_${i}" value="on"${cards[i]!.keep ? html` checked` : ""}> Post this</label></div>
<textarea name="body_${i}" rows="${rows(cards[i]!.body)}" maxlength="${MAX_BODY}" aria-label="Text">\n${cards[i]!.body}</textarea></div>`;
  const form = html`<form method="post" action="/reviews/draft/preview"><input type="hidden" name="run" value="${r.runId}">
${review
  ? html`<div class="field"><fieldset><legend class="label">Verdict</legend>${VERDICTS.map((x) => html`<label class="check"><input type="radio" name="verdict" value="${x}"${x === v.verdict ? html` checked` : ""}> ${VERDICT_LABEL[x]}</label>`)}</fieldset><span class="hint">Yours to pick: the agent doesn't choose it.</span></div>
<label class="field"><span class="label">Summary</span><textarea name="summary" rows="${rows(text("summary", base.summary), 4)}" maxlength="${MAX_SUMMARY}">\n${text("summary", base.summary)}</textarea></label>
${base.kind === "review" ? lineCards(base.comments, card, v.diff, r.headSha, forge) : ""}`
  : html`${base.replies.length ? html`<p class="draft-h">Replies</p>${base.replies.map((x, i) => card(i, html`<span class="draft-where">Reply to ${Link(`${pr.url}#discussion_r${x.commentId}`, "this comment")}</span>`))}` : ""}
<label class="field"><span class="label">A comment on the PR</span><span class="hint">Optional: for what was said outside a thread.</span><textarea name="comment" rows="${rows(text("comment", base.comment))}" maxlength="${MAX_SUMMARY}">\n${text("comment", base.comment)}</textarea></label>`}
<div class="buttons"><button type="submit" class="primary" data-busy="Checking">Preview</button><span class="hint">Nothing goes to ${forge} before Post on the preview.</span></div>
</form>`;
  const p = v.preview;
  const preview = !p
    ? ""
    : "problem" in p
      ? Notice({ tone: "bad", children: p.problem })
      : Panel({
          title: `What goes to ${forge}`,
          meta: review ? Pill({ children: VERDICT_LABEL[v.verdict] }) : undefined,
          children: html`${p.notes.map((n) => Notice({ tone: "warn", children: n }))}
${p.draft.kind === "review"
  ? html`${p.draft.summary ? html`<div class="draft-text">${markdown(p.draft.summary)}</div>` : ""}${p.draft.comments.map((c) => html`<div class="draft-card"><code class="draft-where">${whereOf(c)}</code><div class="draft-text">${markdown(c.body)}</div></div>`)}`
  : html`${p.draft.replies.map((x) => html`<div class="draft-card"><span class="draft-where">Reply to ${Link(`${pr.url}#discussion_r${x.commentId}`, "this comment")}</span><div class="draft-text">${markdown(x.body)}</div></div>`)}${p.draft.comment ? html`<div class="draft-card"><span class="draft-where">On the PR</span><div class="draft-text">${markdown(p.draft.comment)}</div></div>` : ""}`}
<div class="buttons">${Confirm({ kind: "review.post",
            action: "/reviews/draft/post",
            fields: { run: r.runId, verdict: v.verdict, nonce: p.nonce, draft: JSON.stringify(p.draft) },
            label: review ? `Post the review` : `Post the replies`,
            question: html`Post this on ${pr.repo}#${pr.number} as you${review ? html`, as <strong>${VERDICT_LABEL[v.verdict]}</strong>` : ""}?`,
          })}</div>`,
        });
  const body = html`${PageHeader({
    title: review ? "The agent's review" : "The agent's replies",
    crumbs: [{ href: "/prs", label: "Pull requests" }],
    sub: html`${Link(pr.url, html`${pr.repo}#${pr.number}${pr.title ? html` ${pr.title}` : ""}`)}${pr.author ? html` <span class="t3">by ${pr.author}</span>` : ""} · <a href="${safeUrl(r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.runId}`)}">the session</a>${review && !r.posted ? html` · <a href="${safeUrl(`/prs/${pr.repo}/${pr.number}/review`)}">start your own review from it</a>` : ""}`,
  })}
${v.flash ? Notice({ tone: v.flash.ok ? "ok" : "bad", children: v.flash.message }) : ""}
${r.posted
  ? Notice({ tone: "ok", children: html`Posted ${r.posted.what ? html`(${r.posted.what}) ` : ""}${Ago(r.posted.at)}.${r.posted.url ? html` ${Link(r.posted.url, `Open it on ${forge}`)}` : ""}` })
  : html`${Panel({ title: review ? "Go through it" : "Go through them", meta: html`<span class="t3">Change any text, untick what shouldn't go.</span>`, children: form })}${preview}`}`;
  return body;
}

export type ConfirmView = {
  pr: Pr;
  kind: ReviewKind;
  dir?: string;
  clone?: string;
  harnesses: { id: HarnessId; prompt: string; allowed: string[] }[];
  running?: AgentReview;
  problem?: string;
  nonce: string;
};

/** What will run, where, and what it may do without asking; the second click starts it. */
export function confirmPage(c: ConfirmView): Html {
  const { pr, kind } = c;
  const first = c.harnesses[0];
  const canStart = !!(c.dir && first && !c.running);
  const body = html`${PageHeader({
    title: KIND_LABEL[kind],
    crumbs: [{ href: "/prs", label: "Pull requests" }],
    sub: html`${Link(pr.url, html`${pr.repo}#${pr.number} ${pr.title}`)} <span class="t3">by ${pr.author}</span>`,
  })}
${c.problem ? Notice({ tone: "bad", children: c.problem }) : ""}
${c.running ? Notice({ children: html`An agent is on it already (for ${Ago(c.running.startedAt)}). <a href="${sessionHref(c.running)}">Open the session</a>.` }) : ""}
${!c.dir ? Notice({ tone: "warn", children: html`${pr.repo} isn't checked out in your code folder, and the agent works in a checkout. Clone it, then come back: <code data-copy="${c.clone ?? ""}">${c.clone ?? ""}</code>` }) : ""}
${!first ? Notice({ tone: "warn", children: html`No agent here has the <code>${SKILL[kind]}</code> skill. Install it for Claude Code (~/.claude/skills) or omp (~/.agents/skills), clone a checkout of skills into your code folder as agent-skills, or name another skill in <code>.dev.vars</code> (REVIEW_SKILL, TRIAGE_SKILL).` }) : ""}
${Panel({
  title: "What runs",
  children: html`${KeyValues([
    ["In", c.dir ? html`<code>${c.dir}</code>` : html`<span class="t3">no checkout</span>`],
    ["Asks", "before anything that changes something: a worktree, builds, tests, edits, posting. Allow each from the session page."],
    ...c.harnesses.map((h): [Html, Html] => [
      harnessTag(h.id),
      html`<pre class="agent-prompt">${h.prompt}</pre>${h.allowed.length ? html`<span class="hint">Without asking, only: ${h.allowed.map((a) => html`<code>${a}</code> `)}(each only reads)</span>` : html`<span class="hint">Asks before every command.</span>`}`,
    ]),
  ])}
<form method="post" action="/reviews/agent"><input type="hidden" name="pr" value="${prKey(pr)}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="nonce" value="${c.nonce}">
<div class="fields">${c.harnesses.length > 1 ? html`<label class="field"><span class="label">Agent</span><select name="harness">${c.harnesses.map((h) => html`<option value="${h.id}">${HARNESS_NAME[h.id]}</option>`)}</select></label>` : first ? html`<input type="hidden" name="harness" value="${first.id}">` : ""}${modelSelect("", c.harnesses.length ? c.harnesses.map((h) => h.id) : ["claude"])}
<div class="field"><button type="submit" class="primary" data-busy="Starting"${canStart ? "" : html` disabled`}>Start</button></div></div>
</form>`,
})}`;
  return body;
}
