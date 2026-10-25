/**
 * A file's patch (as GHE's PR files API gives it) as lines with numbers on both sides, and the
 * review threads placed on the lines they're about. Pure; src/pages/viewer.ts draws it.
 */
import type { PrFile, Thread } from "../sources/prview.ts";

export type DiffLine =
  | { kind: "hunk"; text: string; oldStart: number; newStart: number }
  | { kind: "ctx" | "add" | "del"; text: string; old?: number; new?: number; threads?: Thread[] }
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
  return out;
}

/** Puts each thread on the line it's about: RIGHT by the new line number, LEFT by the old one. Unplaced ones are returned. */
export function placeThreads(lines: DiffLine[], threads: Thread[]): Thread[] {
  const unplaced: Thread[] = [];
  for (const t of threads) {
    const hit = t.line === null ? undefined : lines.find((l) => (l.kind === "add" || l.kind === "ctx" || l.kind === "del") && (t.side === "LEFT" ? l.old === t.line : l.new === t.line) && (t.side === "LEFT" ? l.kind !== "add" : l.kind !== "del"));
    if (hit && hit.kind !== "hunk" && hit.kind !== "note") (hit.threads ??= []).push(t);
    else unplaced.push(t);
  }
  return unplaced;
}

/** Files nobody reads line by line: shown folded, with a note. */
export const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock)$|\.min\.(js|css)$|\.snap$|(^|\/)(dist|build|out|bin|obj|node_modules|vendor)\/|\.designer\.cs$|\.g\.cs$|\.generated\.\w+$/i;
/** Past this many changed lines a file starts folded. */
export const BIG = 400;

export type FileView = { file: PrFile; lines: DiffLine[]; folded: boolean; why?: string; unplaced: Thread[]; threads: Thread[] };

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
