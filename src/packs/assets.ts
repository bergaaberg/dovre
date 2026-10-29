/**
 * The hosted Worker's static assets: Dovre's icons and fonts, and each pack's WebAssembly files
 * (Pack.wasm as a WasmFile), checked and written where the app serves them from (`ASSETS`). It's an
 * instance's wrangler `build` step, run from the instance folder:
 *
 *   "build": { "command": "node ../dovre/src/packs/assets.ts --out .assets" },
 *   "assets": { "directory": ".assets", "binding": "ASSETS", "run_worker_first": true }
 *
 * It imports the instance's packs.ts under Node, so a pack's `load` can read its own folder.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pack } from "./types.ts";
import { fileWhy, isWasmFile, shaOk, wasmFileAt, wasmNameOk } from "./wasm.ts";

/** Dovre's own static files (icons, fonts). */
export const CORE_ASSETS = resolve(import.meta.dirname, "..", "..", "assets");

/** Writes `out` afresh; returns the WebAssembly files written, or throws naming every module that failed. */
export async function buildAssets(o: { packs: Pack[]; out: string; core?: string }): Promise<string[]> {
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  cpSync(o.core ?? CORE_ASSETS, o.out, { recursive: true });
  const wrote: string[] = [];
  const failed: string[] = [];
  for (const p of o.packs) {
    for (const [name, mod] of Object.entries(p.wasm ?? {})) {
      if (!isWasmFile(mod)) continue;
      const what = `pack ${p.manifest.id}: wasm ${name.slice(0, 40)}`;
      if (!wasmNameOk(name) || !shaOk(mod.sha256)) {
        failed.push(`${what} needs a lowercase name and a 16-digit hex sha256`);
        continue;
      }
      let why: string;
      let bytes: Uint8Array | undefined;
      try {
        bytes = await mod.load();
        why = await fileWhy(bytes, mod.sha256);
      } catch (e) {
        why = `didn't load: ${String((e as Error).message ?? e).slice(0, 200)}`;
      }
      if (why) {
        failed.push(`${what} ${why}`);
        continue;
      }
      const at = wasmFileAt(p.manifest.id, name, mod.sha256);
      mkdirSync(join(o.out, "wasm"), { recursive: true });
      writeFileSync(join(o.out, at), bytes!);
      wrote.push(at);
    }
  }
  if (failed.length) throw new Error(failed.join("\n"));
  return wrote;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const out = resolve(flag("--out") ?? ".assets");
  const entry = ["packs.ts", "crates.ts"].map((f) => resolve(f)).find(existsSync);
  try {
    const packs = entry ? ((await import(pathToFileURL(entry).href)) as { default: Pack[] }).default : [];
    const wrote = await buildAssets({ packs, out });
    console.log(`assets: Dovre's icons and fonts${wrote.length ? `, ${wrote.join(", ")}` : ""} in ${out}`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
