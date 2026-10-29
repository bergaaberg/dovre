/**
 * Copied packs and where they came from (#152). `pnpm packs add` copies a pack out of a dovre-packs
 * checkout and writes `.pack.json` beside it: the source repo, its commit and version, the pack's
 * PACK_API, and a SHA-256 per file as copied. From that:
 *
 *   pnpm packs outdated            each copied pack: up to date, newer upstream, edited here
 *   pnpm packs update <id>|--all   take upstream's files; a file edited here and upstream is merged
 *                                  3-way (git merge-file, base = the recorded commit's version)
 *   pnpm packs track <id> [--at c] write .pack.json for a pack copied before there was one
 *
 * An update reads only the local checkout (pull it first), works it all out in memory, and writes
 * nothing if any file conflicts. It refuses a pack that needs a newer PACK_API than this core and a
 * source outside REPO_OWNERS (bergaaberg/dovre-packs, where packs come from, is always allowed).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { owns } from "../owners.ts";
import { PACK_API } from "./types.ts";

export const META = ".pack.json";
const HOME_SOURCE = "bergaaberg/dovre-packs";

export type PackMeta = {
  /** `owner/repo` on GitHub, from the checkout's origin; null when it has none. */
  source: string | null;
  /** The checkout's commit when copied; null outside git. */
  commit: string | null;
  /** dovre-packs' package.json version. */
  version: string | null;
  /** The PACK_API the pack was written for. */
  api: number;
  /** SHA-256 per file as copied, by path inside the pack. */
  files: Record<string, string>;
};

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function git(repo: string, args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : undefined;
}

function gitShow(repo: string, commit: string, path: string): Buffer | undefined {
  const r = spawnSync("git", ["-C", repo, "show", `${commit}:${path}`], { maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : undefined;
}

/**
 * Every file under `dir`, as paths relative to it; `.pack.json` and node_modules left out. In a git
 * checkout, only files git would keep (tracked, or new and not ignored), so build output such as a
 * Rust `target/` isn't copied.
 */
export function filesOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const listed = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
  if (listed !== undefined) {
    return [...new Set(listed.split("\0").filter(Boolean))]
      .filter((f) => f !== META && !f.split("/").includes("node_modules") && existsSync(join(dir, f)))
      .sort();
  }
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      if (f === "node_modules" || f === ".git") continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!(d === dir && f === META)) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

const hashes = (dir: string): Record<string, string> => Object.fromEntries(filesOf(dir).map((f) => [f, sha(readFileSync(join(dir, f)))]));

/** `owner/repo` from a GitHub remote URL (https or ssh). */
export function sourceOfUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where pack `<id>` lives in a dovre-packs checkout (packs/, or crates/ in old ones), as a path inside it. */
export function upstreamPath(repo: string, id: string): string | undefined {
  for (const sub of ["packs", "crates"]) if (existsSync(join(repo, sub, id, "index.ts"))) return `${sub}/${id}`;
  return undefined;
}

/** Where an instance keeps pack `<id>`: packs/, or crates/ in an instance that still has crates.ts. */
export function instancePath(into: string, id: string): string {
  const crates = existsSync(join(into, "crates.ts")) && !existsSync(join(into, "packs.ts"));
  return join(into, crates ? "crates" : "packs", id);
}

/** The PACK_API a pack needs: a literal `api: 2` in its index.ts, else the core its checkout links. */
export function apiOf(repo: string, packDir: string): number {
  const own = readFileSync(join(packDir, "index.ts"), "utf8").match(/\bapi:\s*(\d+)/);
  if (own) return Number(own[1]);
  const linked = join(repo, "node_modules", "dovre", "src", "packs", "types.ts");
  const m = existsSync(linked) ? readFileSync(linked, "utf8").match(/PACK_API\s*=\s*(\d+)/) : null;
  return m ? Number(m[1]) : PACK_API;
}

function versionOf(repo: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

const sourceOf = (repo: string) => sourceOfUrl(git(repo, ["remote", "get-url", "origin"]) ?? "");
const headOf = (repo: string) => git(repo, ["rev-parse", "HEAD"])?.trim() || null;

/** The `.pack.json` for pack `<id>` as it is in the checkout now. */
export function provenance(repo: string, id: string): PackMeta {
  const at = upstreamPath(repo, id);
  if (!at) throw new Error(`Pack "${id}" isn't in ${repo}`);
  return { source: sourceOf(repo), commit: headOf(repo), version: versionOf(repo), api: apiOf(repo, join(repo, at)), files: hashes(join(repo, at)) };
}

export function writeMeta(dir: string, meta: PackMeta): void {
  writeFileSync(join(dir, META), JSON.stringify(meta, null, 2) + "\n");
}

export function readMeta(dir: string): PackMeta | undefined {
  const p = join(dir, META);
  if (!existsSync(p)) return undefined;
  const m = JSON.parse(readFileSync(p, "utf8")) as PackMeta;
  if (!m || typeof m.files !== "object") throw new Error(`${p} isn't a pack record`);
  return m;
}

/** Sources an update may come from: dovre-packs itself, or a repo of an owner in REPO_OWNERS. */
export function sourceAllowed(source: string | null, env: Record<string, string | undefined> = process.env): boolean {
  if (!source) return false;
  if (source.toLowerCase() === HOME_SOURCE) return true;
  return owns(env.REPO_OWNERS || env.GHE_ORG || env.GITHUB_USER, source.split("/")[0]!);
}

export type PackState = {
  id: string;
  /** Has a `.pack.json`. */
  tracked: boolean;
  /** No longer in the checkout. */
  gone?: boolean;
  /** Commits touching the pack since the recorded one; null when git can't say. */
  behind?: number | null;
  /** Files upstream changed, added or removed since the recorded copy. */
  upstream: string[];
  /** Files changed, added or removed here since the copy. */
  edited: string[];
};

const changed = (base: Record<string, string>, now: Record<string, string>) =>
  [...new Set([...Object.keys(base), ...Object.keys(now)])].filter((f) => base[f] !== now[f]).sort();

/** Each pack folder in the instance, against the checkout (no network: pull dovre-packs first). */
export function outdated(into: string, repo: string): PackState[] {
  const root = dirname(instancePath(into, "x"));
  if (!existsSync(root)) return [];
  const ids = readdirSync(root).filter((f) => statSync(join(root, f)).isDirectory() && existsSync(join(root, f, "index.ts"))).sort();
  const out: PackState[] = [];
  for (const id of ids) {
    const dir = join(root, id);
    const meta = readMeta(dir);
    const at = upstreamPath(repo, id);
    if (!meta) {
      if (at) out.push({ id, tracked: false, upstream: [], edited: [] });
      continue;
    }
    const edited = changed(meta.files, hashes(dir));
    if (!at) {
      out.push({ id, tracked: true, gone: true, upstream: [], edited });
      continue;
    }
    const upstream = changed(meta.files, hashes(join(repo, at)));
    const count = meta.commit ? git(repo, ["rev-list", "--count", `${meta.commit}..HEAD`, "--", at]) : undefined;
    out.push({ id, tracked: true, behind: count === undefined ? null : Number(count.trim()), upstream, edited });
  }
  return out;
}

/** One line per pack for `pnpm packs outdated`. */
export function describe(s: PackState): string {
  if (!s.tracked) return `${s.id}: copied before .pack.json (pnpm packs track ${s.id})`;
  const here = s.edited.length ? `edited here: ${s.edited.join(", ")}` : "";
  if (s.gone) return `${s.id}: no longer in dovre-packs${here ? `; ${here}` : ""}`;
  const parts: string[] = [];
  if (s.upstream.length) parts.push(`newer upstream${s.behind ? ` (${s.behind} commit${s.behind === 1 ? "" : "s"})` : ""}: ${s.upstream.join(", ")}`);
  if (here) parts.push(here);
  return `${s.id}: ${parts.join("; ") || "up to date"}`;
}

export type FileChange = { file: string; how: "updated" | "added" | "removed" | "merged" };
export type UpdateResult = { id: string; changes: FileChange[]; kept: string[]; from: string | null; to: string | null };

function merge3(here: Buffer, base: Buffer, up: Buffer): Buffer | undefined {
  const tmp = mkdtempSync(join(tmpdir(), "dovre-merge-"));
  try {
    const [h, b, u] = ["here", "base", "upstream"].map((n) => join(tmp, n)) as [string, string, string];
    writeFileSync(h, here);
    writeFileSync(b, base);
    writeFileSync(u, up);
    const r = spawnSync("git", ["merge-file", "-p", "-L", "here", "-L", "base", "-L", "upstream", h, b, u], { maxBuffer: 64 << 20 });
    return r.status === 0 ? r.stdout : undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Brings pack `<id>` up to the checkout. A file unchanged here takes upstream's version (new and
 * removed files too); edited here only, it stays; edited both sides, it's merged 3-way. Any
 * conflict throws before a single file is written.
 */
export function updatePack(o: { id: string; into: string; repo: string; env?: Record<string, string | undefined> }): UpdateResult {
  const dir = instancePath(o.into, o.id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`${o.id} has no ${META}: run pnpm packs track ${o.id} first`);
  if (!sourceAllowed(meta.source, o.env)) throw new Error(`${o.id} came from ${meta.source ?? "an unknown source"}, which isn't dovre-packs or an owner in REPO_OWNERS`);
  const source = sourceOf(o.repo);
  if (source?.toLowerCase() !== meta.source?.toLowerCase()) throw new Error(`${o.repo} is ${source ?? "not a GitHub checkout"}, but ${o.id} came from ${meta.source}`);
  const at = upstreamPath(o.repo, o.id);
  if (!at) throw new Error(`${o.id} is no longer in ${o.repo}`);
  if (git(o.repo, ["status", "--porcelain", "--", at])?.trim()) throw new Error(`${o.repo} has uncommitted changes in ${at}: commit or stash them first`);
  const upDir = join(o.repo, at);
  const api = apiOf(o.repo, upDir);
  if (api > PACK_API) throw new Error(`${o.id} upstream needs PACK_API ${api}; this core has ${PACK_API}. Update Dovre first.`);

  const local = hashes(dir);
  const up = hashes(upDir);
  const base = meta.files;
  const writes = new Map<string, Buffer>();
  const removes: string[] = [];
  const changes: FileChange[] = [];
  const kept: string[] = [];
  const conflicts: string[] = [];
  for (const f of [...new Set([...Object.keys(local), ...Object.keys(up), ...Object.keys(base)])].sort()) {
    const [l, u, b] = [local[f], up[f], base[f]];
    if (l === u) continue;
    if (l === b) {
      if (u === undefined) {
        removes.push(f);
        changes.push({ file: f, how: "removed" });
      } else {
        writes.set(f, readFileSync(join(upDir, f)));
        changes.push({ file: f, how: l === undefined ? "added" : "updated" });
      }
      continue;
    }
    if (u === b) {
      kept.push(f);
      continue;
    }
    // Edited here and upstream: merge when both still have it and the base is known.
    const baseText = b && meta.commit ? gitShow(o.repo, meta.commit, `${at}/${f}`) : undefined;
    if (l === undefined || u === undefined || !baseText || sha(baseText) !== b) {
      conflicts.push(f);
      continue;
    }
    const merged = merge3(readFileSync(join(dir, f)), baseText, readFileSync(join(upDir, f)));
    if (!merged) {
      conflicts.push(f);
      continue;
    }
    writes.set(f, merged);
    changes.push({ file: f, how: "merged" });
  }
  if (conflicts.length) throw new Error(`${o.id}: edited here and upstream, can't merge: ${conflicts.join(", ")}. Nothing was changed.`);

  for (const [f, body] of writes) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  for (const f of removes) rmSync(join(dir, f), { force: true });
  writeMeta(dir, { source: meta.source, commit: headOf(o.repo), version: versionOf(o.repo), api, files: up });
  return { id: o.id, changes, kept, from: meta.commit, to: headOf(o.repo) };
}

/** Git's blob id for some bytes, to match a local copy against `git ls-tree` without a spawn per file. */
const blobId = (b: Buffer) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

/**
 * Writes `.pack.json` for a pack copied before there was one. With `at`, that commit is the base;
 * without, the newest commit whose copy of the pack matches this one exactly (else it asks for `at`).
 */
export function trackPack(o: { id: string; into: string; repo: string; at?: string }): PackMeta {
  const dir = instancePath(o.into, o.id);
  if (!existsSync(join(dir, "index.ts"))) throw new Error(`${dir} has no pack`);
  if (readMeta(dir)) throw new Error(`${o.id} already has a ${META}`);
  const at = upstreamPath(o.repo, o.id);
  if (!at) throw new Error(`Pack "${o.id}" isn't in ${o.repo}`);
  const tree = (c: string) =>
    Object.fromEntries(
      (git(o.repo, ["ls-tree", "-r", c, "--", `${at}/`]) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [info, path] = line.split("\t") as [string, string];
          return [path.slice(at.length + 1), info.split(" ")[2]!] as const;
        })
        .filter(([f]) => f !== META),
    );
  let commit = o.at ? git(o.repo, ["rev-parse", "--verify", `${o.at}^{commit}`])?.trim() : undefined;
  if (o.at && !commit) throw new Error(`${o.at} isn't a commit in ${o.repo}`);
  if (!commit) {
    const mine = Object.fromEntries(filesOf(dir).map((f) => [f, blobId(readFileSync(join(dir, f)))]));
    const same = (t: Record<string, string>) => Object.keys(t).length === Object.keys(mine).length && Object.entries(t).every(([f, id]) => mine[f] === id);
    commit = (git(o.repo, ["rev-list", "-n", "300", "HEAD", "--", at]) ?? "").split("\n").filter(Boolean).find((c) => same(tree(c)));
    if (!commit) throw new Error(`No commit of ${o.repo} has ${o.id} exactly as it is here; pass --at <commit> with the one it was copied from`);
  }
  const files: Record<string, string> = {};
  for (const f of Object.keys(tree(commit))) {
    const body = gitShow(o.repo, commit, `${at}/${f}`);
    if (body) files[f] = sha(body);
  }
  const index = gitShow(o.repo, commit, `${at}/index.ts`)?.toString("utf8") ?? "";
  const literal = index.match(/\bapi:\s*(\d+)/);
  const meta: PackMeta = { source: sourceOf(o.repo), commit, version: versionOf(o.repo), api: literal ? Number(literal[1]) : PACK_API, files };
  writeMeta(dir, meta);
  return meta;
}
