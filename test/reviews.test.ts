/** Agent code review (WP-A3): who gets which, the prompt, what runs without asking, one run per click, and the result on the PR card. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessId, Run, Runner, StartOpts } from "../src/agents/runner.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Snapshot } from "../src/gather.ts";
import { logAction, recentActions } from "../src/actions/deploys.ts";
import { checkReview } from "../src/actions/reviews.ts";
import { actingAs } from "../src/actor.ts";
import { allowedFor, kindFor, REVIEW_ALLOWED, reviewPrompt, skillOf } from "../src/reviews/agent.ts";
import { H, assertInert, fakeGhe, pr, snapshot } from "./helpers.ts";

const URL_ = "https://acme.ghe.com/ACME/people/pull/7";

test("someone else's PR gets a review; mine gets an assessment once somebody has reviewed it", () => {
  assert.equal(kindFor(pr({ author: "per-hansen" }), "ola-nordmann"), "review");
  assert.equal(kindFor(pr({ author: "ola-nordmann" }), "ola-nordmann"), null, "nothing to assess yet");
  assert.equal(kindFor(pr({ author: "Ola-Nordmann", reviews: [{ login: "copilot-pull-request-reviewer", state: "COMMENTED" }] }), "ola-nordmann"), "triage");
  assert.equal(kindFor(pr({ author: "ola-nordmann", openThreads: 2 }), "ola-nordmann"), "triage");
  assert.equal(kindFor(pr({ author: "ola-nordmann", reviews: [{ login: "ola-nordmann", state: "COMMENTED" }] }), "ola-nordmann"), null, "my own comment isn't a review");
});

test("the prompt calls the skill where the harness has it, else points at its SKILL.md; it never asks to post or edit", () => {
  const installed = { installed: true, path: "x" };
  const clone = { installed: false, path: "C:/Code/agent-skills/.claude/skills/review/SKILL.md" };
  assert.match(reviewPrompt("review", URL_, "claude", installed), /^\/review https:\/\/acme\.ghe\.com\/ACME\/people\/pull\/7\n/);
  assert.match(reviewPrompt("review", URL_, "omp", installed), /^\/skill:review https:/);
  assert.match(reviewPrompt("review", URL_, "claude", clone), /^Read the skill at C:\/Code\/agent-skills\/.claude\/skills\/review\/SKILL\.md and follow it to review https:/);
  assert.match(reviewPrompt("triage", URL_, "claude", installed), /^\/review-triage https:/);
  const review = reviewPrompt("review", URL_, "claude", installed);
  assert.match(review, /Don't post comments, approve or request changes, and don't edit/);
  assert.match(review, /new git worktree; never switch this checkout's branch/);
  const triage = reviewPrompt("triage", URL_, "omp", installed);
  assert.match(triage, /Apply nothing and post nothing until I say so/);
  assert.match(triage, /show me the table and stop/);
  // WP-A20: the draft goes last, for Dovre to post once I've read it; the agent still posts nothing.
  assert.match(review, /```review-draft block/);
  assert.match(review, /Dovre posts it, you never do/);
  assert.match(review, /No verdict: I choose that/);
  assert.match(triage, /```review-replies block/);
  assert.match(triage, /Dovre posts them, you never do/);
});

test("without asking, a review may only read the PR through gh; omp, which allows whole tools, gets nothing", () => {
  assert.deepEqual(allowedFor("claude"), ["Bash(gh pr view *)", "Bash(gh pr diff *)", "Bash(gh pr checks *)"]);
  for (const a of allowedFor("claude")) {
    assert.match(a, /^Bash\(gh pr (view|diff|checks) \*\)$/, a);
    assert.doesNotMatch(a, /api|fetch|worktree|push|comment|review |merge|edit|close|Edit|Write/, a);
  }
  assert.deepEqual(allowedFor("omp"), []);
  assert.equal(REVIEW_ALLOWED.length, 3);
});

test("the skill is found where agent-skills installs it, or in a clone of agent-skills", () => {
  const has = (paths: string[]) => (p: string) => paths.includes(p.replace(/\\/g, "/"));
  assert.deepEqual(skillOf("review", "claude", { home: "H", exists: has(["H/.claude/skills/review/SKILL.md"]) }), { installed: true, path: join("H", ".claude", "skills", "review", "SKILL.md") });
  assert.equal(skillOf("review", "omp", { home: "H", exists: has(["H/.claude/skills/review/SKILL.md"]) }), null, "omp reads ~/.agents/skills");
  assert.deepEqual(skillOf("triage", "omp", { home: "H", codeDir: "C", exists: has(["C/agent-skills/.claude/skills/review-triage/SKILL.md"]) })?.installed, false);
});

// ── Through the app ──

function fakeRunner(harnesses: HarnessId[] = ["claude", "omp"]) {
  const runs = new Map<string, Run>();
  const started: StartOpts[] = [];
  const runner: Runner = {
    harnesses: () => harnesses,
    start(o) {
      started.push(o);
      const run: Run = { id: `run-${runs.size + 1}`, harness: o.harness ?? "claude", forked: false, cwd: o.cwd, repo: "people", prompt: o.prompt, mode: o.mode ?? "default", model: o.model ?? "", allowed: o.allowed ?? [], status: "running", startedAt: Date.now(), events: [], partial: "", cost: 0 };
      runs.set(run.id, run);
      return run;
    },
    get: (id) => runs.get(id),
    ofSession: () => undefined,
    sandbox: () => undefined,
    pushSandbox: async () => {
      throw new Error("no sandbox");
    },
    landed: () => false,
    copiesOf: () => [],
    list: () => [...runs.values()],
    stop: () => true,
    discard: () => true,
    sessionOf: async () => undefined,
    byMcpToken: () => undefined,
  };
  return { runner, runs, started };
}

function world() {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "people", ".git"), { recursive: true });
  writeFileSync(join(code, "people", ".git", "config"), '[remote "origin"]\n\turl = https://acme.ghe.com/ACME/people.git\n');
  const home = mkdtempSync(join(tmpdir(), "home-"));
  for (const skill of ["review", "review-triage"]) {
    mkdirSync(join(home, ".claude", "skills", skill), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", skill, "SKILL.md"), "---\nname: x\n---\n");
    // A clone of agent-skills in the code folder, for a harness without the skill installed (omp here).
    mkdirSync(join(code, "agent-skills", ".claude", "skills", skill), { recursive: true });
    writeFileSync(join(code, "agent-skills", ".claude", "skills", skill, "SKILL.md"), "---\nname: x\n---\n");
  }
  return { code, home };
}

function appWith(s: { snap: Snapshot }, opts: { runner?: ReturnType<typeof fakeRunner>; db?: ReturnType<typeof openDb>; harnesses?: HarnessId[]; routes?: Parameters<typeof fakeGhe>[0] } = {}) {
  const { code, home } = world();
  const db = opts.db ?? openDb();
  const fr = opts.runner ?? fakeRunner(opts.harnesses);
  const gatherer = { get: async () => s.snap, stale: () => {}, gathering: () => false, peek: () => s.snap };
  const { ghe, calls } = fakeGhe(opts.routes ?? {});
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: code, CLAUDE_DIR: join(home, "nope"), DB: db.DB }, { gatherer, ghe, runner: fr.runner, skillsHome: home });
  const get = async (path: string) => {
    const res = await app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
  };
  const post = async (path: string, body: Record<string, string>) => {
    const res = await app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
  };
  return { get, post, ...fr, db, code, calls };
}

const theirs = (o: Parameters<typeof pr>[0] = {}) => pr({ repo: "ACME/people", number: 7, url: URL_, author: "per-hansen", title: H, headSha: "aaa1111", ...o });
const nonceOf = (page: string) => page.match(/name="nonce" value="([0-9a-f-]{36})"/)?.[1] ?? "";

test("review someone's PR: confirm, one run per click, running, then the report on the card; a newer commit says so", async () => {
  const s = { snap: snapshot({ prs: { ok: true, value: { mine: [], review: [theirs()] } } }) };
  const w = appWith(s);
  const prs = await w.get("/prs");
  assertInert("/prs", prs.text);
  assert.match(prs.text, /href="\/prs\/agent\?pr=ACME%2Fpeople%237&amp;kind=review">Review with an agent…/);

  const confirm = await w.get("/prs/agent?pr=ACME%2Fpeople%237&kind=review");
  assert.equal(confirm.status, 200);
  assertInert("confirm", confirm.text);
  assert.match(confirm.text, /\/review https:\/\/acme\.ghe\.com\/ACME\/people\/pull\/7/);
  assert.match(confirm.text, /Bash\(gh pr view \*\)/);
  assert.equal(w.started.length, 0, "showing the confirm page starts nothing");

  const nonce = nonceOf(confirm.text);
  const go = await w.post("/prs/agent", { pr: "ACME/people#7", kind: "review", nonce, harness: "claude", model: "" });
  assert.equal(go.status, 303);
  assert.equal(go.location, "/agents/r/run-1");
  assert.equal(w.started.length, 1);
  const o = w.started[0]!;
  assert.equal(o.cwd, join(w.code, "people"));
  assert.equal(o.mode, "default", "asks before acting");
  assert.deepEqual(o.allowed, [...REVIEW_ALLOWED]);
  assert.match(o.prompt, /^\/review https:/);

  assert.equal((await w.post("/prs/agent", { pr: "ACME/people#7", kind: "review", nonce, harness: "claude" })).location, "/agents/r/run-1", "a double click lands on the same run");
  const again = await w.post("/prs/agent", { pr: "ACME/people#7", kind: "review", nonce: nonceOf((await w.get("/prs/agent?pr=ACME%2Fpeople%237&kind=review")).text), harness: "claude" });
  assert.equal(again.location, "/agents/r/run-1", "a second confirm page while it runs goes to the running one");
  assert.equal(w.started.length, 1, "one run");
  assert.match((await w.get("/prs")).text, /Agent review<\/span> running, for/);

  const run = w.runs.get("run-1")!;
  run.sessionId = "11111111-2222-3333-4444-555555555555";
  run.events.push({ t: "text", text: "Looking…" }, { t: "result", text: `## Findings\n\n1. ${H} **throws** on an empty list`, cost: 0.1, error: false });
  run.status = "done";
  run.endedAt = Date.now();
  const done = (await w.get("/prs")).text;
  assertInert("done", done);
  assert.match(done, /Agent review<\/span> done/);
  assert.match(done, /href="\/agents\/s\/11111111-2222-3333-4444-555555555555">Open the session/);
  assert.match(done, /<h\d class="md-h">Findings<\/h\d>/);
  assert.match(done, /<strong>throws<\/strong>/);
  assert.doesNotMatch(done, /older commit/);
  assert.match((await w.get("/")).text, /Agent review<\/span> done/, "Today's PR card shows it too");

  s.snap.prs = { ok: true, value: { mine: [], review: [theirs({ headSha: "bbb2222" })] } };
  assert.match((await w.get("/prs")).text, /for an older commit/);
});

test("assess the review on my PR: the triage skill, apply nothing, in my checkout", async () => {
  const mine = pr({ repo: "ACME/people", number: 9, url: "https://acme.ghe.com/ACME/people/pull/9", author: "ola-nordmann", reviews: [{ login: "copilot-pull-request-reviewer", state: "COMMENTED" }] });
  const w = appWith({ snap: snapshot({ prs: { ok: true, value: { mine: [mine, pr({ number: 10 })], review: [] } } }) });
  const prs = (await w.get("/prs")).text;
  assert.match(prs, /kind=triage">Assess the review with an agent…/);
  assert.equal((prs.match(/Assess the review with an agent/g) ?? []).length, 1, "only the reviewed one");
  const confirm = await w.get("/prs/agent?pr=ACME%2Fpeople%239&kind=triage");
  await w.post("/prs/agent", { pr: "ACME/people#9", kind: "triage", nonce: nonceOf(confirm.text), harness: "omp" });
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0]!.harness, "omp");
  assert.match(w.started[0]!.prompt, /^Read the skill at .*review-triage.*SKILL\.md/, "omp has no installed skill here: it reads the file");
  assert.match(w.started[0]!.prompt, /Apply nothing and post nothing/);
  assert.deepEqual(w.started[0]!.allowed, [], "omp gets no allows");
  assert.equal((await w.get("/prs/agent?pr=ACME%2Fpeople%239&kind=review")).location, "/prs", "my own PR isn't reviewed as someone else's");
});

test("no checkout: say so with the clone command, and start nothing", async () => {
  const w = appWith({ snap: snapshot({ prs: { ok: true, value: { mine: [], review: [theirs({ repo: "ACME/elsewhere", url: "https://acme.ghe.com/ACME/elsewhere/pull/7" })] } } }) });
  const confirm = await w.get("/prs/agent?pr=ACME%2Felsewhere%237&kind=review");
  assert.match(confirm.text, /isn't checked out/);
  assert.match(confirm.text, /git clone https:\/\/acme\.ghe\.com\/ACME\/elsewhere\.git/);
  assert.match(confirm.text, /data-busy="Starting" disabled/);
  const go = await w.post("/prs/agent", { pr: "ACME/elsewhere#7", kind: "review", nonce: nonceOf(confirm.text), harness: "claude" });
  assert.equal(go.status, 400);
  assert.equal(w.started.length, 0);
  assert.equal((await w.post("/prs/agent", { pr: "ACME/nope#1", kind: "review", nonce: nonceOf(confirm.text), harness: "claude" })).location, "/prs", "a PR that isn't in view is refused");
});

test("a review whose server went away says it stopped, and offers another", async () => {
  const s = { snap: snapshot({ prs: { ok: true, value: { mine: [], review: [theirs()] } } }) };
  const db = openDb();
  const first = appWith(s, { db });
  const confirm = await first.get("/prs/agent?pr=ACME%2Fpeople%237&kind=review");
  await first.post("/prs/agent", { pr: "ACME/people#7", kind: "review", nonce: nonceOf(confirm.text), harness: "claude" });
  const after = appWith(s, { db });
  const page = (await after.get("/prs")).text;
  assert.match(page, /Agent review<\/span> stopped/);
  assert.match(page, />Try again…</);
});

test("without agents here, PR cards show no agent review", async () => {
  const gatherer = { get: async () => snapshot({ prs: { ok: true, value: { mine: [], review: [theirs()] } } }), stale: () => {}, gathering: () => false, peek: () => snapshot() };
  const app = createApp({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", DB: openDb().DB }, { gatherer, ghe: fakeGhe({}).ghe });
  const out = await (await app.request("http://localhost/prs", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.doesNotMatch(out, /with an agent/);
});

// ── Posting the draft (WP-A20) ──

const PATCH = "@@ -1,3 +1,4 @@\n line1\n-old2\n+new2\n+new3\n line3";
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hidden = (page: string, name: string) => unescape(page.match(new RegExp(`type="hidden" name="${name}" value="([^"]*)"`))?.[1] ?? "");

/** A review run that ended with `report`, the PR on GHE (its head can move: `gh.head`), and what GHE was asked. */
async function reviewed(report: string, o: { head?: string; author?: string; state?: string; mine?: boolean; routes?: Parameters<typeof fakeGhe>[0] } = {}) {
  const p = o.mine ? pr({ repo: "ACME/people", number: 7, url: URL_, author: "ola-nordmann", headSha: "aaa1111", reviews: [{ login: "copilot-pull-request-reviewer", state: "COMMENTED" }] }) : theirs();
  const s = { snap: snapshot({ prs: { ok: true, value: o.mine ? { mine: [p], review: [] } : { mine: [], review: [p] } } }) };
  const reviews: unknown[] = [];
  const gh = { head: o.head ?? "aaa1111" };
  const w = appWith(s, {
    routes: {
      "GET /repos/ACME/people/pulls/7": () => ({ state: o.state ?? "open", head: { sha: gh.head }, user: { login: o.author ?? (o.mine ? "ola-nordmann" : "per-hansen") } }),
      "GET /repos/ACME/people/pulls/7/files?per_page=100&page=1": [{ filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH, sha: "f" }],
      "POST /repos/ACME/people/pulls/7/reviews": (b: unknown) => (reviews.push(b), { html_url: "https://acme.ghe.com/ACME/people/pull/7#pullrequestreview-1" }),
      ...o.routes,
    },
  });
  const kind = o.mine ? "triage" : "review";
  const confirm = await w.get(`/prs/agent?pr=ACME%2Fpeople%237&kind=${kind}`);
  await w.post("/prs/agent", { pr: "ACME/people#7", kind, nonce: nonceOf(confirm.text), harness: "claude" });
  const run = w.runs.get("run-1")!;
  run.events.push({ t: "result", text: report, cost: 0.1, error: false });
  run.status = "done";
  run.endedAt = Date.now();
  return { ...w, s, gh, reviews, writes: () => w.calls.filter((c) => c.method !== "GET") };
}

const DRAFT = {
  summary: `Ser greit ut ${H}`,
  comments: [
    { path: "src/a.ts", line: 2, side: "RIGHT", body: `Hva om lista er tom? ${H}` },
    { path: "src/a.ts", line: 3, side: "RIGHT", body: "Dropp denne" },
    { path: "src/a.ts", line: 40, side: "RIGHT", body: "Utenfor diffen" },
  ],
};
const REPORT = `## Findings\n\n1. ${H} empty list\n\n\`\`\`review-draft\n${JSON.stringify(DRAFT)}\n\`\`\``;

test("a review's draft: cards I edit or drop, a preview of what goes, then one review on GHE as Comment; posted once", async () => {
  const w = await reviewed(REPORT);
  const card = (await w.get("/prs")).text;
  assertInert("/prs", card);
  assert.match(card, /href="\/prs\/draft\?run=run-1">Go through the draft…/);
  assert.doesNotMatch(card, /review-draft|&quot;comments&quot;/, "the card shows the report, not the block");

  const page = await w.get("/prs/draft?run=run-1");
  assert.equal(page.status, 200);
  assertInert("draft", page.text);
  assert.match(page.text, /value="comment" checked> Comment/, "Comment unless I pick otherwise");
  assert.match(page.text, /src\/a\.ts:2<\/code>/);
  assert.equal((page.text.match(/name="keep_\d" value="on" checked/g) ?? []).length, 3);
  // #160: the diff, with the agent's comments at their lines and the one off the diff apart.
  assert.match(page.text, /<p class="draft-h">The diff<\/p>/);
  assert.match(page.text, /new2<\/code><\/td><\/tr><tr class="d-drafts"><td colspan="3"><div class="draft-card">\s*<div class="draft-card-h"><code class="draft-where">src\/a\.ts:2<\/code>/);
  assert.match(page.text, /new3<\/code><\/td><\/tr><tr class="d-drafts">[^]*?src\/a\.ts:3<\/code>/);
  assert.match(page.text, /Not on the diff<\/p><p class="hint">These go at the end of the summary\.<\/p><div class="draft-card">\s*<div class="draft-card-h"><code class="draft-where">src\/a\.ts:40<\/code>/);
  assert.match(page.text, /2 from the agent/);

  const form = { run: "run-1", verdict: "comment", summary: "Ser greit ut", keep_0: "on", body_0: "Hva om lista er tom? (endret)", body_1: "Dropp denne", keep_2: "on", body_2: "Utenfor diffen" };
  const preview = await w.post("/prs/draft/preview", form);
  assert.equal(preview.status, 200);
  assertInert("preview", preview.text);
  assert.match(preview.text, /One comment isn&#39;t on a line of the diff/);
  assert.match(preview.text, />Post the review<\/button>/);
  assert.equal(w.writes().length, 0, "a preview posts nothing");
  assert.match(preview.text, /Hva om lista er tom\? \(endret\)/, "the form keeps my edits");

  const nonce = hidden(preview.text, "nonce");
  const draft = hidden(preview.text, "draft");
  const go = await w.post("/prs/draft/post", { run: "run-1", verdict: hidden(preview.text, "verdict"), nonce, draft });
  assert.equal(go.location, "/prs/draft?run=run-1");
  assert.equal(w.reviews.length, 1);
  assert.deepEqual(w.reviews[0], {
    commit_id: "aaa1111",
    event: "COMMENT",
    body: "Ser greit ut\n\n- `src/a.ts:40`: Utenfor diffen",
    comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "Hva om lista er tom? (endret)" }],
  });
  const after = await w.get("/prs/draft?run=run-1");
  assert.match(after.text, /Posted the review on ACME\/people#7 \(Comment, 1 line comment\)/);
  assert.match(after.text, /href="https:\/\/acme\.ghe\.com\/ACME\/people\/pull\/7#pullrequestreview-1"/);
  assert.doesNotMatch(after.text, /Go through it/, "posted: no form any more");
  const cardAfter = (await w.get("/prs")).text;
  assert.match(cardAfter, /Posted \(Comment, 1 line comment\)/);
  assert.doesNotMatch(cardAfter, /Go through the draft/);

  // A double click, or a second preview's Post, posts nothing more.
  await w.post("/prs/draft/post", { run: "run-1", verdict: "comment", nonce, draft });
  await w.post("/prs/draft/post", { run: "run-1", verdict: "comment", nonce: "11111111-2222-3333-4444-555555555555", draft });
  assert.equal(w.reviews.length, 1);
  const log = (await recentActions(w.db.DB)).filter((a) => a.kind === "pr.review");
  assert.deepEqual(log.map((a) => [a.target, a.detail, a.ok]), [["ACME/people#7", "Comment, 1 line comment", 1]]);
  assert.ok(!JSON.stringify(log).includes("lista"), "the log holds no text");
});

test("the verdict is mine: Request changes goes as such, and needs a summary; Approve may go bare", async () => {
  const w = await reviewed(REPORT);
  const bare = await w.post("/prs/draft/preview", { run: "run-1", verdict: "request-changes", summary: "", keep_0: "on", body_0: "x" });
  assert.equal(bare.status, 400);
  assert.match(bare.text, /Request changes needs a summary/);
  const p = await w.post("/prs/draft/preview", { run: "run-1", verdict: "request-changes", summary: "Må fikses", keep_0: "on", body_0: "x" });
  assert.match(p.text, /value="request-changes" checked/);
  await w.post("/prs/draft/post", { run: "run-1", verdict: hidden(p.text, "verdict"), nonce: hidden(p.text, "nonce"), draft: hidden(p.text, "draft") });
  assert.equal((w.reviews[0] as { event: string }).event, "REQUEST_CHANGES");

  const v = await reviewed(REPORT);
  const a = await v.post("/prs/draft/preview", { run: "run-1", verdict: "approve", summary: "" });
  assert.equal(a.status, 200);
  await v.post("/prs/draft/post", { run: "run-1", verdict: "approve", nonce: hidden(a.text, "nonce"), draft: hidden(a.text, "draft") });
  assert.deepEqual(v.reviews[0], { commit_id: "aaa1111", event: "APPROVE", body: "", comments: [] });
});

test("new commits since the review, a closed PR, or my own PR: nothing is posted, and the page says why", async () => {
  const form = { run: "run-1", verdict: "comment", summary: "S", keep_0: "on", body_0: "x" };
  const moved = await reviewed(REPORT, { head: "bbb2222ffff" });
  const m = await moved.post("/prs/draft/preview", form);
  assert.equal(m.status, 409);
  assert.match(m.text, /new commits since the agent read it \(aaa1111 → bbb2222\): review it again/);
  assert.doesNotMatch(m.text, />Post the review<\/button>/);
  const listed = (await moved.get("/prs/draft?run=run-1")).text;
  assert.match(listed, /new commits since the review \(aaa1111 → bbb2222\), so the comments are listed here, not in the diff/);
  assert.doesNotMatch(listed, /The diff<\/p>/);

  // Moved between the preview and the Post: the Post checks again.
  const late = await reviewed(REPORT);
  const p = await late.post("/prs/draft/preview", form);
  assert.match(p.text, />Post the review<\/button>/);
  late.gh.head = "ccc3333dddd";
  await late.post("/prs/draft/post", { run: "run-1", verdict: "comment", nonce: hidden(p.text, "nonce"), draft: hidden(p.text, "draft") });
  assert.equal(late.reviews.length, 0);
  assert.match((await late.get("/prs/draft?run=run-1")).text, /new commits since the agent read it/);

  const own = await reviewed(REPORT, { author: "ola-nordmann" });
  assert.match((await own.post("/prs/draft/preview", form)).text, /is your own PR/);

  const closed = await reviewed(REPORT, { state: "closed" });
  assert.match((await closed.post("/prs/draft/preview", form)).text, /isn&#39;t open any more: nothing posted/);
  for (const x of [moved, late, own, closed]) assert.equal(x.writes().length, 0);
});

test("a report without a usable draft, an unknown run, or a forged draft: no draft page, nothing posted", async () => {
  const w = await reviewed("## Findings\n\nNo block here.");
  assert.doesNotMatch((await w.get("/prs")).text, /Go through the draft/);
  assert.equal((await w.get("/prs/draft?run=run-1")).location, "/prs");
  const broken = await reviewed("Report\n```review-draft\n{oops\n```");
  assert.match((await broken.get("/prs")).text, /The draft at the end of the report couldn't be read/);
  assert.equal((await w.get("/prs/draft?run=..%2Fx")).location, "/prs");
  assert.equal((await w.get("/prs/draft?run=run-9")).location, "/prs");
  const forged = await reviewed(REPORT);
  const p = await forged.post("/prs/draft/preview", { run: "run-1", verdict: "comment", summary: "S" });
  await forged.post("/prs/draft/post", { run: "run-1", verdict: "comment", nonce: hidden(p.text, "nonce"), draft: "{not json" });
  assert.equal(forged.reviews.length, 0);
  assert.match((await forged.get("/prs/draft?run=run-1")).text, /That isn&#39;t a draft from the preview: nothing posted/);
});

test("replies on my PR: one per thread (a reply to a reply goes to its thread), unknown ones left out, the general comment on the PR", async () => {
  const replies = { replies: [{ comment_id: 11, body: `Fikset ${H}` }, { comment_id: 12, body: "Bevisst, se AGENTS.md" }, { comment_id: 99, body: "Borte" }], comment: "Takk for gjennomgangen" };
  const posted: { path: string; body: unknown }[] = [];
  const push = (path: string) => (b: unknown) => (posted.push({ path, body: b }), {});
  const w = await reviewed(`| # | Verdict |\n|---|---|\n| 1 | Apply |\n\n\`\`\`review-replies\n${JSON.stringify(replies)}\n\`\`\``, {
    mine: true,
    routes: {
      "GET /repos/ACME/people/pulls/7/comments?per_page=100&page=1": [{ id: 11 }, { id: 12, in_reply_to_id: 11 }, { id: 20 }],
      "POST /repos/ACME/people/pulls/7/comments/11/replies": push("replies/11"),
      "POST /repos/ACME/people/issues/7/comments": push("issue"),
    },
  });
  assert.match((await w.get("/prs")).text, /Go through the draft…/);
  const page = await w.get("/prs/draft?run=run-1");
  assertInert("replies", page.text);
  assert.match(page.text, /href="https:\/\/acme\.ghe\.com\/ACME\/people\/pull\/7#discussion_r11"/);
  assert.doesNotMatch(page.text, /name="verdict"/, "replies have no verdict");
  const p = await w.post("/prs/draft/preview", { run: "run-1", keep_0: "on", body_0: "Fikset", keep_1: "on", body_1: "Bevisst, se AGENTS.md", keep_2: "on", body_2: "Borte", comment: "Takk for gjennomgangen" });
  assert.match(p.text, /One reply answers a comment that isn&#39;t on this PR: left out/);
  assert.match(p.text, />Post the replies<\/button>/);
  await w.post("/prs/draft/post", { run: "run-1", verdict: "comment", nonce: hidden(p.text, "nonce"), draft: hidden(p.text, "draft") });
  assert.deepEqual(posted, [
    { path: "replies/11", body: { body: "Fikset" } },
    { path: "replies/11", body: { body: "Bevisst, se AGENTS.md" } },
    { path: "issue", body: { body: "Takk for gjennomgangen" } },
  ]);
  assert.match((await w.get("/prs/draft?run=run-1")).text, /Posted 2 replies and a comment on ACME\/people#7/);
  const log = (await recentActions(w.db.DB)).filter((a) => a.kind === "pr.replies");
  assert.deepEqual(log.map((a) => [a.detail, a.ok]), [["2 replies and a comment", 1]]);
});

test("a team member's write (hosted): 'your own PR' means theirs, and the log names them", async () => {
  const at = (author: string) => ({
    "GET /repos/ACME/people/pulls/7": { state: "open", head: { sha: "aaa1111" }, user: { login: author } },
    "GET /repos/ACME/people/pulls/7/files?per_page=100&page=1": [],
    "GET /user": { login: "kari" },
  });
  const draft = { kind: "review" as const, summary: "S", comments: [] };
  const check = (author: string, who?: string) => actingAs(who ? { email: who } : undefined, () => checkReview(fakeGhe(at(author)).ghe, "ACME/people", 7, { reviewed: "aaa1111", me: "ola", draft }));
  // The instance (local, or a page with no person): the instance's login.
  assert.match((await check("ola") as { message: string }).message, /is your own PR/);
  assert.equal((await check("kari")).ok, true);
  // A member: their own login from GitHub, with their token.
  assert.match((await check("kari", "kari@example.dev") as { message: string }).message, /is your own PR/);
  assert.equal((await check("ola", "kari@example.dev")).ok, true);

  const db = openDb();
  await actingAs({ email: "kari@example.dev" }, () => logAction(db.DB, { kind: "pr.review", target: "ACME/people#7", ok: true }));
  await logAction(db.DB, { kind: "pr.review", target: "ACME/people#8", ok: true });
  assert.deepEqual((await recentActions(db.DB)).map((a) => [a.target, a.actor]), [["ACME/people#8", null], ["ACME/people#7", "kari@example.dev"]]);
});
