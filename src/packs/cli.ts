/**
 * `pnpm packs new <id> [--into <instance folder>]`
 * `pnpm packs add <id> [--into <instance folder>] [--from <dovre-packs folder>]`
 * `pnpm packs list [--from <dovre-packs folder>]`
 *
 * Scaffolds a new custom pack (`new`) or installs a pre-built pack from `dovre-packs` (`add`)
 * into an instance repository and wires it into `crates.ts` / `packs.ts` automatically (WP-M6).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { scaffold, writeScaffold } from "./new.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

/** Finds the exported Crate/Pack identifier in `index.ts` (e.g. `cfHealthPack` or `cfHealthCrate`). */
export function detectExportName(indexTs: string, id: string): string {
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

/** Resolves the local `dovre-packs` checkout directory, cloning from GitHub if needed and allowed. */
export function resolvePacksRepo(from?: string, coreDir = resolve(import.meta.dirname, "..", ".."), allowClone = true): string {
  const candidates = [
    from ? resolve(from) : undefined,
    process.env.DOVRE_PACKS_DIR ? resolve(process.env.DOVRE_PACKS_DIR) : undefined,
    resolve(coreDir, "..", "dovre-packs"),
  ].filter((x): x is string => !!x);

  for (const dir of candidates) {
    if (existsSync(join(dir, "packs")) || existsSync(join(dir, "crates"))) return dir;
  }

  if (allowClone) {
    const target = from ? resolve(from) : resolve(coreDir, "..", "dovre-packs");
    const repoUrl = process.env.DOVRE_PACKS_REPO || "https://github.com/bergaaberg/dovre-packs.git";
    const r = spawnSync("git", ["clone", "--depth", "1", repoUrl, target], { encoding: "utf8" });
    if (r.status === 0 && (existsSync(join(target, "packs")) || existsSync(join(target, "crates")))) {
      return target;
    }
  }
  throw new Error(
    `Could not find dovre-packs repository (looked in ${candidates.join(", ")}). Clone https://github.com/bergaaberg/dovre-packs beside dovre or pass --from <path>.`,
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

/** Copies a pre-built pack `<id>` from `packsRepoDir` into `into` and wires it into `crates.ts` / `packs.ts`. */
export function addPack(o: { id: string; into: string; from?: string; allowClone?: boolean }): { wrote: string[]; wired?: string; exportName: string } {
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
  const srcFiles = walk(srcRoot);
  const existing = srcFiles
    .map((f) => relative(srcRoot, f))
    .filter((rel) => existsSync(join(destRoot, rel)));
  if (existing.length) {
    throw new Error(`already there in ${destRoot}: ${existing.join(", ")}`);
  }

  const wrote: string[] = [];
  for (const f of srcFiles) {
    const rel = relative(srcRoot, f);
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(f, "utf8"), { flag: "wx" });
    wrote.push(join(subDir, o.id, rel));
  }

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
  return { wrote, wired, exportName };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const rest = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const cmd = rest[0];
  const id = rest[1];
  const into = resolve(flag("--into") ?? ".");
  const from = flag("--from");

  try {
    if (cmd === "list") {
      const repo = resolvePacksRepo(from);
      for (const p of listAvailablePacks(repo)) console.log(p);
      process.exit(0);
    }
    if (cmd === "new" && id) {
      const files = scaffold(id);
      for (const p of writeScaffold(into, files)) console.log(`wrote ${join(into, p)}`);
      const entryFile = existsSync(join(into, "packs.ts")) ? join(into, "packs.ts") : existsSync(join(into, "crates.ts")) ? join(into, "crates.ts") : undefined;
      const exportName = `${camel(id)}Crate`;
      if (entryFile) {
        const next = wirePackIntoFile(readFileSync(entryFile, "utf8"), `./crates/${id}/index.ts`, exportName);
        writeFileSync(entryFile, next);
        console.log(`wired ${exportName} into ${entryFile}`);
      } else {
        console.log(`\nAdd it to ${join(into, "crates.ts")}:\n  import { ${exportName} } from "./crates/${id}/index.ts";\n  …and ${exportName} in its list.`);
      }
      process.exit(0);
    }
    if (cmd === "add" && id) {
      const res = addPack({ id, into, from });
      for (const p of res.wrote) console.log(`wrote ${join(into, p)}`);
      if (res.wired) console.log(`wired ${res.exportName} into ${res.wired}`);
      else console.log(`\nAdd ${res.exportName} to your instance's crates.ts / packs.ts.`);
      process.exit(0);
    }
    console.error("usage:\n  pnpm packs add <id> [--into <instance folder>] [--from <dovre-packs folder>]\n  pnpm packs new <id> [--into <instance folder>]\n  pnpm packs list [--from <dovre-packs folder>]");
    process.exit(2);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
