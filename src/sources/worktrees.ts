/**
 * Git worktrees checked out beside their repos in the code folder. A worktree's `.git` is a
 * file pointing at `<main>/.git/worktrees/<name>`; reading that (and its HEAD) needs no git call.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type Worktree = { name: string; path: string; main: string; branch: string | null; head: string; changedAt: number };

/** Branch from a HEAD file's content: null when detached. */
export function branchOf(head: string): string | null {
  const m = head.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1]! : null;
}

export function loadWorktrees(codeDir: string): Worktree[] {
  const out: Worktree[] = [];
  if (!existsSync(codeDir)) return out;
  for (const name of readdirSync(codeDir)) {
    const path = join(codeDir, name);
    const dotgit = join(path, ".git");
    try {
      if (!statSync(dotgit).isFile()) continue;
      const gitdir = readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!gitdir || !/[\\/]\.git[\\/]worktrees[\\/]/.test(gitdir)) continue;
      const dir = resolve(path, gitdir);
      const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
      const index = join(dir, "index");
      out.push({
        name,
        path,
        main: basename(resolve(dir, "..", "..", "..")),
        branch: branchOf(head),
        head: head.startsWith("ref:") ? "" : head.slice(0, 7),
        changedAt: (existsSync(index) ? statSync(index) : statSync(dir)).mtimeMs,
      });
    } catch {}
  }
  return out.sort((a, b) => b.changedAt - a.changedAt);
}
