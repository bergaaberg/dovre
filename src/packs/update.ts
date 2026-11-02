/**
 * Copied packs and where they came from (#152). `pnpm packs add` copies a pack's newest release out
 * of a dovre-packs checkout and writes `.pack.json` beside it: the source repo, the commit and tag
 * it came from, the pack's own version, the PACK_API it needs, and a SHA-256 per file. From that:
 *
 *   pnpm packs outdated            each copied pack: its version, the newest release and what
 *                                  changed in between (its CHANGELOG.md), edited here
 *   pnpm packs update <id>|--all   take a release's files (the newest, or --to x.y.z); a file edited
 *   [--to x.y.z]                   here and upstream is merged 3-way (git merge-file, base = the
 *                                  recorded commit's version)
 *   pnpm packs track <id> [--at c] write .pack.json for a pack copied before there was one
 *
 * Releases are the checkout's tags `<id>@x.y.z` (#361; dovre-packs#128); a pack with none yet
 * follows the checkout's HEAD. An update reads the release from git, works it all out in memory,
 * and writes nothing if any file conflicts. It refuses a release that needs a PACK_API this core
 * lacks and a source outside REPO_OWNERS (bergaaberg/dovre-packs is always allowed).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { owns } from "../owners.ts";
import { apiCompare, apiGap, apiText, parseApi } from "./api.ts";
import { PACK_API } from "./types.ts";

export const META = ".pack.json";
const HOME_SOURCE = "bergaaberg/dovre-packs";

export type PackMeta = {
  /** `owner/repo` on GitHub, from the checkout's origin; null when it has none. */
  source: string | null;
  /** The commit copied from (the release's, or HEAD's when the pack has no releases); null outside git. */
  commit: string | null;
  /** The release tag copied from (`<id>@x.y.z`); null when it followed HEAD. Older records lack it. */
  tag?: string | null;
  /** The pack's own version (its manifest's); only meaningful with `tag` (older records hold the repo's). */
  version: string | null;
  /** The oldest PACK_API the pack works with, "major.minor" (older copies say 1, meaning 1.0). */
  api: string | number;
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

/** A literal `api: "1.6"` (or `api: 1`) in a pack's index.ts, as "major.minor". */
function literalApi(index: string): string | null {
  const m = index.match(/\bapi:\s*(?:"(\d+(?:\.\d+)?)"|'(\d+(?:\.\d+)?)'|(\d+)\b)/);
  const v = m && parseApi(m[1] ?? m[2] ?? Number(m[3]));
  return v ? apiText(v) : null;
}

/** The PACK_API a pack needs: a literal `api: "1.6"` in its index.ts, else the core its checkout links. */
export function apiOf(repo: string, packDir: string): string {
  const own = literalApi(readFileSync(join(packDir, "index.ts"), "utf8"));
  if (own) return own;
  const linked = join(repo, "node_modules", "dovre", "src", "packs", "types.ts");
  const m = existsSync(linked) ? readFileSync(linked, "utf8").match(/PACK_API\s*=\s*"?(\d+(?:\.\d+)?)"?/) : null;
  const v = m && parseApi(m[1].includes(".") ? m[1] : Number(m[1]));
  return v ? apiText(v) : PACK_API;
}

/** A literal `version: "1.2.0"` in a pack's index.ts. */
const literalVersion = (index: string) => index.match(/\bversion:\s*["'](\d+\.\d+\.\d+)["']/)?.[1] ?? null;

const sourceOf = (repo: string) => sourceOfUrl(git(repo, ["remote", "get-url", "origin"]) ?? "");
const headOf = (repo: string) => git(repo, ["rev-parse", "HEAD"])?.trim() || null;

type Semver = [number, number, number];
const semver = (v: string | null | undefined): Semver | null => {
  const m = v?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const newer = (a: Semver, b: Semver) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Pack `<id>`'s releases in the checkout, tags `<id>@x.y.z`, newest first. */
export function releasesOf(repo: string, id: string): { tag: string; version: string }[] {
  return (git(repo, ["tag", "--list", `${id}@*`]) ?? "")
    .split("\n")
    .map((t) => t.trim())
    .flatMap((tag) => {
      const v = semver(tag.slice(id.length + 1));
      return v ? [{ tag, version: tag.slice(id.length + 1), v }] : [];
    })
    .sort((a, b) => newer(b.v, a.v))
    .map(({ tag, version }) => ({ tag, version }));
}

/** Fetches the checkout's tags from origin, best effort (offline is fine: the local ones stay). */
export function fetchTags(repo: string): void {
  spawnSync("git", ["-C", repo, "fetch", "--tags", "--quiet", "origin"], { timeout: 20_000, stdio: "ignore" });
}

/** What an update or add takes: release `to`, else the newest release, else HEAD (a pack with no tags yet). */
export type Target = { tag: string | null; commit: string; version: string | null };
export function targetOf(repo: string, id: string, to?: string): Target {
  const releases = releasesOf(repo, id);
  if (to) {
    const want = to.replace(new RegExp(`^${id}@`), "");
    const r = releases.find((x) => x.version === want);
    if (!r) throw new Error(`${id} has no release ${want} in ${repo}${releases.length ? ` (it has ${releases.map((x) => x.version).join(", ")})` : ""}`);
    return { tag: r.tag, commit: git(repo, ["rev-parse", `${r.tag}^{commit}`])!.trim(), version: r.version };
  }
  const r = releases[0];
  if (r) return { tag: r.tag, commit: git(repo, ["rev-parse", `${r.tag}^{commit}`])!.trim(), version: r.version };
  const head = headOf(repo);
  if (!head) throw new Error(`${repo} isn't a git checkout`);
  return { tag: null, commit: head, version: null };
}

/** The pack's files at a commit, as paths inside it (`.pack.json` and node_modules left out). */
export function filesAt(repo: string, commit: string, at: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const entries = (git(repo, ["ls-tree", "-r", "-z", commit, "--", `${at}/`]) ?? "")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [info, path] = line.split("\t") as [string, string];
      const [, type, id] = info.split(" ") as [string, string, string];
      return { type, id, file: path.slice(at.length + 1) };
    })
    .filter((e) => e.type === "blob" && e.file !== META && !e.file.split("/").includes("node_modules"));
  if (!entries.length) return out;
  const r = spawnSync("git", ["-C", repo, "cat-file", "--batch"], { input: entries.map((e) => e.id).join("\n") + "\n", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git cat-file failed in ${repo}`);
  let pos = 0;
  for (const e of entries) {
    const nl = r.stdout.indexOf(10, pos);
    const size = Number(r.stdout.subarray(pos, nl).toString().split(" ")[2]);
    out.set(e.file, r.stdout.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return out;
}

const hashOf = (files: Map<string, Buffer>): Record<string, string> => Object.fromEntries([...files].map(([f, b]) => [f, sha(b)]).sort(([a], [b]) => (a! < b! ? -1 : 1)));

/** The API a pack at a commit needs: its literal, else the core the checkout links. */
const apiAt = (repo: string, files: Map<string, Buffer>, at: string) => literalApi(files.get("index.ts")?.toString("utf8") ?? "") ?? apiOf(repo, join(repo, at));

/** A changelog's releases newer than `since` (all of them when null), newest first, each with its lines. */
export function notesOf(changelog: string, since: string | null): { version: string; lines: string[] }[] {
  const from = semver(since);
  const out: { version: string; lines: string[] }[] = [];
  for (const part of changelog.split(/^## /m).slice(1)) {
    const version = part.match(/^(\d+\.\d+\.\d+)\b/)?.[1];
    const v = semver(version);
    if (!v || (from && newer(v, from) <= 0)) continue;
    out.push({ version: version!, lines: part.split("\n").slice(1).map((l) => l.trim().replace(/^[-*]\s+/, "")).filter(Boolean).slice(0, 20) });
  }
  return out.slice(0, 10);
}

/** The `.pack.json` for pack `<id>` at its newest release (or `to`), and the files to copy. */
export function provenance(repo: string, id: string, to?: string): { meta: PackMeta; files: Map<string, Buffer> } {
  const at = upstreamPath(repo, id);
  if (!at) throw new Error(`Pack "${id}" isn't in ${repo}`);
  const t = targetOf(repo, id, to);
  const files = t.tag ? filesAt(repo, t.commit, at) : new Map(filesOf(join(repo, at)).map((f) => [f, readFileSync(join(repo, at, f))]));
  const index = files.get("index.ts")?.toString("utf8") ?? "";
  const meta: PackMeta = { source: sourceOf(repo), commit: t.commit, tag: t.tag, version: literalVersion(index) ?? t.version, api: apiAt(repo, files, at), files: hashOf(files) };
  return { meta, files };
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
  /** The pack's version here; null when `.pack.json` doesn't record it (copied before releases). */
  version?: string | null;
  /** The release an update would take (`<id>@x.y.z`), null when the pack has none and follows HEAD. */
  tag?: string | null;
  /** That release's version. */
  newest?: string | null;
  /** What the releases since this copy changed, from the pack's CHANGELOG.md, newest first. */
  notes?: { version: string; lines: string[] }[];
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
    const t = targetOf(repo, id);
    const version = "tag" in meta ? meta.version : null;
    const same = meta.commit && git(repo, ["rev-parse", `${meta.commit}:${at}`])?.trim() === git(repo, ["rev-parse", `${t.commit}:${at}`])?.trim();
    const upstream = same ? [] : changed(meta.files, t.tag ? hashOf(filesAt(repo, t.commit, at)) : hashes(join(repo, at)));
    const count = meta.commit ? git(repo, ["rev-list", "--count", `${meta.commit}..${t.commit}`, "--", at]) : undefined;
    const changelog = t.tag && upstream.length ? gitShow(repo, t.commit, `${at}/CHANGELOG.md`)?.toString("utf8") : undefined;
    const notes = changelog ? notesOf(changelog, version).slice(0, version ? 10 : 1) : [];
    out.push({ id, tracked: true, behind: count === undefined ? null : Number(count.trim()), upstream, edited, version, tag: t.tag, newest: t.version, notes });
  }
  return out;
}

/** One line per pack for `pnpm packs outdated`. */
export function describe(s: PackState): string {
  if (!s.tracked) return `${s.id}: copied before .pack.json (pnpm packs track ${s.id})`;
  const here = s.edited.length ? `edited here: ${s.edited.join(", ")}` : "";
  const name = `${s.id}${s.version ? ` ${s.version}` : ""}`;
  if (s.gone) return `${name}: no longer in dovre-packs${here ? `; ${here}` : ""}`;
  const parts: string[] = [];
  if (s.upstream.length) parts.push(`${s.newest ? `newer release ${s.newest}` : "newer upstream"}${s.behind ? ` (${s.behind} commit${s.behind === 1 ? "" : "s"})` : ""}: ${s.upstream.join(", ")}`);
  else if (s.tag && !s.version) parts.push(`at ${s.newest}, not recorded yet (pnpm packs update ${s.id} records it)`);
  if (here) parts.push(here);
  return `${name}: ${parts.join("; ") || "up to date"}`;
}

export type FileChange = { file: string; how: "updated" | "added" | "removed" | "merged" };
export type UpdateResult = { id: string; changes: FileChange[]; kept: string[]; from: string | null; to: string | null; fromVersion: string | null; toVersion: string | null };

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
 * Brings pack `<id>` to its newest release (or `to`). A file unchanged here takes the release's
 * version (new and removed files too); edited here only, it stays; edited both sides, it's merged
 * 3-way. Any conflict throws before a single file is written.
 */
export function updatePack(o: { id: string; into: string; repo: string; to?: string; env?: Record<string, string | undefined> }): UpdateResult {
  const dir = instancePath(o.into, o.id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`${o.id} has no ${META}: run pnpm packs track ${o.id} first`);
  if (!sourceAllowed(meta.source, o.env)) throw new Error(`${o.id} came from ${meta.source ?? "an unknown source"}, which isn't dovre-packs or an owner in REPO_OWNERS`);
  const source = sourceOf(o.repo);
  if (source?.toLowerCase() !== meta.source?.toLowerCase()) throw new Error(`${o.repo} is ${source ?? "not a GitHub checkout"}, but ${o.id} came from ${meta.source}`);
  const at = upstreamPath(o.repo, o.id);
  if (!at) throw new Error(`${o.id} is no longer in ${o.repo}`);
  const t = targetOf(o.repo, o.id, o.to);
  if (!t.tag && git(o.repo, ["status", "--porcelain", "--", at])?.trim()) throw new Error(`${o.repo} has uncommitted changes in ${at}: commit or stash them first`);
  const upFiles = filesAt(o.repo, t.commit, at);
  const name = t.tag ?? `${o.id} upstream`;
  const api = apiAt(o.repo, upFiles, at);
  if (apiCompare(api, PACK_API) > 0) throw new Error(`${name} needs PACK_API ${api}; this core has ${PACK_API}. Update Dovre first.`);
  const gap = apiGap(api);
  if (gap) throw new Error(`${name}: ${gap}`);

  const local = hashes(dir);
  const up = hashOf(upFiles);
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
        writes.set(f, upFiles.get(f)!);
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
    const merged = merge3(readFileSync(join(dir, f)), baseText, upFiles.get(f)!);
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
  const version = literalVersion(upFiles.get("index.ts")?.toString("utf8") ?? "") ?? t.version;
  writeMeta(dir, { source: meta.source, commit: t.commit, tag: t.tag, version, api, files: up });
  return { id: o.id, changes, kept, from: meta.commit, to: t.commit, fromVersion: "tag" in meta ? meta.version : null, toVersion: version };
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
  const tag = releasesOf(o.repo, o.id).find((r) => git(o.repo, ["rev-parse", `${r.tag}^{commit}`])?.trim() === commit)?.tag ?? null;
  const meta: PackMeta = { source: sourceOf(o.repo), commit, tag, version: literalVersion(index), api: literalApi(index) ?? PACK_API, files };
  writeMeta(dir, meta);
  return meta;
}
