/**
 * Agent reviews, a core pack (#389): review someone else's PR, or assess the review on mine, with
 * an agent skill (REVIEW_SKILL, TRIAGE_SKILL), then go through its draft and post it. Local only:
 * the agent runs through this machine's runner, in the repo's checkout, asking before it acts.
 * It fills the PR cards ("pr.agent") and hands a finished review's draft to my own review in the
 * viewer ("review.draft"). The runs it started are kept in agent_reviews (store.ts).
 */
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { checkReplies, checkReview, postReplies, postReview, reviewedDiff } from "../../../actions/reviews.ts";
import { findSession, SID } from "../../../agents/desk.ts";
import type { HarnessId, Run, Runner } from "../../../agents/runner.ts";
import type { AppEnv } from "../../../env.ts";
import type { Snapshot } from "../../../gather.ts";
import { owns } from "../../../owners.ts";
import { later } from "../../../pages/later.ts";
import { type Draft, draftOf, editedDraft, postProblem, splitDraft, verdictOf } from "../../../reviews/draft.ts";
import type { Ghe, Pr } from "../../../sources/ghe.ts";
import type { Html } from "../../../ui/kit.ts";
import { type Pack, type PackContext, PACK_API } from "../../types.ts";
import { allowedFor, cloneCommand, KIND_LABEL, kindFor, prKey, type ReviewKind, reviewPrompt, setSkills, skillOf } from "./agent.ts";
import { type AgentReview, latestReviews, liveOf, markPosted, recordReview, reviewOf, syncReviews } from "./store.ts";
import { agentBlock, confirmPage, type DraftDiff, draftHref, draftPage, prOfKey, sessionHref } from "./view.ts";

export type ReviewsDeps = {
  runner: Runner;
  /** The forge, to read the reviewed diff and post. */
  ghe: Ghe;
  /** Whose repos are mine (REPO_OWNERS): a draft for anyone else's isn't posted. */
  owners: () => string;
  /** The folder of the checkout a repo is in, or undefined when it isn't checked out. */
  dirOf: (repo: string) => string | undefined;
  /** Where checkouts go (CODE_DIR), for the clone command and agent-skills' clone. */
  codeDir: string;
  /** Where Claude Code keeps its transcripts: a finished review's report when the run's gone. */
  claudeDir?: string;
  /** Where the agents' skills are installed (default: the home folder); for tests. */
  home?: string;
  modelOf: (v: unknown, h: HarnessId) => string;
  /** After a post: gather again, so the PR shows it. */
  stale?: () => void;
};

const RUN_ID = /^[\w-]{1,80}$/;
const NONCE = /^[0-9a-f-]{36}$/;
const first = (v: unknown): string => (typeof v === "string" ? v : "");
const findPr = (s: Snapshot | undefined, key: string): Pr | undefined =>
  s?.prs.ok ? [...s.prs.value.review, ...s.prs.value.mine].find((p) => prKey(p).toLowerCase() === key.toLowerCase()) : undefined;
const status = (res: Response, code: number) => (code === 200 ? res : new Response(res.body, { status: code, headers: res.headers }));
/** Remembers a few hundred keys, the oldest let go. */
const bounded = <V>(m: Map<string, V>, k: string, v: V) => {
  if (m.size > 200) m.delete(m.keys().next().value as string);
  m.set(k, v);
};

export function reviewsPack(deps: ReviewsDeps): Pack {
  const { runner } = deps;
  /** The newest review of each kind per PR (store.ts), loaded before the first page and kept after each start and post. */
  let latest: Map<string, AgentReview> | undefined;
  let loading: Promise<void> | undefined;
  const load = (ctx: PackContext) =>
    (loading ??= (async () => {
      const next = await latestReviews(ctx.db);
      await syncReviews(ctx.db, next, (id) => runner.get(id));
      latest = next;
    })().finally(() => (loading = undefined)));
  /** A review as it is now: the runner says whether it's still running. */
  const now = (r: AgentReview | undefined) => (r ? liveOf(r, (id) => runner.get(id)) : undefined);

  /** A finished review's report doesn't change: read once, from the run or the session's transcript. */
  const reports = new Map<string, string>();
  const lastMessage = (r: AgentReview): string | undefined => {
    const hit = reports.get(r.runId);
    if (hit !== undefined) return hit;
    const run = runner.get(r.runId);
    const fromRun = run ? ([...run.events].reverse().find((e) => e.t === "result" && e.text.trim()) as { text: string } | undefined)?.text ?? ([...run.events].reverse().find((e) => e.t === "text") as { text: string } | undefined)?.text : undefined;
    // The agent's own last message: what the session page shows, never a tool result.
    const fromTranscript = !fromRun && deps.claudeDir && r.sessionId && SID.test(r.sessionId) ? [...findSession(deps.claudeDir, r.sessionId, []).turns].reverse().find((t) => t.role === "assistant") : undefined;
    const text = fromRun ?? (fromTranscript && "text" in fromTranscript ? fromTranscript.text : undefined);
    if (text !== undefined && r.status !== "running") reports.set(r.runId, text);
    return text;
  };

  const offered = (kind: ReviewKind, p: Pr) =>
    runner.harnesses().flatMap((id) => {
      const skill = skillOf(kind, id, { home: deps.home, codeDir: deps.codeDir });
      return skill ? [{ id, prompt: reviewPrompt(kind, p.url, id, skill), allowed: allowedFor(id) }] : [];
    });

  return {
    manifest: {
      api: PACK_API,
      id: "reviews",
      name: "Agent reviews",
      description: "Review a PR, or assess the review on yours, with an agent skill; go through its draft before it's posted",
      domain: "general",
      execution: "local-only",
      settings: [
        { key: "REVIEW_SKILL", label: "Review skill", help: "The skill that reviews someone else's PR (default: review)." },
        { key: "TRIAGE_SKILL", label: "Assessment skill", help: "The skill that assesses the review on my PR (default: review-triage)." },
      ],
      // Keeps what ended in agent_reviews; the cards ask the runner directly.
      everyMs: 60_000,
    },
    // Without an agent CLI here, there's nothing to offer.
    available: () => runner.harnesses().length > 0,
    init: (ctx) => load(ctx),
    refresh: (ctx) => load(ctx),
    beforePage: async (ctx) => {
      if (!latest) await load(ctx);
    },
    slots: (ctx) => ({
      "pr.agent": (a) => {
        const s = ctx.snapshot();
        const p = findPr(s, prKey(a));
        const kind = p && s ? kindFor(p, s.login) : null;
        if (!p || !kind) return "";
        const r = now(latest?.get(`${kind}:${prKey(p)}`));
        return agentBlock(p, kind, r, r?.status === "done" ? lastMessage(r) : undefined, ctx.forge()?.name ?? "GitHub");
      },
      "review.draft": (a) => {
        const r = now(latest?.get(`review:${prKey(a)}`));
        if (!r || r.status !== "done" || r.posted) return undefined;
        const d = splitDraft("review", lastMessage(r) ?? "").draft;
        return d?.kind === "review" ? { sha: r.headSha, draft: d } : undefined;
      },
    }),
    routes(app, ctx) {
      setSkills({ review: ctx.env.REVIEW_SKILL, triage: ctx.env.TRIAGE_SKILL });
      const forge = () => ctx.forge()?.name ?? "GitHub";
      /** Confirm-page nonces already used: a double click or a re-post starts one run. */
      const spent = new Map<string, string>();
      const runningOf = async (kind: ReviewKind, p: Pr) => {
        await load(ctx);
        const r = latest?.get(`${kind}:${prKey(p)}`);
        return r?.status === "running" ? r : undefined;
      };
      const page = (c: Context<AppEnv>, title: string, body: Html, code = 200) => ctx.page(c, { title, body, current: "/prs" }).then((res) => status(res, code));
      const confirm = async (c: Context<AppEnv>, p: Pr, kind: ReviewKind, problem?: string, code = 200) =>
        page(c, KIND_LABEL[kind], confirmPage({ pr: p, kind, dir: deps.dirOf(p.repo), clone: cloneCommand(deps.ghe.host, p.repo, deps.codeDir), harnesses: offered(kind, p), running: await runningOf(kind, p), problem, nonce: randomUUID() }), code);

      app.get("/reviews/agent", async (c) => {
        const s = await ctx.gathered();
        const p = findPr(s, c.req.query("pr") ?? "");
        const kind = p && s ? kindFor(p, s.login) : null;
        if (!p || !kind || kind !== c.req.query("kind")) return c.redirect("/prs", 303);
        return confirm(c, p, kind);
      });

      app.post("/reviews/agent", async (c) => {
        const form = await c.req.parseBody();
        const s = await ctx.gathered();
        const p = findPr(s, first(form.pr));
        const kind = p && s ? kindFor(p, s.login) : null;
        if (!p || !kind || kind !== first(form.kind)) return c.redirect("/prs", 303);
        const nonce = first(form.nonce);
        if (!NONCE.test(nonce)) return confirm(c, p, kind, "Start from the confirm page: nothing was started.", 400);
        const was = spent.get(nonce);
        if (was) return c.redirect(was, 303);
        const running = await runningOf(kind, p);
        if (running) return c.redirect(sessionHref(running), 303);
        const h = offered(kind, p).find((x) => x.id === first(form.harness));
        const cwd = deps.dirOf(p.repo);
        if (!h || !cwd) return confirm(c, p, kind, !cwd ? `${p.repo} isn't checked out.` : "That agent can't do this here.", 400);
        bounded(spent, nonce, "/prs");
        const run: Run = runner.start({ harness: h.id, cwd, prompt: h.prompt, mode: "default", model: deps.modelOf(form.model, h.id), allowed: h.allowed });
        const r: AgentReview = { runId: run.id, kind, pr: prKey(p), headSha: p.headSha, harness: h.id, status: "running", startedAt: run.startedAt };
        await recordReview(ctx.db, r);
        latest?.set(`${kind}:${r.pr}`, r);
        const sid = await runner.sessionOf(run.id, 300);
        const to = sid ? `/agents/s/${sid}` : `/agents/r/${run.id}`;
        spent.set(nonce, to);
        return c.redirect(to, 303);
      });

      // ── Posting the draft (WP-A20) ──
      /** What the last post said, shown once on the draft page. */
      const flashes = new Map<string, { ok: boolean; message: string }>();
      /** A finished review with a draft for its PR, or undefined when there's nothing to go through. */
      const draftCtx = async (runId: unknown) => {
        const id = first(runId);
        if (!RUN_ID.test(id)) return undefined;
        const r = await reviewOf(ctx.db, id);
        const at = r ? prOfKey(r.pr) : undefined;
        if (!r || !at || !owns(deps.owners(), r.pr.split("/")[0]!)) return undefined;
        await syncReviews(ctx.db, new Map([[r.runId, r]]), (x) => runner.get(x));
        const s = await ctx.gathered();
        const card = findPr(s, r.pr);
        const pr = { ...at, url: card?.url ?? `https://${deps.ghe.host}/${at.repo}/pull/${at.number}`, title: card?.title, author: card?.author };
        const split = r.status === "done" ? splitDraft(r.kind, lastMessage(r) ?? "") : undefined;
        return { r, pr, login: s?.login ?? "", base: split?.draft };
      };
      /** The reviewed diff, per PR and commit: up to 1.5 s, then the page reads on (data-pending) while it loads. Kept a minute. */
      const diffs = later({ max: 50 });
      const diffOf = async (d: { r: AgentReview; pr: { repo: string; number: number } }): Promise<DraftDiff | undefined> => {
        if (d.r.kind !== "review" || d.r.posted) return undefined;
        const r = await diffs(`${d.pr.repo}#${d.pr.number}@${d.r.headSha}`, () => reviewedDiff(deps.ghe, d.pr.repo, d.pr.number, d.r.headSha));
        if (!r) return "reading";
        if (!r.ok) return { ok: false, why: `The diff didn't load: ${r.error}` };
        const x = r.value;
        return "moved" in x ? { ok: false, why: `The PR has new commits since the review (${d.r.headSha.slice(0, 7)} → ${x.moved.slice(0, 7)}), so the comments are listed here, not in the diff.` } : { ok: true, ...x };
      };
      const titleOf = (d: Draft) => (d.kind === "review" ? "The agent's review" : "The agent's replies");

      app.get("/reviews/draft", async (c) => {
        const d = await draftCtx(c.req.query("run"));
        if (!d?.base) return c.redirect("/prs", 303);
        const flash = flashes.get(d.r.runId);
        flashes.delete(d.r.runId);
        return page(c, titleOf(d.base), draftPage(forge(), { r: d.r, pr: d.pr, base: d.base, verdict: "comment", flash, diff: await diffOf(d) }));
      });

      app.post("/reviews/draft/preview", async (c) => {
        const form = await c.req.parseBody();
        const d = await draftCtx(form.run);
        if (!d?.base) return c.redirect("/prs", 303);
        if (d.r.posted) return c.redirect(draftHref(d.r), 303);
        const verdict = d.base.kind === "review" ? verdictOf(form.verdict) : "comment";
        // A POST's page can't fill itself in (it would fetch the URL again): no pending diff here.
        const diff = await diffOf(d);
        const view = { r: d.r, pr: d.pr, base: d.base, form, verdict, diff: diff === "reading" ? undefined : diff };
        const show = (preview: Parameters<typeof draftPage>[1]["preview"], code = 200) => page(c, titleOf(d.base!), draftPage(forge(), { ...view, preview }), code);
        const edited = editedDraft(d.base, form);
        const problem = postProblem(edited, verdict);
        if (problem) return show({ problem }, 400);
        const checked = edited.kind === "review" ? await checkReview(deps.ghe, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, me: d.login, draft: edited }) : await checkReplies(deps.ghe, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, draft: edited });
        if (!checked.ok) return show({ problem: checked.message }, 409);
        // What's shown is what goes: the draft after the checks, with comments off the diff in the summary.
        return show({ draft: checked.draft, notes: checked.notes, nonce: randomUUID() });
      });

      app.post("/reviews/draft/post", async (c) => {
        const form = await c.req.parseBody();
        const d = await draftCtx(form.run);
        if (!d?.base) return c.redirect("/prs", 303);
        const back = draftHref(d.r);
        const nonce = first(form.nonce);
        if (!NONCE.test(nonce) || spent.has(nonce) || d.r.posted) return c.redirect(back, 303);
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
        bounded(spent, nonce, back);
        const res =
          draft.kind === "review"
            ? await postReview(deps.ghe, ctx.db, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, me: d.login, draft, verdict })
            : await postReplies(deps.ghe, ctx.db, d.pr.repo, d.pr.number, { reviewed: d.r.headSha, draft });
        // Partly posted counts as posted: posting again would repeat what went.
        if (res.ok) {
          const url = res.url && res.url.startsWith(`https://${deps.ghe.host}/`) ? res.url : undefined;
          const posted = { at: Date.now(), what: res.what ?? "", url };
          await markPosted(ctx.db, d.r.runId, posted);
          const kept = latest?.get(`${d.r.kind}:${d.r.pr}`);
          if (kept?.runId === d.r.runId) kept.posted = posted;
          deps.stale?.();
        }
        bounded(flashes, d.r.runId, { ok: res.ok && !res.partial, message: res.message });
        return c.redirect(back, 303);
      });
    },
  };
}
