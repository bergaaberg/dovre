/**
 * The PR viewer's routes (dovre#106): a PR's conversation and files, read-only from GitHub. A PR
 * seen before draws at once from the cache and is read again in the background; the first visit
 * shows "Reading" and fills itself in over the hub. My own review is kept per person until I post
 * it, and the agent's check of it runs apart from the request (hosted, in the Durable Object).
 */
import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { repoIn } from "../../../actions/deploys.ts";
import { checkReview, postReview } from "../../../actions/reviews.ts";
import { replyToThread, resolveThread } from "../../../actions/threads.ts";
import { type Checkout, checkoutOf, checkouts } from "../../../checkouts.ts";
import type { D1 } from "../../../db.ts";
import type { AppEnv } from "../../../env.ts";
import { type Kept, memoize } from "../../../kept.ts";
import { fileId } from "../../../pages/diffview.ts";
import { BUDGET_MS, type Res, settle, within } from "../../../pages/later.ts";
import { forgeName } from "../../../pages/parts.ts";
import { type Card, type CheckJob, checkOf, lost, saveCheck, startCheck, takeCard } from "../../../reviews/check.ts";
import { cleanText, MAX_BODY, postProblem, type ReviewDraft, verdictOf } from "../../../reviews/draft.ts";
import { addComment, anchorOf, asDraft, clearReview, dropComment, editComment, importDraft, moveReview, type MyReview, myReview, saveSummary } from "../../../reviews/mine.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import { loadPrFiles, loadPrView, type PrFile, type PrView } from "../../../sources/prview.ts";
import type { Child, Html } from "../../../ui/kit.ts";
import { commitOf, dirOf, type Git, git as realGit } from "../../../viewer/code.ts";
import type { PageOpts, PrSlotArg } from "../../types.ts";
import { type Flash, reviewPage } from "./myreview.ts";
import { filesPage, header, type MineOnFiles, prHref, prPage, readingPage } from "./view.ts";


export type PrRoutesDeps = {
  ghe: Ghe;
  /** Draws a page in Dovre's shell (the pack's `ctx.page`). */
  page: (c: Context<AppEnv>, o: PageOpts) => Promise<Response>;
  /** Whose repos are mine (REPO_OWNERS): only their PRs open here. */
  owners: () => string;
  /** Local: the code folder, for a PR's checkout (View file, the fetch hint). */
  codeDir?: string;
  /** Tells pages showing these topics to fetch themselves again. */
  publish?: (topics: string[]) => void;
  kept?: Kept;
  /** What the packs put on the PR's card ("pr.agent" slot: the reviews pack), for a PR the snapshot knows. */
  agentFor?: (repo: string, n: number) => Promise<Html | "">;
  /** "2 of 6 in a stack · waits on #839", when the stacks are known (never waits for them). */
  stackFor?: (repo: string, n: number) => Promise<Child | undefined>;
  /** Pack facts for the PR ("pr.facts" slot), keyed by the PR itself. */
  facts?: (pr: PrSlotArg) => [Child, Child][];
  /** Pack buttons for a file on the Files tab ("pr.file" slot). */
  fileSlot?: (f: PrSlotArg & { path: string; status: string; sha: string }) => Html | "";
  checkouts?: () => Checkout[];
  git?: Git;
  /** My own reviews (dovre#106): where they're kept. Without it, the viewer stays read-only. */
  db?: D1;
  /** My login, to tell my own PRs. */
  login?: () => Promise<string>;
  /** The agent's unposted review draft of this PR, and the commit it read. */
  agentDraft?: (repo: string, n: number) => Promise<{ sha: string; draft: ReviewDraft } | undefined>;
  /** A model to check my review with before I post it (Bino's route), while it's ready. */
  checker?: () => { model: string; /** Runs the job apart from this request; publishes `topic` when its cards are in. Rejects only when it couldn't start. */ start(job: CheckJob, topic: string): Promise<void> } | undefined;
  stale?: () => void;
};

const SHA = /^[0-9a-f]{40}$/;
/** The head and a commit as stored (perhaps short) are the same one. */
const sameSha = (head: string, sha: string) => sha.length >= 7 && head.startsWith(sha);

/** /prs/:owner/:repo/:n and its tabs and my review's actions: the pack mounts them under its own /prs. */
export function createPrRoutes(deps: PrRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const g = deps.git ?? realGit;
  /** What the forge is called on these pages ("GitHub", or a GHE host). */
  const forge = forgeName(deps.ghe.host);
  const draw = (c: Context<AppEnv>, o: PageOpts, status = 200) => {
    c.status(status as 200);
    return deps.page(c, o);
  };
  const views = memoize({ ttlMs: 60e3, kept: deps.kept });
  // Patches are big and a commit's never change: memory only, by head sha.
  const files = memoize({ ttlMs: 60 * 60e3 });
  const list = () => {
    try {
      return deps.checkouts ? deps.checkouts() : deps.codeDir ? checkouts(deps.codeDir, deps.ghe.host, deps.owners()) : [];
    } catch {
      return [];
    }
  };
  const topicOf = (repo: string, n: number) => `pr:${repo}#${n}`;
  /** The PR, at once if it's known (refreshed in the background, and the page told when it lands); else up to 1.5 s for the first read. */
  /** The PR as last read: undefined while it's still loading after `ms` (a page then shows "reading"). */
  async function viewOf(repo: string, n: number, ms?: number): Promise<Res<PrView> | undefined> {
    const loading = settle(views(`prview:${repo}#${n}`, () => loadPrView(deps.ghe, repo, n).then((v) => (deps.publish?.([topicOf(repo, n)]), v))));
    return within(loading, ms);
  }
  const present = new Map<string, boolean>();
  async function hasCommit(dir: string, sha: string) {
    const key = `${dir}@${sha}`;
    if (!present.has(key)) present.set(key, SHA.test(sha) && (await commitOf(g, dirOf(deps.codeDir ?? "", dir), sha)) === sha);
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
    const review = await myReview(deps.db!, who, key);
    return {
      review,
      check: review ? await checkOf(deps.db!, who, key) : undefined,
      at: a ?? undefined,
      agent: d && sameSha(v.headSha, d.sha) && d.draft.comments.length ? d.draft.comments.length : undefined,
      flash: flashOf(`${who}|${key}`),
      checker: !!deps.checker?.(),
    };
  }

  const parse = (owner: string, repo: string, n: string) => {
    const full = /^[\w.-]{1,100}$/.test(repo) && !repo.includes("..") ? repoIn(deps.owners(), `${owner}/${repo}`) : null;
    return full && /^\d{1,7}$/.test(n) ? { repo: full, n: Number(n) } : null;
  };

  app.get("/prs/:owner/:repo/:n", async (c) => {
    const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
    if (!at) return c.notFound();
    const topic = topicOf(at.repo, at.n);
    const got = await viewOf(at.repo, at.n);
    if (!got || !got.ok) return draw(c, readingPage({ ...at, topic, error: got && !got.ok ? got.error : undefined }), got ? 502 : 200);
    const who = c.get("who") ?? "";
    const key = `${at.repo}#${at.n}`;
    const mine = deps.db ? await myReview(deps.db, who, key) : undefined;
    return draw(
      c,
      prPage(forge, {
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
    const topic = topicOf(at.repo, at.n);
    const got = await viewOf(at.repo, at.n);
    if (!got || !got.ok) return draw(c, readingPage({ ...at, topic, error: got && !got.ok ? got.error : undefined }), got ? 502 : 200);
    const v = got.value;
    const loading = settle(files(`files:${at.repo}#${at.n}@${v.headSha}`, () => loadPrFiles(deps.ghe, at.repo, at.n).then((f) => (deps.publish?.([topic]), f))));
    const co = checkoutOf(list(), at.repo);
    // The files and the checkout's git in the same budget: neither holds the page. Still checking git: no "fetch" hint yet.
    const [fs, mine, present] = await Promise.all([within(loading), deps.db ? mineOn(c, at, v) : undefined, co ? within(hasCommit(co.dir, v.headSha), 500) : false]);
    return draw(c, filesPage(forge, { view: v, files: fs, dir: co?.dir, present: present ?? true, topic, mine, fileSlot: deps.fileSlot }));
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
    /** Where an action came from (a PR of the org), the PR as last read, and my review of it. An action
     * waits for the PR however long GitHub takes (hosted, a fresh isolate has nothing cached); a page
     * passes a budget and reads `slow` instead. */
    const ctxOf = async (c: { req: { param: (k: string) => string }; get: (k: "who") => string | undefined }, slow?: { ms: number; got?: Res<PrView> | "slow" }) => {
      const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"));
      if (!at) return undefined;
      const got = await viewOf(at.repo, at.n, slow ? slow.ms : Infinity);
      if (slow) slow.got = got ?? "slow";
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
      return reviewPage(forge, {
        header: header(x.v, "review", { forge, review: { n: review?.comments.length ?? 0 } }),
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
        checker: !!deps.checker?.(),
        check: review ? await checkOf(db, x.who, x.key) : undefined,
        topic: topicOf(x.repo, x.n),
      });
    };

    app.get("/prs/:owner/:repo/:n/review", async (c) => {
      const slow: { ms: number; got?: Res<PrView> | "slow" } = { ms: BUDGET_MS };
      const x = await ctxOf(c, slow);
      if (!x && slow.got) {
        // The PR is still loading, or GitHub failed: say so (it fills in over the hub) rather than "Not found".
        const at = parse(c.req.param("owner"), c.req.param("repo"), c.req.param("n"))!;
        const error = slow.got !== "slow" && !slow.got.ok ? slow.got.error : undefined;
        return draw(c, readingPage({ ...at, topic: topicOf(at.repo, at.n), error }), error ? 502 : 200);
      }
      if (!x) return c.notFound();
      return draw(c, await page(x));
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

    // The agent's check (dovre#299): one model call, its cards kept on the review. It's kept as
    // running and the page comes back at once; the answer fills it in over the hub. Hosted, it runs
    // in the Durable Object, where an answer may take as long as the model does.
    app.post("/prs/:owner/:repo/:n/review/check", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const form = await c.req.parseBody();
      const back = `${x.base}/review`;
      const mode = form.mode === "review" ? "review" : "check";
      const fail = (message: string) => (setFlash(x.flashKey, { ok: false, message }), c.redirect(back, 303));
      if (x.review && x.review.sha !== x.v.headSha) return fail(`Your review is on ${x.review.sha.slice(0, 7)}: move it to ${x.v.headSha.slice(0, 7)} before an agent ${mode === "review" ? "reviews the PR" : "checks it"}.`);
      const ck = deps.checker?.();
      if (!ck) return fail(`There's no agent to ${mode === "review" ? "review" : "check"} with: Bino isn't set up here.`);
      // From the Files tab there's no summary field: keep the one I have.
      if (typeof form.summary === "string") await saveSummary(db, x.who, x.key, x.v.headSha, form.summary);
      else if (!x.review) await saveSummary(db, x.who, x.key, x.v.headSha, "");
      const review = (await myReview(db, x.who, x.key))!;
      if (mode === "check" && !review.summary && !review.comments.length) return fail("Nothing to check yet: write a summary or add a comment, or have the agent review the PR first.");
      const was = await checkOf(db, x.who, x.key);
      if (was?.running && !lost(was)) return c.redirect(`${back}#check`, 303);
      const fs = (await files(`files:${x.repo}#${x.n}@${x.v.headSha}`, () => loadPrFiles(deps.ghe, x.repo, x.n)).catch(() => [])) as PrFile[];
      const job = await startCheck(db, { who: x.who, pr: x.key, model: ck.model, review, files: fs, prView: x.v, mode });
      const topic = topicOf(x.repo, x.n);
      ck.start(job, topic).catch(async (e) => {
        // It never started (the hub didn't take it): the page says so rather than waiting.
        await saveCheck(db, x.who, x.key, { sha: review.sha, at: job.at, model: ck.model, cost: 0, cards: [], mode, error: `The agent couldn't start: ${String((e as Error)?.message ?? e).slice(0, 200)}` }).catch(() => undefined);
        deps.publish?.([topic]);
      });
      return c.redirect(`${back}#check`, 303);
    });

    /** A card's text (as I edited it) into my pending review. False with a flash when it doesn't fit. */
    const keepCard = async (x: NonNullable<Awaited<ReturnType<typeof ctxOf>>>, card: Card, body: string): Promise<false | { id?: number }> => {
      if (!x.review || card.text === undefined) return {};
      if (card.at) {
        const r = await addComment(db, x.who, x.key, x.review.sha, { ...card.at, body });
        if (!r.ok) return (setFlash(x.flashKey, r), false);
        return { id: r.id };
      } else if (card.on === "summary") await saveSummary(db, x.who, x.key, x.review.sha, body);
      else if (x.review.comments.some((k) => k.id === card.on)) await editComment(db, x.who, x.key, card.on as number, body);
      return { id: typeof card.on === "number" ? card.on : undefined };
    };

    /** Every card with text kept as the agent wrote it (a first review taken whole, to edit on the diff). */
    app.post("/prs/:owner/:repo/:n/review/check/all", async (c) => {
      const x = await ctxOf(c);
      if (!x) return c.notFound();
      const back = `${x.base}/review#check`;
      const k = await checkOf(db, x.who, x.key);
      if (!k || k.running || !x.review || k.sha !== x.review.sha) return c.redirect(back, 303);
      let n = 0;
      for (const card of k.cards.filter((y) => y.text !== undefined)) {
        if (!(await keepCard(x, card, card.text!))) return c.redirect(back, 303);
        await takeCard(db, x.who, x.key, card.id);
        n++;
      }
      setFlash(x.flashKey, { ok: true, message: `Added ${n} of the agent's ${n === 1 ? "card" : "cards"} to your review. Change any of it before you post.` });
      return c.redirect(`${x.base}/review`, 303);
    });

    /** A card kept (its text, as I edited it, goes into my pending review) or dismissed. */
    app.post("/prs/:owner/:repo/:n/review/check/:card", async (c) => {
      const x = await ctxOf(c);
      const id = Number(c.req.param("card"));
      if (!x || !Number.isSafeInteger(id) || id <= 0) return c.notFound();
      const form = await c.req.parseBody();
      const files = form.back === "files";
      const k = await checkOf(db, x.who, x.key);
      // Still writing: its cards aren't final yet (they're kept again whole when it's done).
      const card = k?.running ? undefined : k?.cards.find((y) => y.id === id);
      // From the Files tab: back to the comment it made, or to the card's file.
      const path = card?.at?.path ?? x.review?.comments.find((y) => y.id === card?.on)?.path;
      const back = (kept?: number) => (files ? `${x.base}/files${kept ? `#c-${kept}` : path ? `#${fileId(path)}` : ""}` : `${x.base}/review#check`);
      if (card && form.do === "keep" && card.text !== undefined) {
        const r = await keepCard(x, card, typeof form.body === "string" ? form.body : card.text);
        if (!r) return c.redirect(back(), 303);
        await takeCard(db, x.who, x.key, id);
        return c.redirect(back(r.id), 303);
      }
      if (card) await takeCard(db, x.who, x.key, id);
      return c.redirect(back(), 303);
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
    const reread = (repo: string, n: number) => views(`prview:${repo}#${n}`, () => loadPrView(deps.ghe, repo, n), { fresh: true }).then(() => deps.publish?.([topicOf(repo, n)]), () => undefined);
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
      if (problem) return draw(c, await page(x, { review, verdict, preview: { problem } }), 400);
      const me = deps.login ? await deps.login().catch(() => "") : "";
      const checked = await checkReview(deps.ghe, x.repo, x.n, { reviewed: review.sha, me, draft, by: "me", verdict });
      if (!checked.ok) return draw(c, await page(x, { review, verdict, preview: { problem: checked.message } }), 409);
      return draw(c, await page(x, { review, verdict, preview: { draft: checked.draft, notes: checked.notes, nonce: randomUUID(), print: print(draft, verdict, review.sha) } }));
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

  return app;
}
