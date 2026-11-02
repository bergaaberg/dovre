/**
 * A pack's checkouts (API 1.7, #368): the git repos directly under the code folder, each a real
 * folder (not a symlink) with `.git` in it. A pack session (src/run.ts) narrows them to the one
 * checkout it was started on, so a pack that asks here sees nothing beside it.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const REPO_NAME = /^[\w.-]{1,100}$/;

const realDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The checkout's folder, or null: a plain name, a real folder directly under `codeDir` with .git, and `only` when set. */
export function checkoutIn(codeDir: string, name: unknown, only?: string): string | null {
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") return null;
  if (only !== undefined && name !== only) return null;
  const dir = join(codeDir, name);
  return realDir(dir) && existsSync(join(dir, ".git")) ? dir : null;
}

/** The checkouts' names, sorted; only `only` when set. */
export function checkoutsIn(codeDir: string, only?: string): string[] {
  let names: string[];
  try {
    names = readdirSync(codeDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.filter((n) => checkoutIn(codeDir, n, only)).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}
