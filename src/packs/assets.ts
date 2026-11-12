/**
 * The hosted Worker's static assets: Dovre's icons and fonts, and each pack's WebAssembly files
 * (Pack.wasm as a WasmFile) and big scripts and stylesheets (Pack.files), checked and written where the app serves them from (`ASSETS`). It's an
 * instance's wrangler `build` step, run from the instance folder:
 *
 *   "build": { "command": "node ../dovre/src/packs/assets.ts --out .assets" },
 *   "assets": { "directory": ".assets", "binding": "ASSETS", "run_worker_first": true }
 *
 * It imports the instance's packs.ts under Node, so a pack's `load` can read its own folder.
 *
 * A module over 25 MiB (the static assets' limit for a file) is checked here but not written: it
 * goes to R2, before `wrangler deploy`, and the Worker reads it from the `PACK_FILES` binding:
 *
 *   node ../dovre/src/packs/assets.ts --r2 <bucket>
 *
 * Its key is its path under `/assets/`, its SHA-256 in the name, so a module goes up once: the keys
 * sent are kept in `.assets-r2` (one per line) and not sent again.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pack } from "./types.ts";
import { ASSET_MAX, fileWhy, isWasmFile, packFileAt, packFileNameOk, packFileWhy, shaOk, wasmFileAt, wasmNameOk } from "./wasm.ts";

/** Dovre's own static files (icons, fonts). */
const CORE_ASSETS = resolve(import.meta.dirname, "..", "..", "assets");

/** Writes `out` afresh; returns the pack files written, or throws naming every module that failed. Modules over 25 MiB are checked, not written (`bigModules`). */
export async function buildAssets(o: { packs: Pack[]; out: string; core?: string }): Promise<string[]> {
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  cpSync(o.core ?? CORE_ASSETS, o.out, { recursive: true });
  const wrote: string[] = [];
  const failed: string[] = [];
  const write = async (what: string, file: { sha256: string; load(): Uint8Array | Promise<Uint8Array> }, check: (b: unknown, sha: string) => Promise<string>, at: string) => {
    let why: string;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await file.load();
      why = await check(bytes, file.sha256);
    } catch (e) {
      why = `didn't load: ${String((e as Error).message ?? e).slice(0, 200)}`;
    }
    if (why) return void failed.push(`${what} ${why}`);
    // Over the static assets' limit: R2's (`--r2`), not written here.
    if (bytes!.length > ASSET_MAX) return;
    mkdirSync(dirname(join(o.out, at)), { recursive: true });
    writeFileSync(join(o.out, at), bytes!);
    wrote.push(at);
  };
  for (const p of o.packs) {
    for (const [name, mod] of Object.entries(p.wasm ?? {})) {
      if (!isWasmFile(mod)) continue;
      const what = `pack ${p.manifest.id}: wasm ${name.slice(0, 40)}`;
      if (!wasmNameOk(name) || !shaOk(mod.sha256)) {
        failed.push(`${what} needs a lowercase name and a 16-digit hex sha256`);
        continue;
      }
      await write(what, mod, fileWhy, wasmFileAt(p.manifest.id, name, mod.sha256));
    }
    for (const [name, f] of Object.entries(p.files ?? {})) {
      const what = `pack ${p.manifest.id}: file ${name.slice(0, 40)}`;
      if (!packFileNameOk(name) || !isWasmFile(f) || !shaOk(f.sha256)) {
        failed.push(`${what} needs a lowercase name ending .js or .css, a 16-digit hex sha256 and a load`);
        continue;
      }
      await write(what, f, packFileWhy, packFileAt(p.manifest.id, name, f.sha256));
    }
  }
  if (failed.length) throw new Error(failed.join("\n"));
  return wrote;
}

/** Each pack's modules over 25 MiB, checked: key (its path under `/assets/`) → bytes. Throws naming any that fails. */
export async function bigModules(packs: Pack[]): Promise<Map<string, Uint8Array>> {
  const big = new Map<string, Uint8Array>();
  const failed: string[] = [];
  for (const p of packs)
    for (const [name, mod] of Object.entries(p.wasm ?? {})) {
      if (!isWasmFile(mod) || !wasmNameOk(name) || !shaOk(mod.sha256)) continue;
      const what = `pack ${p.manifest.id}: wasm ${name}`;
      try {
        const bytes = await mod.load();
        const why = await fileWhy(bytes, mod.sha256);
        if (why) failed.push(`${what} ${why}`);
        else if (bytes.length > ASSET_MAX) big.set(wasmFileAt(p.manifest.id, name, mod.sha256), bytes);
      } catch (e) {
        failed.push(`${what} didn't load: ${String((e as Error).message ?? e).slice(0, 200)}`);
      }
    }
  if (failed.length) throw new Error(failed.join("\n"));
  return big;
}

/**
 * Sends each module over 25 MiB to the R2 bucket, unless `sent` (`.assets-r2`) has its key. `put`
 * uploads one file (wrangler); returns the keys sent now.
 */
export async function uploadBig(o: { packs: Pack[]; bucket: string; sent: string; put?: (bucket: string, key: string, file: string) => void }): Promise<string[]> {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error(`${o.bucket.slice(0, 80)} isn't an R2 bucket name`);
  const done = new Set(existsSync(o.sent) ? readFileSync(o.sent, "utf8").split("\n").filter(Boolean) : []);
  const put = o.put ?? wranglerPut;
  const now: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "dovre-r2-"));
  try {
    for (const [key, bytes] of await bigModules(o.packs)) {
      if (done.has(key)) continue;
      const file = join(tmp, "module.wasm");
      writeFileSync(file, bytes);
      put(o.bucket, key, file);
      appendFileSync(o.sent, `${key}\n`);
      now.push(key);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return now;
}

function wranglerPut(bucket: string, key: string, file: string) {
  const r = spawnSync("wrangler", ["r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", "application/wasm", "--remote"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`wrangler couldn't put ${key} in ${bucket}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const out = resolve(flag("--out") ?? ".assets");
  const bucket = flag("--r2");
  const entry = [resolve("packs.ts")].find(existsSync);
  try {
    const packs = entry ? ((await import(pathToFileURL(entry).href)) as { default: Pack[] }).default : [];
    if (bucket !== undefined) {
      const sent = await uploadBig({ packs, bucket, sent: resolve(".assets-r2") });
      console.log(`assets: ${sent.length ? `sent ${sent.join(", ")} to R2 ${bucket}` : `R2 ${bucket} has every module over 25 MiB`}`);
      process.exit(0);
    }
    const wrote = await buildAssets({ packs, out });
    console.log(`assets: Dovre's icons and fonts${wrote.length ? `, ${wrote.join(", ")}` : ""} in ${out}`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
