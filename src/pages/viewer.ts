/**
 * Dovre's own PR viewer (conversation and files) and code explorer. GHE stays one link away
 * ("Open on GHE ↗", new tab). Read-only. A PR seen before draws at once from the cache and is read
 * again in the background; the first visit shows "Reading" and fills itself in over the hub.
 */
import { ownersIn } from "../owners.ts";
import { Hono } from "hono";
import { html } from "hono/html";
import { repoIn } from "../actions/deploys.ts";
import type { AppEnv, Env } from "../env.ts";
import { type Frame, shell } from "../html.ts";
import { type Checkout, checkoutOf, checkouts } from "../issues/tasks.ts";
import { type Kept, memoize } from "../issues/templates.ts";
import type { Hub } from "../live.ts";
import type { Ghe } from "../sources/ghe.ts";
import { loadPrFiles, loadPrView, type PrFile, type PrView, type Thread } from "../sources/prview.ts";
import { Confirm, ConfirmSubmit, type Child, Empty, type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Tabs } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import type { PrSlotArg } from "../packs/types.ts";
import { blob, commitOf, dirOf, type Entry, type Git, git as realGit, grep, safePath, safeRef, tree } from "../viewer/code.ts";
import { type DiffLine, type FileView, fileViews, placeMine } from "../viewer/diff.ts";
import { type DiffAsk, type LocalDiff, localDiff, MAX_FILES, MAX_UNTRACKED } from "../viewer/localdiff.ts";
import { Ago, Link } from "./parts.ts";
import { createHash, randomUUID } from "node:crypto";
import { checkReview, postReview } from "../actions/reviews.ts";
import { replyToThread, resolveThread } from "../actions/threads.ts";
import type { D1 } from "../db.ts";
import { cleanText, MAX_BODY, postProblem, type ReviewDraft, type Side, verdictOf } from "../reviews/draft.ts";
import { addComment, anchorOf, asDraft, clearReview, dropComment, editComment, importDraft, moveReview, type MyReview, myReview, saveSummary } from "../reviews/mine.ts";
import { commentForm, commentHref, type Flash, offDiff, pendingCard, reviewBar, reviewPage } from "./myreview.ts";

type Res<T> = { ok: true; value: T } | { ok: false; error: string };
const settle = <T>(p: Promise<T>): Promise<Res<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }),
  );

export const prHref = (repo: string, n: number) => `/prs/${repo}/${n}`;
const codeHref = (dir: string, o: { ref?: string; path?: string; q?: string } = {}) => {
  const q = new URLSearchParams();
  if (o.ref) q.set("ref", o.ref);
  if (o.path) q.set("path", o.path);
  if (o.q) q.set("q", o.q);
  const s = q.toString();
  return `/code/${encodeURIComponent(dir)}${s ? `?${s}` : ""}`;
};
/** A checkout's own diff (dovre#105): uncommitted by default, or two refs, or one commit. */
export const diffHref = (dir: string, o: { base?: string; head?: string; commit?: string } = {}) => {
  const q = new URLSearchParams();
  for (const k of ["base", "head", "commit"] as const) if (o[k]) q.set(k, o[k]!);
  const s = q.toString();
  return `/code/${encodeURIComponent(dir)}/diff${s ? `?${s}` : ""}`;
};

const STATE_TONE = { OPEN: "ok", MERGED: "ok", CLOSED: "bad" } as const;
const REVIEW_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { APPROVED: "ok", CHANGES_REQUESTED: "bad", REVIEW_REQUIRED: "warn" };
const REVIEW_WORD: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending", REVIEW_REQUIRED: "review required" };
const RUN_TONE = { ok: "ok", bad: "bad", pending: "warn", skipped: undefined } as const;

// ── PR: header and tabs ──────────────────────────────────────────────────────

function header(v: PrView, current: "conversation" | "files" | "review", extra: { stack?: Child; /** The Review tab (dovre#106), with my pending comments' count. */ review?: { n: number } }) {
  const tabs = Tabs({
    label: "Pull request",
    items: [
      { href: prHref(v.repo, v.number), label: "Conversation", current: current === "conversation" },
      { href: `${prHref(v.repo, v.number)}/files`, label: "Files", n: v.changedFiles, current: current === "files" },
      ...(extra.review ? [{ href: `${prHref(v.repo, v.number)}/review`, label: "Your review", ...(extra.review.n ? { n: extra.review.n } : {}), current: current === "review" }] : []),
    ],
  });
  const sub = html`<span class="pr-meta">${Pill({ tone: v.draft ? undefined : STATE_TONE[v.state], children: v.draft ? "draft" : v.state.toLowerCase() })}${
    v.reviewDecision ? Pill({ tone: REVIEW_TONE[v.reviewDecision], children: REVIEW_WORD[v.reviewDecision] ?? v.reviewDecision }) : ""
  }${v.mergeable === "CONFLICTING" ? Pill({ tone: "bad", children: "conflicts" }) : ""} <span>${v.author}</span> wants <code>${v.head}</code> into <code>${v.base}</code> · <span class="add">+${v.additions}</span> <span class="del">−${v.deletions}</span> in ${v.changedFiles} ${
    v.changedFiles === 1 ? "file" : "files"
  } · opened ${Ago(v.createdAt)} ago${extra.stack ? html` · ${extra.stack}` : ""}</span>`;
  return PageHeader({
    title: html`#${v.number} ${v.title}`,
    sub,
    crumbs: [{ href: "/prs", label: "Pull requests" }, { label: v.repo }],
    actions: Link(v.url, html`Open on GHE ↗`, "btn ghost"),
    tabs,
  });
}

function checks(v: PrView): Html {
  if (!v.runs.length) return html`<p class="t3">No checks reported on ${v.headSha.slice(0, 7)}.</p>`;
  return List(v.runs.map((r) => Item({ lead: Pill({ tone: RUN_TONE[r.state], children: r.state === "ok" ? "passed" : r.state === "bad" ? "failed" : r.state === "pending" ? "running" : "skipped" }), title: r.url ? Link(r.url, r.name) : r.name, quiet: r.state === "skipped" })));
}

function comment(c: { author: string; body: string; at: string; url: string }): Html {
  return html`<li class="pr-comment" data-stop="2"><div class="pr-who"><strong>${c.author}</strong> ${Ago(c.at)}${c.url ? html` · ${Link(c.url, "↗")}` : ""}</div>${c.body.trim() ? html`<div class="description">${markdown(c.body, { headingOffset: 3 })}</div>` : ""}</li>`;
}

/** Replying to and resolving a thread (dovre#106), where the PR's page can: its base, and the tab to come back to. */
type ThreadActs = { base: string; back: "files" | "conversation" };

function threadActs(t: Thread, a: ThreadActs): Html | "" {
  if (!t.id) return "";
  const fields = { thread: t.id, back: a.back };
  const reply = t.firstId
    ? html`<details class="thread-reply"><summary>Reply</summary><form method="post" action="${a.base}/threads/reply">${Object.entries(fields).map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}<textarea name="body" rows="3" maxlength="${MAX_BODY}" required aria-label="Your reply" placeholder="Your reply (Markdown)"></textarea><div class="buttons">${ConfirmSubmit({ kind: "review.reply", label: "Reply", question: "Post this reply as you?" })}</div></form></details>`
    : "";
  const resolve = Confirm({ kind: "review.resolve", action: `${a.base}/threads/resolve`, fields: { ...fields, resolve: t.resolved ? "0" : "1" }, label: t.resolved ? "Reopen" : "Resolve", question: t.resolved ? "Reopen this thread?" : "Resolve this thread?" });
  return html`<div class="thread-acts">${reply}<div class="buttons">${resolve}</div></div>`;
}

function threadView(t: Thread, o: { showPath?: boolean; acts?: ThreadActs } = {}): Html {
  const label = html`${o.showPath ? html`<code>${t.path}${t.line !== null ? `:${t.line}` : ""}</code> · ` : ""}${t.comments.length} ${t.comments.length === 1 ? "comment" : "comments"}${t.resolved ? " · resolved" : ""}${t.outdated ? " · outdated" : ""}`;
  return html`<details class="pr-thread" data-stop="2"${t.resolved || t.outdated ? "" : html` open`}><summary>${label}</summary><ol class="pr-comments">${t.comments.map(comment)}</ol>${o.acts ? threadActs(t, o.acts) : ""}</details>`;
}

const TIMELINE_WORD: Record<string, string> = { commit: "pushed", "force-push": "force-pushed", "review-requested": "asked for a review from", ready: "marked it ready for review", draft: "made it a draft", merged: "merged it", closed: "closed it", reopened: "reopened it" };

export function prPage(frame: Frame, o: { view: PrView; agent?: Html | ""; stack?: Child; /** Pack facts for this PR ("pr.facts" slot). */ facts?: (pr: PrSlotArg) => [Child, Child][]; topic: string; /** Threads take replies and resolve here (dovre#106). */ acts?: boolean; flash?: Flash; review?: { n: number } }): Html {
  const v = o.view;
  const acts: ThreadActs | undefined = o.acts && v.state === "OPEN" ? { base: prHref(v.repo, v.number), back: "conversation" } : undefined;
  const open = v.threads.filter((t) => !t.resolved && !t.outdated);
  const folded = v.threads.filter((t) => t.resolved || t.outdated);
  const reviews = v.reviews.filter((r) => r.state !== "PENDING" && (r.body.trim() || r.state !== "COMMENTED"));
  const factRows = o.facts?.({ repo: v.repo, number: v.number, branch: v.head, title: v.title, url: v.url }) ?? [];
  const body = html`<div data-live id="pr-view">
${Panel({ title: "Description", children: html`${factRows.length ? KeyValues(factRows) : ""}${v.body.trim() ? html`<div class="description">${markdown(v.body)}</div>` : html`<p class="t3">No description.</p>`}` })}
${o.agent ?? ""}
${Panel({ title: "Checks", meta: v.headSha.slice(0, 7), flush: true, children: checks(v) })}
${Panel({
  title: "Reviews",
  meta: v.requested.length ? html`asked: ${v.requested.join(", ")}` : undefined,
  children: reviews.length ? html`<ol class="pr-comments">${reviews.map((r) => html`<li class="pr-comment"><div class="pr-who"><strong>${r.author}</strong> ${Pill({ tone: REVIEW_TONE[r.state], children: REVIEW_WORD[r.state] ?? r.state.toLowerCase() })} ${Ago(r.at)}</div>${r.body.trim() ? html`<div class="description">${markdown(r.body, { headingOffset: 3 })}</div>` : ""}</li>`)}</ol>` : html`<p class="t3">No reviews yet.</p>`,
})}
${Panel({
  title: "Review threads",
  meta: `${open.length} open${folded.length ? `, ${folded.length} resolved or outdated` : ""}`,
  children: v.threads.length ? html`${open.map((t) => threadView(t, { showPath: true, acts }))}${folded.length ? html`<details class="pr-folded"><summary>${folded.length} resolved or outdated</summary>${folded.map((t) => threadView(t, { showPath: true, acts }))}</details>` : ""}` : html`<p class="t3">No review threads.</p>`,
})}
${Panel({
  title: "Timeline",
  flush: true,
  children: v.timeline.length ? List([...v.timeline].reverse().slice(0, 30).map((t) => Item({ title: html`<strong>${t.who}</strong> ${TIMELINE_WORD[t.what] ?? t.what}${t.detail ? html` <code>${t.detail}</code>` : ""}`, trail: Ago(t.at), quiet: t.what === "commit" }))) : Empty({ title: "Nothing yet" }),
})}
</div>`;
  return shell({ title: `#${v.number} ${v.title} · Dovre`, frame, current: "/prs", body: html`${header(v, "conversation", { stack: o.stack, review: o.review })}${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : ""}${body}`, head: html`<meta name="u-topics" content="snapshot ${o.topic}">` });
}

// ── PR: files ────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { added: "ok", removed: "bad", renamed: "warn" };

const LINE_CLASS = { add: "d-add", del: "d-del", ctx: "d-ctx" } as const;

/** What goes under a line besides its threads (the draft page's comment cards). */
export type LineExtra = (l: DiffLine) => Html | "";

/** Where a line's "+" goes (my own review, dovre#106): a comment on that side's line number. */
export type CommentAt = (side: "LEFT" | "RIGHT", line: number) => string;

function lineRow(l: DiffLine, extra?: LineExtra, at?: CommentAt, acts?: ThreadActs): Html {
  if (l.kind === "hunk") return html`<tr class="d-hunk" data-stop="2"><td class="ln"></td><td class="ln"></td><td class="code"><code>${l.text}</code></td></tr>`;
  if (l.kind === "note") return html`<tr class="d-note"><td class="ln"></td><td class="ln"></td><td class="code t3">${l.text}</td></tr>`;
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
  const side = l.kind === "del" ? "LEFT" : "RIGHT";
  const line = side === "LEFT" ? l.old : l.new;
  const plus = at && line ? html`<a class="d-c" href="${at(side, line)}" data-side="${side}" data-line="${line}" aria-label="Comment on line ${line}" title="Comment (c)">+</a>` : "";
  return html`<tr class="${LINE_CLASS[l.kind]}"><td class="ln">${l.old ?? ""}</td><td class="ln">${l.new ?? ""}</td><td class="code">${plus}<code><span class="d-sign" aria-hidden="true">${sign}</span>${l.text}</code></td></tr>${
    l.threads?.length ? html`<tr class="d-threads"><td colspan="3">${l.threads.map((t) => threadView(t, { acts }))}</td></tr>` : ""
  }${extra ? extra(l) : ""}`;
}

export const fileId = (path: string) => `f-${path.replace(/[^\w-]/g, "-")}`;

/** One file of a diff. `extra` adds rows under lines; a file with draft comments starts open. */
export function fileView(fv: FileView, o: { sha: string; dir?: string; present: boolean; extra?: LineExtra; /** The "+" on each line, for this file. */ comment?: (path: string) => CommentAt; acts?: ThreadActs }): Html {
  const f = fv.file;
  const name = f.previous && f.previous !== f.path ? html`<code>${f.previous}</code> → <code>${f.path}</code>` : html`<code>${f.path}</code>`;
  const view = o.dir && f.status !== "removed" ? (o.present ? html`<a class="btn sm ghost" href="${codeHref(o.dir, { ref: o.sha, path: f.path })}">View file</a>` : "") : "";
  const at = o.comment && f.patch !== undefined ? o.comment(f.path) : undefined;
  return html`<details class="dfile" id="${fileId(f.path)}" data-stop="1" data-stop-label="${f.path}"${at ? html` data-path="${f.path}"` : ""}${fv.folded && !fv.drafts && !fv.mine ? "" : html` open`}><summary><span class="dfile-name">${Pill({ tone: STATUS_TONE[f.status], children: f.status })} ${name}</span><span class="dfile-meta"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span>${
    fv.threads.length ? html` · ${fv.threads.length} ${fv.threads.length === 1 ? "thread" : "threads"}` : ""
  }${fv.drafts ? html` · <span class="spark">${fv.drafts} from the agent</span>` : ""}${fv.mine ? html` · <span class="spark">${fv.mine} pending</span>` : ""} <label class="viewed-label"><input type="checkbox" class="viewed" data-key="${o.sha}:${f.path}"> Viewed</label>${view}</span></summary>${fv.why ? html`<p class="dfile-why t3">${fv.why}</p>` : ""}${
    fv.unplaced.length ? html`<div class="dfile-threads">${fv.unplaced.map((t) => threadView(t, { showPath: true, acts: o.acts }))}</div>` : ""
  }${fv.lines.length ? html`<div class="diff-wrap"><table class="diff"><tbody>${fv.lines.map((l) => lineRow(l, o.extra, at, o.acts))}</tbody></table></div>` : ""}</details>`;
}

/** My own review on the Files tab (dovre#106): pending comments, the form open at a line (no script), the agent's draft to start from. */
export type MineOnFiles = { review?: MyReview; at?: { path: string; side: Side; line: number }; agent?: number; flash?: Flash };

export function filesPage(frame: Frame, o: { view: PrView; files: Res<PrFile[]> | undefined; dir?: string; present: boolean; topic: string; mine?: MineOnFiles }): Html {
  const v = o.view;
  const base = prHref(v.repo, v.number);
  const m = o.mine;
  const moved = !!m?.review && m.review.sha !== v.headSha;
  let inner: Html;
  if (!o.files) inner = html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><p class="t2">Reading the files from GHE…</p></section>`;
  else if (!o.files.ok) inner = Notice({ tone: "bad", children: html`<strong>The files didn't load.</strong> ${o.files.error}` });
  else {
    const views = fileViews(o.files.value, v.threads);
    const pending = m?.review?.comments ?? [];
    const off = m && !moved ? placeMine(views, pending) : pending.map((_, i) => i);
    const extra: LineExtra = (l) => {
      if (l.kind === "hunk" || l.kind === "note") return "";
      const cards = l.mine?.length ? html`<tr class="d-drafts"><td colspan="3">${l.mine.map((i) => pendingCard(pending[i]!, base))}</td></tr>` : "";
      const a = m?.at;
      const here = a && !moved && (a.side === "LEFT" ? l.kind !== "add" && l.old === a.line : l.kind !== "del" && l.new === a.line);
      return html`${cards}${here ? commentForm({ base, sha: v.headSha, path: a.path, side: a.side, line: a.line }) : ""}`;
    };
    const comment = m && !moved ? (path: string): CommentAt => (side, line) => commentHref(base, path, side, line) : undefined;
    // The no-script form opens in its own file only.
    const fileExtra = (path: string): LineExtra => (l) => (m?.at && m.at.path !== path && !(l.kind !== "hunk" && l.kind !== "note" && l.mine?.length) ? "" : extra(l));
    const fetch = o.dir && !o.present ? html`<p class="t3">${v.headSha.slice(0, 7)} isn't in your checkout yet: <code data-copy>git -C ${o.dir} fetch origin ${v.head}</code></p>` : "";
    const bar = m ? reviewBar({ base, review: m.review, head: v.headSha, agent: m.agent, flash: m.flash }) : "";
    const template = comment ? commentForm({ base, sha: v.headSha, template: true }) : "";
    inner = html`${bar}<nav class="dfile-index" aria-label="Files"><ul>${views.map(
      (fv) => html`<li><a href="#${fileId(fv.file.path)}"><code>${fv.file.path}</code></a> <span class="add">+${fv.file.additions}</span> <span class="del">−${fv.file.deletions}</span></li>`,
    )}</ul></nav>${fetch}${o.files.value.length >= 300 ? Notice({ tone: "warn", children: "Showing the first 300 files." }) : ""}${views.map((fv) => fileView(fv, { sha: v.headSha, dir: o.dir, present: o.present, extra: m ? fileExtra(fv.file.path) : undefined, comment, acts: m && v.state === "OPEN" ? { base, back: "files" } : undefined }))}${
      m ? offDiff(off.map((i) => pending[i]!), base, moved ? "Your review is on an older commit." : "These go at the end of the summary when you post.") : ""
    }${template}`;
  }
  return shell({
    title: `Files · #${v.number} ${v.title} · Dovre`,
    frame,
    current: "/prs",
    body: html`${header(v, "files", { review: m ? { n: m.review?.comments.length ?? 0 } : undefined })}<div data-live id="pr-files">${inner}</div>`,
    head: html`<meta name="u-topics" content="${o.topic}">`,
  });
}

/** While a PR's first read is under way. */
export function readingPage(frame: Frame, o: { repo: string; n: number; topic: string; error?: string }): Html {
  return shell({
    title: `${o.repo}#${o.n} · Dovre`,
    frame,
    current: "/prs",
    body: html`${PageHeader({ title: `${o.repo}#${o.n}`, crumbs: [{ href: "/prs", label: "Pull requests" }] })}${
      o.error ? Notice({ tone: "bad", children: html`<strong>The pull request didn't load.</strong> ${o.error}` }) : html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><h1>Reading the pull request</h1><p class="t2">It fills in by itself.</p></section>`
    }`,
    head: html`<meta name="u-topics" content="${o.topic}">`,
  });
}

// ── Code explorer ────────────────────────────────────────────────────────────

function crumbsOf(dir: string, ref: string, path: string): Html {
  const parts = path ? path.split("/") : [];
  return html`<nav class="code-crumbs" aria-label="Path"><a href="${codeHref(dir, { ref })}">${dir}</a>${parts.map((p, i) => html` / <a href="${codeHref(dir, { ref, path: parts.slice(0, i + 1).join("/") })}">${p}</a>`)}</nav>`;
}

export function codeListPage(frame: Frame, list: Checkout[]): Html {
  return shell({
    title: "Code · Dovre",
    frame,
    current: "/code",
    body: html`${PageHeader({ title: "Code", sub: "Checkouts at any branch, tag or commit. Read-only." })}${Panel({
      flush: true,
      children: list.length ? List(list.map((c) => Item({ href: codeHref(c.dir), title: html`<strong>${c.dir}</strong>`, line: c.repo }))) : Empty({ title: "No checkouts of the org's repos in your code folder" }),
    })}`,
  });
}

export type CodeView =
  | { kind: "tree"; entries: Entry[] }
  | { kind: "file"; text?: string; size: number; note?: string }
  | { kind: "search"; q: string; hits: { path: string; line: number; text: string }[]; more: boolean }
  | { kind: "problem"; message: Child };

export function codePage(frame: Frame, o: { dir: string; repo: string; ref: string; sha: string; path: string; view: CodeView }): Html {
  const v = o.view;
  let inner: Html;
  if (v.kind === "problem") inner = Notice({ tone: "bad", children: v.message });
  else if (v.kind === "tree") inner = Panel({ flush: true, children: v.entries.length ? List(v.entries.map((e) => Item({ href: codeHref(o.dir, { ref: o.ref, path: e.path }), lead: e.type === "tree" ? "📁" : e.type === "commit" ? "⎇" : "", title: e.type === "tree" ? html`<strong>${e.name}/</strong>` : e.name, trail: e.size !== null ? html`<span class="t3">${e.size.toLocaleString("en-GB")} B</span>` : "" }))) : Empty({ title: "Empty folder" }) });
  else if (v.kind === "file")
    inner = v.text === undefined
      ? Notice({ tone: "neutral", children: v.note ?? "Can't show this file." })
      : html`<div class="diff-wrap"><table class="code-view"><tbody>${v.text.replace(/\n$/, "").split("\n").map((line, i) => html`<tr id="L${i + 1}"><td class="ln"><a href="#L${i + 1}">${i + 1}</a></td><td class="code"><code>${line}</code></td></tr>`)}</tbody></table></div>`;
  else
    inner = Panel({
      title: html`Lines with «${v.q}»`,
      meta: `${v.hits.length}${v.more ? "+" : ""}`,
      flush: true,
      children: v.hits.length ? List(v.hits.map((h) => Item({ href: `${codeHref(o.dir, { ref: o.ref, path: h.path })}#L${h.line}`, title: html`<code>${h.path}:${h.line}</code>`, line: html`<code>${h.text}</code>` }))) : Empty({ title: "Nothing found" }),
    });
  const forms = html`<div class="code-bar"><form method="get" action="/code/${encodeURIComponent(o.dir)}" class="code-ref"><label class="label" for="ref">Ref</label><input type="text" id="ref" name="ref" value="${o.ref}" maxlength="200"><input type="hidden" name="path" value="${o.path}"><button type="submit" class="sm">Go</button></form><form method="get" action="/code/${encodeURIComponent(o.dir)}" class="code-search"><input type="hidden" name="ref" value="${o.ref}"><input type="search" name="q" placeholder="Search this ref" maxlength="200" value="${v.kind === "search" ? v.q : ""}" aria-label="Search this ref"><button type="submit" class="sm">Search</button></form></div>`;
  return shell({
    title: `${o.path || o.dir} · Code · Dovre`,
    frame,
    current: "/code",
    body: html`${PageHeader({ title: o.path ? o.path.split("/").pop()! : o.dir, sub: html`<code>${o.repo}</code> at <code>${o.ref}</code> (${o.sha.slice(0, 7)})`, crumbs: [{ href: "/code", label: "Code" }, { href: codeHref(o.dir), label: o.dir }], actions: html`<a class="btn sm ghost" href="${diffHref(o.dir)}">Changes</a>` })}${forms}${crumbsOf(o.dir, o.ref, o.path)}${inner}`,
  });
}

// ── A checkout's own diff (dovre#105) ───────────────────────────────────────

export function diffPage(frame: Frame, o: { dir: string; repo: string; ask: DiffAsk; diff: LocalDiff }): Html {
  const a = o.ask;
  const d = o.diff;
  const short = (sha?: string) => (sha ? sha.slice(0, 7) : "");
  const sub =
    a.kind === "worktree"
      ? html`What's not committed in <code>${o.dir}</code>, against <code>${a.base}</code>${d.ok ? html` (${short(d.base)})` : ""}, untracked files too.`
      : a.kind === "refs"
        ? html`<code>${a.head}</code> against <code>${a.base}</code>, from where they split.`
        : html`Commit <code>${short(d.ok ? d.head : a.sha) || a.sha}</code>.`;
  const tabs = Tabs({
    label: "What to compare",
    items: [
      { href: diffHref(o.dir), label: "Uncommitted", current: a.kind === "worktree" && a.base === "HEAD" },
      { href: diffHref(o.dir, { base: "origin/HEAD", head: "HEAD" }), label: "Branch vs default", current: a.kind === "refs" },
    ],
  });
  const form = html`<div class="code-bar"><form method="get" action="${diffHref(o.dir)}" class="code-ref"><label class="label" for="base">Base</label><input type="text" id="base" name="base" value="${a.kind === "commit" ? "" : a.base}" maxlength="200" placeholder="HEAD"><label class="label" for="head">Head</label><input type="text" id="head" name="head" value="${a.kind === "refs" ? a.head : ""}" maxlength="200" placeholder="working tree"><button type="submit" class="sm">Compare</button></form><form method="get" action="${diffHref(o.dir)}" class="code-ref"><label class="label" for="commit">Commit</label><input type="text" id="commit" name="commit" value="${a.kind === "commit" ? a.sha : ""}" maxlength="200"><button type="submit" class="sm">Show</button></form></div>`;
  let inner: Html;
  if (!d.ok) inner = Notice({ tone: "bad", children: html`<strong>The diff didn't load.</strong> ${d.error}` });
  else if (!d.files.length) inner = Panel({ children: Empty({ title: a.kind === "worktree" ? "Nothing uncommitted" : "No changes" }) });
  else {
    const views = fileViews(d.files, []);
    const adds = d.files.reduce((n, f) => n + f.additions, 0);
    const dels = d.files.reduce((n, f) => n + f.deletions, 0);
    // "View file" opens the head commit; the working tree has none.
    const head = a.kind === "worktree" ? undefined : d.head;
    const key = head ?? `worktree:${o.dir}`;
    inner = html`<p class="t3">${d.files.length} ${d.files.length === 1 ? "file" : "files"} · <span class="add">+${adds}</span> <span class="del">−${dels}</span></p><nav class="dfile-index" aria-label="Files"><ul>${views.map(
      (fv) => html`<li><a href="#${fileId(fv.file.path)}"><code>${fv.file.path}</code></a> <span class="add">+${fv.file.additions}</span> <span class="del">−${fv.file.deletions}</span></li>`,
    )}</ul></nav>${d.capped ? Notice({ tone: "warn", children: `Showing the first ${MAX_FILES} files.` }) : ""}${
      d.moreUntracked ? Notice({ tone: "warn", children: `${d.moreUntracked} more untracked ${d.moreUntracked === 1 ? "file" : "files"} past the first ${MAX_UNTRACKED}, not shown.` }) : ""
    }${views.map((fv) => fileView(fv, { sha: key, dir: head ? o.dir : undefined, present: !!head }))}`;
  }
  return shell({
    title: `Changes · ${o.dir} · Dovre`,
    frame,
    current: "/code",
    body: html`${PageHeader({ title: "Changes", sub, crumbs: [{ href: "/code", label: "Code" }, { href: codeHref(o.dir), label: o.dir }], tabs })}${form}${inner}`,
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

export type ViewerDeps = {
  ghe: Ghe;
  frame: () => Promise<Frame>;
  hub?: Hub;
  kept?: Kept;
  /** The agent review card for a PR the snapshot knows (src/pages/reviews.ts). */
  agentFor?: (repo: string, n: number) => Promise<Html | "">;
  /** "2 of 6 in a stack · waits on #839", when the stacks are known (never waits for them). */
  stackFor?: (repo: string, n: number) => Promise<Child | undefined>;
  /** Pack facts for the PR ("pr.facts" slot), keyed by the PR itself. */
  facts?: (pr: PrSlotArg) => [Child, Child][];
  checkouts?: () => Checkout[];
  git?: Git;
  /** My own reviews (dovre#106): where they're kept. Without it, the viewer stays read-only. */
  db?: D1;
  /** My login, to tell my own PRs. */
  login?: () => Promise<string>;
  /** The agent's unposted review draft of this PR, and the commit it read. */
  agentDraft?: (repo: string, n: number) => Promise<{ sha: string; draft: ReviewDraft } | undefined>;
  stale?: () => void;
};

const SHA = /^[0-9a-f]{40}$/;
/** The head and a commit as stored (perhaps short) are the same one. */
const sameSha = (head: string, sha: string) => sha.length >= 7 && head.startsWith(sha);

/** /prs/:owner/:repo/:n(/files) and /code: mounted at "/" by app.ts, behind its cookie and same-origin checks. */
export function createViewerRoutes(env: Env, deps: ViewerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const g = deps.git ?? realGit;
  const views = memoize({ ttlMs: 60e3, kept: deps.kept });
  // Patches are big and a commit's never change: memory only, by head sha.
  const files = memoize({ ttlMs: 60 * 60e3 });
  const list = () => {
    try {
      return deps.checkouts ? deps.checkouts() : checkouts(env.CODE_DIR, deps.ghe.host, ownersIn(env));
    } catch {
      return [];
    }
  };
  const topicOf = (repo: string, n: number) => `pr:${repo}#${n}`;
  /** The PR, at once if it's known (refreshed in the background, and the page told when it lands); else up to 1.5 s for the first read. */
  async function viewOf(repo: string, n: number): Promise<Res<PrView> | undefined> {
    const loading = settle(views(`prview:${repo}#${n}`, () => loadPrView(deps.ghe, repo, n).then((v) => (deps.hub?.publish([topicOf(repo, n)]), v))));
    return Promise.race([loading, new Promise<undefined>((res) => setTimeout(res, 1500))]);
  }
  const present = new Map<string, boolean>();
  async function hasCommit(dir: string, sha: string) {
    const key = `${dir}@${sha}`;
    if (!present.has(key)) present.set(key, SHA.test(sha) && (await commitOf(g, dirOf(env.CODE_DIR, dir), sha)) === sha);
    return present.get(key)!;
  }

  /** What my review's last action said, shown once (keyed by person and PR). */
  const flashes = new Map<string, Flash>();
  const flashOf = (key: string) => {
    const f = flashes.get(key);
    flashes.delete(key);
    return f;
  };
  const setFlash = (key: string, f: Flash) => {
    if (flashes.size > 100) flashes.delete(flashes.keys().next().value as string);
    flashes.set(key, f);
  };
  /** My review on the Files tab: what's pending, the line asked for with ?c=SIDE:LINE&p=path, the agent's draft. */
  async function mineOn(c: { req: { query: (k: string) => string | undefined }; get: (k: "who") => string | undefined }, at: { repo: string; n: number }, v: PrView): Promise<MineOnFiles> {
    const who = c.get("who") ?? "";
    const key = `${at.repo}#${at.n}`;
    const m = /^(LEFT|RIGHT):(\d{1,6})$/.exec(c.req.query("c") ?? "");
    const a = m ? anchorOf({ side: m[1], line: m[2], path: c.req.query("p") }) : null;
    const d = await deps.agentDraft?.(at.repo, at.n).catch(() => undefined);
    return {
      review: await myReview(deps.db!, who, key),
      at: a ?? undefined,
      agent: d && sameSha(v.headSha, d.sha) && d.draft.comments.length ? d.draft.comments.length : undefined,
      flash: flashOf(`${who}|${key}`),
    };
  }

  const parse = (owner: string, repo: string, n: string) => {
    const full = /^[\w.-]{1,100}$/.test(repo) && !repo.includes("..") ? repoIn(ownersIn(env), `${owner}/${repo}`) : null;
    return full && /^\d{1,7}$/.test(n) ? { repo: full, n: Number(n) } : null;
  };

  app.get("/prs/:owner/:repo/:n", async (c) => {
    const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
    if (!at) return c.notFound();
    const frame = await deps.frame();
    const topic = topicOf(at.repo, at.n);
    const got = await viewOf(at.repo, at.n);
    if (!got || !got.ok) return c.html(readingPage(frame, { ...at, topic, error: got && !got.ok ? got.error : undefined }), got ? 502 : 200);
    const who = c.get("who") ?? "";
    const key = `${at.repo}#${at.n}`;
    const mine = deps.db ? await myReview(deps.db, who, key) : undefined;
    return c.html(
      prPage(frame, {
        view: got.value,
        agent: (await deps.agentFor?.(at.repo, at.n)) ?? "",
        stack: await deps.stackFor?.(at.repo, at.n),
        facts: deps.facts,
        topic,
        acts: !!deps.db,
        flash: flashOf(`${who}|${key}`),
        review: deps.db ? { n: mine?.comments.length ?? 0 } : undefined,
      }),
    );
  });

  app.get("/prs/:owner/:repo/:n/files", async (c) => {
    const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
    if (!at) return c.notFound();
    const frame = await deps.frame();
    const topic = topicOf(at.repo, at.n);
    const got = await viewOf(at.repo, at.n);
    if (!got || !got.ok) return c.html(readingPage(frame, { ...at, topic, error: got && !got.ok ? got.error : undefined }), got ? 502 : 200);
    const v = got.value;
    const loading = settle(files(`files:${at.repo}#${at.n}@${v.headSha}`, () => loadPrFiles(deps.ghe, at.repo, at.n).then((f) => (deps.hub?.publish([topic]), f))));
    const fs = await Promise.race([loading, new Promise<undefined>((res) => setTimeout(res, 1500))]);
    const co = checkoutOf(list(), at.repo);
    const mine = deps.db ? await mineOn(c, at, v) : undefined;
    return c.html(filesPage(frame, { view: v, files: fs, dir: co?.dir, present: co ? await hasCommit(co.dir, v.headSha) : false, topic, mine }));
  });

  // ── My own review (dovre#106): kept per person until posted ──
  const db = deps.db;
  if (db) {
    const whoOf = (c: { get: (k: "who") => string | undefined }) => c.get("who") ?? "";
    const spent = new Set<string>();
    /** The agent's draft of this PR, when it read the commit the PR is at now: how many comments it would add. */
    const agentCount = async (repo: string, n: number, head: string) => {
      const d = await deps.agentDraft?.(repo, n).catch(() => undefined);
      return d && sameSha(head, d.sha) && d.draft.comments.length ? d : undefined;
    };
    /** Where an action came from (a PR of the org), the PR as last read, and my review of it. */
    const ctxOf = async (c: { req: { param: (k: string) => string }; get: (k: "who") => string | undefined }) => {
      const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
      if (!at) return undefined;
      const got = await viewOf(at.repo, at.n);
      if (!got?.ok) return undefined;
      const who = whoOf(c);
      const key = `${at.repo}#${at.n}`;
      return { ...at, v: got.value, who, key, flashKey: `${who}|${key}`, base: prHref(at.repo, at.n), review: await myReview(db, who, key) };
    };
    const print = (d: ReviewDraft, verdict: string, sha: string) => createHash("sha256").update(JSON.stringify([d, verdict, sha])).digest("hex").slice(0, 32);
    const own = async (v: PrView) => {
      const me = deps.login ? await deps.login().catch(() => "") : "";
      return !!me && v.author.toLowerCase() === me.toLowerCase();
    };
    const page = async (x: NonNullable<Awaited<ReturnType<typeof ctxOf>>>, o: { summary?: string; verdict?: string; preview?: Parameters<typeof reviewPage>[1]["preview"]; review?: MyReview } = {}) => {
      const review = o.review ?? x.review;
      const mine = await own(x.v);
      return reviewPage(await deps.frame(), {
        header: header(x.v, "review", { review: { n: review?.comments.length ?? 0 } }),
        title: `#${x.v.number} ${x.v.title}`,
        base: x.base,
        head: x.v.headSha,
        review,
        summary: o.summary ?? review?.summary ?? "",
        verdict: mine ? "comment" : verdictOf(o.verdict),
        own: mine,
        agent: (await agentCount(x.repo, x.n, x.v.headSha))?.draft.comments.length,
        preview: o.preview,
        flash: flashOf(x.flashKey),
      });
    };

    app.get("/prs/:owner/:repo/:n/review", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      return c.html(await page(x));
    });

    app.post("/prs/:owner/:repo/:n/review/comments", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      const a = anchorOf(form);
      const sha = typeof form.sha === "string" && /^[0-9a-f]{40}$/.test(form.sha) ? form.sha : "";
      if (!a || !sha) return c.text("That isn't a line to comment on.", 400);
      const r = await addComment(db, x.who, x.key, sha, { ...a, body: typeof form.body === "string" ? form.body : "" });
      if (!r.ok) setFlash(x.flashKey, { ok: false, message: r.message });
      return c.redirect(`${x.base}/files${r.ok ? `#c-${r.id}` : ""}`, 303);
    });

    app.post("/prs/:owner/:repo/:n/review/comments/:id", async (c) => {
      const x = await ctxOf(c);
      const id = Number(c.req.param("id"));
      if (!x || !Number.isSafeInteger(id) || id <= 0) return c.notFound();
      const form = await c.req.parseBody();
      if (form.do === "drop") await dropComment(db, x.who, x.key, id);
      else await editComment(db, x.who, x.key, id, form.body);
      return c.redirect(`${x.base}/files${form.do === "drop" ? "" : `#c-${id}`}`, 303);
    });

    app.post("/prs/:owner/:repo/:n/review/import", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const d = await agentCount(x.repo, x.n, x.v.headSha);
      if (!d) setFlash(x.flashKey, { ok: false, message: "There's no agent draft for the commit the PR is at now." });
      else {
        const n = await importDraft(db, x.who, x.key, x.v.headSha, d.draft);
        setFlash(x.flashKey, n ? { ok: true, message: `Added the agent's ${n} ${n === 1 ? "comment" : "comments"} to your review.` } : { ok: false, message: "Nothing added: your review is on another commit, or full." });
      }
      return c.redirect(`${x.base}/files`, 303);
    });

    app.post("/prs/:owner/:repo/:n/review/move", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      // Only to the commit the PR is at now, and only from the page that showed it.
      if (x.review && form.sha === x.v.headSha) await moveReview(db, x.who, x.key, x.v.headSha);
      return c.redirect(`${x.base}/files`, 303);
    });

    /** After a write: the PR read again, so the page it goes back to shows it. */
    const reread = (repo: string, n: number) => views(`prview:${repo}#${n}`, () => loadPrView(deps.ghe, repo, n), { fresh: true }).then(() => deps.hub?.publish([topicOf(repo, n)]), () => undefined);
    const backOf = (x: { base: string }, back: unknown) => (back === "files" ? `${x.base}/files` : x.base);

    app.post("/prs/:owner/:repo/:n/threads/reply", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      const body = cleanText(form.body, MAX_BODY);
      const thread = typeof form.thread === "string" ? form.thread : "";
      const res = body ? await replyToThread(deps.ghe, db, x.repo, x.n, { thread, body }) : { ok: false, message: "The reply is empty: nothing posted." };
      if (res.ok) await reread(x.repo, x.n);
      setFlash(x.flashKey, res);
      return c.redirect(backOf(x, form.back), 303);
    });

    app.post("/prs/:owner/:repo/:n/threads/resolve", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      const thread = typeof form.thread === "string" ? form.thread : "";
      const res = await resolveThread(deps.ghe, db, x.repo, x.n, { thread, resolve: form.resolve !== "0" });
      if (res.ok) await reread(x.repo, x.n);
      setFlash(x.flashKey, res);
      return c.redirect(backOf(x, form.back), 303);
    });

    app.post("/prs/:owner/:repo/:n/review/discard", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      await clearReview(db, x.who, x.key);
      setFlash(x.flashKey, { ok: true, message: "Your review is discarded. Nothing was posted." });
      return c.redirect(`${x.base}/review`, 303);
    });

    app.post("/prs/:owner/:repo/:n/review/preview", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      const sha = x.review?.sha ?? x.v.headSha;
      await saveSummary(db, x.who, x.key, sha, form.summary);
      const review = (await myReview(db, x.who, x.key))!;
      const mine = await own(x.v);
      const verdict = mine ? "comment" : verdictOf(form.verdict);
      const draft = asDraft(review);
      const problem = postProblem(draft, verdict);
      if (problem) return c.html(await page(x, { review, verdict, preview: { problem } }), 400);
      const me = deps.login ? await deps.login().catch(() => "") : "";
      const checked = await checkReview(deps.ghe, x.repo, x.n, { reviewed: review.sha, me, draft, by: "me", verdict });
      if (!checked.ok) return c.html(await page(x, { review, verdict, preview: { problem: checked.message } }), 409);
      return c.html(await page(x, { review, verdict, preview: { draft: checked.draft, notes: checked.notes, nonce: randomUUID(), print: print(draft, verdict, review.sha) } }));
    });

    app.post("/prs/:owner/:repo/:n/review/post", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      const back = `${x.base}/review`;
      const nonce = typeof form.nonce === "string" ? form.nonce : "";
      if (!/^[0-9a-f-]{36}$/.test(nonce) || spent.has(nonce) || !x.review) return c.redirect(back, 303);
      const verdict = verdictOf(form.verdict);
      const draft = asDraft(x.review);
      // What goes is what the preview showed: a review changed since (another tab) previews again.
      if (form.print !== print(draft, verdict, x.review.sha)) {
        setFlash(x.flashKey, { ok: false, message: "Your review changed since the preview: nothing posted. Preview it again." });
        return c.redirect(back, 303);
      }
      const problem = postProblem(draft, verdict);
      if (problem) {
        setFlash(x.flashKey, { ok: false, message: problem });
        return c.redirect(back, 303);
      }
      if (spent.size > 200) spent.delete(spent.values().next().value as string);
      spent.add(nonce);
      const me = deps.login ? await deps.login().catch(() => "") : "";
      const res = await postReview(deps.ghe, db, x.repo, x.n, { reviewed: x.review.sha, me, draft, verdict, by: "me" });
      if (res.ok) {
        await clearReview(db, x.who, x.key);
        deps.stale?.();
        await reread(x.repo, x.n);
      }
      const url = res.url && res.url.startsWith(`https://${deps.ghe.host}/`) ? res.url : undefined;
      setFlash(x.flashKey, { ok: res.ok, message: res.message, url });
      return c.redirect(back, 303);
    });
  }

  app.get("/code", async (c) => env.IS_HOSTED === "1" ? c.notFound() : c.html(codeListPage(await deps.frame(), list())));

  app.get("/code/:dir/diff", async (c) => {
    if (env.IS_HOSTED === "1") return c.notFound();
    const co = list().find((x) => x.dir === c.req.param("dir"));
    if (!co) return c.notFound();
    const frame = await deps.frame();
    const q = (k: string) => (c.req.query(k) ?? "").trim().slice(0, 200);
    const commit = q("commit");
    const base = q("base") || "HEAD";
    const head = q("head");
    const ask: DiffAsk = commit ? { kind: "commit", sha: commit } : head ? { kind: "refs", base, head } : { kind: "worktree", base };
    const refs = ask.kind === "commit" ? [ask.sha] : ask.kind === "refs" ? [ask.base, ask.head] : [ask.base];
    if (!refs.every(safeRef)) return c.html(diffPage(frame, { dir: co.dir, repo: co.repo, ask, diff: { ok: false, error: "That isn't a ref in this checkout." } }), 400);
    const diff = await localDiff(g, dirOf(env.CODE_DIR, co.dir), ask);
    return c.html(diffPage(frame, { dir: co.dir, repo: co.repo, ask, diff }), diff.ok ? 200 : 404);
  });

  app.get("/code/:dir", async (c) => {
    if (env.IS_HOSTED === "1") return c.notFound();
    const dirName = c.req.param("dir");
    const co = list().find((x) => x.dir === dirName);
    if (!co) return c.notFound();
    const frame = await deps.frame();
    const dir = dirOf(env.CODE_DIR, co.dir);
    const ref = c.req.query("ref") || "HEAD";
    const path = safePath(c.req.query("path") ?? "");
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const base = { dir: co.dir, repo: co.repo, ref, path: path ?? "", sha: "" };
    if (!safeRef(ref) || path === null) return c.html(codePage(frame, { ...base, view: { kind: "problem", message: "That isn't a ref or a path in this checkout." } }), 400);
    const sha = await commitOf(g, dir, ref);
    if (!sha) return c.html(codePage(frame, { ...base, view: { kind: "problem", message: html`<code>${ref}</code> isn't in this checkout. Fetch it first: <code data-copy>git -C ${co.dir} fetch origin</code>` } }), 404);
    if (q.trim()) {
      const r = await grep(g, dir, sha, q);
      return c.html(codePage(frame, { ...base, sha, view: r ? { kind: "search", q, ...r } : { kind: "problem", message: "The search failed." } }));
    }
    // A folder lists; anything else is read as a file.
    const entries = await tree(g, dir, sha, path);
    if (entries) return c.html(codePage(frame, { ...base, sha, view: { kind: "tree", entries } }));
    const b = await blob(g, dir, sha, path);
    if (b.kind === "missing") return c.html(codePage(frame, { ...base, sha, view: { kind: "problem", message: "No such file or folder at this ref." } }), 404);
    if (b.kind === "text") return c.html(codePage(frame, { ...base, sha, view: { kind: "file", text: b.text, size: b.size } }));
    return c.html(codePage(frame, { ...base, sha, view: { kind: "file", size: b.size, note: b.kind === "binary" ? `A binary file (${b.size.toLocaleString("en-GB")} bytes).` : `Too big to show here (${b.size.toLocaleString("en-GB")} bytes).` } }));
  });

  return app;
}

