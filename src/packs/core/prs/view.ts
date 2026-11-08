/** The PR viewer's pages (dovre#106): its conversation, its files with my review on them, and the page while it's read. Each returns what `ctx.page` draws. */
import { html } from "hono/html";
import { Reading, type Res } from "../../../pages/later.ts";
import type { PrFile, PrView } from "../../../sources/prview.ts";
import { type Child, Empty, type Html, Item, KeyValues, List, Notice, PageHeader, Panel, Pill, Tabs } from "../../../ui/kit.ts";
import { markdown } from "../../../ui/markdown.ts";
import type { PageOpts, PrSlotArg } from "../../types.ts";
import { fileViews, placeDrafts, placeMine } from "../../../viewer/diff.ts";
import { type CommentAt, fileView, type LineExtra, type ThreadActs, threadView, withTree } from "../../../pages/diffview.ts";
import { Ago, Link } from "../../../pages/parts.ts";
import type { LineComment, Side } from "../../../reviews/draft.ts";
import { type Card, type Check, lost } from "../../../reviews/check.ts";
import type { MyReview } from "../../../reviews/mine.ts";
import { checkCard, commentForm, commentHref, type Flash, offDiff, pendingCard, reviewBar } from "./myreview.ts";

/** The list's page: the pack's own top-level path. */
export const PRS = "/prs";
export const prHref = (repo: string, n: number) => `/prs/${repo}/${n}`;

const STATE_TONE = { OPEN: "ok", MERGED: "ok", CLOSED: "bad" } as const;
const REVIEW_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { APPROVED: "ok", CHANGES_REQUESTED: "bad", REVIEW_REQUIRED: "warn" };
const REVIEW_WORD: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending", REVIEW_REQUIRED: "review required" };
const RUN_TONE = { ok: "ok", bad: "bad", pending: "warn", skipped: undefined } as const;

// ── PR: header and tabs ──────────────────────────────────────────────────────

export function header(v: PrView, current: "conversation" | "files" | "review", extra: { stack?: Child; /** The Review tab (dovre#106), with my pending comments' count. */ review?: { n: number }; /** What the forge is called ("GitHub"). */ forge: string }) {
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
    crumbs: [{ href: PRS, label: "Pull requests" }, { label: v.repo }],
    actions: Link(v.url, html`Open on ${extra.forge} ↗`, "btn ghost"),
    tabs,
  });
}

function checks(v: PrView): Html {
  if (!v.runs.length) return html`<p class="t3">No checks reported on ${v.headSha.slice(0, 7)}.</p>`;
  return List(v.runs.map((r) => Item({ lead: Pill({ tone: RUN_TONE[r.state], children: r.state === "ok" ? "passed" : r.state === "bad" ? "failed" : r.state === "pending" ? "running" : "skipped" }), title: r.url ? Link(r.url, r.name) : r.name, quiet: r.state === "skipped" })));
}

const TIMELINE_WORD: Record<string, string> = { commit: "pushed", "force-push": "force-pushed", "review-requested": "asked for a review from", ready: "marked it ready for review", draft: "made it a draft", merged: "merged it", closed: "closed it", reopened: "reopened it" };

export function prPage(forge: string, o: { view: PrView; agent?: Html | ""; stack?: Child; /** Pack facts for this PR ("pr.facts" slot). */ facts?: (pr: PrSlotArg) => [Child, Child][]; topic: string; /** Threads take replies and resolve here (dovre#106). */ acts?: boolean; flash?: Flash; review?: { n: number } }): PageOpts {
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
  return { title: `#${v.number} ${v.title} · Dovre`, current: PRS, body: html`${header(v, "conversation", { forge, stack: o.stack, review: o.review })}${o.flash ? Notice({ tone: o.flash.ok ? "ok" : "bad", children: o.flash.message }) : ""}${body}`, head: html`<meta name="u-topics" content="snapshot ${o.topic}">` };
}


/** My own review on the Files tab (dovre#106): pending comments, the form open at a line (no script), the agent's draft to start from. */
export type MineOnFiles = { review?: MyReview; at?: { path: string; side: Side; line: number }; agent?: number; flash?: Flash; /** An agent can write a first review (Bino's route is ready). */ checker?: boolean; /** The agent's last review or check: its line cards show at their lines (dovre#316). */ check?: Check };

/** The agent's cards that sit on a line: a comment it would add there, or one about my comment on that line. */
export function lineCards(k: Check | undefined, review: MyReview | undefined, moved: boolean): { card: Card; at: Omit<LineComment, "body"> }[] {
  if (!k || !review || moved || k.sha !== review.sha || k.error || (k.running && lost(k))) return [];
  return k.cards.flatMap((card) => {
    const at = card.at ?? review.comments.find((c) => c.id === card.on);
    return at ? [{ card, at }] : [];
  });
}

export function filesPage(forge: string, o: { view: PrView; files: Res<PrFile[]> | undefined; dir?: string; present: boolean; topic: string; mine?: MineOnFiles; /** Pack buttons for a file ("pr.file" slot). */ fileSlot?: (f: PrSlotArg & { path: string; status: string; sha: string }) => Html | "" }): PageOpts {
  const v = o.view;
  const base = prHref(v.repo, v.number);
  const m = o.mine;
  const moved = !!m?.review && m.review.sha !== v.headSha;
  let inner: Html;
  if (!o.files) inner = Reading({ text: `Reading the files from ${forge}…` });
  else if (!o.files.ok) inner = Notice({ tone: "bad", children: html`<strong>The files didn't load.</strong> ${o.files.error}` });
  else {
    const views = fileViews(o.files.value, v.threads);
    const pending = m?.review?.comments ?? [];
    const off = m && !moved ? placeMine(views, pending) : pending.map((_, i) => i);
    // The agent's cards go on the Files tab's own "drafts" key (that key is for its older draft on the Reviews page).
    const agent = lineCards(m?.check, m?.review, moved);
    placeDrafts(views, agent.map((x) => x.at));
    const writing = !!m?.check?.running;
    const mode = m?.check?.mode === "review" ? "review" : "check";
    const extra: LineExtra = (l) => {
      if (l.kind === "hunk" || l.kind === "note") return "";
      const mineHere = [...(l.mine ?? []).map((i) => pendingCard(pending[i]!, base)), ...(l.drafts ?? []).map((i) => checkCard(agent[i]!.card, pending, base, mode, writing, true))];
      const cards = mineHere.length ? html`<tr class="d-drafts"><td colspan="3">${mineHere}</td></tr>` : "";
      const a = m?.at;
      const here = a && !moved && (a.side === "LEFT" ? l.kind !== "add" && l.old === a.line : l.kind !== "del" && l.new === a.line);
      return html`${cards}${here ? commentForm({ base, sha: v.headSha, path: a.path, side: a.side, line: a.line }) : ""}`;
    };
    const comment = m && !moved ? (path: string): CommentAt => (side, line) => commentHref(base, path, side, line) : undefined;
    // The no-script form opens in its own file only.
    const fileExtra = (path: string): LineExtra => (l) => (m?.at && m.at.path !== path && !(l.kind !== "hunk" && l.kind !== "note" && (l.mine?.length || l.drafts?.length)) ? "" : extra(l));
    const fetch = o.dir && !o.present ? html`<p class="t3">${v.headSha.slice(0, 7)} isn't in your checkout yet: <code data-copy>git -C ${o.dir} fetch origin ${v.head}</code></p>` : "";
    const bar = m ? reviewBar({ base, review: m.review, head: v.headSha, agent: m.agent, flash: m.flash, checker: m.checker }) : "";
    const template = comment ? commentForm({ base, sha: v.headSha, template: true }) : "";
    const pr: PrSlotArg = { repo: v.repo, number: v.number, branch: v.head, title: v.title, url: v.url };
    inner = html`${bar}${withTree(
      views,
      html`${fetch}${o.files.value.length >= 300 ? Notice({ tone: "warn", children: "Showing the first 300 files." }) : ""}${views.map((fv) => fileView(fv, { sha: v.headSha, dir: o.dir, present: o.present, extra: m ? fileExtra(fv.file.path) : undefined, comment, acts: m && v.state === "OPEN" ? { base, back: "files" } : undefined, more: o.fileSlot?.({ ...pr, path: fv.file.path, status: fv.file.status, sha: v.headSha }) }))}${
        m ? offDiff(off.map((i) => pending[i]!), base, moved ? "Your review is on an older commit." : "These go at the end of the summary when you post.") : ""
      }`,
    )}${template}`;
  }
  return {
    title: `Files · #${v.number} ${v.title} · Dovre`,
    current: PRS,
    body: html`${header(v, "files", { forge, review: m ? { n: m.review?.comments.length ?? 0 } : undefined })}<div data-live id="pr-files">${inner}</div>`,
    head: html`<meta name="u-topics" content="${o.topic}">`,
  };
}

/** While a PR's first read is under way. */
export function readingPage(o: { repo: string; n: number; topic: string; error?: string }): PageOpts {
  return {
    title: `${o.repo}#${o.n} · Dovre`,
    current: PRS,
    body: html`${PageHeader({ title: `${o.repo}#${o.n}`, crumbs: [{ href: PRS, label: "Pull requests" }] })}${
      o.error ? Notice({ tone: "bad", children: html`<strong>The pull request didn't load.</strong> ${o.error}` }) : Reading({ title: "Reading the pull request", text: "It fills in by itself." })
    }`,
    head: html`<meta name="u-topics" content="${o.topic}">`,
  };
}
