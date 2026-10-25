/**
 * Agent code review on a PR (WP-A3): the block on the PR card (start one; running; the report),
 * the confirm page that shows what will run, and the routes that start it. The agent runs
 * through the same runner as any session, in the repo's checkout, asking before it acts.
 */
import { owns, ownersIn } from "../owners.ts";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { html } from "hono/html";
import type { HarnessId, Run, Runner } from "../agents/runner.ts";
import { repoDir } from "../agents/runner.ts";
import type { D1 } from "../db.ts";
import type { AppEnv, Env } from "../env.ts";
import type { Snapshot } from "../gather.ts";
import { type Frame, shell } from "../html.ts";
import { checkoutOf, checkouts } from "../issues/tasks.ts";
import { allowedFor, cloneCommand, KIND_LABEL, kindFor, prKey, type ReviewKind, reviewPrompt, setSkills, SKILL, skillOf } from "../reviews/agent.ts";
import { type AgentReview, latestReviews, markPosted, recordReview, reviewOf, syncReviews } from "../reviews/store.ts";
import { checkReplies, checkReview, postReplies, postReview } from "../actions/reviews.ts";
import { type Draft, draftOf, editedDraft, type LineComment, MAX_BODY, MAX_SUMMARY, postProblem, splitDraft, type Verdict, VERDICT_LABEL, verdictOf, VERDICTS } from "../reviews/draft.ts";
import type { Ghe, Pr } from "../sources/ghe.ts";
import { Confirm, type Html, KeyValues, Notice, PageHeader, Panel, Pill } from "../ui/kit.ts";
import { markdown } from "../ui/markdown.ts";
import { modelSelect } from "./models.ts";
import { Ago, harnessTag, HARNESS_NAME, Link, safeUrl } from "./parts.ts";

import type { AgentOf } from "./inline.ts";
export type { AgentOf };

const startHref = (p: Pr, kind: ReviewKind) => safeUrl(`/prs/agent?pr=${encodeURIComponent(prKey(p))}&kind=${kind}`);
const sessionHref = (r: AgentReview) => safeUrl(r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.runId}`);

/** The block on a PR card. `report`: the agent's last message, once it's done. */
export function agentBlock(p: Pr, kind: ReviewKind, r: AgentReview | undefined, report: string | undefined): Html {
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
  const posted = r.posted ? html`<p class="hint">Posted ${r.posted.what ? html`(${r.posted.what}) ` : ""}${Ago(r.posted.at)}${r.posted.url ? html` · ${Link(r.posted.url, "Open on GHE")}` : ""}</p>` : "";
  const draft = r.posted || !split ? "" : split.draft ? (older ? html`<span class="hint">The draft is for an older commit: review again to post one.</span>` : html`<a class="btn primary" href="${draftHref(r)}">Go through the draft…</a>`) : split.broken ? html`<span class="hint">The draft at the end of the ${kind === "review" ? "report" : "assessment"} couldn't be read.</span>` : "";
  return html`<div class="agent-review">${head}${body}${posted}<div class="buttons">${draft}${again}</div></div>`;
}

const draftHref = (r: AgentReview) => safeUrl(`/prs/draft?run=${encodeURIComponent(r.runId)}`);
const RUN_ID = /^[\w-]{1,80}$/;

/** The PR a review was of, from its key ("ACME/people#7"); its card in the snapshot when there is one. */
const prOfKey = (key: string) => {
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

type DraftView = {
  r: AgentReview;
  pr: { repo: string; number: number; url: string; title?: string; author?: string };
  base: Draft;
  form?: Record<string, unknown>;
  verdict: Verdict;
  /** After Preview: what would go, or why it can't. */
  preview?: { draft: Draft; notes: string[]; nonce: string } | { problem: string };
  flash?: { ok: boolean; message: string };
};

/** The draft as cards I change or drop, and after Preview, exactly what goes with its Post. */
export function draftPage(frame: Frame, v: DraftView): Html {
  const { r, pr, base } = v;
  const review = base.kind === "review";
  const cards = cardsOf(base, v.form);
  const text = (name: string, was: string) => (v.form && typeof v.form[name] === "string" ? String(v.form[name]) : was);
  const card = (i: number, label: Html) => html`<div class="draft-card">
<div class="draft-card-h">${label}<label class="check"><input type="checkbox" name="keep_${i}" value="on"${cards[i]!.keep ? html` checked` : ""}> Post this</label></div>
<textarea name="body_${i}" rows="${rows(cards[i]!.body)}" maxlength="${MAX_BODY}" aria-label="Text">\n${cards[i]!.body}</textarea></div>`;
  const form = html`<form method="post" action="/prs/draft/preview"><input type="hidden" name="run" value="${r.runId}">
${review
  ? html`<div class="field"><fieldset><legend class="label">Verdict</legend>${VERDICTS.map((x) => html`<label class="check"><input type="radio" name="verdict" value="${x}"${x === v.verdict ? html` checked` : ""}> ${VERDICT_LABEL[x]}</label>`)}</fieldset><span class="hint">Yours to pick: the agent doesn't choose it.</span></div>
<label class="field"><span class="label">Summary</span><textarea name="summary" rows="${rows(text("summary", base.summary), 4)}" maxlength="${MAX_SUMMARY}">\n${text("summary", base.summary)}</textarea></label>
${base.comments.length ? html`<p class="draft-h">Line comments</p>${base.comments.map((c, i) => card(i, html`<code class="draft-where">${whereOf(c)}</code>`))}` : ""}`
  : html`${base.replies.length ? html`<p class="draft-h">Replies</p>${base.replies.map((x, i) => card(i, html`<span class="draft-where">Reply to ${Link(`${pr.url}#discussion_r${x.commentId}`, "this comment")}</span>`))}` : ""}
<label class="field"><span class="label">A comment on the PR</span><span class="hint">Optional: for what was said outside a thread.</span><textarea name="comment" rows="${rows(text("comment", base.comment))}" maxlength="${MAX_SUMMARY}">\n${text("comment", base.comment)}</textarea></label>`}
<div class="buttons"><button type="submit" class="primary" data-busy="Checking">Preview</button><span class="hint">Nothing goes to GHE before Post on the preview.</span></div>
</form>`;
  const p = v.preview;
  const preview = !p
    ? ""
    : "problem" in p
      ? Notice({ tone: "bad", children: p.problem })
      : Panel({
          title: "What goes to GHE",
          meta: review ? Pill({ children: VERDICT_LABEL[v.verdict] }) : undefined,
          children: html`${p.notes.map((n) => Notice({ tone: "warn", children: n }))}
${p.draft.kind === "review"
  ? html`${p.draft.summary ? html`<div class="draft-text">${markdown(p.draft.summary)}</div>` : ""}${p.draft.comments.map((c) => html`<div class="draft-card"><code class="draft-where">${whereOf(c)}</code><div class="draft-text">${markdown(c.body)}</div></div>`)}`
  : html`${p.draft.replies.map((x) => html`<div class="draft-card"><span class="draft-where">Reply to ${Link(`${pr.url}#discussion_r${x.commentId}`, "this comment")}</span><div class="draft-text">${markdown(x.body)}</div></div>`)}${p.draft.comment ? html`<div class="draft-card"><span class="draft-where">On the PR</span><div class="draft-text">${markdown(p.draft.comment)}</div></div>` : ""}`}
<div class="buttons">${Confirm({
            action: "/prs/draft/post",
            fields: { run: r.runId, verdict: v.verdict, nonce: p.nonce, draft: JSON.stringify(p.draft) },
            label: review ? `Post the review` : `Post the replies`,
            question: html`Post this on ${pr.repo}#${pr.number} as you${review ? html`, as <strong>${VERDICT_LABEL[v.verdict]}</strong>` : ""}?`,
          })}</div>`,
        });
  const body = html`${PageHeader({
    title: review ? "The agent's review" : "The agent's replies",
    crumbs: [{ href: "/prs", label: "Pull requests" }],
    sub: html`${Link(pr.url, html`${pr.repo}#${pr.number}${pr.title ? html` ${pr.title}` : ""}`)}${pr.author ? html` <span class="t3">by ${pr.author}</span>` : ""} · <a href="${safeUrl(r.sessionId ? `/agents/s/${r.sessionId}` : `/agents/r/${r.runId}`)}">the session</a>`,
  })}
${v.flash ? Notice({ tone: v.flash.ok ? "ok" : "bad", children: v.flash.message }) : ""}
${r.posted
  ? Notice({ tone: "ok", children: html`Posted ${r.posted.what ? html`(${r.posted.what}) ` : ""}${Ago(r.posted.at)}.${r.posted.url ? html` ${Link(r.posted.url, "Open it on GHE")}` : ""}` })
  : html`${Panel({ title: review ? "Go through it" : "Go through them", meta: html`<span class="t3">Change any text, untick what shouldn't go.</span>`, children: form })}${preview}`}`;
  return shell({ title: `${review ? "The agent's review" : "The agent's replies"} · Dovre`, frame, current: "/prs", body });
}

type Confirm = {
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
export function confirmPage(frame: Frame, c: Confirm): Html {
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
<form method="post" action="/prs/agent"><input type="hidden" name="pr" value="${prKey(pr)}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="nonce" value="${c.nonce}">
<div class="fields">${c.harnesses.length > 1 ? html`<label class="field"><span class="label">Agent</span><select name="harness">${c.harnesses.map((h) => html`<option value="${h.id}">${HARNESS_NAME[h.id]}</option>`)}</select></label>` : first ? html`<input type="hidden" name="harness" value="${first.id}">` : ""}${modelSelect("", c.harnesses.length ? c.harnesses.map((h) => h.id) : ["claude"])}
<div class="field"><button type="submit" class="primary" data-busy="Starting"${canStart ? "" : html` disabled`}>Start</button></div></div>
</form>`,
})}`;
  return shell({ title: `${KIND_LABEL[kind]} · Dovre`, frame, current: "/prs", body });
}

export type ReviewDeps = {
  db: D1;
  runner?: Runner;
  page: () => Promise<{ s: Snapshot; frame: Frame }>;
  /** The agent's last message in a session: from the run, or its transcript. */
  lastMessage: (r: AgentReview) => string | undefined;
  checkouts?: () => { dir: string; repo: string }[];
  home?: string;
  modelOf: (v: unknown, h: HarnessId) => string;
};

const findPr = (s: Snapshot, key: string): Pr | undefined => (s.prs.ok ? [...s.prs.value.review, ...s.prs.value.mine].find((p) => prKey(p).toLowerCase() === key.toLowerCase()) : undefined);
const first = (v: unknown): string => (typeof v === "string" ? v : "");

/** The agent block for every PR card on a page, from what's stored and what's running. */
export async function agentViews(deps: ReviewDeps, s: Snapshot): Promise<AgentOf> {
  // No agent CLI here: nothing to offer.
  if (!deps.runner?.harnesses().length) return () => "";
  const reviews = await latestReviews(deps.db);
  await syncReviews(deps.db, reviews, (id) => deps.runner?.get(id));
  return (p) => {
    const kind = kindFor(p, s.login);
    if (!kind) return "";
    const r = reviews.get(`${kind}:${prKey(p)}`);
    return agentBlock(p, kind, r, r?.status === "done" ? deps.lastMessage(r) : undefined);
  };
}

/** /prs/agent: the confirm page and the start. Mounted at "/" behind the app's cookie and same-origin checks. */
export function createReviewRoutes(env: Env, deps: ReviewDeps & { ghe: Ghe; stale?: () => void }): Hono<AppEnv> {
  setSkills({ review: env.REVIEW_SKILL, triage: env.TRIAGE_SKILL });
  const app = new Hono<AppEnv>();
  /** Confirm-page nonces already used: a double click or a re-post starts one run. */
  const spent = new Map<string, string>();
  const dirOf = (repo: string) => {
    const list = deps.checkouts ? deps.checkouts() : checkouts(env.CODE_DIR, deps.ghe.host, ownersIn(env));
    const c = checkoutOf(list, repo);
    return c ? repoDir(env.CODE_DIR, c.dir) ?? undefined : undefined;
  };
  const offered = (kind: ReviewKind, p: Pr) =>
    (deps.runner?.harnesses() ?? []).flatMap((id) => {
      const skill = skillOf(kind, id, { home: deps.home, codeDir: env.CODE_DIR });
      return skill ? [{ id, prompt: reviewPrompt(kind, p.url, id, skill), allowed: allowedFor(id) }] : [];
    });
  const runningOf = async (kind: ReviewKind, p: Pr) => {
    const reviews = await latestReviews(deps.db);
    await syncReviews(deps.db, reviews, (id) => deps.runner?.get(id));
    const r = reviews.get(`${kind}:${prKey(p)}`);
    return r?.status === "running" ? r : undefined;
  };
  const confirm = async (c: { s: Snapshot; frame: Frame }, p: Pr, kind: ReviewKind, problem?: string, status: 200 | 400 | 409 = 200) =>
    new Response(String(confirmPage(c.frame, { pr: p, kind, dir: dirOf(p.repo), clone: cloneCommand(deps.ghe.host, p.repo, env.CODE_DIR), harnesses: offered(kind, p), running: await runningOf(kind, p), problem, nonce: randomUUID() })), {
      status,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });

  app.get("/prs/agent", async (c) => {
    const ctx = await deps.page();
    const p = findPr(ctx.s, c.req.query("pr") ?? "");
    const kind = p ? kindFor(p, ctx.s.login) : null;
    if (!p || !kind || kind !== c.req.query("kind")) return c.redirect("/prs", 303);
    return confirm(ctx, p, kind);
  });

  app.post("/prs/agent", async (c) => {
    const form = await c.req.parseBody();
    const ctx = await deps.page();
    const p = findPr(ctx.s, first(form.pr));
    const kind = p ? kindFor(p, ctx.s.login) : null;
    if (!p || !kind || kind !== first(form.kind)) return c.redirect("/prs", 303);
    const nonce = first(form.nonce);
    if (!/^[0-9a-f-]{36}$/.test(nonce)) return confirm(ctx, p, kind, "Start from the confirm page: nothing was started.", 400);
    const was = spent.get(nonce);
    if (was) return c.redirect(was, 303);
    const running = await runningOf(kind, p);
    if (running) return c.redirect(sessionHref(running), 303);
    const h = offered(kind, p).find((x) => x.id === first(form.harness));
    const cwd = dirOf(p.repo);
    if (!deps.runner || !h || !cwd) return confirm(ctx, p, kind, !deps.runner ? "Agents can't run here." : !cwd ? `${p.repo} isn't checked out.` : "That agent can't do this here.", 400);
    if (spent.size > 200) spent.delete(spent.keys().next().value as string);
    spent.set(nonce, "/prs");
    const run: Run = deps.runner.start({ harness: h.id, cwd, prompt: h.prompt, mode: "default", model: deps.modelOf(form.model, h.id), allowed: h.allowed });
    await recordReview(deps.db, { runId: run.id, kind, pr: prKey(p), headSha: p.headSha, harness: h.id, status: "running", startedAt: run.startedAt });
    const sid = await deps.runner.sessionOf(run.id, 300);
    const to = sid ? `/agents/s/${sid}` : `/agents/r/${run.id}`;
    spent.set(nonce, to);
    return c.redirect(to, 303);
  });

  // ── Posting the draft (WP-A20) ──
  /** What the last post said, shown once on the draft page. */
  const flashes = new Map<string, { ok: boolean; message: string }>();
  /** A finished review with a draft for its PR, or why there's nothing to go through. */
  const draftCtx = async (runId: unknown) => {
    const id = first(runId);
    if (!RUN_ID.test(id)) return undefined;
    const r = await reviewOf(deps.db, id);
    const at = r ? prOfKey(r.pr) : undefined;
    if (!r || !at || !owns(ownersIn(env), r.pr.split("/")[0]!)) return undefined;
    await syncReviews(deps.db, new Map([[r.runId, r]]), (x) => deps.runner?.get(x));
    const ctx = await deps.page();
    const card = findPr(ctx.s, r.pr);
    const pr = { ...at, url: card?.url ?? `https://${deps.ghe.host}/${at.repo}/pull/${at.number}`, title: card?.title, author: card?.author };
    const split = r.status === "done" ? splitDraft(r.kind, deps.lastMessage(r) ?? "") : undefined;
    return { r, pr, ctx, base: split?.draft };
  };
  const html200 = (h: Html, status: 200 | 400 | 409 = 200) => new Response(String(h), { status, headers: { "content-type": "text/html; charset=UTF-8" } });

  app.get("/prs/draft", async (c) => {
    const d = await draftCtx(c.req.query("run"));
    if (!d) return c.redirect("/prs", 303);
    const flash = flashes.get(d.r.runId);
    flashes.delete(d.r.runId);
    if (!d.base) return c.redirect("/prs", 303);
    return html200(draftPage(d.ctx.frame, { r: d.r, pr: d.pr, base: d.base, verdict: "comment", flash }));
  });

  app.post("/prs/draft/preview", async (c) => {
    const form = await c.req.parseBody();
    const d = await draftCtx(form.run);
    if (!d?.base) return c.redirect("/prs", 303);
    const verdict = d.base.kind === "review" ? verdictOf(form.verdict) : "comment";
    const view = { r: d.r, pr: d.pr, base: d.base, form, verdict };
    if (d.r.posted) return c.redirect(draftHref(d.r), 303);
    const edited = editedDraft(d.base, form);
    const problem = postProblem(edited, verdict);
    if (problem) return html200(draftPage(d.ctx.frame, { ...view, preview: { problem } }), 400);
    const checked = edited.kind === "review" ? await checkReview(deps.ghe, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, me: d.ctx.s.login, draft: edited }) : await checkReplies(deps.ghe, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, draft: edited });
    if (!checked.ok) return html200(draftPage(d.ctx.frame, { ...view, preview: { problem: checked.message } }), 409);
    // What's shown is what goes: the draft after the checks, with comments off the diff in the summary.
    return html200(draftPage(d.ctx.frame, { ...view, preview: { draft: checked.draft, notes: checked.notes, nonce: randomUUID() } }));
  });

  app.post("/prs/draft/post", async (c) => {
    const form = await c.req.parseBody();
    const d = await draftCtx(form.run);
    if (!d?.base) return c.redirect("/prs", 303);
    const back = draftHref(d.r);
    const nonce = first(form.nonce);
    if (!/^[0-9a-f-]{36}$/.test(nonce) || spent.has(nonce) || d.r.posted) return c.redirect(back, 303);
    let draft: Draft | null = null;
    try {
      const raw = JSON.parse(first(form.draft));
      // An Approve may go with nothing else: the preview's empty review, kept as one.
      draft = draftOf(d.r.kind, raw) ?? (d.r.kind === "review" && raw?.kind === "review" ? { kind: "review", summary: "", comments: [] } : null);
    } catch {}
    const verdict = d.r.kind === "review" ? verdictOf(form.verdict) : "comment";
    const problem = !draft || draft.kind !== d.r.kind ? "That isn't a draft from the preview: nothing posted." : postProblem(draft, verdict);
    if (problem || !draft) {
      flashes.set(d.r.runId, { ok: false, message: problem ?? "Nothing posted." });
      return c.redirect(back, 303);
    }
    if (spent.size > 200) spent.delete(spent.keys().next().value as string);
    spent.set(nonce, back);
    const res =
      draft.kind === "review"
        ? await postReview(deps.ghe, deps.db, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, me: d.ctx.s.login, draft, verdict })
        : await postReplies(deps.ghe, deps.db, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, draft });
    // Partly posted counts as posted: posting again would repeat what went.
    if (res.ok) {
      const url = res.url && res.url.startsWith(`https://${deps.ghe.host}/`) ? res.url : undefined;
      await markPosted(deps.db, d.r.runId, { at: Date.now(), what: res.what ?? "", url });
      deps.stale?.();
    }
    flashes.set(d.r.runId, { ok: res.ok && !res.partial, message: res.message });
    return c.redirect(back, 303);
  });

  return app;
}

