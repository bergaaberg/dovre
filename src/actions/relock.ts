/**
 * Lockfile conflicts in a combined Dependabot PR (dovre#108, local mode only): the bumps combine()
 * left out are merged into the combined branch in a checkout under CODE_DIR. When only lockfiles
 * conflict, ours is kept and the lockfile is made again from the merged manifests (pnpm and npm
 * with lifecycle scripts off, `go mod tidy`). Any other conflict leaves that bump out. The work
 * happens in a temporary worktree, so the checkout's own branch and files stay as they were; the
 * result is pushed to the combined branch as a fast-forward only (a push since is refused), with
 * the user's own git credentials. Re-checks GitHub first and logs either way.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { D1 } from "../db.ts";
import { listRepos } from "../sources/claude.ts";
import type { Ghe } from "../sources/ghe.ts";
import { BRANCH, type CombineResult, DEPENDABOT, MAX_COMBINE } from "./dependabot.ts";
import { logAction } from "./deploys.ts";

/** Runs a program (never a shell); resolves with its exit code and output. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; out: string }>;

export const runFile: Run = (cmd, args, cwd) =>
  new Promise((res) =>
    execFile(cmd, args, { cwd, timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
      res({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );

/** The lockfiles made again, and how: run in the lockfile's own folder. */
export const LOCKFILES: Record<string, [string, string[]]> = {
  "pnpm-lock.yaml": ["pnpm", ["install", "--lockfile-only", "--ignore-scripts"]],
  "package-lock.json": ["npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]],
  "go.sum": ["go", ["mod", "tidy"]],
};

/** Whether a remote URL points at owner/name (https or ssh, any host, with or without .git). */
export function remoteIs(url: string, repo: string): boolean {
  const path = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  return path.toLowerCase().endsWith(`/${repo.toLowerCase()}`) || path.toLowerCase().endsWith(`:${repo.toLowerCase()}`);
}

/** The checkout right under the code folder whose origin is the repo: the one named like it first. */
export async function checkoutOf(codeDir: string, repo: string, run: Run): Promise<string | undefined> {
  const name = repo.split("/")[1]!.toLowerCase();
  const dirs = listRepos(codeDir).sort((a, b) => Number(b.toLowerCase() === name) - Number(a.toLowerCase() === name));
  for (const d of dirs) {
    const dir = join(codeDir, d);
    const r = await run("git", ["remote", "get-url", "origin"], dir);
    if (r.code === 0 && remoteIs(r.out, repo)) return dir;
  }
  return undefined;
}

type RawPull = { number: number; title: string; state: string; user: { login: string; type: string } | null; head: { sha: string; ref: string; repo: { full_name: string } | null }; html_url: string };
const SHA = /^[0-9a-f]{40}$/;

/**
 * Merges the open Dependabot PRs that aren't in the combined PR `number` yet into its branch,
 * making lockfiles again where they're the only conflict, and pushes the branch.
 */
export async function addLeftOut(ghe: Ghe, db: D1, codeDir: string, repo: string, number: number, run: Run = runFile): Promise<CombineResult> {
  const target = `${repo}#${number}`;
  const fail = async (message: string, error?: string) => {
    await logAction(db, { kind: "pr.relock-dependabot", target, ok: false, error: error ?? message });
    return { ok: false, message: `${target}: ${message}` };
  };
  let tree: string | undefined;
  let checkout: string | undefined;
  const git = async (args: string[], cwd = tree!) => run("git", args, cwd);
  try {
    const pr = await ghe.rest<RawPull & { merged?: boolean }>(`/repos/${repo}/pulls/${number}`);
    if (pr.state !== "open") return fail(pr.merged ? "already merged." : "it's closed.");
    if (!pr.head.ref.startsWith(BRANCH) || pr.head.repo?.full_name !== repo || !SHA.test(pr.head.sha)) return fail("not a combined PR Dovre opened.");
    const open = await ghe.rest<RawPull[]>(`/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc`);
    const bots = open.filter((p) => p.state === "open" && p.user?.login === DEPENDABOT && p.user.type === "Bot" && p.head.repo?.full_name === repo && SHA.test(p.head.sha)).slice(0, MAX_COMBINE);
    if (!bots.length) return fail("no open Dependabot PRs to add.");
    checkout = await checkoutOf(codeDir, repo, run);
    if (!checkout) return fail(`no checkout of ${repo} right under ${codeDir}.`);
    const fetched = await git(["fetch", "--no-tags", "--quiet", "origin", pr.head.sha, ...bots.map((p) => p.head.sha)], checkout);
    if (fetched.code) return fail(`git fetch failed: ${fetched.out.trim().slice(0, 200)}`);
    tree = join(mkdtempSync(join(tmpdir(), "dovre-relock-")), "tree");
    const added = await git(["worktree", "add", "--detach", "--quiet", tree, pr.head.sha], checkout);
    if (added.code) {
      tree = undefined;
      return fail(`git worktree failed: ${added.out.trim().slice(0, 200)}`);
    }
    const merged: { number: number; relocked: string[] }[] = [];
    const left: { number: number; why: string }[] = [];
    for (const p of bots) {
      if ((await git(["merge-base", "--is-ancestor", p.head.sha, "HEAD"])).code === 0) continue;
      const msg = `Merge #${p.number}: ${p.title.replace(/[\r\n]+/g, " ")}`;
      const m = await git(["-c", "user.name=Dovre", "-c", "user.email=dovre@localhost", "merge", "--no-ff", "--no-edit", "-m", msg, p.head.sha]);
      if (m.code === 0) {
        merged.push({ number: p.number, relocked: [] });
        continue;
      }
      const conflicted = (await git(["diff", "--name-only", "--diff-filter=U"])).out.split("\n").map((s) => s.trim()).filter(Boolean);
      const others = conflicted.filter((f) => !LOCKFILES[basename(f)]);
      if (!conflicted.length || others.length) {
        await git(["merge", "--abort"]);
        left.push({ number: p.number, why: others.length ? `conflicts in ${others.slice(0, 3).join(", ")}` : "couldn't merge" });
        continue;
      }
      let broke: string | undefined;
      for (const f of conflicted) {
        const [cmd, args] = LOCKFILES[basename(f)]!;
        await git(["checkout", "--ours", "--", f]);
        const r = await run(cmd, args, join(tree, dirname(f)));
        if (r.code) {
          broke = `${cmd} ${args.join(" ")} failed`;
          break;
        }
      }
      // go mod tidy may change go.mod too; add whatever the tools changed.
      if (!broke && (await git(["add", "-A"])).code === 0 && (await git(["-c", "user.name=Dovre", "-c", "user.email=dovre@localhost", "commit", "--no-edit", "--quiet"])).code === 0) {
        merged.push({ number: p.number, relocked: conflicted });
        continue;
      }
      await git(["merge", "--abort"]);
      left.push({ number: p.number, why: broke ?? "couldn't commit the merge" });
    }
    if (!merged.length) {
      const why = left.length ? `none could be added (${left.map((l) => `#${l.number} ${l.why}`).join("; ")}).` : "every open Dependabot PR is in it already.";
      return fail(why);
    }
    const pushed = await git(["push", "--quiet", "origin", `HEAD:refs/heads/${pr.head.ref}`]);
    if (pushed.code) return fail(`git push failed (pushed to since?): ${pushed.out.trim().slice(0, 200)}`);
    const line = (m: { number: number; relocked: string[] }) => `- #${m.number}${m.relocked.length ? ` (made ${m.relocked.join(", ")} again)` : ""}`;
    await ghe.rest(`/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: { body: [`Added ${merged.length} more Dependabot PR${merged.length === 1 ? "" : "s"}:`, ...merged.map(line), ...(left.length ? ["", "Still left out:", ...left.map((l) => `- #${l.number} (${l.why})`)] : []), "", "Added by Dovre."].join("\n") },
    });
    const n = /^Dependency updates \((\d+)\)$/.exec(pr.title)?.[1];
    if (n) await ghe.rest(`/repos/${repo}/pulls/${number}`, { method: "PATCH", body: { title: `Dependency updates (${Number(n) + merged.length})` } }).catch(() => {});
    await logAction(db, { kind: "pr.relock-dependabot", target, detail: `added ${merged.map((m) => `#${m.number}`).join(" ")}${left.length ? `; left out ${left.map((l) => `#${l.number}`).join(" ")}` : ""}`, ok: true });
    return {
      ok: true,
      message: `Added ${merged.length} to ${target}${merged.some((m) => m.relocked.length) ? ", lockfiles made again" : ""}${left.length ? `; ${left.length} still left out (${left.map((l) => `#${l.number} ${l.why}`).join(", ")})` : ""}.`,
      url: pr.html_url,
      merged: merged.map((m) => m.number),
      skipped: left,
    };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    return fail(`couldn't add the left-out bumps: ${error.slice(0, 200)}`, error);
  } finally {
    if (tree && checkout) {
      await run("git", ["worktree", "remove", "--force", tree], checkout).catch(() => undefined);
      rmSync(dirname(tree), { recursive: true, force: true });
    }
  }
}
