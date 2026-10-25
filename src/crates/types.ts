/**
 * The pack contract's address and names before WP-M4 (crates -> packs), for instances not yet
 * renamed: `dovre/crates/types.ts` and Crate, CrateContext… still work. New code imports
 * `dovre/packs/types.ts`.
 */
export * from "../packs/types.ts";
import { PACK_API } from "../packs/types.ts";
import type { Pack, PackContext, PackDomain, PackManifest, PackNeed, PackNote, PackSetting, PacksModule } from "../packs/types.ts";
export const CRATE_API = PACK_API;
export type CrateDomain = PackDomain;
export type CrateSetting = PackSetting;
export type CrateManifest = PackManifest;
export type CrateNeed = PackNeed;
export type CrateContext = PackContext;
export type CrateNote = PackNote;
export type Crate = Pack;
export type CratesModule = PacksModule;
