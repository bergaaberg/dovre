/**
 * The hosted Workers for packs' servers (Pack.server, #304): one Worker per pack, generated from
 * its script and the `wasm` modules it uses, which are imported at build time (a Worker can't
 * compile WebAssembly from bytes at run time). Run from the instance folder:
 *
 *   node ../dovre/src/packs/servers.ts --out .servers --name dovre            # write them
 *   node ../dovre/src/packs/servers.ts --out .servers --name dovre --deploy   # and deploy each
 *
 * Each goes to `<out>/<id>/` as `index.js`, `server.js`, its modules and a `wrangler.jsonc` naming
 * the Worker `<name>-pack-<id>`: no routes, no workers.dev URL, no bindings, and a CPU limit of
 * the server's own `ms`. The app's Worker reaches it through a service binding, which this prints:
 *
 *   { "binding": "SERVER_CODE_REVIEW", "service": "dovre-pack-code-review", "entrypoint": "PackServer" }
 *
 * It imports the instance's packs.ts under Node, as src/packs/assets.ts does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_ENTRYPOINT, serverBinding, serverMs, serverScript, serverWasm, serverWhy } from "./server.ts";
import type { Pack } from "./types.ts";

/** A built server: where it is, its Worker's name, and the binding line for the app's wrangler.jsonc. */
export type BuiltServer = { id: string; dir: string; worker: string; binding: { binding: string; service: string; entrypoint: string } };

const COMPAT = "2026-10-06";
const nameOk = (n: string) => /^[a-z][a-z0-9-]{0,30}$/.test(n);

/** The generated Worker's entry: the calls it takes, checked again here, and the script's answer as JSON. */
export function serverEntry(calls: string[], wasm: string[]): string {
  const imports = wasm.map((n, i) => `import w${i} from "./${n}.wasm";`).join("\n");
  const table = `{ ${wasm.map((n, i) => `${JSON.stringify(n)}: w${i}`).join(", ")} }`;
  return `// Written by dovre/src/packs/servers.ts: don't edit, run it again.
import { WorkerEntrypoint } from "cloudflare:workers";
import { call } from "./server.js";
${imports}
const WASM = ${table};
const CALLS = new Set(${JSON.stringify(calls)});
export class ${SERVER_ENTRYPOINT} extends WorkerEntrypoint {
  async call(fn, input) {
    if (!CALLS.has(fn)) throw new Error("not one of its calls");
    const value = await call(fn, JSON.parse(input), WASM);
    return JSON.stringify(value === undefined ? null : value);
  }
}
export default { fetch: () => new Response("Not found", { status: 404 }) };
`;
}

/** The compatibility date of the app's own wrangler.jsonc, so both Workers run the same runtime. */
function compatOf(file: string): string {
  try {
    return readFileSync(file, "utf8").match(/"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? COMPAT;
  } catch {
    return COMPAT;
  }
}

/** Writes `out` afresh with a Worker per pack that has a server; throws naming every one that failed. */
export async function buildServers(o: { packs: Pack[]; out: string; name: string; compat?: string }): Promise<BuiltServer[]> {
  if (!nameOk(o.name)) throw new Error(`--name ${JSON.stringify(o.name)} isn't a lowercase Worker name`);
  rmSync(o.out, { recursive: true, force: true });
  const built: BuiltServer[] = [];
  const failed: string[] = [];
  for (const p of o.packs) {
    if (!p.server) continue;
    const id = p.manifest.id;
    const why = serverWhy(p);
    if (why) {
      failed.push(`pack ${id}: server ${why}`);
      continue;
    }
    let script: string;
    let wasm: Record<string, Uint8Array>;
    try {
      script = await serverScript(p.server);
      wasm = await serverWasm(p);
    } catch (e) {
      failed.push(`pack ${id}: server ${String((e as Error).message ?? e).slice(0, 300)}`);
      continue;
    }
    const dir = join(o.out, id);
    const worker = `${o.name}-pack-${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server.js"), script);
    for (const [n, b] of Object.entries(wasm)) writeFileSync(join(dir, `${n}.wasm`), b);
    writeFileSync(join(dir, "index.js"), serverEntry(p.server.calls, Object.keys(wasm)));
    const config = {
      name: worker,
      main: "index.js",
      compatibility_date: o.compat ?? COMPAT,
      // Reached only over the service binding.
      workers_dev: false,
      preview_urls: false,
      limits: { cpu_ms: serverMs(p.server) },
      rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false }],
    };
    writeFileSync(join(dir, "wrangler.jsonc"), `// Written by dovre/src/packs/servers.ts: don't edit, run it again.\n${JSON.stringify(config, null, 2)}\n`);
    built.push({ id, dir, worker, binding: { binding: serverBinding(id), service: worker, entrypoint: SERVER_ENTRYPOINT } });
  }
  if (failed.length) throw new Error(failed.join("\n"));
  return built;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const out = resolve(flag("--out") ?? ".servers");
  const entry = [resolve("packs.ts")].find(existsSync);
  try {
    const packs = entry ? ((await import(pathToFileURL(entry).href)) as { default: Pack[] }).default : [];
    const built = await buildServers({ packs, out, name: flag("--name") ?? "dovre", compat: compatOf(resolve("wrangler.jsonc")) });
    if (!built.length) console.log("servers: no pack here has a server");
    for (const b of built) {
      console.log(`servers: ${b.worker} in ${b.dir}`);
      console.log(`  binding for wrangler.jsonc "services": ${JSON.stringify(b.binding)}`);
    }
    if (args.includes("--deploy")) {
      for (const b of built) {
        const r = spawnSync("npx", ["wrangler", "deploy", "-c", join(b.dir, "wrangler.jsonc")], { stdio: "inherit" });
        if (r.status !== 0) throw new Error(`servers: deploying ${b.worker} failed`);
      }
    }
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
