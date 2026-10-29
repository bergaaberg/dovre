/**
 * This instance's packs: each one app Dovre works with. Locally, Dovre's PACKS=<this folder>
 * imports this file; hosted, worker.ts bundles it. Start one with
 * `node ../dovre/src/packs/new.ts new <id> --into .`, then add it to the list (`… add <id>`
 * copies one from dovre-packs and lists it for you).
 */
import type { Pack } from "dovre/packs/types.ts";

const packs: Pack[] = [];

export default packs;
