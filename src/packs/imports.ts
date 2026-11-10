/**
 * The one-door rule (#473): a pack imports core as `dovre/pack.ts`, and `dovre/pack-testing.ts`
 * in its tests. Any other `dovre/…` path is a reach-in: since 2.0 `package.json` exports only the
 * doors and an instance's wiring, and the rest may move without notice. A packs repo's test calls
 * `assertDoors`; an instance still moving may pass the reach-ins it has left, counted per module,
 * so a new one fails and the list only shrinks.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** What a pack's own files import. */
export const PACK_DOOR = "dovre/pack.ts";
/** What its tests may import as well. */
export const PACK_TEST_DOOR = "dovre/pack-testing.ts";

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(dovre\/[^"'\n]+)\1/g;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : /\.[cm]?tsx?$/.test(e.name) ? [p] : [];
  });
}

/** A file under a `test` folder, or named `*.test.ts`. */
const isTest = (rel: string) => rel.split("/").includes("test") || /\.test\.[cm]?tsx?$/.test(rel);

/**
 * Every import of core under `dir` (a `packs` folder) that isn't through a door, as imports per
 * module, sorted. The testing door counts as a reach-in from a file that isn't a test.
 */
export function reachIns(dir: string): Record<string, number> {
  const n = new Map<string, number>();
  for (const file of tsFiles(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const mod = m[2]!;
      if (mod === PACK_DOOR || (mod === PACK_TEST_DOOR && isTest(rel))) continue;
      n.set(mod, (n.get(mod) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...n].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Fails unless the reach-ins under `dir` are exactly `allow` (imports per module). More than
 * allowed is a new reach-in; fewer means the list is out of date, so it can't grow back.
 */
export function assertDoors(dir: string, allow: Record<string, number> = {}) {
  const now = reachIns(dir);
  const more = Object.entries(now).filter(([mod, n]) => n > (allow[mod] ?? 0)).map(([mod, n]) => `${mod}: ${n} (allowed ${allow[mod] ?? 0})`);
  assert.deepEqual(more, [], `packs import core through ${PACK_DOOR} (${PACK_TEST_DOOR} in tests); these go around it`);
  const fewer = Object.entries(allow).filter(([mod, n]) => (now[mod] ?? 0) < n).map(([mod, n]) => `${mod}: ${now[mod] ?? 0} (listed ${n})`);
  assert.deepEqual(fewer, [], "fewer reach-ins than listed: lower the list to match, so they can't come back");
}
