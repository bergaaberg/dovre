/** Local only: the packs this machine's PACKS setting lists (PLAN D23). The Worker bundles its own instead. */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Off } from "./registry.ts";
import type { Pack, PacksModule } from "./types.ts";

/** Each folder (or file) in PACKS, imported: its default export's packs. A folder means its packs.ts (or crates.ts, an instance from before WP-M4). */
export async function loadPacks(list: string | undefined, env: Record<string, string | undefined>, opts: { home?: string } = {}): Promise<{ packs: Pack[]; failed: Off[] }> {
  const packs: Pack[] = [];
  const failed: Off[] = [];
  for (const raw of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const path = raw.replace(/^~(?=\/|$)/, opts.home ?? process.env.HOME ?? "~");
    const dir = path.replace(/\/$/, "");
    const file = /\.(ts|js|mjs)$/.test(path) ? path : existsSync(`${dir}/packs.ts`) || !existsSync(`${dir}/crates.ts`) ? `${dir}/packs.ts` : `${dir}/crates.ts`;
    try {
      const mod = (await import(pathToFileURL(file).href)) as PacksModule;
      const got = typeof mod.default === "function" ? mod.default(env) : mod.default;
      if (!Array.isArray(got)) throw new Error("its default export isn't a list of packs");
      packs.push(...got);
    } catch (e) {
      failed.push({ id: raw, name: raw, why: `didn't load: ${(e as Error)?.message ?? e}` });
    }
  }
  return { packs, failed };
}
