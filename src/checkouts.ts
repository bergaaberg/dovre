/** Local checkouts under the code folder: which folder holds which of the owners' repos. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownersOf } from "./owners.ts";
import { repoIn } from "./actions/deploys.ts";
import { listRepos } from "./sources/claude.ts";

/** The repo `origin` points at when one of the owners has it, from a `.git/config`: https or ssh, `.git` or not. */
export function remoteRepo(config: string, host: string, org: string): string | null {
  const section = config.split(/^\[/m).find((s) => /^remote\s+"origin"\]/.test(s));
  const url = section?.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1];
  if (!url) return null;
  const h = host.replace(/[.]/g, "\\.");
  const m = url.match(new RegExp(`^(?:https://(?:[^@/]+@)?${h}/|git@${h}:|ssh://git@${h}/)([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$`, "i"));
  const owner = m ? ownersOf(org).find((o) => o.toLowerCase() === m[1]!.toLowerCase()) : undefined;
  return owner ? repoIn(org, `${owner}/${m![2]}`) : null;
}

export type Checkout = { dir: string; repo: string };

/** Folders under the code folder that check out an org repo; for a worktree, its main checkout's remote. Main checkouts first. */
export function checkouts(codeDir: string, host: string, org: string): Checkout[] {
  const out: (Checkout & { main: boolean })[] = [];
  for (const dir of listRepos(codeDir)) {
    try {
      let git = join(codeDir, dir, ".git");
      const main = statSync(git).isDirectory();
      if (!main) {
        const to = readFileSync(git, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
        if (!to) continue;
        // <main>/.git/worktrees/<name> → <main>/.git
        git = dirname(dirname(resolve(join(codeDir, dir), to)));
      }
      const config = join(git, "config");
      const repo = existsSync(config) ? remoteRepo(readFileSync(config, "utf8"), host, org) : null;
      if (repo) out.push({ dir, repo, main });
    } catch {}
  }
  return out.sort((a, b) => Number(b.main) - Number(a.main) || a.dir.localeCompare(b.dir, "en", { sensitivity: "base" })).map(({ dir, repo }) => ({ dir, repo }));
}

/** GHE repo names ignore case (a checkout's remote may say ACME/forms for ACME/FORMS). */
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const inRepos = (list: string[], repo: string) => list.some((r) => sameRepo(r, repo));

/** The folder to run an agent in for a repo: its main checkout, the one named like it. */
export const checkoutOf = (list: Checkout[], repo: string) => list.find((c) => sameRepo(c.repo, repo) && c.dir.toLowerCase() === repo.split("/")[1]!.toLowerCase()) ?? list.find((c) => sameRepo(c.repo, repo));
