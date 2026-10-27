/**
 * The assistant, a core pack (PLAN WP-M4): Bino. PACK_ASSISTANT=off switches it off.
 *
 * Bino (conversations, memory, its model route, the dock) is still wired by the core (src/app.ts,
 * src/hosted/hub.ts); this pack is its switch and its place on /packs. Topo, what each repo is
 * (peak.yaml), is its own pack in bergaaberg/dovre-packs (`pnpm packs add topo`, #147).
 */
import { type Pack, PACK_API } from "../../types.ts";

const MANIFEST = {
  api: PACK_API,
  id: "assistant",
  name: "Assistant",
  description: "Bino: scoped memory, what the packs know about your repos and apps, and plan proposals",
  domain: "general",
} as const;

export function assistantPack(): Pack {
  return { manifest: { ...MANIFEST } };
}
