/**
 * This instance's packs: each one app Dovre works with. Locally, Dovre's PACKS=<this folder>
 * imports this file; hosted, worker.ts bundles it. Start one with
 * `pnpm --dir ../dovre pack new <id> --into .`, then add it to the list.
 */
import type { Pack } from "dovre/packs/types.ts";

const packs: Pack[] = [];

export default packs;
