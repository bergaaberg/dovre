/**
 * A pack's declared `api` is checked, not promised (#482): a pack's manifest names the oldest
 * `PACK_API` it works with, and an older core shows it as off instead of half-working. That only
 * holds while the number is true. `apiUses` reads a pack (as loaded, and its files as text)
 * against what each minor added (`API_ADDED`, src/packs/api.ts); `assertApi` fails on a name newer
 * than the manifest says: the forgotten bump. For a packs repo's tests and its release script.
 *
 * The stricter check, typechecking a pack against core as it was at its declared minor, needs a
 * commit and a worktree per floor; not done.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ADDED, apiCompare, apiText, parseApi } from "./api.ts";
import { PACK_DOOR, PACK_TEST_DOOR } from "./imports.ts";
import type { Pack } from "./types.ts";

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.[cm]?tsx?$/.test(e.name) ? [readFileSync(p, "utf8")] : [];
  });
}

/** The names a file imports (or re-exports) by name from a module: `a`, `type B` and `c as d` give a, B, c. */
function imported(source: string, mod: string): string[] {
  const from = mod.replace(/[.\/]/g, "\\$&");
  return [...source.matchAll(new RegExp(`\\b(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${from}["']`, "g"))].flatMap((m) =>
    m[1]!
      .split(",")
      .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean),
  );
}

/** What a pack uses of each minor's additions, oldest first: the pack as loaded, and the files under `dir` (its folder, tests too). */
export function apiUses(pack: Pack, dir: string): { name: string; api: string }[] {
  const files = sources(dir);
  const all = files.join("\n");
  const doors = new Set(files.flatMap((f) => imported(f, PACK_DOOR)));
  const tests = new Set(files.flatMap((f) => imported(f, PACK_TEST_DOOR)));
  return Object.entries(API_ADDED)
    .sort(([a], [b]) => apiCompare(a, b))
    .flatMap(([api, uses]) =>
      uses
        .filter((u) => {
          try {
            return (u.has?.(pack) ?? false) || (u.text?.test(all) ?? false) || (!!u.door && doors.has(u.door)) || (!!u.testing && tests.has(u.testing));
          } catch {
            return false; // a manifest too odd to read is another check's finding
          }
        })
        .map((u) => ({ name: u.name, api })),
    );
}

/** What a pack uses that's newer than its manifest's `api`, as lines ("uses ctx.agent (1.23), declares 1.6"); empty when the number holds. */
export function apiOver(pack: Pack, dir: string): string[] {
  const declared = parseApi(pack.manifest.api);
  if (!declared) return [`its api ${JSON.stringify(pack.manifest.api) ?? "?"} isn't a version`];
  return apiUses(pack, dir)
    .filter((u) => apiCompare(u.api, apiText(declared)) > 0)
    .map((u) => `uses ${u.name} (${u.api}), declares ${apiText(declared)}`);
}

/** Fails when a pack uses something newer than its manifest's `api`, naming each name and its minor. `dir` is the pack's folder. */
export function assertApi(pack: Pack, dir: string) {
  assert.ok(existsSync(dir), `${pack.manifest.id}: no folder at ${dir}`);
  assert.deepEqual(apiOver(pack, dir), [], `${pack.manifest.id}: raise its manifest's api to the newest minor it uses`);
}
