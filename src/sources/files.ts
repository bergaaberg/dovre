/**
 * Read-only files from the owners' repos, for packs (PackContext.forge, #139): which repos there
 * are, and one file's text. Health reads each repo's peak.yaml with these, locally and hosted.
 * Only repos of REPO_OWNERS are read; a path is a plain relative one. Answers are kept a few minutes.
 */
import type { D1 } from "../db.ts";
import type { ForgeShipped } from "../forge/types.ts";
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
export async function loadFile(ghe: Ghe, repo: string, path: string, at?: string): Promise<string | undefined> {
  let j: { type?: string; encoding?: string; content?: string; size?: number };
  try {
    j = await ghe.rest(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${at ? `?ref=${at}` : ""}`);
  } catch (e) {
    if (/: 404 /.test(String((e as Error)?.message ?? e))) return undefined;
    throw e;
  }
  if (j?.type !== "file" || j.encoding !== "base64" || typeof j.content !== "string" || (j.size ?? 0) > MAX_FILE) return undefined;
  return decode(j.content);
}

/** A repo with the asked files it has (path → text), from `loadEveryRepo`. */
export type RepoFiles = { repo: string; /** Its last push (ISO). */ pushedAt?: string; files: Record<string, string> };
/** Every repo's files at some paths, and when that was read (ms). */
export type EveryRepo = { at: number; repos: RepoFiles[] };
/** Paths asked in one go, at most. */
const MAX_PATHS = 6;

type BlobNode = { text?: string | null; byteSize?: number; isBinary?: boolean | null } | null;
type RepoNode = { nameWithOwner: string; pushedAt?: string | null } & Record<string, BlobNode | string | null | undefined>;

/**
 * Each of the owners' repos (not archived, most recently pushed first, 100 per owner) with its
 * files at `paths` on the default branch: one GraphQL call per owner, where a file a time would be
 * a REST call per repo and path (#294). A file that's missing, binary or too big is left out.
 */
export async function loadEveryRepo(ghe: Ghe, owners: string, paths: string[]): Promise<RepoFiles[]> {
  const ps = paths.map(repoPath).filter((p): p is string => !!p).slice(0, MAX_PATHS);
  const fields = ps.map((p, i) => `f${i}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text byteSize isBinary } }`).join(" ");
  const out: RepoFiles[] = [];
  for (const o of ownersOf(owners)) {
    // ownersOf keeps plain logins only, so `o` is safe inside the query.
    const d = await ghe.graphql<{ repositoryOwner: { repositories: { nodes: RepoNode[] } } | null }>(
      `{ repositoryOwner(login: "${o}") { repositories(first: 100, isArchived: false, orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { nameWithOwner pushedAt ${fields} } } } }`,
    );
    for (const n of d.repositoryOwner?.repositories.nodes ?? []) {
      if (!ownedRepo(owners, n.nameWithOwner)) continue;
      const files: Record<string, string> = {};
      ps.forEach((p, i) => {
        const b = n[`f${i}`] as BlobNode | undefined;
        if (b && typeof b.text === "string" && !b.isBinary && (b.byteSize ?? 0) <= MAX_FILE) files[p] = b.text;
      });
      out.push({ repo: n.nameWithOwner, ...(n.pushedAt ? { pushedAt: n.pushedAt } : {}), files });
    }
  }
  return out;
}

/** Where pack reads are kept for every isolate (hosted) or the process (local): D1's forge_reads. */
export type SharedReads = { get(key: string): Promise<{ at: number; value: string } | undefined>; put(key: string, at: number, value: string): Promise<void> };

/** The largest answer kept in D1 (a row holds 2 MB). */
const MAX_SHARED = 1_500_000;
/** How long D1 keeps an answer at all. */
const KEEP_SHARED = 2 * 24 * 3600_000;

/** forge_reads in D1. Writes also drop answers older than two days. */
export function d1Reads(db: D1, now: () => number = Date.now): SharedReads {
  return {
    async get(key) {
      const r = await db.prepare("SELECT at, value FROM forge_reads WHERE key = ?").bind(key).first<{ at: number; value: string }>();
      return r ?? undefined;
    },
    async put(key, at, value) {
      if (value.length > MAX_SHARED) return;
      await db.batch([
        db.prepare("INSERT INTO forge_reads (key, at, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value").bind(key, at, value),
        db.prepare("DELETE FROM forge_reads WHERE at < ?").bind(now() - KEEP_SHARED),
      ]);
    },
  };
}

/** A full commit SHA, the only ref a pack reads a file at. */
const SHA = /^[0-9a-fA-F]{40}$/;

/** A PR as a pack reads it: its two ends and the paths it changes (`status`: added, removed, modified, renamed…). */
export type ForgePr = { head: { ref: string; sha: string }; base: { ref: string; sha: string }; files: { path: string; status: string }[] };
/** The most changed files a PR read gives. */
const MAX_PR_FILES = 300;

/** A PR's ends and changed paths; undefined when it isn't one (or isn't visible). */
export async function loadPr(ghe: Ghe, repo: string, n: number): Promise<ForgePr | undefined> {
  let pr: { head?: { ref?: unknown; sha?: unknown }; base?: { ref?: unknown; sha?: unknown } };
  try {
    pr = await ghe.rest(`/repos/${repo}/pulls/${n}`);
  } catch (e) {
    if (/: 404 /.test(String((e as Error)?.message ?? e))) return undefined;
    throw e;
  }
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 255) : "");
  const head = { ref: str(pr?.head?.ref), sha: str(pr?.head?.sha) };
  const base = { ref: str(pr?.base?.ref), sha: str(pr?.base?.sha) };
  if (!head.ref || !SHA.test(head.sha) || !base.ref || !SHA.test(base.sha)) return undefined;
  const files: ForgePr["files"] = [];
  for (let page = 1; files.length < MAX_PR_FILES && page <= 3; page++) {
    const got = await ghe.rest<unknown[]>(`/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
    if (!Array.isArray(got)) break;
    for (const f of got as { filename?: unknown; status?: unknown }[]) if (typeof f?.filename === "string" && f.filename.length <= 1000) files.push({ path: f.filename, status: str(f.status).slice(0, 20) });
    if (got.length < 100) break;
  }
  return { head, base, files: files.slice(0, MAX_PR_FILES) };
}

/** The files (not folders) directly in a repo's folder at a commit, as repo paths; none when it isn't one. */
export async function loadDir(ghe: Ghe, repo: string, path: string, at: string): Promise<string[]> {
  let got: unknown;
  try {
    got = await ghe.rest(`/repos/${repo}/contents/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}?ref=${at}`);
  } catch (e) {
    if (/: 404 /.test(String((e as Error)?.message ?? e))) return [];
    throw e;
  }
  return Array.isArray(got) ? (got as { type?: unknown; path?: unknown }[]).filter((x) => x?.type === "file" && typeof x.path === "string" && !!repoPath(x.path)).map((x) => x.path as string).slice(0, 1000) : [];
}

/** How far back a pack may ask what shipped. */
export const MAX_SHIPPED_DAYS = 92;

/** The longest a pack may take an every-repo read to be. */
const MAX_AGE = 24 * 3600_000;

type Source = {
  repos?(owners: string): Promise<string[]>;
  untriaged?(owners: string): Promise<Record<string, number>>;
  shipped?(owners: string, since: string): Promise<ForgeShipped>;
  file?(repo: string, path: string, at?: string): Promise<string | undefined>;
  everyRepo?(owners: string, paths: string[]): Promise<RepoFiles[]>;
  pr?(repo: string, n: number): Promise<ForgePr | undefined>;
  dir?(repo: string, path: string, at: string): Promise<string[]>;
};

/**
 * Reads for packs: checked against the owners, each answer kept `ttlMs` (a failure isn't kept).
 * With `shared` (D1), an answer one isolate read is what the others get too, until it's too old:
 * without it each Worker isolate read everything again (#294).
 */
export function packReads(f: Source, owners: () => string, o: { ttlMs?: number; now?: () => number; shared?: SharedReads } = {}) {
  const ttl = o.ttlMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  /** In this isolate: the answer and when it was read (where it was read, maybe another isolate). */
  const kept = new Map<string, { at: number; p: Promise<{ at: number; value: unknown }> }>();
  const cached = <T>(key: string, load: () => Promise<T>, maxAge = ttl): Promise<{ at: number; value: T }> => {
    const k = kept.get(key);
    if (k && now() - k.at < maxAge) return k.p as Promise<{ at: number; value: T }>;
    if (kept.size >= 500) kept.clear();
    const entry = { at: now(), p: undefined as unknown as Promise<{ at: number; value: T }> };
    entry.p = (async () => {
      const s = maxAge > 0 ? await o.shared?.get(key).catch(() => undefined) : undefined;
      if (s && now() - s.at < maxAge) {
        try {
          const got = { at: s.at, value: (JSON.parse(s.value) as { v: T }).v };
          entry.at = s.at;
          return got;
        } catch {}
      }
      const value = await load();
      const at = now();
      entry.at = at;
      await o.shared?.put(key, at, JSON.stringify({ v: value })).catch(() => undefined);
      return { at, value };
    })();
    kept.set(key, entry as { at: number; p: Promise<{ at: number; value: unknown }> });
    entry.p.catch(() => kept.get(key) === entry && kept.delete(key));
    return entry.p;
  };
  return {
    ...(f.repos ? { repos: async () => (await cached(`repos:${owners()}`, () => f.repos!(owners()))).value } : {}),
    ...(f.untriaged ? { untriaged: async () => (await cached(`untriaged:${owners()}`, () => f.untriaged!(owners()))).value } : {}),
    ...(f.shipped
      ? {
          shipped: async (since: string) => {
            // A day, so every pack asking for the same window gets the one kept answer.
            const t = typeof since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(`${since}T00:00:00Z`) : NaN;
            if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== since || t > now() || Math.floor(now() / 86_400_000) - t / 86_400_000 > MAX_SHIPPED_DAYS) throw new Error(`Not a day to read from: YYYY-MM-DD, ${MAX_SHIPPED_DAYS} days back at most`);
            return (await cached(`shipped:${owners()}:${since}`, () => f.shipped!(owners(), since))).value;
          },
        }
      : {}),
    ...(f.file
      ? {
          file: async (repo: string, path: string, at?: string) => {
            const r = ownedRepo(owners(), repo);
            const p = repoPath(path);
            if (!r || !p) throw new Error(`Not a file in your repos: ${String(repo).slice(0, 100)}/${String(path).slice(0, 100)}`);
            if (at !== undefined && !SHA.test(at)) throw new Error("Not a commit: a full SHA (40 hex)");
            const sha = at?.toLowerCase();
            // A file at a commit never changes: kept as long as the cache keeps anything.
            return (await cached(`file:${r.toLowerCase()}:${p}${sha ? `@${sha}` : ""}`, () => f.file!(r, p, sha), sha ? MAX_AGE : undefined)).value;
          },
        }
      : {}),
    ...(f.pr
      ? {
          // A PR moves: kept a minute.
          pr: async (repo: string, n: number) => {
            const r = ownedRepo(owners(), repo);
            if (!r || !Number.isSafeInteger(n) || n < 1) throw new Error(`Not a PR in your repos: ${String(repo).slice(0, 100)}#${String(n).slice(0, 20)}`);
            return (await cached(`pr:${r.toLowerCase()}#${n}`, () => f.pr!(r, n), Math.min(ttl, 60_000))).value;
          },
        }
      : {}),
    ...(f.dir
      ? {
          dir: async (repo: string, path: string, at: string) => {
            const r = ownedRepo(owners(), repo);
            const p = path === "" ? "" : repoPath(path);
            if (!r || p === undefined) throw new Error(`Not a folder in your repos: ${String(repo).slice(0, 100)}/${String(path).slice(0, 100)}`);
            if (!SHA.test(at)) throw new Error("Not a commit: a full SHA (40 hex)");
            const sha = at.toLowerCase();
            // A folder at a commit never changes.
            return (await cached(`dir:${r.toLowerCase()}:${p}@${sha}`, () => f.dir!(r, p, sha), MAX_AGE)).value;
          },
        }
      : {}),
    ...(f.everyRepo
      ? {
          everyRepo: async (paths: string[], q: { maxAgeMs?: number } = {}): Promise<EveryRepo> => {
            const ps = paths.map(repoPath);
            if (!ps.length || ps.length > MAX_PATHS || ps.some((p) => !p)) throw new Error(`Not paths to read: 1 to ${MAX_PATHS} plain relative paths`);
            const maxAge = Math.max(0, Math.min(MAX_AGE, q.maxAgeMs ?? ttl));
            const sorted = [...new Set(ps as string[])].sort();
            const got = await cached(`every:${owners()}:${sorted.join(",")}`, () => f.everyRepo!(owners(), sorted), maxAge);
            return { at: got.at, repos: got.value };
          },
        }
      : {}),
  };
}
