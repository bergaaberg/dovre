/**
 * First run's scan (#417): which packs' marker files the checkouts have. File and folder names
 * only, never what's in them, and never through a symlink. Each marker is looked up as its own
 * path (src/packs/suggest.ts, markerMatches), so a checkout's tree isn't walked.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkoutIn, checkoutsIn } from "./checkouts.ts";
import { markerMatches } from "./suggest.ts";

/** At most this many checkouts are looked at, and this many names read in a folder. */
const MAX_CHECKOUTS = 200;
const MAX_NAMES = 2000;

const realDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The names in a folder, a subfolder's ending in "/". Symlinks are left out. */
function names(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .slice(0, MAX_NAMES)
      .filter((d) => d.isFile() || d.isDirectory())
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
  } catch {
    return [];
  }
}

/** Does this checkout have the marker? Its folders are followed by name, the last part matched. */
function has(checkout: string, marker: string): boolean {
  const parts = marker.replace(/\/$/, "").split("/");
  const last = parts.pop()!;
  let dir = checkout;
  for (const p of parts) {
    dir = join(dir, p);
    if (!realDir(dir)) return false;
  }
  const prefix = parts.length ? `${parts.join("/")}/` : "";
  const want = marker.endsWith("/") ? `${prefix}${last}/` : `${prefix}${last}`;
  return names(dir).some((n) => markerMatches(want, `${prefix}${n}`));
}

/** How many checkouts under `codeDir` have each marker; a marker no checkout has is left out. */
export function scanCheckouts(codeDir: string, markers: Iterable<string>): { checkouts: number; found: Map<string, number> } {
  const repos = checkoutsIn(codeDir).slice(0, MAX_CHECKOUTS);
  const dirs = repos.map((r) => checkoutIn(codeDir, r)).filter((d): d is string => !!d);
  const found = new Map<string, number>();
  for (const k of new Set(markers)) {
    const n = dirs.filter((d) => has(d, k)).length;
    if (n) found.set(k, n);
  }
  return { checkouts: dirs.length, found };
}
