/**
 * Installs a pre-built pack from `dovre-packs` (`pnpm packs add`, run from src/packs/new.ts) into an
 * instance repository, records where it came from in `.pack.json` (src/packs/update.ts), and wires
 * it into `packs.ts` (WP-M6).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { META, provenance, writeMeta } from "./update.ts";
import { detectExportName, wirePackIntoFile } from "./wire.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
export { detectExportName, wirePackIntoFile } from "./wire.ts";

/** Where the CLI keeps its own clone of dovre-packs when there's no checkout (#362). */
function packsCache(env: Record<string, string | undefined> = process.env): string {
  if (env.DOVRE_PACKS_CACHE) return resolve(env.DOVRE_PACKS_CACHE);
  return join(env.XDG_CACHE_HOME || join(env.HOME ?? homedir(), ".cache"), "dovre", "dovre-packs");
}

const isPacksRepo = (dir: string) => existsSync(join(dir, "packs"));

/**
 * The `dovre-packs` checkout: `from`, DOVRE_PACKS_DIR, one beside dovre, else the CLI's own clone
 * in the cache (#362). With `allowClone`, that clone is made when missing (blob-less: every commit
 * and tag, files fetched as needed, so releases and 3-way merges work) and brought up to date with
 * GitHub when there; it's the CLI's alone, so it simply follows origin.
 */
export function resolvePacksRepo(from?: string, coreDir = resolve(import.meta.dirname, "..", ".."), allowClone = true, cache = packsCache()): string {
  const candidates = [
    from ? resolve(from) : undefined,
    process.env.DOVRE_PACKS_DIR ? resolve(process.env.DOVRE_PACKS_DIR) : undefined,
    resolve(coreDir, "..", "dovre-packs"),
  ].filter((x): x is string => !!x);

  for (const dir of candidates) if (isPacksRepo(dir)) return dir;
  if (isPacksRepo(cache)) {
    if (allowClone) {
      const sync = spawnSync("git", ["-C", cache, "fetch", "--tags", "--force", "--quiet", "origin"], { timeout: 60_000, stdio: "ignore" });
      if (sync.status === 0) spawnSync("git", ["-C", cache, "reset", "--hard", "--quiet", "origin/HEAD"], { stdio: "ignore" });
    }
    return cache;
  }

  if (allowClone) {
    const target = from ? resolve(from) : cache;
    const repoUrl = process.env.DOVRE_PACKS_REPO || "https://github.com/bergaaberg/dovre-packs.git";
    mkdirSync(dirname(target), { recursive: true });
    const r = spawnSync("git", ["clone", "--filter=blob:none", "--quiet", repoUrl, target], { encoding: "utf8" });
    if (r.status === 0 && isPacksRepo(target)) return target;
  }
  throw new Error(
    `Could not find dovre-packs (looked in ${[...candidates, cache].join(", ")}). Clone https://github.com/bergaaberg/dovre-packs beside dovre or pass --from <path>.`,
  );
}

/** Lists available pre-built packs in a `dovre-packs` checkout. */
export function listAvailablePacks(packsRepoDir: string): string[] {
  const root = join(packsRepoDir, "packs");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => ID.test(f) && statSync(join(root, f)).isDirectory() && existsSync(join(root, f, "index.ts")))
    .sort();
}

/**
 * Copies pack `<id>`'s newest release (or `to`; HEAD when it has none) from the dovre-packs checkout
 * into `into` and wires it into `packs.ts`.
 */
export function addPack(o: { id: string; into: string; from?: string; to?: string; allowClone?: boolean }): { wrote: string[]; wired?: string; exportName: string; version: string | null } {
  if (!ID.test(o.id)) throw new Error(`"${o.id}" isn't a pack id: lowercase letters, digits and dashes`);
  const repoDir = resolvePacksRepo(o.from, undefined, o.allowClone ?? true);
  const srcRoot = join(repoDir, "packs", o.id);
  if (!existsSync(srcRoot)) {
    const avail = listAvailablePacks(repoDir);
    throw new Error(`Pack "${o.id}" not found in ${repoDir}. Available packs: ${avail.join(", ") || "none"}`);
  }

  const subDir = "packs";
  const destRoot = join(o.into, subDir, o.id);
  const { meta, files } = provenance(repoDir, o.id, o.to);
  const existing = [...files.keys()].filter((rel) => existsSync(join(destRoot, rel)));
  if (existing.length) {
    throw new Error(`already there in ${destRoot}: ${existing.join(", ")}`);
  }

  const wrote: string[] = [];
  for (const [rel, body] of files) {
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body, { flag: "wx" });
    wrote.push(`${subDir}/${o.id}/${rel}`);
  }
  writeMeta(destRoot, meta);
  wrote.push(`${subDir}/${o.id}/${META}`);

  const indexText = readFileSync(join(destRoot, "index.ts"), "utf8");
  const exportName = detectExportName(indexText, o.id);
  const entryFile = existsSync(join(o.into, "packs.ts")) ? join(o.into, "packs.ts") : undefined;
  let wired: string | undefined;
  if (entryFile) {
    const prev = readFileSync(entryFile, "utf8");
    const next = wirePackIntoFile(prev, `./${subDir}/${o.id}/index.ts`, exportName);
    if (next !== prev) {
      writeFileSync(entryFile, next);
      wired = entryFile;
    }
  }
  return { wrote, wired, exportName, version: meta.version };
}
