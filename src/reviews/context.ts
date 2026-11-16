/**
 * The code around a diff (#555 step 4): the files a PR changed, read from the forge as they are
 * at the reviewed commit, so a reviewer judges a change with what surrounds it. Bounded in count
 * and size: the most changed files first, a long file as the parts around its changed lines.
 * Only files the diff changes, never a path a reviewer or the PR's text names. A file the forge
 * won't give is left out; a review never fails for it.
 */
import type { Ghe } from "../sources/ghe.ts";
import type { PrFile } from "../sources/prview.ts";

/** Files read for one review, at most. */
export const MAX_CONTEXT_FILES = 8;
/** Characters of one file shown, numbered; a longer one is shown around its changes. */
export const MAX_CONTEXT_FILE = 16_000;
/** Characters of all files shown together. */
export const MAX_CONTEXT = 60_000;
/** A bigger file isn't asked for in full: the forge would send it all. */
const MAX_BYTES = 400_000;
/** Lines shown either side of a hunk, in a file too long to show whole. */
const AROUND = 40;

/** Lock files, generated and minified code, and what isn't text: nothing to read around a change. */
const SKIP = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|flake\.lock)$|\.(?:min\.(?:js|css)|map|snap|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|wasm|zip|gz|lockb)$|(?:^|\/)(?:dist|build|vendor|node_modules)\//i;

/** A changed file as it is at the commit: numbered lines, whole or (`part`) around its changes. */
export type FileText = { path: string; text: string; part: boolean };

/**
 * Which files to read: changed ones that were there before (an added file is whole in the diff
 * already, a removed one is gone), the most changed first.
 */
export function contextWanted(files: PrFile[]): PrFile[] {
  return files
    .filter((f) => f.patch && f.status !== "added" && f.status !== "removed" && !SKIP.test(f.path))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, MAX_CONTEXT_FILES);
}

/** The new file's line ranges a patch's hunks cover, widened by `AROUND` and merged. */
function windowsOf(patch: string, lines: number): [number, number][] {
  const out: [number, number][] = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    const from = Math.max(1, start - AROUND);
    const to = Math.min(lines, start + Math.max(len, 1) - 1 + AROUND);
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else if (from <= to) out.push([from, to]);
  }
  return out;
}

const number = (lines: string[], from: number) => lines.map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");

/** A file's text as a reviewer gets it; undefined for what isn't text. */
export function fileText(path: string, content: string, patch: string): FileText | undefined {
  if (content.includes("\u0000")) return undefined;
  const lines = content.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const whole = number(lines, 1);
  if (whole.length <= MAX_CONTEXT_FILE) return { path, text: whole, part: false };
  const parts = windowsOf(patch, lines.length).map(([from, to]) => number(lines.slice(from - 1, to), from));
  if (!parts.length) return undefined;
  let text = parts.join("\n    …\n");
  if (text.length > MAX_CONTEXT_FILE) text = `${text.slice(0, text.lastIndexOf("\n", MAX_CONTEXT_FILE))}\n    …`;
  return { path, text, part: true };
}

const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The changed files at `sha`, as many as fit; empty when none can be read. */
export async function loadContext(ghe: Pick<Ghe, "rest">, repo: string, sha: string, files: PrFile[]): Promise<FileText[]> {
  const read = await Promise.all(
    contextWanted(files).map(async (f) => {
      try {
        const r = await ghe.rest<{ content?: string; encoding?: string; size?: number; type?: string }>(`/repos/${repo}/contents/${encoded(f.path)}?ref=${encodeURIComponent(sha)}`);
        if (r?.type !== undefined && r.type !== "file") return undefined;
        if (typeof r?.content !== "string" || r.encoding !== "base64" || (r.size ?? 0) > MAX_BYTES) return undefined;
        const bytes = Uint8Array.from(atob(r.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
        return fileText(f.path, new TextDecoder().decode(bytes), f.patch ?? "");
      } catch {
        return undefined;
      }
    }),
  );
  const out: FileText[] = [];
  let left = MAX_CONTEXT;
  for (const f of read) {
    if (!f || f.text.length > left) continue;
    left -= f.text.length;
    out.push(f);
  }
  return out;
}

/** The files as the prompt shows them, each under its path; empty for none. */
export const shownContext = (list: FileText[]): string => list.map((f) => `--- ${f.path}${f.part ? " (the parts around its changes)" : ""}\n${f.text}`).join("\n\n");
