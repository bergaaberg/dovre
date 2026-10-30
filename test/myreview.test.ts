/** My own review of a PR (dovre#106): comments on lines kept until I post, then one review on GHE after the same checks as an agent's. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentActions } from "../src/actions/deploys.ts";
import { openDb } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { createViewerRoutes } from "../src/pages/viewer.ts";
import type { ReviewDraft } from "../src/reviews/draft.ts";
import { addComment, anchorOf, importDraft, myReview, saveSummary } from "../src/reviews/mine.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import type { Complete } from "../src/ai/llm.ts";
import { checkOf, runCheck, saveCheck } from "../src/reviews/check.ts";
import { assertInert, H } from "./helpers.ts";

const SHA = "a".repeat(40);
const NEW = "b".repeat(40);
const PATH = `src/${H}.ts`;
const view = (o: { author?: string; sha?: string } = {}) => ({
  repository: {
    pullRequest: {
      number: 840, title: `Fix ${H}`, url: "https://acme.ghe.com/ACME/shop-api/pull/840", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
      baseRefName: "main", headRefName: "feat/840", headRefOid: o.sha ?? SHA, author: { login: o.author ?? "per" }, body: "", additions: 2, deletions: 1, changedFiles: 1,
      createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-22T08:00:00Z", reviewDecision: null, labels: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [] },
      reviewThreads: { nodes: [{ id: "PRRT_one", isResolved: false, isOutdated: false, path: PATH, line: 11, originalLine: 11, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 77, author: { login: "per" }, body: `Why ${H}?`, createdAt: "2026-10-21T09:00:00Z", url: "" }] } }] }, commits: { nodes: [] }, timelineItems: { nodes: [] },
    },
  },
});
const FILES = [{ filename: PATH, status: "modified", additions: 2, deletions: 1, sha: "1", patch: "@@ -10,3 +10,4 @@ class A\n ctx\n-old\n+new\n+added\n" }];

function setup(o: { author?: string; sha?: string; agent?: { sha: string; draft: ReviewDraft }; me?: string; thread?: { repo?: string; n?: number; resolved?: boolean }; checker?: { ask: Complete; model: string }; files?: typeof FILES; gate?: Promise<void> } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const state = { sha: o.sha ?? SHA };
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const method = init.method ?? "GET";
      calls.push({ method, path, body: init.body });
      if (path.startsWith("/repos/ACME/shop-api/pulls/840/files")) return (path.includes("page=1") ? (o.files ?? FILES) : []) as T;
      if (method === "GET" && path === "/repos/ACME/shop-api/pulls/840") return { state: "open", head: { sha: state.sha }, user: { login: o.author ?? "per" } } as T;
      if (method === "POST" && path === "/repos/ACME/shop-api/pulls/840/comments/77/replies") return { id: 78 } as T;
      if (method === "POST" && path === "/repos/ACME/shop-api/pulls/840/reviews") return { html_url: "https://acme.ghe.com/ACME/shop-api/pull/840#pullrequestreview-1" } as T;
      throw new Error(`GHE ${method} ${path}: 404`);
    },
    async graphql<T>(q: string) {
      if (q.startsWith("mutation")) {
        calls.push({ method: "MUTATION", path: q });
        return {} as T;
      }
      if (q.includes("node(id:")) {
        calls.push({ method: "NODE", path: q });
        const t = o.thread ?? {};
        return { node: q.includes('"PRRT_one"') ? { isResolved: !!t.resolved, pullRequest: { number: t.n ?? 840, repository: { nameWithOwner: t.repo ?? "ACME/shop-api" } }, comments: { nodes: [{ databaseId: 77 }] } } : null } as T;
      }
      await o.gate;
      return view({ author: o.author, sha: state.sha }) as T;
    },
  };
  const db = openDb();
  const runs: { done: Promise<void>; topic: string }[] = [];
  const app = createViewerRoutes({ GHE_ORG: "ACME", CODE_DIR: "C:/code" } as unknown as Env, {
    ghe,
    frame: async () => ({ operator: "me", nav: [] }),
    checkouts: () => [],
    db: db.DB,
    login: async () => o.me ?? "me",
    agentDraft: async () => o.agent,
    checker: o.checker ? () => ({ model: o.checker!.model, start: async (job, topic) => void runs.push({ done: runCheck(db.DB, o.checker!.ask, job), topic }) }) : undefined,
  });
  const post = (path: string, form: Record<string, string>) => app.request(path, { method: "POST", body: new URLSearchParams(form) });
  const text = async (path: string) => (await app.request(path)).text();
  return { app, db, calls, state, post, text, runs };
}

const B = "/prs/ACME/shop-api/840";

test("a form's anchor: a path, a side and a line; a start only before the line; nothing odd", () => {
  assert.deepEqual(anchorOf({ path: "src/a.ts", side: "LEFT", line: "11", start: "9" }), { path: "src/a.ts", side: "LEFT", line: 11, startLine: 9 });
  assert.deepEqual(anchorOf({ path: "src/a.ts", line: "11", start: "12" }), { path: "src/a.ts", side: "RIGHT", line: 11 });
  for (const bad of [{ path: "../x", line: "1" }, { path: "/etc/x", line: "1" }, { path: "a", line: "0" }, { path: "a", line: "x" }, { path: "", line: "1" }]) assert.equal(anchorOf(bad), null, JSON.stringify(bad));
});

test("the Files tab: a folder tree beside the files, hostile names inert; one file has none", async () => {
  assert.doesNotMatch(await setup().text(`${B}/files`), /class="dfile-tree"/);
  const two = [...FILES, { filename: `docs/${H}/b.md`, status: "added", additions: 1, deletions: 0, sha: "2", patch: "@@ -0,0 +1,1 @@\n+x\n" }];
  const page = await setup({ files: two }).text(`${B}/files`);
  assertInert("files with the tree", page);
  assert.match(page, /<nav class="dfile-tree" aria-label="Files"><ul><li class="dt-dir"><span class="dt-folder">docs\/.*<\/span><ul><li><a href="#f-docs-/s);
  assert.match(page, /<div class="dfile-list">.*<details class="dfile"/s, "the files beside it");
});

test("the Files tab: a + on each line, the form at a line without script, hostile paths and text inert", async () => {
  const { text } = setup();
  const files = await text(`${B}/files`);
  assertInert("files with review", files);
  assert.match(files, /class="d-c" href="\/prs\/ACME\/shop-api\/840\/files\?c=RIGHT:11&amp;p=src%2F/, "the added line's + links to its form");
  assert.match(files, /class="d-c" href="[^"]*c=LEFT:11&amp;/, "a removed line takes a LEFT comment");
  assert.match(files, /<template id="c-form">/, "the script's copy of the form");
  assert.match(files, /Your review/, "the Review tab");
  const at = await text(`${B}/files?c=RIGHT:12&p=${encodeURIComponent(PATH)}`);
  assertInert("files with the form open", at);
  assert.match(at, /<tr class="d-form" id="c-new">.*name="line" value="12"/s);
  const odd = await text(`${B}/files?c=RIGHT:12&p=..%2Fetc`);
  assert.doesNotMatch(odd, /name="line" value="12"/, "an odd path opens no form");
});

test("comment, edit, remove: kept per PR until posted, shown at their lines", async () => {
  const { db, post, text } = setup();
  const res = await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "11", body: `Why ${H}?` });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /\/files#c-\d+$/);
  const r = (await myReview(db.DB, "", "ACME/shop-api#840"))!;
  assert.equal(r.sha, SHA);
  assert.deepEqual(r.comments.map((c) => [c.path, c.side, c.line, c.body]), [[PATH, "RIGHT", 11, `Why ${H}?`]]);
  const files = await text(`${B}/files`);
  assertInert("files with a pending comment", files);
  assert.match(files, /1 pending comment/);
  assert.match(files, /<tr class="d-drafts"><td colspan="3"><form method="post" action="\/prs\/ACME\/shop-api\/840\/review\/comments\/\d+"/, "the card sits under its line");
  const id = r.comments[0]!.id;
  await post(`${B}/review/comments/${id}`, { do: "save", body: "Better" });
  assert.equal((await myReview(db.DB, "", "ACME/shop-api#840"))!.comments[0]!.body, "Better");
  await post(`${B}/review/comments/${id}`, { do: "drop" });
  assert.equal((await myReview(db.DB, "", "ACME/shop-api#840"))!.comments.length, 0);
  assert.equal((await post(`${B}/review/comments`, { sha: SHA, path: "../x", line: "1", body: "x" })).status, 400);
  assert.equal((await post(`/prs/evil/x/1/review/comments`, { sha: SHA, path: "a", line: "1", body: "x" })).status, 404);
});

test("preview, then post: one review on GHE at the commit, with the verdict I picked; logged without text; then gone", async () => {
  const { db, calls, post, text } = setup();
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "12", start: "11", body: "Range" });
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "LEFT", line: "11", body: "Old" });
  const pre = await post(`${B}/review/preview`, { summary: `Looks ${H}`, verdict: "request-changes" });
  assert.equal(pre.status, 200);
  const page = await pre.text();
  assertInert("review preview", page);
  assert.match(page, /What goes to GHE/);
  const nonce = /name="nonce" value="([^"]+)"/.exec(page)![1]!;
  const print = /name="print" value="([^"]+)"/.exec(page)![1]!;
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing posted by the preview");
  const done = await post(`${B}/review/post`, { verdict: "request-changes", nonce, print });
  assert.equal(done.status, 303);
  const sent = calls.filter((c) => c.method === "POST");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.event, "REQUEST_CHANGES");
  assert.equal(sent[0]!.body.commit_id, SHA);
  assert.equal(sent[0]!.body.body, `Looks ${H}`);
  assert.deepEqual(sent[0]!.body.comments.map((c: any) => [c.side, c.line, c.start_line]), [["RIGHT", 12, 11], ["LEFT", 11, undefined]]);
  assert.equal(await myReview(db.DB, "", "ACME/shop-api#840"), undefined, "posted, so gone");
  const log = await recentActions(db.DB);
  assert.deepEqual([log[0]!.kind, log[0]!.detail], ["pr.review", "Request changes, 2 line comments"]);
  assert.match(await text(`${B}/review`), /Posted the review/);
  assert.equal((await post(`${B}/review/post`, { verdict: "request-changes", nonce, print })).status, 303);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "the same Post twice posts once");
});

test("a review changed since the preview, or a different verdict, isn't posted", async () => {
  const { calls, post, text } = setup();
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "11", body: "One" });
  const page = await (await post(`${B}/review/preview`, { summary: "S", verdict: "comment" })).text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(page)![1]!;
  const print = /name="print" value="([^"]+)"/.exec(page)![1]!;
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "12", body: "Two" });
  await post(`${B}/review/post`, { verdict: "comment", nonce, print });
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  assert.match(await text(`${B}/review`), /changed since the preview/);
  await post(`${B}/review/post`, { verdict: "approve", nonce: crypto.randomUUID(), print });
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("my own PR: a Comment only", async () => {
  const { calls, post, text } = setup({ author: "me", me: "me" });
  const page = await text(`${B}/review`);
  assert.match(page, /Your own PR: a Comment only/);
  assert.doesNotMatch(page, /value="approve"/);
  const pre = await (await post(`${B}/review/preview`, { summary: "Note", verdict: "approve" })).text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(pre)![1]!;
  const print = /name="print" value="([^"]+)"/.exec(pre)![1]!;
  await post(`${B}/review/post`, { verdict: "comment", nonce, print });
  assert.equal(calls.filter((c) => c.method === "POST")[0]?.body.event, "COMMENT");
});

test("the PR moved on: the review says so, adds nothing new, posts nothing, until I move it", async () => {
  const { db, calls, post, text } = setup({ sha: NEW });
  await addComment(db.DB, "", "ACME/shop-api#840", SHA, { path: PATH, side: "RIGHT", line: 11, body: "One" });
  const files = await text(`${B}/files`);
  assert.match(files, /Your review is on aaaaaaa, and the PR has moved on to bbbbbbb/);
  assert.doesNotMatch(files, /class="d-c"/, "no + until it's moved");
  const added = await addComment(db.DB, "", "ACME/shop-api#840", NEW, { path: PATH, side: "RIGHT", line: 12, body: "x" });
  assert.equal(added.ok, false);
  const pre = await post(`${B}/review/preview`, { summary: "S", verdict: "comment" });
  assert.equal(pre.status, 409);
  assert.match(await pre.text(), /new commits since you started this review/);
  await post(`${B}/review/move`, { sha: "c".repeat(40) });
  assert.equal((await myReview(db.DB, "", "ACME/shop-api#840"))!.sha, SHA, "only to the commit the PR is at");
  await post(`${B}/review/move`, { sha: NEW });
  assert.equal((await myReview(db.DB, "", "ACME/shop-api#840"))!.sha, NEW);
  assert.match(await text(`${B}/files`), /class="d-c"/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("start from the agent's draft: its comments join mine and its summary fills an empty one; not from another commit", async () => {
  const draft: ReviewDraft = { kind: "review", summary: `Agent ${H}`, comments: [{ path: PATH, side: "RIGHT", line: 11, body: `Agent says ${H}` }] };
  const { db, post, text } = setup({ agent: { sha: SHA.slice(0, 7), draft } });
  assert.match(await text(`${B}/files`), /Add the agent&#39;s 1 comment|Add the agent's 1 comment/);
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "12", body: "Mine" });
  await post(`${B}/review/import`, {});
  const r = (await myReview(db.DB, "", "ACME/shop-api#840"))!;
  assert.deepEqual(r.comments.map((c) => c.body), ["Mine", `Agent says ${H}`]);
  assert.equal(r.summary, `Agent ${H}`);
  const page = await text(`${B}/review`);
  assertInert("review page", page);
  assert.equal(await importDraft(db.DB, "", "ACME/shop-api#840", NEW, draft), 0, "a draft of another commit adds nothing");
  const other = setup({ agent: { sha: NEW, draft } });
  assert.doesNotMatch(await other.text(`${B}/files`), /Add the agent/);
});

test("discard throws it away, and asks twice", async () => {
  const { db, post, text } = setup();
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "11", body: "One" });
  assert.match(await text(`${B}/review`), />Discard your review<\/button>/);
  await post(`${B}/review/discard`, {});
  assert.equal(await myReview(db.DB, "", "ACME/shop-api#840"), undefined);
});

test("people's reviews are their own (hosted: by verified email)", async () => {
  const { db } = setup();
  await addComment(db.DB, "a@x.no", "ACME/shop-api#840", SHA, { path: PATH, side: "RIGHT", line: 11, body: "A's" });
  assert.equal(await myReview(db.DB, "b@x.no", "ACME/shop-api#840"), undefined);
  assert.equal((await myReview(db.DB, "a@x.no", "ACME/shop-api#840"))!.comments.length, 1);
});

test("threads: reply and resolve from the conversation and the files, each checked on GHE, asked twice, logged without text", async () => {
  const { db, calls, post, text } = setup();
  const page = await text(B);
  assertInert("conversation with thread actions", page);
  assert.match(page, /<details class="thread-reply"><summary>Reply<\/summary><form method="post" action="\/prs\/ACME\/shop-api\/840\/threads\/reply"><input type="hidden" name="thread" value="PRRT_one">/);
  assert.match(page, />Reply<\/button>/, "a reply: one click");
  assert.match(page, />Resolve<\/button>/);
  assert.match(await text(`${B}/files`), /threads\/reply/, "on the diff too");
  const res = await post(`${B}/threads/reply`, { thread: "PRRT_one", body: `Because ${H}`, back: "files" });
  assert.equal(res.headers.get("location"), `${B}/files`);
  const sent = calls.filter((c) => c.method === "POST");
  assert.deepEqual(sent.map((c) => [c.path, c.body.body]), [["/repos/ACME/shop-api/pulls/840/comments/77/replies", `Because ${H}`]]);
  assert.match(await text(`${B}/files`), /Replied on ACME\/shop-api#840/);
  await post(`${B}/threads/resolve`, { thread: "PRRT_one", resolve: "1", back: "conversation" });
  assert.equal(calls.filter((c) => c.method === "MUTATION").length, 1);
  assert.match(calls.find((c) => c.method === "MUTATION")!.path, /^mutation\{resolveReviewThread\(input:\{threadId:"PRRT_one"\}\)/);
  assert.match(await text(B), /Resolved the thread/);
  const log = await recentActions(db.DB);
  assert.deepEqual(log.map((a) => [a.kind, a.detail]).reverse(), [["pr.thread-reply", "a reply to 77"], ["pr.thread-resolve", "a thread"]]);
});

test("threads: one on another PR, an odd id, or an empty reply changes nothing; resolving a resolved one does nothing", async () => {
  const other = setup({ thread: { n: 841 } });
  await other.post(`${B}/threads/reply`, { thread: "PRRT_one", body: "x" });
  await other.post(`${B}/threads/resolve`, { thread: "PRRT_one", resolve: "1" });
  assert.equal(other.calls.filter((c) => c.method === "POST" || c.method === "MUTATION").length, 0);
  assert.match(await other.text(B), /isn&#39;t on ACME\/shop-api#840|isn't on ACME\/shop-api#840/);
  const odd = setup();
  await odd.post(`${B}/threads/reply`, { thread: "x y}){evil", body: "x" });
  await odd.post(`${B}/threads/reply`, { thread: "PRRT_one", body: "   " });
  assert.equal(odd.calls.filter((c) => c.method !== "GET").length, 0, "neither reaches GHE");
  const done = setup({ thread: { resolved: true } });
  await done.post(`${B}/threads/resolve`, { thread: "PRRT_one", resolve: "1" });
  assert.equal(done.calls.filter((c) => c.method === "MUTATION").length, 0);
  await done.post(`${B}/threads/resolve`, { thread: "PRRT_one", resolve: "0" });
  assert.match(done.calls.find((c) => c.method === "MUTATION")!.path, /unresolveReviewThread/);
});

test("the agent's check: one call with my review and the diff; its cards kept, used or dismissed; hostile text inert; nothing posted", async () => {
  const asked: { system: string; user: string }[] = [];
  const cards = (id: number) => [
    { kind: "rewrite", on: `c${id}`, why: `Clearer ${H}`, text: `Could this be ${H}?` },
    { kind: "missed", path: PATH, line: 12, side: "RIGHT", why: `Unchecked ${H}`, text: "This needs a test." },
    { kind: "nit", on: "summary", why: "Say what to change." },
    { kind: "missed", path: PATH, line: 99, side: "RIGHT", why: "Off the diff", text: "x" },
  ];
  let reply = "";
  let open = () => {};
  let gate = Promise.resolve();
  const { db, calls, post, text, runs } = setup({ checker: { model: "sonnet", ask: async (p) => (asked.push(p), await gate, { text: reply, cost: 0.01 }) } });
  assert.match(await text(`${B}/review`), /formaction="\/prs\/ACME\/shop-api\/840\/review\/check"/, "the button, in the summary's form");
  assert.match(await (await post(`${B}/review/check`, { summary: "" })).headers.get("location")!, /\/review$/);
  assert.match(await text(`${B}/review`), /Nothing to check yet/);
  await post(`${B}/review/comments`, { sha: SHA, path: PATH, side: "RIGHT", line: "11", body: `Why ${H}?` });
  const id = (await myReview(db.DB, "", "ACME/shop-api#840"))!.comments[0]!.id;
  reply = "```review-check\n" + JSON.stringify({ cards: cards(id) }) + "\n```";
  gate = new Promise((r) => (open = r));
  const res = await post(`${B}/review/check`, { summary: `Looks ${H}` });
  assert.equal(res.headers.get("location"), `${B}/review#check`, "back at once, before the agent answers");
  const waiting = await text(`${B}/review`);
  assert.match(waiting, /The agent is reading your review/);
  assert.match(waiting, /<meta name="u-topics" content="pr:ACME\/shop-api#840">/, "the page listens for the answer");
  await post(`${B}/review/check`, { summary: `Looks ${H}` });
  assert.equal(runs.length, 1, "pressed again while it runs: no second call");
  assert.equal(runs[0]!.topic, "pr:ACME/shop-api#840");
  open();
  await runs[0]!.done;
  assert.equal(asked.length, 1);
  assert.match(asked[0]!.user, new RegExp(`### c${id} on src/.*:11`), "each comment with its id and place");
  assert.match(asked[0]!.user, /11 \+ new/, "and the lines it sits on, numbered");
  assert.match(asked[0]!.user, /Looks /, "the summary as I typed it, saved first");
  assert.equal((await checkOf(db.DB, "", "ACME/shop-api#840"))!.cards.length, 3, "the card off the diff is left out");
  const page = await text(`${B}/review`);
  assertInert("review with the agent's check", page);
  assert.match(page, /The agent&#39;s check/);
  assert.match(page, /Use this text/);
  assert.match(page, /Add this comment/);
  await post(`${B}/review/check/1`, { do: "keep", body: "Edited by me" });
  assert.equal((await myReview(db.DB, "", "ACME/shop-api#840"))!.comments[0]!.body, "Edited by me", "kept as I edited it");
  await post(`${B}/review/check/2`, { do: "keep", body: "This needs a test." });
  assert.deepEqual((await myReview(db.DB, "", "ACME/shop-api#840"))!.comments.map((c) => c.line), [11, 12], "the missed issue becomes a pending comment");
  await post(`${B}/review/check/3`, { do: "drop" });
  assert.deepEqual((await checkOf(db.DB, "", "ACME/shop-api#840"))!.cards, []);
  assert.match(await text(`${B}/review`), /nothing to add/);
  reply = "no block";
  await post(`${B}/review/check`, { summary: "x" });
  await runs.at(-1)!.done;
  assert.match(await text(`${B}/review`), /not with cards Dovre could read/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing goes to GHE");
});

test("the agent's first review: from the Files tab with nothing written, its comments and summary as cards, all added at once; nothing posted", async () => {
  const asked: { system: string; user: string }[] = [];
  let reply = "";
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const { db, calls, post, text, runs } = setup({ checker: { model: "sonnet", ask: async (p) => (asked.push(p), await gate, { text: reply, cost: 0.02 }) } });
  const files = await text(`${B}/files`);
  assert.match(files, /name="mode" value="review"/, "the Files tab offers it while my review is empty");
  assert.match(await text(`${B}/review`), /Review with an agent/);
  assert.doesNotMatch(await text(`${B}/review`), /Check with an agent/, "nothing to check yet");
  reply = "```review-check\n" + JSON.stringify({ cards: [
    { kind: "missed", path: PATH, line: 12, side: "RIGHT", why: `Wrong total ${H}`, text: `This divides by the wrong count ${H}.` },
    { kind: "missed", path: PATH, line: 11, side: "RIGHT", why: "Small", text: "nit: a clearer name" },
    { kind: "rewrite", on: "summary", why: "Overall", text: "One bug to fix, then good." },
  ] }) + "\n```";
  const res = await post(`${B}/review/check`, { mode: "review" });
  assert.equal(res.headers.get("location"), `${B}/review#check`);
  assert.match(await text(`${B}/review`), /The agent is reading the PR/);
  open();
  await runs[0]!.done;
  assert.match(asked[0]!.system, /You review a pull request first/, "the first-review prompt, not the check's");
  assert.match(asked[0]!.user, /\(none yet\)/);
  const page = await text(`${B}/review`);
  assertInert("review with the agent's first review", page);
  assert.match(page, /The agent&#39;s review/);
  assert.match(page, />Comment</);
  assert.match(page, />Summary</);
  assert.match(page, /Add all 3/);
  await post(`${B}/review/check/all`, {});
  const mine = (await myReview(db.DB, "", "ACME/shop-api#840"))!;
  assert.deepEqual(mine.comments.map((c) => c.line).sort(), [11, 12], "its comments are now pending, mine to edit");
  assert.equal(mine.summary, "One bug to fix, then good.");
  assert.deepEqual((await checkOf(db.DB, "", "ACME/shop-api#840"))!.cards, []);
  assert.match(await text(`${B}/review`), /Check with an agent/, "with something written, it can be checked");
  assert.doesNotMatch(await text(`${B}/files`), /name="mode" value="review"/, "and the Files tab stops offering a first review");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing goes to GHE");
});

test("the PR still loading (hosted, nothing cached): Your review says it's reading, and an action waits for it rather than Not found", async () => {
  let open!: () => void;
  const { text, post, db } = setup({ gate: new Promise<void>((res) => (open = res)) });
  const page = await text(`${B}/review`);
  assert.match(page, /Reading the pull request/);
  assert.doesNotMatch(page, /Not found/);
  const posting = post(`${B}/review/comments`, { path: PATH, side: "RIGHT", line: "11", sha: SHA, body: "slow" });
  setTimeout(open, 50);
  const r = await posting;
  assert.equal(r.status, 303);
  assert.equal((await myReview(db.DB, "", "ACME/shop-api#840"))?.comments[0]?.body, "slow");
  assert.match(await text(`${B}/review`), /slow/);
});

test("the agent still writing: its cards so far show, read-only, and can't be kept until it's done", async () => {
  const { text, post, db } = setup();
  const key = "ACME/shop-api#840";
  await saveSummary(db.DB, "", key, SHA, "");
  const card = { id: 1, kind: "missed" as const, why: `Off by one ${H}`, text: `Use <= ${H}`, at: { path: PATH, line: 11, side: "RIGHT" as const } };
  await saveCheck(db.DB, "", key, { sha: SHA, at: Date.now(), model: "m", cost: 0, cards: [card], running: true, mode: "review" });
  const page = await text(`${B}/review`);
  assert.match(page, /still writing: 1 card so far/);
  assert.match(page, /Off by one/);
  assert.doesNotMatch(page, /Add this comment|Dismiss|Add all/);
  assertInert("the agent still writing", page);
  await post(`${B}/review/check/1`, { do: "keep", body: "x" });
  assert.equal((await myReview(db.DB, "", key))?.comments.length, 0, "not kept while it's writing");
  assert.equal((await checkOf(db.DB, "", key))?.cards.length, 1);
});

test("the agent's line cards on the Files tab (dovre#316): under their lines, kept or dismissed there, read-only while it writes; summary cards stay on Your review", async () => {
  const { text, post, db } = setup();
  const key = "ACME/shop-api#840";
  const mine = await addComment(db.DB, "", key, SHA, { path: PATH, side: "RIGHT", line: 12, body: "mine" });
  assert.ok(mine.ok);
  const cards = [
    { id: 1, kind: "missed" as const, why: `Wrong count ${H}`, text: `Divide by the week ${H}`, at: { path: PATH, line: 11, side: "RIGHT" as const } },
    { id: 2, kind: "rewrite" as const, why: "Clearer", text: "mine, said better", on: mine.id },
    { id: 3, kind: "rewrite" as const, why: "Overall", text: "Summary text", on: "summary" as const },
    { id: 4, kind: "missed" as const, why: "Gone", text: "far away", at: { path: PATH, line: 99, side: "RIGHT" as const } },
  ];
  await saveCheck(db.DB, "", key, { sha: SHA, at: Date.now(), model: "m", cost: 0, cards, running: true, mode: "review" });
  let files = await text(`${B}/files`);
  assertInert("agent cards on the files, writing", files);
  assert.match(files, /id="k-1"/);
  assert.doesNotMatch(files, /review\/check\/1"/, "read-only while it writes");
  await saveCheck(db.DB, "", key, { sha: SHA, at: Date.now(), model: "m", cost: 0, cards, mode: "review" });
  files = await text(`${B}/files`);
  assertInert("agent cards on the files", files);
  assert.match(files, /class="d-drafts"><td colspan="3"><form method="post" action="\/prs\/ACME\/shop-api\/840\/review\/check\/1"/, "the new comment's card under line 11");
  assert.match(files, /id="c-\d+"[\s\S]*id="k-2"/, "the rewrite under my comment on line 12");
  assert.doesNotMatch(files, /id="k-3"|id="k-4"/, "the summary card and the one off the diff stay on Your review");
  assert.match(files, /2 from the agent/);
  const kept = await post(`${B}/review/check/1`, { do: "keep", body: "Edited here", back: "files" });
  const r = (await myReview(db.DB, "", key))!;
  const added = r.comments.find((c) => c.line === 11)!;
  assert.equal(added.body, "Edited here");
  assert.equal(kept.headers.get("location"), `${B}/files#c-${added.id}`, "back to the comment it made");
  const dropped = await post(`${B}/review/check/2`, { do: "drop", back: "files" });
  assert.match(dropped.headers.get("location")!, new RegExp(`^${B}/files#f-`), "back to the card's file");
  assert.deepEqual((await checkOf(db.DB, "", key))!.cards.map((c) => c.id), [3, 4]);
  assert.equal((await post(`${B}/review/check/3`, { do: "drop" })).headers.get("location"), `${B}/review#check`, "from Your review, back there");
});

test("no agent to check with: no button, and the route says so", async () => {
  const { post, text } = setup();
  assert.doesNotMatch(await text(`${B}/review`), /Check with an agent/);
  await post(`${B}/review/check`, { summary: "x" });
  assert.match(await text(`${B}/review`), /no agent to check with/);
});
