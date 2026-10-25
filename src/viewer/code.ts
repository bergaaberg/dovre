/**
 * The code explorer's reads: a local checkout at a ref, through git (on the worker thread,
 * arguments passed as they are, never through a shell). Paths are checked before git sees them,
 * and must then exist in the tree at that ref. Read-only: nothing here changes a checkout.
 */
import { join } from "node:path";
import { runOff } from "../spawn.ts";

/** A ref someone may name: a branch, a tag, a sha. Never an option, never a range, never a path trick. */
export const safeRef = (ref: string) => /^[\w][\w./-]{0,200}$/.test(ref) && !ref.includes("..") && !ref.endsWith(".lock") && !ref.includes("//");

/** A path inside the tree: relative, forward slashes, no `..`, nothing git reads as magic. */
export function safePath(path: string): string | null {
  const p = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return "";
  if (p.length > 1000 || /[\\:*?"<>|\u0000-\u001f]/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === ".." || x.startsWith(":"))) return null;
  return p;
}

export type Git = (dir: string, args: string[], opts?: { maxBuffer?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export const git: Git = (dir, args, opts = {}) => runOff("git", ["-c", "core.quotePath=false", "--no-pager", ...args], { cwd: dir, timeoutMs: 15_000, maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024 });

/** The commit a ref names in this checkout, or null when it isn't here (a PR head that hasn't been fetched). */
export async function commitOf(g: Git, dir: string, ref: string): Promise<string | null> {
  if (!safeRef(ref)) return null;
  const r = await g(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export type Entry = { name: string; path: string; type: "tree" | "blob" | "commit"; size: number | null };

/** A folder's entries at a commit, folders first. */
export async function tree(g: Git, dir: string, sha: string, path: string): Promise<Entry[] | null> {
  const r = await g(dir, ["ls-tree", "-z", "-l", "--end-of-options", path ? `${sha}:${path}` : sha]);
  if (r.code !== 0) return null;
  const out: Entry[] = [];
  for (const rec of r.stdout.split("\u0000")) {
    const m = /^\d+ (tree|blob|commit) [0-9a-f]+\s+(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) continue;
    out.push({ name: m[3]!, path: path ? `${path}/${m[3]}` : m[3]!, type: m[1] as Entry["type"], size: m[2] === "-" ? null : Number(m[2]) });
  }
  return out.sort((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** Files past this are shown as "too big" instead of their text. */
export const MAX_FILE = 512 * 1024;

export type Blob = { kind: "text"; text: string; size: number } | { kind: "binary" | "big"; size: number } | { kind: "missing" };

export async function blob(g: Git, dir: string, sha: string, path: string): Promise<Blob> {
  const type = await g(dir, ["cat-file", "-t", "--end-of-options", `${sha}:${path}`]);
  if (type.code !== 0 || type.stdout.trim() !== "blob") return { kind: "missing" };
  const size = Number((await g(dir, ["cat-file", "-s", "--end-of-options", `${sha}:${path}`])).stdout.trim()) || 0;
  if (size > MAX_FILE) return { kind: "big", size };
  const r = await g(dir, ["cat-file", "blob", "--end-of-options", `${sha}:${path}`], { maxBuffer: MAX_FILE + 1024 });
  if (r.code !== 0) return { kind: "missing" };
  if (r.stdout.slice(0, 8000).includes("\u0000")) return { kind: "binary", size };
  return { kind: "text", text: r.stdout, size };
}

export type Hit = { path: string; line: number; text: string };
export const MAX_HITS = 200;

/** Lines with the text, at that commit: fixed string, case-insensitive, capped. */
export async function grep(g: Git, dir: string, sha: string, q: string): Promise<{ hits: Hit[]; more: boolean } | null> {
  const query = q.slice(0, 200);
  if (!query.trim()) return { hits: [], more: false };
  const r = await g(dir, ["grep", "-n", "-I", "-i", "-F", "--max-count=20", "-e", query, "--end-of-options", sha], { maxBuffer: 2 * 1024 * 1024 });
  // 1: nothing found.
  if (r.code === 1) return { hits: [], more: false };
  if (r.code !== 0) return null;
  const hits: Hit[] = [];
  const prefix = `${sha}:`;
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const m = /^([^:]+):(\d+):(.*)$/s.exec(line.slice(prefix.length));
    if (m) hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
    if (hits.length > MAX_HITS) break;
  }
  return { hits: hits.slice(0, MAX_HITS), more: hits.length > MAX_HITS };
}

/** Where a checkout lives. */
export const dirOf = (codeDir: string, folder: string) => join(codeDir, folder);
