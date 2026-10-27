/**
 * Read-only files from the owners' repos, for packs (PackContext.forge, #139): which repos there
 * are, and one file's text. Health reads each repo's peak.yaml with these, locally and hosted.
 * Only repos of REPO_OWNERS are read; a path is a plain relative one. Answers are kept a few minutes.
 */
import type { Ghe } from "./ghe.ts";
import { owns, ownersOf } from "../owners.ts";

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const PATH = /^[\w.-]+(\/[\w.-]+)*$/;
/** The largest file handed to a pack. */
export const MAX_FILE = 512 * 1024;

/** A repo name as `owner/name` of one of the owners, or undefined. */
export function ownedRepo(owners: string, repo: unknown): string | undefined {
  if (typeof repo !== "string" || !REPO.test(repo)) return undefined;
  const [owner, name] = repo.split("/") as [string, string];
  return owns(owners, owner) && name !== "." && name !== ".." ? repo : undefined;
}

/** A path inside a repo: relative, plain names, no `.` or `..` parts, at most 300 characters. */
export function repoPath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length > 300 || !PATH.test(path)) return undefined;
  return path.split("/").some((p) => p === "." || p === "..") ? undefined : path;
}

/** The owners' repos that aren't archived, most recently pushed first, at most 100 per owner. */
export async function loadRepos(ghe: Ghe, owners: string): Promise<string[]> {
  const out: string[] = [];
  for (const o of ownersOf(owners)) {
    // ownersOf keeps plain logins only, so `o` is safe inside the query.
    const d = await ghe.graphql<{ repositoryOwner: { repositories: { nodes: { nameWithOwner: string }[] } } | null }>(
      `{ repositoryOwner(login: "${o}") { repositories(first: 100, isArchived: false, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner } } } }`,
    );
    for (const n of d.repositoryOwner?.repositories.nodes ?? []) if (ownedRepo(owners, n.nameWithOwner)) out.push(n.nameWithOwner);
  }
  return out;
}

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

/** One file's text on the default branch; undefined when there's none (or it's a folder, or too big). */
export async function loadFile(ghe: Ghe, repo: string, path: string): Promise<string | undefined> {
  let j: { type?: string; encoding?: string; content?: string; size?: number };
  try {
    j = await ghe.rest(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  } catch (e) {
    if (/: 404 /.test(String((e as Error)?.message ?? e))) return undefined;
    throw e;
  }
  if (j?.type !== "file" || j.encoding !== "base64" || typeof j.content !== "string" || (j.size ?? 0) > MAX_FILE) return undefined;
  return decode(j.content);
}

/** Reads for packs: checked against the owners, each answer kept `ttlMs` (a failure isn't kept). */
export function packReads(f: { repos?(owners: string): Promise<string[]>; file?(repo: string, path: string): Promise<string | undefined> }, owners: () => string, o: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = o.ttlMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  const kept = new Map<string, { at: number; p: Promise<unknown> }>();
  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const k = kept.get(key);
    if (k && now() - k.at < ttl) return k.p as Promise<T>;
    if (kept.size >= 500) kept.clear();
    const p = load();
    kept.set(key, { at: now(), p });
    p.catch(() => kept.get(key)?.p === p && kept.delete(key));
    return p;
  };
  return {
    ...(f.repos ? { repos: () => cached(`repos:${owners()}`, () => f.repos!(owners())) } : {}),
    ...(f.file
      ? {
          file: async (repo: string, path: string) => {
            const r = ownedRepo(owners(), repo);
            const p = repoPath(path);
            if (!r || !p) throw new Error(`Not a file in your repos: ${String(repo).slice(0, 100)}/${String(path).slice(0, 100)}`);
            return cached(`file:${r.toLowerCase()}:${p}`, () => f.file!(r, p));
          },
        }
      : {}),
  };
}
