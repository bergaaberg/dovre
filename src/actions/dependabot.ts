/**
 * Dependabot cleanup (dovre#108): the open Dependabot PRs across the owners' repos, and combining a
 * repo's into one PR. Combining re-checks GitHub first (still open, still Dependabot's), makes a
 * branch from the default branch, merges each PR's head into it in turn (one that conflicts is
 * skipped and listed), opens one PR that lists every bump, and logs either way. `addGroups` opens a
 * PR adding `groups:` to dependabot.yml, so Dependabot groups its bumps itself from then on.
 */
import type { D1 } from "../db.ts";
import { isMap, isSeq, parseDocument } from "yaml";
import { ownerQuery, owns } from "../owners.ts";
import type { Ghe } from "../sources/ghe.ts";
import { logAction } from "./deploys.ts";

export const DEPENDABOT = "dependabot[bot]";
/** At most this many PRs go into one combined PR (each is a merge on GitHub). */
export const MAX_COMBINE = 30;

export type BotPr = { repo: string; number: number; title: string; url: string; createdAt: string; security: boolean };
/** A combined PR Dovre opened: its checks (the head commit's rollup, null without any) and whether it can merge now. */
export type Combined = { number: number; url: string; checks: string | null; mergeable: string | null; draft: boolean };
/** Green, mergeable and not a draft: what may be ticked to merge. */
export const combinedReady = (c: Combined) => !c.draft && c.mergeable === "MERGEABLE" && c.checks === "SUCCESS";
export type RepoQueue = { repo: string; prs: BotPr[]; oldest: string; security: number; combined?: Combined };

/** The package a bump names: "Bump lodash from 4.17.20 to 4.17.21" → "lodash"; grouped bumps have none. */
export function bumpedPackage(title: string): string | undefined {
  return /\b[Bb]ump (\S+) from \S+ to \S+/.exec(title)?.[1]?.toLowerCase();
}

/** A Python package's name as PyPI compares it (PEP 503): "Typing_Extensions" and "typing-extensions" are one. */
export const pipName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

type SearchNode = {
  number?: number;
  title?: string;
  url?: string;
  createdAt?: string;
  headRefName?: string;
  isDraft?: boolean;
  mergeable?: string;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
  author?: { login: string } | null;
  repository?: { nameWithOwner: string } | null;
};
const q = (s: string) => JSON.stringify(s);

/**
 * The queue: every open Dependabot PR in the owners' repos, by repo, the ones with a security fix
 * first (an open Dependabot alert for the package it bumps; unknown when the token can't read alerts),
 * and the combined PRs Dovre opened that are still open.
 */
export async function loadQueue(ghe: Ghe, owners: string): Promise<{ repos: RepoQueue[]; alertsUnread: string[] }> {
  const d = await ghe.graphql<{ bots: { nodes: SearchNode[] }; mine: { nodes: SearchNode[] } }>(`{
    bots: search(query:${q(`is:pr is:open author:app/dependabot ${ownerQuery(owners)} archived:false sort:created-asc`)}, type:ISSUE, first:100){ nodes{ ... on PullRequest { number title url createdAt repository{nameWithOwner} } } }
    mine: search(query:${q(`is:pr is:open in:title \"Dependency updates\" ${ownerQuery(owners)} archived:false`)}, type:ISSUE, first:50){ nodes{ ... on PullRequest { number url headRefName isDraft mergeable repository{nameWithOwner} commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } } } } }
  }`);
  const by = new Map<string, BotPr[]>();
  for (const n of d.bots?.nodes ?? []) {
    const repo = n.repository?.nameWithOwner;
    if (!repo || typeof n.number !== "number" || !owns(owners, repo.split("/")[0]!)) continue;
    const list = by.get(repo) ?? [];
    list.push({ repo, number: n.number, title: String(n.title ?? ""), url: String(n.url ?? ""), createdAt: String(n.createdAt ?? ""), security: false });
    by.set(repo, list);
  }
  const alertsUnread: string[] = [];
  await Promise.all(
    [...by.keys()].slice(0, 30).map(async (repo) => {
      try {
        const alerts = await ghe.rest<{ dependency?: { package?: { name?: string; ecosystem?: string } } }[]>(`/repos/${repo}/dependabot/alerts?state=open&per_page=100`);
        const names = new Set(alerts.map((a) => a.dependency?.package?.name?.toLowerCase()).filter(Boolean));
        const pip = new Set(alerts.filter((a) => a.dependency?.package?.ecosystem === "pip").map((a) => pipName(a.dependency?.package?.name ?? "")).filter(Boolean));
        for (const p of by.get(repo)!) {
          const name = bumpedPackage(p.title) ?? "";
          p.security = !!name && (names.has(name) || pip.has(pipName(name)));
        }
      } catch {
        alertsUnread.push(repo);
      }
    }),
  );
  const combined = new Map<string, Combined>();
  for (const n of d.mine?.nodes ?? [])
    if (n.repository?.nameWithOwner && typeof n.number === "number" && n.headRefName?.startsWith(BRANCH))
      combined.set(n.repository.nameWithOwner, {
        number: n.number,
        url: String(n.url ?? ""),
        checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
        mergeable: n.mergeable ?? null,
        draft: n.isDraft === true,
      });
  const repos = [...by.entries()].map(([repo, prs]): RepoQueue => {
    prs.sort((a, b) => Number(b.security) - Number(a.security) || a.createdAt.localeCompare(b.createdAt));
    return { repo, prs, oldest: prs.reduce((m, p) => (p.createdAt < m ? p.createdAt : m), prs[0]!.createdAt), security: prs.filter((p) => p.security).length, combined: combined.get(repo) };
  });
  repos.sort((a, b) => b.security - a.security || b.prs.length - a.prs.length || a.repo.localeCompare(b.repo));
  return { repos, alertsUnread: alertsUnread.sort() };
}

type RawPull = { number: number; title: string; html_url: string; state: string; created_at: string; user: { login: string; type: string } | null; head: { sha: string; ref: string; repo: { full_name: string } | null } };

export type CombineResult = { ok: boolean; message: string; url?: string; merged?: number[]; skipped?: { number: number; why: string }[] };

/** The branches combine() opens its PRs from. */
export const BRANCH = "dovre/dependabot-";

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function combinedBody(merged: RawPull[], skipped: { pr: RawPull; why: string }[], security: Set<number>): string {
  const line = (p: RawPull) => `- #${p.number} ${p.title.replace(/[\r\n]+/g, " ")}`;
  const sec = merged.filter((p) => security.has(p.number));
  const rest = merged.filter((p) => !security.has(p.number));
  return [
    `Combines ${merged.length} Dependabot PR${merged.length === 1 ? "" : "s"} into one.`,
    ...(sec.length ? ["", `**Security fixes (${sec.length})**`, ...sec.map(line)] : []),
    "",
    sec.length ? `**Other bumps (${rest.length})**` : "**Bumps**",
    ...rest.map(line),
    ...(skipped.length ? ["", `**Left out (${skipped.length})**: merge or recreate these on their own.`, ...skipped.map(({ pr, why }) => `${line(pr)} (${why})`)] : []),
    "",
    "When this merges, Dependabot closes the originals itself on its next run.",
    "",
    "Opened by Dovre.",
  ].join("\n");
}

/**
 * Combines the repo's open Dependabot PRs (all of them, or the `only` numbers) into one PR.
 * `security`: the numbers the queue saw a security fix in, so the body says so first.
 */
export async function combine(ghe: Ghe, db: D1, repo: string, opts: { only?: number[]; security?: number[]; now?: Date } = {}): Promise<CombineResult> {
  const now = opts.now ?? new Date();
  const fail = async (message: string, error?: string) => {
    await logAction(db, { kind: "pr.combine-dependabot", target: repo, ok: false, error: error ?? message });
    return { ok: false, message };
  };
  let branch: string | undefined;
  try {
    const open = await ghe.rest<RawPull[]>(`/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc`);
    const only = opts.only ? new Set(opts.only) : undefined;
    const bots = open.filter((p) => p.state === "open" && p.user?.login === DEPENDABOT && p.user.type === "Bot" && p.head.repo?.full_name === repo && (!only || only.has(p.number))).slice(0, MAX_COMBINE);
    if (bots.length < 2) return fail(bots.length ? `Only one open Dependabot PR in ${repo}: nothing to combine.` : `No open Dependabot PRs in ${repo} now.`);
    const info = await ghe.rest<{ default_branch: string }>(`/repos/${repo}`);
    const base = info.default_branch;
    const ref = await ghe.rest<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    branch = `${BRANCH}${stamp(now)}`;
    await ghe.rest(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: ref.object.sha } });
    const merged: RawPull[] = [];
    const skipped: { pr: RawPull; why: string }[] = [];
    for (const p of bots) {
      try {
        await ghe.rest(`/repos/${repo}/merges`, { method: "POST", body: { base: branch, head: p.head.sha, commit_message: `Merge #${p.number}: ${p.title}` } });
        merged.push(p);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        skipped.push({ pr: p, why: /: 409 /.test(msg) ? "conflicts" : "couldn't merge" });
      }
    }
    if (!merged.length) {
      await ghe.rest(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => {});
      return fail(`None of the ${bots.length} Dependabot PRs in ${repo} merged cleanly onto ${base}: left alone.`);
    }
    const pr = await ghe.rest<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, {
      method: "POST",
      body: { title: `Dependency updates (${merged.length})`, head: branch, base, body: combinedBody(merged, skipped, new Set(opts.security ?? [])) },
    });
    const detail = `#${pr.number} from ${merged.map((p) => `#${p.number}`).join(" ")}${skipped.length ? `; left out ${skipped.map((s) => `#${s.pr.number}`).join(" ")}` : ""}`;
    await logAction(db, { kind: "pr.combine-dependabot", target: repo, detail, ok: true });
    return {
      ok: true,
      message: `Opened ${repo}#${pr.number} with ${merged.length} bump${merged.length === 1 ? "" : "s"}${skipped.length ? `; ${skipped.length} left out (${skipped.map((s) => `#${s.pr.number} ${s.why}`).join(", ")})` : ""}.`,
      url: pr.html_url,
      merged: merged.map((p) => p.number),
      skipped: skipped.map((s) => ({ number: s.pr.number, why: s.why })),
    };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    if (branch) await ghe.rest(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => {});
    return fail(`Couldn't combine the Dependabot PRs in ${repo}: ${error}`, error);
  }
}

/** How many combined PRs one bulk merge takes. */
export const MAX_MERGE = 20;

/**
 * Merges a combined PR Dovre opened, once green (dovre#108, bulk via #104): re-read now, still open,
 * from one of combine()'s branches in the repo itself, mergeable, its head's checks all passed, and
 * merged at that head only (a push since is refused by GitHub). Squashed, so main gets one commit.
 */
export async function mergeCombined(ghe: Ghe, db: D1, repo: string, number: number): Promise<CombineResult> {
  const target = `${repo}#${number}`;
  const fail = async (message: string, error?: string) => {
    await logAction(db, { kind: "pr.merge-combined", target, ok: false, error: error ?? message });
    return { ok: false, message: `${target}: ${message}` };
  };
  try {
    const pr = await ghe.rest<RawPull & { mergeable: boolean | null; draft?: boolean; merged?: boolean }>(`/repos/${repo}/pulls/${number}`);
    if (pr.state !== "open") return fail(pr.merged ? "already merged." : "it's closed.");
    if (!pr.head.ref.startsWith(BRANCH) || pr.head.repo?.full_name !== repo) return fail("not a combined PR Dovre opened.");
    if (pr.draft) return fail("it's a draft.");
    if (pr.mergeable === null) return fail("GitHub is still working out whether it merges; try again in a moment.");
    if (!pr.mergeable) return fail("it doesn't merge cleanly.");
    const [owner, name] = repo.split("/");
    const c = await ghe.graphql<{ repository?: { object?: { statusCheckRollup?: { state?: string } | null } | null } | null }>(
      `{ repository(owner:${q(owner!)}, name:${q(name!)}){ object(oid:${q(pr.head.sha)}){ ... on Commit { statusCheckRollup{ state } } } } }`,
    );
    const checks = c.repository?.object?.statusCheckRollup?.state ?? null;
    if (checks !== "SUCCESS") return fail(checks ? `its checks are ${checks.toLowerCase()}.` : "no checks ran on it.");
    await ghe.rest(`/repos/${repo}/pulls/${number}/merge`, { method: "PUT", body: { sha: pr.head.sha, merge_method: "squash" } });
    await logAction(db, { kind: "pr.merge-combined", target, detail: pr.head.sha.slice(0, 7), ok: true });
    return { ok: true, message: `Merged ${target}.`, url: pr.html_url };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    return fail(`couldn't merge: ${error.slice(0, 200)}`, error);
  }
}

// ── Stop it at the source: Dependabot groups its own bumps from then on ──

const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const toB64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));

/** The group added to an update entry that has none: its minor and patch bumps in one PR. */
export const GROUP = { "minor-and-patch": { patterns: ["*"], "update-types": ["minor", "patch"] } };

/**
 * dependabot.yml with `groups:` added to each update entry that has none (comments kept).
 * `added` names the entries' ecosystems; empty when every entry is grouped already.
 */
export function withGroups(text: string): { text: string; added: string[] } {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`dependabot.yml doesn't parse: ${doc.errors[0]!.message.split("\n")[0]}`);
  const updates = doc.get("updates");
  if (!isSeq(updates)) throw new Error("dependabot.yml has no updates: list");
  const added: string[] = [];
  for (const item of updates.items) {
    if (!isMap(item) || item.has("groups")) continue;
    item.set("groups", doc.createNode(GROUP));
    added.push(String(item.get("package-ecosystem") ?? "?"));
  }
  return { text: added.length ? doc.toString() : text, added };
}

/** Opens a PR adding `groups:` to the repo's .github/dependabot.yml, so Dependabot opens grouped PRs itself. */
export async function addGroups(ghe: Ghe, db: D1, repo: string, now = new Date()): Promise<CombineResult> {
  const fail = async (message: string, error?: string) => {
    await logAction(db, { kind: "pr.dependabot-groups", target: repo, ok: false, error: error ?? message });
    return { ok: false, message };
  };
  let branch: string | undefined;
  try {
    const info = await ghe.rest<{ default_branch: string }>(`/repos/${repo}`);
    const base = info.default_branch;
    let file: { path: string; sha: string; content: string } | undefined;
    for (const path of [".github/dependabot.yml", ".github/dependabot.yaml"]) {
      file = await ghe.rest<{ sha: string; content: string }>(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`).then(
        (f) => ({ path, sha: f.sha, content: f.content }),
        (e) => (/: 404\b/.test(String((e as Error)?.message ?? e)) ? undefined : Promise.reject(e)),
      );
      if (file) break;
    }
    if (!file) return fail(`${repo} has no .github/dependabot.yml: its bumps are security updates only, which Dependabot doesn't group this way.`);
    const { text, added } = withGroups(fromB64(file.content));
    if (!added.length) return fail(`Every update in ${repo}'s ${file.path} has groups already.`);
    const ref = await ghe.rest<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    branch = `dovre/dependabot-groups-${stamp(now)}`;
    await ghe.rest(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: ref.object.sha } });
    await ghe.rest(`/repos/${repo}/contents/${file.path}`, { method: "PUT", body: { message: "Group Dependabot's minor and patch bumps", content: toB64(text), sha: file.sha, branch } });
    const pr = await ghe.rest<{ number: number; html_url: string }>(`/repos/${repo}/pulls`, {
      method: "POST",
      body: {
        title: "Group Dependabot's minor and patch bumps",
        head: branch,
        base,
        body: [
          `Adds a \`minor-and-patch\` group to ${added.length === 1 ? "the" : `${added.length}`} update ${added.length === 1 ? "entry" : "entries"} in \`${file.path}\` (${added.join(", ")}).`,
          "",
          "From then on Dependabot opens one PR per ecosystem for those bumps; major bumps and security updates still come one by one.",
          "",
          "Opened by Dovre.",
        ].join("\n"),
      },
    });
    await logAction(db, { kind: "pr.dependabot-groups", target: repo, detail: `#${pr.number}: ${added.join(", ")}`, ok: true });
    return { ok: true, message: `Opened ${repo}#${pr.number}: Dependabot groups minor and patch bumps (${added.join(", ")}) once it merges.`, url: pr.html_url };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    if (branch) await ghe.rest(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" }).catch(() => {});
    return fail(`Couldn't add groups to ${repo}'s dependabot.yml: ${error}`, error);
  }
}
