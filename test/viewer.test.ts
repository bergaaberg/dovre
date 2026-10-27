/** Dovre's own PR viewer, diff viewer and code explorer: read-only, org-only, cached, hostile text inert. */
import assert from "node:assert/strict";
import { html } from "hono/html";
import type { Child } from "../src/ui/kit.ts";
import { test } from "node:test";
import type { Env } from "../src/env.ts";
import { createViewerRoutes } from "../src/pages/viewer.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import { normalizePrView } from "../src/sources/prview.ts";
import { blob, commitOf, type Git, grep, safePath, safeRef, tree } from "../src/viewer/code.ts";
import { fileViews, parsePatch, placeDrafts, placeThreads } from "../src/viewer/diff.ts";
import { git as realGit } from "../src/viewer/code.ts";
import { localDiff, parseGitDiff } from "../src/viewer/localdiff.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInert, H, signedIn, snapshot } from "./helpers.ts";

const SHA = "a".repeat(40);
const raw = (o: Record<string, unknown> = {}) => ({
  repository: {
    pullRequest: {
      number: 840, title: `Stack top ${H}`, url: "https://acme.ghe.com/ACME/shop-api/pull/840", state: "OPEN", isDraft: false, mergeable: "CONFLICTING",
      baseRefName: `feat/839${H}`, headRefName: "feat/840", headRefOid: SHA, author: { login: `me${H}` }, body: `Body ${H}`, additions: 3, deletions: 1, changedFiles: 2,
      createdAt: "2026-10-20T08:00:00Z", updatedAt: "2026-10-22T08:00:00Z", reviewDecision: "REVIEW_REQUIRED", labels: { nodes: [{ name: H }] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "per" } }] },
      reviews: { nodes: [{ author: { login: "copilot" }, state: "COMMENTED", body: `Looks ${H}`, submittedAt: "2026-10-21T08:00:00Z", url: "javascript:x" }] },
      reviewThreads: { nodes: [{ isResolved: false, isOutdated: false, path: "src/a.ts", line: 11, originalLine: 11, diffSide: "RIGHT", comments: { nodes: [{ author: { login: "per" }, body: `Why ${H}?`, createdAt: "2026-10-21T09:00:00Z", url: "" }] } }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: `build ${H}`, conclusion: "FAILURE", detailsUrl: "javascript:alert(1)" }] } } } }] },
      timelineItems: { nodes: [{ __typename: "PullRequestCommit", commit: { oid: SHA, messageHeadline: `feat: ${H}`, committedDate: "2026-10-20T09:00:00Z", author: { user: { login: "me" } } } }] },
      ...o,
    },
  },
});
const FILES = [
  { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, sha: "1", patch: "@@ -10,3 +10,4 @@ class A\n ctx\n-old\n+new\n+added " + H + "\n" },
  { filename: "logo.png", status: "added", additions: 0, deletions: 0, sha: "2" },
  { filename: "pnpm-lock.yaml", previous_filename: "old.lock", status: "renamed", additions: 900, deletions: 0, sha: "3", patch: "@@ -0,0 +1,1 @@\n+x\n" },
];

function fakeGhe(view: unknown = raw()) {
  const calls: string[] = [];
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest<T>(path: string) {
      calls.push(`REST ${path}`);
      if (path.startsWith("/repos/ACME/shop-api/pulls/840/files")) return (path.includes("page=1") ? FILES : []) as T;
      throw new Error(`GHE ${path}: 404`);
    },
    async graphql<T>(q: string) {
      calls.push("GRAPHQL");
      assert.ok(q.includes('owner:"ACME"') && q.includes('name:"shop-api"') && q.includes("pullRequest(number:840)"));
      return view as T;
    },
  };
  return { ghe, calls };
}

const ENV = { GHE_ORG: "ACME", CODE_DIR: "C:/code" } as unknown as Env;
const frame = async () => ({ operator: "me", nav: [] });

test("a diff's lines have both sides' numbers; threads sit on their line; unplaced ones are kept", () => {
  const lines = parsePatch("@@ -10,3 +10,4 @@ class A\n ctx\n-old\n+new\n+two\n\\ No newline at end of file");
  assert.deepEqual(lines.map((l) => [l.kind, "old" in l ? l.old : undefined, "new" in l ? l.new : undefined]), [
    ["hunk", undefined, undefined], ["ctx", 10, 10], ["del", 11, undefined], ["add", undefined, 11], ["add", undefined, 12], ["note", undefined, undefined],
  ]);
  const t = (line: number, side: "LEFT" | "RIGHT") => ({ path: "a", line, side, resolved: false, outdated: false, comments: [] });
  const unplaced = placeThreads(lines, [t(11, "RIGHT"), t(11, "LEFT"), t(99, "RIGHT")]);
  assert.equal(lines.find((l) => l.kind === "add" && l.new === 11 && l.threads?.length === 1) !== undefined, true, "RIGHT 11 is the added line");
  assert.equal(lines.find((l) => l.kind === "del" && l.old === 11 && l.threads?.length === 1) !== undefined, true, "LEFT 11 is the deleted line");
  assert.equal(unplaced.length, 1);
});

test("files: binary, renamed, generated and big ones start folded, with why", () => {
  const view = normalizePrView("ACME/shop-api", raw())!;
  const views = fileViews(FILES.map((f) => ({ path: f.filename, previous: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch, sha: f.sha })), view.threads);
  assert.equal(views[0]!.folded, false);
  assert.equal(views[0]!.threads.length, 1);
  assert.match(views[1]!.why ?? "", /binary/);
  assert.equal(views[2]!.folded, true);
  assert.match(views[2]!.why ?? "", /Generated|lock/);
});

test("the PR page and its files draw hostile text inert, link nothing unsafe, and a second view doesn't ask GHE again", async () => {
  const { ghe, calls } = fakeGhe();
  const app = createViewerRoutes(ENV, { ghe, frame, checkouts: () => [] });
  const page = await app.request("/prs/ACME/shop-api/840");
  assert.equal(page.status, 200);
  const out = await page.text();
  assertInert("pr page", out);
  assert.ok(!out.includes('href="javascript:'));
  assert.match(out, /conflicts/);
  assert.match(out, /Why /);
  const files = await (await app.request("/prs/ACME/shop-api/840/files")).text();
  assertInert("files page", files);
  assert.match(files, /class="d-add"/);
  assert.match(files, /<details class="dfile" id="[^"]+" data-stop="1" data-stop-label="src\/a.ts"/, "each file is a section to move between");
  assert.match(files, /<tr class="d-hunk" data-stop="2">/, "each hunk an item in it");
  assert.match(files, /input type="checkbox" class="viewed" data-key="a{40}:src\/a.ts"/);
  const before = calls.length;
  await app.request("/prs/ACME/shop-api/840");
  await app.request("/prs/ACME/shop-api/840/files");
  assert.equal(calls.length, before, "both cached");
});

test("the PR page draws the pack's facts for that PR, not just its repo", async () => {
  const { ghe } = fakeGhe();
  const facts = (p: { repo: string; number: number; branch: string }) => [["Ticket", html`<a href="https://example.net/${p.number}">${p.branch}</a>`] as [Child, Child]];
  const app = createViewerRoutes(ENV, { ghe, frame, checkouts: () => [], facts });
  const out = await (await app.request("/prs/ACME/shop-api/840")).text();
  assert.match(out, /href="https:\/\/example.net\/840"/, "the fact row is this PR's");
});

test("only the org's PRs; odd numbers and other owners are a 404 without asking GHE", async () => {
  const { ghe, calls } = fakeGhe();
  const app = createViewerRoutes(ENV, { ghe, frame, checkouts: () => [] });
  for (const p of ["/prs/evil/repo/1", "/prs/ACME/a..b/1", "/prs/ACME/shop-api/1x", "/prs/ACME/shop-api/99999999"]) assert.equal((await app.request(p)).status, 404, p);
  assert.equal(calls.length, 0);
});

test("explorer: refs and paths are checked before git sees them", () => {
  for (const ok of ["HEAD", "main", "feat/840", "v1.2.3", SHA]) assert.ok(safeRef(ok), ok);
  for (const bad of ["-o", "--output=x", "a..b", "x.lock", "a//b", "", "a b", "HEAD~1;rm"]) assert.ok(!safeRef(bad), bad);
  assert.equal(safePath("src/a.ts"), "src/a.ts");
  assert.equal(safePath("/src/"), "src");
  assert.equal(safePath(""), "");
  for (const bad of ["../x", "a/../b", "a\\b", "C:/x", ":(top)x", "a//b", "a/./b"]) assert.equal(safePath(bad), null, bad);
});

/** A git that answers from a table, and says which commands it got. */
function fakeGit(answers: Record<string, { code?: number; stdout: string }>) {
  const seen: string[][] = [];
  const g: Git = async (_dir, args) => {
    seen.push(args);
    const key = args.join(" ");
    const hit = Object.entries(answers).find(([k]) => key.includes(k));
    return { code: hit ? (hit[1].code ?? 0) : 128, stdout: hit ? hit[1].stdout : "", stderr: "" };
  };
  return { g, seen };
}

test("explorer: trees list folders first, files are text, binary or too big, search is capped and fixed-string", async () => {
  const { g, seen } = fakeGit({
    "rev-parse": { stdout: `${SHA}\n` },
    "ls-tree -z -l --end-of-options aaaa": { stdout: `100644 blob 1f    120\tb.ts\u0000040000 tree 2e      -\tsrc\u0000` },
    "cat-file -t": { stdout: "blob\n" },
    "cat-file -s": { stdout: "42\n" },
    "cat-file blob": { stdout: `line ${H}\nbin\u0000` },
    grep: { stdout: `${SHA}:src/a.ts:3:const x = "${H}"\n${SHA}:b.ts:9:y\n` },
  });
  assert.equal(await commitOf(g, "d", "main"), SHA);
  assert.equal(await commitOf(g, "d", "--evil"), null, "an option-shaped ref never reaches git");
  const entries = (await tree(g, "d", SHA, ""))!;
  assert.deepEqual(entries.map((e) => [e.name, e.type]), [["src", "tree"], ["b.ts", "blob"]]);
  assert.equal((await blob(g, "d", SHA, "b.ts")).kind, "binary");
  const r = (await grep(g, "d", SHA, "x"))!;
  assert.deepEqual(r.hits.map((h) => [h.path, h.line]), [["src/a.ts", 3], ["b.ts", 9]]);
  const grepArgs = seen.find((a) => a.includes("grep"))!;
  assert.ok(grepArgs.includes("-F") && grepArgs[grepArgs.indexOf("-e") + 1] === "x", "the query is a fixed string after -e");
  assert.ok(seen.every((a) => a.includes("--end-of-options") || a[0] === "grep"), "refs come after --end-of-options");
});

test("the code explorer through the app: only checkouts it knows, hostile code inert", async () => {
  const { g } = fakeGit({
    "rev-parse": { stdout: `${SHA}\n` },
    "ls-tree -z -l --end-of-options aaaa:src/a.ts": { code: 128, stdout: "" },
    "cat-file -t": { stdout: "blob\n" },
    "cat-file -s": { stdout: "40\n" },
    "cat-file blob": { stdout: `<script>alert(1)</script>\n${H}\n` },
  });
  const app = createViewerRoutes(ENV, { ghe: fakeGhe().ghe, frame, checkouts: () => [{ dir: "shop-api", repo: "ACME/shop-api" }], git: g });
  assert.equal((await app.request("/code/other")).status, 404);
  assert.equal((await app.request("/code/shop-api?path=../x")).status, 400);
  const res = await app.request("/code/shop-api?path=src/a.ts");
  assert.equal(res.status, 200);
  const out = await res.text();
  assertInert("code page", out);
  assert.match(out, /<tr id="L2">/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("in the app: the viewer is behind the cookie, and /code lists checkouts", async () => {
  const { app, get } = signedIn(snapshot());
  assert.equal((await app.request("http://localhost/prs/ACME/shop-api/840")).status, 404, "no cookie, nothing here");
  assert.equal((await get("/code")).status, 200);
  assert.equal((await get("/prs/evil/x/1")).status, 404);
});

test("draft comments go on their lines (RIGHT on the new side, LEFT on a removed line); the rest come back by index", () => {
  const file = { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,3 +1,4 @@\n line1\n-old2\n+new2\n+new3\n line3", sha: "f" };
  const views = fileViews([file], []);
  const off = placeDrafts(views, [
    { path: "src/a.ts", line: 2, side: "RIGHT" },
    { path: "src/a.ts", line: 2, side: "LEFT" },
    { path: "src/a.ts", line: 40, side: "RIGHT" },
    { path: "src/b.ts", line: 1, side: "RIGHT" },
  ]);
  assert.deepEqual(off, [2, 3]);
  const at = (text: string) => views[0]!.lines.find((l) => l.kind !== "hunk" && l.kind !== "note" && l.text === text) as { drafts?: number[] };
  assert.deepEqual(at("new2").drafts, [0]);
  assert.deepEqual(at("old2").drafts, [1]);
  assert.equal(views[0]!.drafts, 2);
});

test("local diff (#105): git's output as the viewer's files: added, removed, renamed, binary, mode-only", () => {
  const out = [
    "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
    "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "index 1..0", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/old name.ts b/new name.ts", "similarity index 90%", "rename from old name.ts", "rename to new name.ts",
    "diff --git a/img.png b/img.png", "new file mode 100644", "index 0..1", "Binary files /dev/null and b/img.png differ",
    "diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", "",
  ].join("\n");
  const files = parseGitDiff(out);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.previous ?? null, f.patch === undefined]), [
    ["src/a.ts", "modified", 1, 1, null, false],
    ["gone.ts", "removed", 0, 1, null, false],
    ["new name.ts", "renamed", 0, 0, "old name.ts", true],
    ["img.png", "added", 0, 0, null, true],
    ["run.sh", "modified", 0, 0, null, true],
  ]);
  assert.equal(files[0]!.patch, "@@ -1,2 +1,2 @@\n keep\n-old\n+new");
});

/** A real repo: main with two files, a branch with a commit, and uncommitted work on top. */
function repo() {
  const code = mkdtempSync(join(tmpdir(), "dovre-localdiff-"));
  const dir = join(code, "shop-api");
  mkdirSync(dir);
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" }).toString().trim();
  run("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "b.ts"), "bee\n");
  run("add", "-A");
  run("commit", "-q", "-m", "first");
  run("switch", "-q", "-c", "feat");
  writeFileSync(join(dir, "c.ts"), "sea\n");
  run("add", "-A");
  run("commit", "-q", "-m", "second");
  const second = run("rev-parse", "HEAD");
  // Uncommitted: a change, a rename, a deletion, an untracked file with hostile text, an ignored one.
  writeFileSync(join(dir, "a.ts"), `one\n2 ${H}\nthree\n`);
  renameSync(join(dir, "b.ts"), join(dir, "bee.ts"));
  run("add", "-A", "b.ts", "bee.ts");
  unlinkSync(join(dir, "c.ts"));
  writeFileSync(join(dir, "new&'.ts"), `${H}\n`);
  writeFileSync(join(dir, ".gitignore"), "secret.env\n");
  writeFileSync(join(dir, "secret.env"), "TOKEN=x\n");
  return { code, dir, second, done: () => rmSync(code, { recursive: true, force: true }) };
}

test("local diff (#105) on a real checkout: uncommitted (untracked too, ignored never), two refs, one commit", async () => {
  const r = repo();
  try {
    const wt = await localDiff(realGit, r.dir, { kind: "worktree", base: "HEAD" });
    assert.ok(wt.ok, JSON.stringify(wt));
    assert.deepEqual(wt.files.map((f) => [f.path, f.status]).sort(), [[".gitignore", "added"], ["a.ts", "modified"], ["bee.ts", "renamed"], ["c.ts", "removed"], ["new&'.ts", "added"]]);
    assert.equal(wt.files.find((f) => f.path === "new&'.ts")!.additions, 1);
    const refs = await localDiff(realGit, r.dir, { kind: "refs", base: "main", head: "feat" });
    assert.ok(refs.ok);
    assert.deepEqual(refs.files.map((f) => [f.path, f.status]), [["c.ts", "added"]]);
    const one = await localDiff(realGit, r.dir, { kind: "commit", sha: r.second });
    assert.ok(one.ok && one.files.length === 1 && one.head === r.second);
    const root = await localDiff(realGit, r.dir, { kind: "commit", sha: "main" });
    assert.ok(root.ok);
    assert.deepEqual(root.files.map((f) => f.path), ["a.ts", "b.ts"], "a root commit diffs against the empty tree");
    assert.equal((await localDiff(realGit, r.dir, { kind: "refs", base: "main", head: "nope" })).ok, false);
  } finally {
    r.done();
  }
});

test("local diff (#105) through the app: hostile code inert, bad refs refused before git, unknown checkouts 404, hosted 404", async () => {
  const r = repo();
  try {
    const env = { ...ENV, CODE_DIR: r.code } as Env;
    const app = createViewerRoutes(env, { ghe: fakeGhe().ghe, frame, checkouts: () => [{ dir: "shop-api", repo: "ACME/shop-api" }] });
    const res = await app.request("/code/shop-api/diff");
    assert.equal(res.status, 200);
    const out = await res.text();
    assertInert("local diff page", out);
    assert.match(out, /Nothing uncommitted|a\.ts/);
    assert.match(out, /new&amp;&#39;\.ts|new&amp;'\.ts/);
    assert.doesNotMatch(out, /TOKEN=x/, "ignored files stay out");
    assert.doesNotMatch(out, /View file/, "the working tree has no commit to open");
    const refs = await (await app.request("/code/shop-api/diff?base=main&head=feat")).text();
    assert.match(refs, /c\.ts/);
    assert.match(refs, /View file/);
    assert.equal((await app.request("/code/shop-api/diff?base=--output=x")).status, 400);
    assert.equal((await app.request("/code/shop-api/diff?commit=a..b")).status, 400);
    assert.equal((await app.request("/code/shop-api/diff?head=nope")).status, 404);
    assert.equal((await app.request("/code/other/diff")).status, 404);
    assert.match(await (await app.request("/code/shop-api")).text(), /href="\/code\/shop-api\/diff"/);
    const hosted = createViewerRoutes({ ...env, IS_HOSTED: "1" } as Env, { ghe: fakeGhe().ghe, frame, checkouts: () => [{ dir: "shop-api", repo: "ACME/shop-api" }] });
    assert.equal((await hosted.request("/code/shop-api/diff")).status, 404);
  } finally {
    r.done();
  }
});
