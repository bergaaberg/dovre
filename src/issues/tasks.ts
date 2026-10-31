/**
 * Dev tasks: a piece of a planned issue, filed in the code repo where the work happens and hung
 * under the planned one as a sub-issue (what reads the plan sees a task closed when its PR merges).
 * The parent is any open issue in the org; the planning repos' open issues are offered first.
 */
import { ownersOf, primaryOf } from "../owners.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logAction, repoIn } from "../actions/deploys.ts";
import type { D1 } from "../db.ts";
import type { Ghe } from "../sources/ghe.ts";
import { listRepos } from "../sources/claude.ts";
import { ensureType, msg, type RawIssue } from "./create.ts";

export type IssueRef = { repo: string; number: number };

/** `ACME/x#12`, `x#12` (the first owner's) or an issue URL on the host. Anything outside the owners is refused. */
export function parseRef(input: string, org: string, host?: string): IssueRef | null {
  const s = input.trim();
  const url = host ? s.match(new RegExp(`^https://${host.replace(/[.]/g, "\\.")}/([\\w.-]+/[\\w.-]+)/issues/(\\d{1,9})/?$`, "i")) : null;
  const short = s.match(/^(?:([\w.-]+)\/)?([\w.-]+)#(\d{1,9})$/);
  const [owner, name, n] = url ? [url[1]!.split("/")[0], url[1]!.split("/")[1], url[2]] : short ? [short[1] ?? primaryOf(org), short[2], short[3]] : [];
  const repo = owner && name ? repoIn(org, `${owner}/${name}`) : null;
  return repo && name !== "." && name !== ".." ? { repo, number: Number(n) } : null;
}

export const refText = (r: IssueRef) => `${r.repo}#${r.number}`;

export type Parent = IssueRef & { title: string; url: string; mine: boolean; updated: string; state: string };

type ListedIssue = { number: number; title: string; html_url: string; state: string; updated_at: string; pull_request?: unknown; assignees?: { login: string }[]; repository_url?: string };

const parentOf = (repo: string, i: ListedIssue, login: string): Parent => ({
  repo,
  number: i.number,
  title: i.title,
  url: i.html_url,
  mine: (i.assignees ?? []).some((a) => a.login === login),
  updated: i.updated_at,
  state: i.state,
});

/** Open issues in the parent repos: mine first, then the most recently updated. Pull requests left out. */
export async function loadParents(ghe: Ghe, repos: string[], login: string, max = 30): Promise<Parent[]> {
  const lists = await Promise.all(repos.map(async (repo) => (await ghe.rest<ListedIssue[]>(`/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=50`)).filter((i) => !i.pull_request).map((i) => parentOf(repo, i, login))));
  return lists.flat().sort((a, b) => Number(b.mine) - Number(a.mine) || b.updated.localeCompare(a.updated)).slice(0, max);
}

/** One issue, read fresh: the re-check before anything hangs under it. */
export async function loadIssue(ghe: Ghe, ref: IssueRef, login = ""): Promise<Parent & { pr: boolean }> {
  const i = await ghe.rest<ListedIssue>(`/repos/${ref.repo}/issues/${ref.number}`);
  return { ...parentOf(ref.repo, i, login), pr: !!i.pull_request };
}

// ── Local checkouts: which folder holds which org repo ─────────────────────────

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
export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const inRepos = (list: string[], repo: string) => list.some((r) => sameRepo(r, repo));

/** The folder to run an agent in for a repo: its main checkout, the one named like it. */
export const checkoutOf = (list: Checkout[], repo: string) => list.find((c) => sameRepo(c.repo, repo) && c.dir.toLowerCase() === repo.split("/")[1]!.toLowerCase()) ?? list.find((c) => sameRepo(c.repo, repo));

// ── Creating one ───────────────────────────────────────────────────────────────

export type NewTask = { repo: string; title: string; body: string; type: string; typeNodeId?: string; assignees: string[]; parent: IssueRef };
export type TaskCreated = { ok: true; repo: string; number: number; url: string; title: string; parent: IssueRef; linked: boolean; warnings: string[] } | { ok: false; message: string };

/**
 * Re-checks the parent (open, an issue, in the org), files the task with its type, then hangs it
 * under the parent. The link is a second call: when it fails the task exists unlinked, and the
 * done page says so (the plan would never see it). Logged either way.
 */
export async function createTask(ghe: Ghe, db: D1, org: string, t: NewTask): Promise<TaskCreated> {
  const under = refText(t.parent);
  const fail = async (message: string, target = t.repo) => {
    await logAction(db, { kind: "task.create", target, detail: `${t.type} · ${t.title} · under ${under}`, ok: false, error: message });
    return { ok: false as const, message };
  };
  if (!repoIn(org, t.repo) || !repoIn(org, t.parent.repo)) return fail(`Both repos must be in ${ownersOf(org).join(", ")}.`);
  try {
    const p = await loadIssue(ghe, t.parent);
    if (p.pr) return fail(`${under} is a pull request, not an issue: nothing was created.`);
    if (p.state !== "open") return fail(`${under} is ${p.state} now: nothing was created. Reopen it, or pick another issue.`);
  } catch (e) {
    return fail(`Couldn't read ${under}: ${msg(e)}. Nothing was created.`);
  }
  let issue: RawIssue & { assignees?: { login: string }[] };
  try {
    issue = await ghe.rest(`/repos/${t.repo}/issues`, { method: "POST", body: { title: t.title, body: t.body, type: t.type, assignees: t.assignees } });
  } catch (e) {
    return fail(`Couldn't create the task in ${t.repo}: ${msg(e)}`);
  }
  const warnings: string[] = [];
  const typeWarning = await ensureType(ghe, issue, t.type, t.typeNodeId);
  if (typeWarning) warnings.push(typeWarning);
  const got = new Set((issue.assignees ?? []).map((a) => a.login));
  const dropped = t.assignees.filter((a) => !got.has(a));
  if (dropped.length) warnings.push(`Not assigned to ${dropped.join(", ")} (the forge dropped it: no push access to ${t.repo}?).`);
  let linked = true;
  try {
    await ghe.rest(`/repos/${t.parent.repo}/issues/${t.parent.number}/sub_issues`, { method: "POST", body: { sub_issue_id: issue.id } });
  } catch (e) {
    linked = false;
    warnings.push(`Created, but not hung under ${under} (${msg(e)}). Add it there by hand (Sub-issues → Add existing), or the planned issue won't count it.`);
  }
  const target = `${t.repo}#${issue.number}`;
  await logAction(db, { kind: "task.create", target, detail: `${t.type} · ${t.title} · under ${under}`, ok: true, error: warnings.join(" ") || undefined });
  return { ok: true, repo: t.repo, number: issue.number, url: issue.html_url, title: t.title, parent: t.parent, linked, warnings };
}
