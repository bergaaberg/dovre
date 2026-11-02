/**
 * Installs a pre-built pack from `dovre-packs` (`pnpm packs add`, run from src/packs/new.ts) into an
 * instance repository, records where it came from in `.pack.json` (src/packs/update.ts), and wires
 * it into `crates.ts` / `packs.ts` (WP-M6).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { META, provenance, writeMeta } from "./update.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Finds the exported Crate/Pack identifier in `index.ts` (e.g. `cfHealthPack` or `cfHealthCrate`). */
export function detectExportName(indexTs: string, id: string): string {
  for (const want of [`${camel(id)}Pack`, `${camel(id)}Crate`]) {
    if (new RegExp(`export\\s+const\\s+${want}\\b`).test(indexTs)) return want;
  }
  const m = indexTs.match(/export\s+const\s+([A-Za-z0-9_]+)\s*(?::\s*(?:Crate|Pack))?\s*=/);
  return m?.[1] ?? `${camel(id)}Crate`;
}

/**
 * Adds an import and array entry for `exportName` in an instance's `crates.ts` or `packs.ts`.
 * Idempotent: if already imported, returns the file unchanged.
 */
export function wirePackIntoFile(sourceText: string, relImport: string, exportName: string): string {
  if (sourceText.includes(exportName) || sourceText.includes(relImport)) return sourceText;
  const importLine = `import { ${exportName} } from ${JSON.stringify(relImport)};\n`;
  let next = sourceText;
  // Insert after the last import statement, or at top of file.
  const imports = [...next.matchAll(/^import\s+[^\n]+\n/gm)];
  if (imports.length > 0) {
    const last = imports.at(-1)!;
    const idx = (last.index ?? 0) + last[0].length;
    next = next.slice(0, idx) + importLine + next.slice(idx);
  } else {
    next = importLine + next;
  }

  // Add to `const crates: Crate[] = [...]` or `const packs: Pack[] = [...]` or `export default [...]`
  const listRe = /((?:const\s+(?:crates|packs)\s*(?::[^=]+)?=\s*|export\s+default\s*)\[)([^\]]*)(\])/;
  if (listRe.test(next)) {
    next = next.replace(listRe, (_m, open: string, inner: string, close: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return `${open}${exportName}${close}`;
      const sep = trimmed.endsWith(",") ? " " : ", ";
      return `${open}${trimmed}${sep}${exportName}${close}`;
    });
  }
  return next;
}

/** Where the CLI keeps its own clone of dovre-packs when there's no checkout (#362). */
export function packsCache(env: Record<string, string | undefined> = process.env): string {
  if (env.DOVRE_PACKS_CACHE) return resolve(env.DOVRE_PACKS_CACHE);
  return join(env.XDG_CACHE_HOME || join(env.HOME ?? homedir(), ".cache"), "dovre", "dovre-packs");
}

const isPacksRepo = (dir: string) => existsSync(join(dir, "packs")) || existsSync(join(dir, "crates"));

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
  const root = existsSync(join(packsRepoDir, "packs")) ? join(packsRepoDir, "packs") : join(packsRepoDir, "crates");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => ID.test(f) && statSync(join(root, f)).isDirectory() && existsSync(join(root, f, "index.ts")))
    .sort();
}

/**
 * Copies pack `<id>`'s newest release (or `to`; HEAD when it has none) from the dovre-packs checkout
 * into `into` and wires it into `crates.ts` / `packs.ts`.
 */
export function addPack(o: { id: string; into: string; from?: string; to?: string; allowClone?: boolean }): { wrote: string[]; wired?: string; exportName: string; version: string | null } {
  if (!ID.test(o.id)) throw new Error(`"${o.id}" isn't a pack id: lowercase letters, digits and dashes`);
  const repoDir = resolvePacksRepo(o.from, undefined, o.allowClone ?? true);
  const srcRoot = existsSync(join(repoDir, "packs", o.id))
    ? join(repoDir, "packs", o.id)
    : existsSync(join(repoDir, "crates", o.id))
      ? join(repoDir, "crates", o.id)
      : undefined;
  if (!srcRoot) {
    const avail = listAvailablePacks(repoDir);
    throw new Error(`Pack "${o.id}" not found in ${repoDir}. Available packs: ${avail.join(", ") || "none"}`);
  }

  const usesPacksDir = existsSync(join(o.into, "packs.ts")) && !existsSync(join(o.into, "crates.ts"));
  const subDir = usesPacksDir ? "packs" : "crates";
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
    wrote.push(join(subDir, o.id, rel));
  }
  writeMeta(destRoot, meta);
  wrote.push(join(subDir, o.id, META));

  const indexText = readFileSync(join(destRoot, "index.ts"), "utf8");
  const exportName = detectExportName(indexText, o.id);
  const entryFile = existsSync(join(o.into, "packs.ts"))
    ? join(o.into, "packs.ts")
    : existsSync(join(o.into, "crates.ts"))
      ? join(o.into, "crates.ts")
      : undefined;
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
