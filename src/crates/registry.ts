/** The registry at its address before WP-M4 (crates -> packs), for instances not yet renamed: new code imports `dovre/packs/registry.ts`. */
export * from "../packs/registry.ts";
import { activePacks, type PackAct } from "../packs/registry.ts";
export const activeCrates = activePacks;
export type CrateAct = PackAct;
