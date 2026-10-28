/**
 * What a turn changed in its checkout (#241): the checkout's tree when the turn starts, and the
 * diff from there when it ends. The tree is written through a copy of the checkout's index, so
 * the real index, the working tree and the refs are never touched, and new files count as well as
 * edits (ignored ones don't). Another agent working in the same checkout at the same time counts
 * too: it's what changed in the checkout during the turn.
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type TurnDiff = { files: number; add: number; del: number };

export type TurnDiffer = {
  /** The checkout's tree now (a tree id), or undefined when it isn't a git checkout. */
  tree(cwd: string): Promise<string | undefined>;
  /** Files, lines added and removed between two trees. */
  between(cwd: string, from: string, to: string): Promise<TurnDiff | undefined>;
};

const TREE = /^[0-9a-f]{40,64}$/;

const git = (cwd: string, args: string[], env?: Record<string, string>) =>
  new Promise<string>((ok, no) =>
    execFile("git", args, { cwd, env: env ? { ...process.env, ...env } : undefined, timeout: 30_000, maxBuffer: 8 << 20, windowsHide: true }, (e, out) => (e ? no(e) : ok(String(out)))),
  );

/** `git diff --numstat` lines as one count; a binary file counts as a file with no lines. */
export function numstat(out: string): TurnDiff {
  const d: TurnDiff = { files: 0, add: 0, del: 0 };
  for (const line of out.split("\n")) {
    const m = line.match(/^(-|\d+)\t(-|\d+)\t/);
    if (!m) continue;
    d.files++;
    d.add += m[1] === "-" ? 0 : Number(m[1]);
    d.del += m[2] === "-" ? 0 : Number(m[2]);
  }
  return d;
}

export function gitTurnDiff(): TurnDiffer {
  return {
    async tree(cwd) {
      const tmp = mkdtempSync(join(tmpdir(), "dovre-turn-"));
      try {
        const index = join(tmp, "index");
        // Starting from the real index, only files changed since it are hashed again.
        const real = (await git(cwd, ["rev-parse", "--git-path", "index"])).trim();
        try {
          copyFileSync(resolve(cwd, real), index);
        } catch {}
        const env = { GIT_INDEX_FILE: index };
        await git(cwd, ["add", "-A", "--", "."], env);
        const tree = (await git(cwd, ["write-tree"], env)).trim();
        return TREE.test(tree) ? tree : undefined;
      } catch {
        return undefined;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    async between(cwd, from, to) {
      if (!TREE.test(from) || !TREE.test(to)) return undefined;
      try {
        return numstat(await git(cwd, ["diff", "--numstat", "--no-renames", from, to]));
      } catch {
        return undefined;
      }
    },
  };
}
