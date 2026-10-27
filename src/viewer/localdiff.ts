/**
 * A checkout's own diffs (dovre#105): what's uncommitted against a commit (untracked files too),
 * two refs as a PR shows them (base...head, from where they split), or one commit. Read through
 * git like the code explorer, never through a shell; external diff programs and textconv filters
 * are off, so nothing a repo configures runs. The result is the PR viewer's file shape, drawn by
 * its renderer. Read-only: nothing here changes a checkout or its index.
 */
import type { PrFile } from "../sources/prview.ts";
import { commitOf, type Git } from "./code.ts";

/** What to compare. No `head`: the working tree. */
export type DiffAsk = { kind: "worktree"; base: string } | { kind: "refs"; base: string; head: string } | { kind: "commit"; sha: string };

export type LocalDiff =
  | { ok: true; files: PrFile[]; base: string; head?: string; /** Untracked files past the cap, not shown. */ moreUntracked: number; capped: boolean }
  | { ok: false; error: string };

export const MAX_FILES = 300;
/** Untracked files read one by one: past this many they're counted, not shown. */
export const MAX_UNTRACKED = 50;
const MAX_OUT = 8 * 1024 * 1024;
/** The empty tree: a root commit's parent. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF = ["-c", "core.fsmonitor=false", "--no-optional-locks", "diff", "-M", "--no-color", "--no-ext-diff", "--no-textconv"];

/** `a/P b/P` from a `diff --git` line, when both sides are one path (a binary or mode-only change). */
function samePath(rest: string): string | undefined {
  const n = (rest.length - 5) / 2;
  if (!Number.isInteger(n) || n < 1) return undefined;
  const a = rest.slice(2, 2 + n);
  return rest.startsWith("a/") && rest.slice(2 + n) === ` b/${a}` ? a : undefined;
}

/** `git diff` output as the PR viewer's files: path, status, counts, and the patch from its first hunk. */
export function parseGitDiff(out: string): PrFile[] {
  const files: PrFile[] = [];
  const chunks = out.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const at = lines.findIndex((l) => l.startsWith("@@"));
    const head = at < 0 ? lines : lines.slice(0, at);
    const field = (p: string) => head.find((l) => l.startsWith(p))?.slice(p.length);
    const minus = field("--- ");
    const plus = field("+++ ");
    const from = field("rename from ");
    const to = field("rename to ");
    const path = to ?? (plus && plus !== "/dev/null" ? plus.replace(/^b\//, "") : minus && minus !== "/dev/null" ? minus.replace(/^a\//, "") : samePath(head[0] ?? ""));
    if (!path) continue;
    const status = from !== undefined ? "renamed" : field("new file mode ") !== undefined ? "added" : field("deleted file mode ") !== undefined ? "removed" : "modified";
    const body = at < 0 ? [] : lines.slice(at);
    while (body.length && body[body.length - 1] === "") body.pop();
    let additions = 0;
    let deletions = 0;
    for (const l of body) {
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
    files.push({ path, previous: from, status, additions, deletions, patch: body.length ? body.join("\n") : undefined, sha: "" });
  }
  return files;
}

async function run(g: Git, dir: string, args: string[]): Promise<{ out: string } | { error: string }> {
  const r = await g(dir, args, { maxBuffer: MAX_OUT });
  // `--no-index` says 1 when the files differ.
  if (r.code === 0 || (r.code === 1 && args.includes("--no-index"))) return { out: r.stdout };
  return { error: r.code === null ? "git took too long, or the diff is too big to show here." : (r.stderr.trim().split("\n")[0] ?? "").slice(0, 300) || `git said ${r.code}.` };
}

/** Untracked files (ignored ones left out), each as an added file. */
async function untracked(g: Git, dir: string): Promise<{ files: PrFile[]; more: number }> {
  const r = await g(dir, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
  if (r.code !== 0) return { files: [], more: 0 };
  // A folder here is a nested repo: not read into.
  const paths = r.stdout.split("\u0000").filter((p) => p && !p.endsWith("/"));
  const files: PrFile[] = [];
  for (const p of paths.slice(0, MAX_UNTRACKED)) {
    const d = await run(g, dir, [...DIFF.slice(0, 3), "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", p]);
    const f = "out" in d ? parseGitDiff(d.out)[0] : undefined;
    files.push(f ? { ...f, path: p, status: "added", previous: undefined } : { path: p, status: "added", additions: 0, deletions: 0, sha: "" });
  }
  return { files, more: Math.max(0, paths.length - MAX_UNTRACKED) };
}

/** The diff asked for, in a checkout. Refs are checked (`safeRef`) and resolved to commits first. */
export async function localDiff(g: Git, dir: string, ask: DiffAsk): Promise<LocalDiff> {
  const cap = (files: PrFile[], more = 0, base: string, head?: string): LocalDiff => ({ ok: true, files: files.slice(0, MAX_FILES), capped: files.length > MAX_FILES, moreUntracked: more, base, head });
  if (ask.kind === "commit") {
    const sha = await commitOf(g, dir, ask.sha);
    if (!sha) return { ok: false, error: `${ask.sha} isn't a commit in this checkout.` };
    const p = await g(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^1^{commit}`]);
    const parent = p.code === 0 && /^[0-9a-f]{40}$/.test(p.stdout.trim()) ? p.stdout.trim() : EMPTY_TREE;
    const d = await run(g, dir, [...DIFF, "--end-of-options", parent, sha, "--"]);
    return "out" in d ? cap(parseGitDiff(d.out), 0, parent, sha) : { ok: false, error: d.error };
  }
  const base = await commitOf(g, dir, ask.base);
  if (!base) return { ok: false, error: `${ask.base} isn't in this checkout. Fetch it first.` };
  if (ask.kind === "refs") {
    const head = await commitOf(g, dir, ask.head);
    if (!head) return { ok: false, error: `${ask.head} isn't in this checkout. Fetch it first.` };
    const d = await run(g, dir, [...DIFF, "--end-of-options", `${base}...${head}`, "--"]);
    return "out" in d ? cap(parseGitDiff(d.out), 0, base, head) : { ok: false, error: d.error };
  }
  const d = await run(g, dir, [...DIFF, "--end-of-options", base, "--"]);
  if (!("out" in d)) return { ok: false, error: d.error };
  const u = await untracked(g, dir);
  return cap([...parseGitDiff(d.out), ...u.files].sort((a, b) => a.path.localeCompare(b.path)), u.more, base);
}
