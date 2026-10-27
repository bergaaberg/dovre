/**
 * A file's patch (as GHE's PR files API gives it) as lines with numbers on both sides, and the
 * review threads placed on the lines they're about. Pure; src/pages/viewer.ts draws it.
 */
import type { PrFile, Thread } from "../sources/prview.ts";

export type DiffLine =
  | { kind: "hunk"; text: string; oldStart: number; newStart: number }
  | { kind: "ctx" | "add" | "del"; text: string; old?: number; new?: number; threads?: Thread[]; /** What changed within the line, as [from, to) offsets into `text`, against the line it replaced (markWords). */ marks?: Mark[]; /** Draft line comments here, by their index in the draft. */ drafts?: number[]; /** My pending review's comments here, by index (dovre#106). */ mine?: number[] }
  | { kind: "note"; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const h = HUNK.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: "hunk", text: line, oldStart: o, newStart: n });
      continue;
    }
    if (!out.length) continue;
    if (line.startsWith("\\")) out.push({ kind: "note", text: line.slice(1).trim() });
    else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), new: n++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: o++ });
    else out.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, old: o++, new: n++ });
  }
  return markWords(out);
}

/** A stretch of a line: [from, to) offsets. */
export type Mark = [number, number];

const TOKEN = /\w+|\s+|[^\w\s]/g;
/** Longer lines aren't compared word by word: the whole line's tint says enough. */
const MAX_CHARS = 500;
const MAX_TOKENS = 160;

/**
 * The words that differ between a removed line and the line that took its place, on each side.
 * Undefined when they're too long to compare, or too unlike for word marks to help.
 */
export function wordDiff(a: string, b: string): { a: Mark[]; b: Mark[] } | undefined {
  if (a === b || a.length > MAX_CHARS || b.length > MAX_CHARS) return undefined;
  const x = [...a.matchAll(TOKEN)];
  const y = [...b.matchAll(TOKEN)];
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) return undefined;
  // The longest run of tokens they share (LCS), from the end.
  const L = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i]![j] = x[i]![0] === y[j]![0] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const keepA = new Array<boolean>(x.length).fill(false);
  const keepB = new Array<boolean>(y.length).fill(false);
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i]![0] === y[j]![0]) keepA[i++] = keepB[j++] = true;
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++;
    else j++;
  }
  // Shared visible characters, against all of them: under 40%, it's a different line.
  const seen = (t: RegExpExecArray[]) => t.reduce((n, m) => n + m[0].replace(/\s/g, "").length, 0);
  const shared = seen(x.filter((_, i) => keepA[i]));
  if (shared * 2 < 0.4 * (seen(x) + seen(y))) return undefined;
  const ranges = (t: RegExpExecArray[], keep: boolean[]) => {
    const out: Mark[] = [];
    t.forEach((m, i) => {
      if (keep[i]) return;
      const last = out[out.length - 1];
      if (last && last[1] === m.index) last[1] = m.index + m[0].length;
      else out.push([m.index, m.index + m[0].length]);
    });
    return out;
  };
  return { a: ranges(x, keepA), b: ranges(y, keepB) };
}

/** Pairs each run of removed lines with the added lines straight after it, line by line, and marks the words that changed. */
export function markWords(lines: DiffLine[]): DiffLine[] {
  for (let i = 0; i < lines.length; ) {
    let d = i;
    while (lines[d]?.kind === "del") d++;
    let e = d;
    while (lines[e]?.kind === "add") e++;
    for (let k = 0; k < Math.min(d - i, e - d); k++) {
      const del = lines[i + k] as Code;
      const add = lines[d + k] as Code;
      const w = wordDiff(del.text, add.text);
      if (w) {
        del.marks = w.a;
        add.marks = w.b;
      }
    }
    i = Math.max(e, i + 1);
  }
  return lines;
}

/** Where a comment sits: on its side's line number (RIGHT: the new file, LEFT: the old one). */
export type Anchor = { line: number | null; side: "LEFT" | "RIGHT" };
type Code = Extract<DiffLine, { kind: "ctx" | "add" | "del" }>;

/** The line a comment is about, if it's in the diff: RIGHT by the new line number, LEFT by the old one. */
export function lineAt(lines: DiffLine[], a: Anchor): Code | undefined {
  if (a.line === null) return undefined;
  return lines.find((l): l is Code => (l.kind === "add" || l.kind === "ctx" || l.kind === "del") && (a.side === "LEFT" ? l.old === a.line && l.kind !== "add" : l.new === a.line && l.kind !== "del"));
}

/** Puts each thread on the line it's about. Unplaced ones are returned. */
export function placeThreads(lines: DiffLine[], threads: Thread[]): Thread[] {
  const unplaced: Thread[] = [];
  for (const t of threads) {
    const hit = lineAt(lines, t);
    if (hit) (hit.threads ??= []).push(t);
    else unplaced.push(t);
  }
  return unplaced;
}

/** Puts each comment on its file's line (by index) under `key`. The indices of those off the diff are returned. */
function placeOn(views: FileView[], comments: (Anchor & { path: string })[], key: "drafts" | "mine"): number[] {
  const off: number[] = [];
  comments.forEach((c, i) => {
    const fv = views.find((v) => v.file.path === c.path);
    const hit = fv ? lineAt(fv.lines, c) : undefined;
    if (hit && fv) {
      (hit[key] ??= []).push(i);
      fv[key] = (fv[key] ?? 0) + 1;
    } else off.push(i);
  });
  return off;
}

/** Puts each draft line comment on its file's line (by index). The indices of those off the diff are returned. */
export const placeDrafts = (views: FileView[], comments: (Anchor & { path: string })[]) => placeOn(views, comments, "drafts");
/** The same for my pending review's comments. */
export const placeMine = (views: FileView[], comments: (Anchor & { path: string })[]) => placeOn(views, comments, "mine");

/** Files nobody reads line by line: shown folded, with a note. */
export const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock)$|\.min\.(js|css)$|\.snap$|(^|\/)(dist|build|out|bin|obj|node_modules|vendor)\/|\.designer\.cs$|\.g\.cs$|\.generated\.\w+$/i;
/** Past this many changed lines a file starts folded. */
export const BIG = 400;

export type FileView = { file: PrFile; lines: DiffLine[]; folded: boolean; why?: string; unplaced: Thread[]; threads: Thread[]; /** How many draft comments sit in it (placeDrafts). */ drafts?: number; /** How many of my pending comments (placeMine). */ mine?: number };

/** Each file's lines and threads, and whether it starts folded (generated, big, binary, too large for GHE to send). */
export function fileViews(files: PrFile[], threads: Thread[]): FileView[] {
  return files.map((file) => {
    const mine = threads.filter((t) => t.path === file.path || (!!file.previous && t.path === file.previous));
    if (file.patch === undefined) {
      const why = file.status === "removed" ? "Deleted." : file.additions + file.deletions === 0 ? "No text changes (binary, or only renamed or mode-changed)." : "Too large for GHE to show here.";
      return { file, lines: [], folded: true, why, unplaced: mine, threads: mine };
    }
    const lines = parsePatch(file.patch);
    const unplaced = placeThreads(lines, mine.map((t) => ({ ...t })));
    const generated = GENERATED.test(file.path);
    const big = file.additions + file.deletions > BIG;
    return { file, lines, folded: generated || big, why: generated ? "Generated or a lock file." : big ? `${file.additions + file.deletions} changed lines.` : undefined, unplaced, threads: mine };
  });
}
