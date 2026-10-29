/**
 * My own review of a PR (dovre#106), drawn in the PR viewer: the "+" on each line of the Files tab
 * opens a comment form, my pending comments sit at their lines as cards I edit or remove, and the
 * Review tab holds the summary, the verdict, the preview and the Post. Nothing goes to GHE before
 * that Post (src/actions/reviews.ts, the same checks as an agent's draft). Routes: src/pages/viewer.ts.
 */
import { html } from "hono/html";
import { type Frame, shell } from "../html.ts";
import { type LineComment, MAX_BODY, MAX_SUMMARY, type ReviewDraft, type Side, type Verdict, VERDICT_LABEL, VERDICTS } from "../reviews/draft.ts";
import { type Card, cardLabel, type Check, type CheckMode, lost, targetLabel } from "../reviews/check.ts";
import type { MyReview, Pending } from "../reviews/mine.ts";
import { Confirm, type Html, Notice, Panel, Pill, Post } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import { Link } from "./parts.ts";

export type Flash = { ok: boolean; message: string; url?: string };

const rows = (s: string, min = 3, max = 14) => Math.min(max, Math.max(min, s.split("\n").length + 1));
export const whereOf = (c: LineComment) => `${c.path}:${c.startLine ? `${c.startLine}–` : ""}${c.line}${c.side === "LEFT" ? " (removed)" : ""}`;

/** Where the "+" on a line goes without script: the Files tab with the form open at that line. */
export const commentHref = (base: string, path: string, side: Side, line: number) => `${base}/files?c=${side}:${line}&p=${encodeURIComponent(path)}#c-new`;

/** The form for a new comment. With `template`, the empty one the page's script copies under a line. */
export function commentForm(o: { base: string; sha: string; path?: string; side?: Side; line?: number; start?: number; template?: boolean }): Html {
  const where = o.path ? html`<code class="draft-where">${whereOf({ path: o.path, side: o.side ?? "RIGHT", line: o.line ?? 0, startLine: o.start, body: "" })}</code>` : html`<code class="draft-where" data-where></code>`;
  const form = html`<tr class="d-form" id="c-new"><td colspan="3"><form method="post" action="${o.base}/review/comments" class="draft-card" data-ctrl-enter>
<input type="hidden" name="sha" value="${o.sha}"><input type="hidden" name="path" value="${o.path ?? ""}"><input type="hidden" name="side" value="${o.side ?? "RIGHT"}"><input type="hidden" name="line" value="${o.line ?? ""}"><input type="hidden" name="start" value="${o.start ?? ""}">
<div class="draft-card-h">${where}<span class="hint">Shift-click another line's + for a range.</span></div>
<textarea name="body" rows="4" maxlength="${MAX_BODY}" required aria-label="Your comment" placeholder="Your comment (Markdown)"${o.template ? "" : html` autofocus`}></textarea>
<div class="buttons"><button type="submit" class="primary sm" data-busy="Adding">Add to your review</button><a class="btn ghost sm" href="${o.base}/files" data-cancel>Cancel</a><span class="hint">Ctrl/⌘ + Enter adds it.</span></div>
</form></td></tr>`;
  return o.template ? html`<template id="c-form">${form}</template>` : form;
}

/** One of my pending comments, as a card I edit or remove. */
export function pendingCard(c: Pending, base: string): Html {
  return html`<form method="post" action="${base}/review/comments/${c.id}" class="draft-card" id="c-${c.id}" data-ctrl-enter>
<div class="draft-card-h"><code class="draft-where">${whereOf(c)}</code>${Pill({ children: "pending" })}</div>
<textarea name="body" rows="${rows(c.body)}" maxlength="${MAX_BODY}" aria-label="Your comment">\n${c.body}</textarea>
<div class="buttons"><button type="submit" name="do" value="save" class="sm">Save</button><button type="submit" name="do" value="drop" class="ghost sm">Remove</button></div>
</form>`;
}

/** Above the files: what's pending, where to finish, and the agent's draft to start from. */
export function reviewBar(o: { base: string; review?: MyReview; head: string; agent?: number; flash?: Flash; /** An agent can write a first review. */ checker?: boolean }): Html {
  const r = o.review;
  const n = r?.comments.length ?? 0;
  const moved = !!r && r.sha !== o.head;
  const flash = o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : "";
  const agent = o.agent && !moved ? Post({ action: `${o.base}/review/import`, label: `Add the agent's ${o.agent} ${o.agent === 1 ? "comment" : "comments"}` }) : "";
  if (moved)
    return html`${flash}${Notice({
      tone: "warn",
      children: html`<strong>Your review is on ${r!.sha.slice(0, 7)}, and the PR has moved on to ${o.head.slice(0, 7)}.</strong> Its ${n} ${n === 1 ? "comment is" : "comments are"} listed below the files until you move it; where each sits is checked again when you post. <div class="buttons">${Post({ action: `${o.base}/review/move`, fields: { sha: o.head }, label: `Move it to ${o.head.slice(0, 7)}` })}<a class="btn ghost" href="${o.base}/review">Your review</a></div>`,
    })}`;
  const what = n ? html`<strong>Your review:</strong> ${n} pending ${n === 1 ? "comment" : "comments"}` : r ? html`<strong>Your review</strong> is started` : html`<span class="t3">Click + on a line to comment; comments collect as your review.</span>`;
  const finish = n || r ? "btn primary sm" : "btn ghost sm";
  const first = o.checker && !n && !r?.summary ? Post({ action: `${o.base}/review/check`, fields: { mode: "review" }, label: "Review with an agent" }) : "";
  return html`${flash}<div class="review-bar">${what}<span class="buttons">${agent}${first}<a class="${finish}" href="${o.base}/review">Finish your review…</a></span></div>`;
}

/** The comments that aren't on a line of this diff, under the files. */
export function offDiff(comments: Pending[], base: string, why: string): Html | "" {
  if (!comments.length) return "";
  return Panel({ title: "Your comments not on this diff", meta: html`<span class="t3">${why}</span>`, children: html`${comments.map((c) => pendingCard(c, base))}` });
}

export type ReviewPageView = {
  header: Html;
  title: string;
  base: string;
  head: string;
  review?: MyReview;
  summary: string;
  verdict: Verdict;
  /** My own PR: GHE takes a Comment only. */
  own: boolean;
  agent?: number;
  preview?: { draft: ReviewDraft; notes: string[]; nonce: string; print: string } | { problem: string };
  flash?: Flash;
  /** An agent can review the PR first, or check my review before I post it (Bino's route is ready). */
  checker?: boolean;
  /** Its last check: running, failed, or its cards still to keep or dismiss. */
  check?: Check;
  /** The hub topic a check's answer is published on. */
  topic?: string;
};

/** One of the agent's cards: what it's about, why, and its text to keep (as I edit it) or dismiss. */
function checkCard(card: Card, comments: Pending[], base: string, mode: CheckMode): Html {
  const about = card.at
    ? html`<code class="draft-where">${whereOf({ ...card.at, body: "" })}</code>`
    : html`<code class="draft-where">${targetLabel(card.on!, comments)}</code>${card.also !== undefined ? html` and <code class="draft-where">${targetLabel(card.also, comments)}</code>` : ""}`;
  const gone = card.on !== undefined && card.on !== "summary" && !comments.some((c) => c.id === card.on);
  const keep = card.text !== undefined && !gone;
  const label = card.kind === "missed" ? "Add this comment" : card.on === "summary" ? "Use as your summary" : "Use this text";
  return html`<form method="post" action="${base}/review/check/${card.id}" class="draft-card" id="k-${card.id}">
<div class="draft-card-h">${Pill({ children: cardLabel(card, mode) })}${about}</div>
${card.why ? html`<div class="draft-text">${markdown(card.why)}</div>` : ""}
${keep ? html`<textarea name="body" rows="${rows(card.text!)}" maxlength="${card.on === "summary" ? MAX_SUMMARY : MAX_BODY}" aria-label="The agent's text">\n${card.text}</textarea>` : ""}
<div class="buttons">${keep ? html`<button type="submit" name="do" value="keep" class="sm">${label}</button>` : ""}<button type="submit" name="do" value="drop" class="ghost sm">Dismiss</button></div>
</form>`;
}

/** The agent's last check: reading still, why it failed, or its cards left. */
function checkPanel(v: ReviewPageView, comments: Pending[]): Html | "" {
  const k = v.check;
  if (!k) return "";
  const stale = !!v.review && k.sha !== v.review.sha;
  const first = k.mode === "review";
  const keepable = k.cards.filter((c) => c.text !== undefined).length;
  const all = !stale && keepable > 1 ? html`<div class="buttons">${Post({ action: `${v.base}/review/check/all`, label: `Add all ${keepable}` })}<span class="hint">Then edit or remove any of them on the Files tab.</span></div>` : "";
  const body = k.running && !lost(k)
    ? html`<p class="t3" role="status">The agent is reading ${first ? "the PR" : "your review"}. Its cards show up here when it answers, in up to 3 minutes. You can leave this page.</p>`
    : k.running || k.error
      ? Notice({ tone: "bad", children: k.error ?? `The ${first ? "review" : "check"} stopped before the agent answered. Try again.` })
      : k.cards.length
        ? html`${stale ? Notice({ tone: "warn", children: `This ${first ? "review" : "check"} was of an earlier commit.` }) : ""}${all}${k.cards.map((c) => checkCard(c, comments, v.base, first ? "review" : "check"))}`
        : html`<p class="t3">${first ? "The agent found nothing to comment on." : "The agent has nothing to add. Your review is as it was."}</p>`;
  return Panel({ id: "check", title: first ? "The agent's review" : "The agent's check", meta: html`<span class="t3">${k.model}${k.cost ? ` · $${k.cost.toFixed(3)}` : ""}</span>`, children: html`${body}<p class="hint">Keeping a card changes only your pending review. The agent never posts.</p>` });
}

/** The Review tab: my comments, the summary and verdict, then the preview with its Post. */
export function reviewPage(frame: Frame, v: ReviewPageView): Html {
  const r = v.review;
  const comments = r?.comments ?? [];
  const moved = !!r && r.sha !== v.head;
  const verdicts = v.own ? (["comment"] as const) : VERDICTS;
  const list = comments.length
    ? html`<p class="draft-h">Line comments</p>${comments.map((c) => html`<div class="draft-card"><div class="draft-card-h"><code class="draft-where">${whereOf(c)}</code><a class="sm" href="${v.base}/files#c-${c.id}">Edit on the diff</a></div><div class="draft-text">${markdown(c.body)}</div></div>`)}`
    : html`<p class="t3">No line comments. Add them with + on the <a href="${v.base}/files">Files</a> tab, or post just a summary.</p>`;
  const form = html`<form method="post" action="${v.base}/review/preview">
<div class="field"><fieldset><legend class="label">Verdict</legend>${verdicts.map((x) => html`<label class="check"><input type="radio" name="verdict" value="${x}"${x === v.verdict ? html` checked` : ""}> ${VERDICT_LABEL[x]}</label>`)}</fieldset>${v.own ? html`<span class="hint">Your own PR: a Comment only.</span>` : ""}</div>
<label class="field"><span class="label">Summary</span><textarea name="summary" rows="${rows(v.summary, 5)}" maxlength="${MAX_SUMMARY}" placeholder="Markdown">\n${v.summary}</textarea></label>
${list}
<div class="buttons"><button type="submit" class="primary" data-busy="Checking">Preview</button>${v.checker && !moved ? html`<button type="submit" formaction="${v.base}/review/check" name="mode" value="review" data-busy="Starting">Review with an agent</button>${comments.length || v.summary ? html`<button type="submit" formaction="${v.base}/review/check" data-busy="Starting">Check with an agent</button>` : ""}` : ""}<span class="hint">Nothing goes to GHE before Post on the preview.</span></div>
</form>`;
  const p = v.preview;
  const preview = !p
    ? ""
    : "problem" in p
      ? Notice({ tone: "bad", children: p.problem })
      : Panel({
          title: "What goes to GHE",
          meta: Pill({ children: VERDICT_LABEL[v.verdict] }),
          children: html`${p.notes.map((n) => Notice({ tone: "warn", children: n }))}${p.draft.summary ? html`<div class="draft-text">${markdown(p.draft.summary)}</div>` : ""}${p.draft.comments.map(
            (c) => html`<div class="draft-card"><code class="draft-where">${whereOf(c)}</code><div class="draft-text">${markdown(c.body)}</div></div>`,
          )}<div class="buttons">${Confirm({
            kind: "review.post",
            action: `${v.base}/review/post`,
            fields: { verdict: v.verdict, nonce: p.nonce, print: p.print },
            label: "Post your review",
            question: html`Post this review as <strong>${VERDICT_LABEL[v.verdict]}</strong>?`,
          })}</div>`,
        });
  const flash = v.flash ? Notice({ tone: v.flash.ok ? "ok" : "bad", children: html`${v.flash.message}${v.flash.url ? html` ${Link(v.flash.url, "Open it on GHE")}` : ""}` }) : "";
  const agent = v.agent && !moved ? html`<div class="buttons">${Post({ action: `${v.base}/review/import`, label: `Add the agent's ${v.agent} ${v.agent === 1 ? "comment" : "comments"}` })}<span class="hint">Its comments join yours, and its summary fills an empty one: change any of it before you post.</span></div>` : "";
  const movedNote = moved
    ? Notice({ tone: "warn", children: html`Your review is on ${r!.sha.slice(0, 7)}; the PR is now at ${v.head.slice(0, 7)}. ${Post({ action: `${v.base}/review/move`, fields: { sha: v.head }, label: `Move it to ${v.head.slice(0, 7)}` })}` })
    : "";
  const discard = r
    ? html`<div class="buttons">${Confirm({ kind: "review.discard", action: `${v.base}/review/discard`, label: "Discard your review", question: `Throw away your summary and ${comments.length} pending ${comments.length === 1 ? "comment" : "comments"}? Nothing was posted.`, danger: true })}</div>`
    : "";
  const body = html`${v.header}${flash}${movedNote}${agent}${Panel({ title: "Your review", meta: comments.length ? `${comments.length} pending` : undefined, children: form })}${checkPanel(v, comments)}${preview}${discard}`;
  return shell({ title: `Your review · ${v.title} · Dovre`, frame, current: "/prs", body, head: v.topic ? html`<meta name="u-topics" content="${v.topic}">` : undefined });
}
