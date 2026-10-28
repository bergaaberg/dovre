/** Left-out bumps added to a combined Dependabot PR, lockfiles made again (dovre#108), against real git with a local origin. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addLeftOut, LOCKFILES, remoteIs, type Run, runFile } from "../src/actions/relock.ts";
import { dependabotPage } from "../src/pages/dependabot.ts";
import { openDb } from "../src/db.ts";
import { fakeGhe } from "./helpers.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const bot = { login: "dependabot[bot]", type: "Bot" };

test("remoteIs matches https and ssh remotes of the repo only", () => {
  assert.equal(remoteIs("https://github.com/ACME/web.git\n", "acme/web"), true);
  assert.equal(remoteIs("git@github.com:ACME/web.git", "ACME/web"), true);
  assert.equal(remoteIs("https://github.com/ACME/web-old.git", "ACME/web"), false);
  assert.equal(remoteIs("https://github.com/evil/ACME/webx", "ACME/web"), false);
});

test("addLeftOut: lockfile-only conflicts made again, other conflicts left out, pushed to the combined branch, checkout untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "relock-test-"));
  try {
    const origin = join(root, "remote", "ACME", "web.git");
    mkdirSync(origin, { recursive: true });
    sh(origin, "init", "--quiet", "--bare", "-b", "main");
    sh(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const seed = join(root, "seed");
    sh(root, "clone", "--quiet", origin, seed);
    const pkg = (a: string, b: string) => `{\n  "a": "${a}",\n\n\n\n\n  "b": "${b}"\n}\n`;
    const commit = (files: Record<string, string>, msg: string) => {
      for (const [f, t] of Object.entries(files)) writeFileSync(join(seed, f), t);
      sh(seed, "add", "-A");
      sh(seed, "commit", "--quiet", "-m", msg);
      return sh(seed, "rev-parse", "HEAD");
    };
    commit({ "package.json": pkg("1", "1"), "pnpm-lock.yaml": "lock: base\n", "src.txt": "base\n" }, "base");
    sh(seed, "push", "--quiet", "origin", "main");
    const branchOff = (name: string, files: Record<string, string>) => {
      sh(seed, "checkout", "--quiet", "-B", name, "main");
      const sha = commit(files, name);
      sh(seed, "push", "--quiet", "origin", name);
      return sha;
    };
    const head = branchOff("dovre/dependabot-x", { "package.json": pkg("2", "1"), "pnpm-lock.yaml": "lock: a2\n", "src.txt": "combined\n" });
    const pr2 = branchOff("dependabot/b", { "package.json": pkg("1", "2"), "pnpm-lock.yaml": "lock: b2\n" });
    const pr3 = branchOff("dependabot/c", { "src.txt": "other\n" });
    const pr4 = branchOff("dependabot/d", { "new.txt": "d\n" });

    const code = join(root, "code");
    mkdirSync(code);
    sh(code, "clone", "--quiet", origin, "web");
    const checkout = join(code, "web");
    const ran: string[] = [];
    const run: Run = async (cmd, args, cwd) => {
      if (cmd !== "git") {
        ran.push(`${cmd} ${args.join(" ")}`);
        writeFileSync(join(cwd, "pnpm-lock.yaml"), "lock: made again\n");
        return { code: 0, out: "" };
      }
      return runFile(cmd, args, cwd);
    };
    const pull = (number: number, sha: string, ref: string, user = bot) => ({ number, title: `Bump x${number} from 1 to 2`, state: "open", html_url: "", user, head: { sha, ref, repo: { full_name: "ACME/web" } } });
    const { ghe, calls } = fakeGhe({
      "GET /repos/ACME/web/pulls/99": { number: 99, title: "Dependency updates (1)", state: "open", html_url: "https://x/99", user: { login: "me", type: "User" }, head: { sha: head, ref: "dovre/dependabot-x", repo: { full_name: "ACME/web" } } },
      "GET /repos/ACME/web/pulls?state=open&per_page=100&sort=created&direction=asc": [pull(1, head, "dependabot/a"), pull(2, pr2, "dependabot/b"), pull(3, pr3, "dependabot/c"), pull(4, pr4, "dependabot/d"), pull(5, pr4, "mine", { login: "me", type: "User" })],
      "POST /repos/ACME/web/issues/99/comments": {},
      "PATCH /repos/ACME/web/pulls/99": {},
    });
    const db = openDb();
    const r = await addLeftOut(ghe, db.DB, code, "ACME/web", 99, run);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.merged, [2, 4], "#1 is in it already; #5 isn't Dependabot's");
    assert.deepEqual(r.skipped, [{ number: 3, why: "conflicts in src.txt" }]);
    assert.deepEqual(ran, ["pnpm install --lockfile-only --ignore-scripts"]);

    sh(seed, "fetch", "--quiet", "origin");
    const pushed = sh(seed, "rev-parse", "origin/dovre/dependabot-x");
    assert.equal(sh(seed, "merge-base", "--is-ancestor", head, pushed), "", "a fast-forward of the combined branch");
    assert.equal(sh(seed, "show", `${pushed}:pnpm-lock.yaml`), "lock: made again");
    assert.equal(sh(seed, "show", `${pushed}:package.json`), pkg("2", "2").trim());

    assert.equal(sh(checkout, "status", "--porcelain"), "");
    assert.equal(sh(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(sh(checkout, "worktree", "list").split("\n").length, 1, "the temporary worktree is gone");
    assert.equal(readFileSync(join(checkout, "src.txt"), "utf8"), "base\n");

    const comment = calls.find((c) => c.path.endsWith("/comments"))!.body as { body: string };
    assert.match(comment.body, /- #2 \(made pnpm-lock\.yaml again\)\n- #4\n\nStill left out:\n- #3 \(conflicts in src\.txt\)/);
    assert.deepEqual(calls.find((c) => c.method === "PATCH")!.body, { title: "Dependency updates (3)" });
    const logged = db.raw.prepare("SELECT kind, target, ok, detail FROM actions").all() as { kind: string; target: string; ok: number; detail: string }[];
    assert.deepEqual(logged.map((l) => [l.kind, l.target, l.ok, l.detail]), [["pr.relock-dependabot", "ACME/web#99", 1, "added #2 #4; left out #3"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addLeftOut refuses a PR that isn't one of combine()'s, and a repo with no checkout", async () => {
  const db = openDb();
  const sha = "a".repeat(40);
  const other = fakeGhe({ "GET /repos/ACME/web/pulls/7": { number: 7, title: "x", state: "open", html_url: "", user: null, head: { sha, ref: "feature", repo: { full_name: "ACME/web" } } } });
  const r = await addLeftOut(other.ghe, db.DB, "/nowhere", "ACME/web", 7, runFile);
  assert.equal(r.ok, false);
  assert.match(r.message, /not a combined PR Dovre opened/);
  const none = fakeGhe({
    "GET /repos/ACME/web/pulls/9": { number: 9, title: "x", state: "open", html_url: "", user: null, head: { sha, ref: "dovre/dependabot-1", repo: { full_name: "ACME/web" } } },
    "GET /repos/ACME/web/pulls?state=open&per_page=100&sort=created&direction=asc": [{ number: 2, title: "Bump", state: "open", html_url: "", user: bot, head: { sha, ref: "d", repo: { full_name: "ACME/web" } } }],
  });
  const n = await addLeftOut(none.ghe, db.DB, mkdtempSync(join(tmpdir(), "relock-empty-")), "ACME/web", 9, runFile);
  assert.match(n.message, /no checkout of ACME\/web/);
  assert.equal(none.calls.filter((c) => c.method !== "GET").length, 0);
});

test("the page offers to add left-out bumps only in local mode, with a combined PR open", () => {
  const frame = { operator: "me", nav: [] } as unknown as Parameters<typeof dependabotPage>[0];
  const repos = [{ repo: "ACME/web", prs: [{ repo: "ACME/web", number: 2, title: "Bump b", url: "https://x/2", createdAt: "2026-10-01T00:00:00Z", security: false }], oldest: "2026-10-01T00:00:00Z", security: 0, combined: { number: 99, url: "https://x/99", checks: null, mergeable: null, draft: false } }];
  assert.match(dependabotPage(frame, { org: "ACME", repos, relock: true }), /name="number" value="99"[\s\S]*Add left-out bumps/);
  assert.doesNotMatch(dependabotPage(frame, { org: "ACME", repos }), /Add left-out bumps/);
});

test("LOCKFILES: Python and .NET are made again; Poetry 1 keeps its pins with --no-update, Poetry 2 by default", async () => {
  for (const f of ["uv.lock", "poetry.lock", "pdm.lock", "packages.lock.json"]) assert.ok(LOCKFILES[f], f);
  assert.equal(LOCKFILES["Pipfile.lock"], undefined, "pipenv lock moves every pin");
  assert.equal(LOCKFILES["uv.lock"]!.label, "uv lock");
  assert.equal(LOCKFILES["pdm.lock"]!.label, "pdm lock --update-reuse");
  assert.equal(LOCKFILES["packages.lock.json"]!.label, "dotnet restore --force-evaluate");
  for (const [version, args] of [["Poetry (version 1.8.3)", "lock --no-update"], ["Poetry (version 2.1.0)", "lock"]] as const) {
    const ran: string[] = [];
    const run: Run = async (cmd, a) => (ran.push(`${cmd} ${a.join(" ")}`), { code: 0, out: a[0] === "--version" ? version : "" });
    assert.equal(await LOCKFILES["poetry.lock"]!.make(run, "/x"), 0);
    assert.deepEqual(ran, ["poetry --version", `poetry ${args}`]);
  }
  const missing: Run = async () => ({ code: 127, out: "poetry: not found" });
  assert.equal(await LOCKFILES["poetry.lock"]!.make(missing, "/x"), 127);
});
