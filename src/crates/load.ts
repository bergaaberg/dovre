/** The loader at its address before WP-M4 (crates -> packs), for instances not yet renamed: new code imports `dovre/packs/load.ts`. */
export * from "../packs/load.ts";
import { loadPacks } from "../packs/load.ts";
export const loadCrates = loadPacks;
