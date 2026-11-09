/**
 * The pack SDK (#473): what a pack imports from core, as `dovre/pack.ts`. This file is the
 * contract. What it exports is what `PACK_API` versions: a name added here is a minor, one taken
 * away or changed is a major (`test/sdk.test.ts` holds the list). Any other path under `dovre/…`
 * may move without notice.
 *
 * A flat barrel: nothing is defined here but `Pulse`, which is both a contract type and a kit part.
 * A pack's tests also get `dovre/pack-testing.ts`.
 */
import type { Pulse as PulseState } from "./packs/types.ts";
import { Pulse as PulseChart } from "./ui/kit.ts";

/** The contract: `Pack`, `PackContext`, `PACK_API` and every type they name. */
export * from "./packs/types.ts";
/** The kit: every page and card is built from these, and `html` escapes what goes in. */
export * from "./ui/kit.ts";
/** Acts for Bino that check, confirm and log before they write. */
export * from "./packs/acts.ts";
/** Links and small parts: every `href` built from data goes through `safeUrl`. */
export { Ago, failed, Link, safeUrl, trunc } from "./pages/parts.ts";
/** Core's Markdown, as inert HTML. */
export { markdown } from "./ui/markdown.ts";

/** The kit's requests-and-errors chart; as a type, what the header's pulse shows (`PulseFeed` is what a pack reports). */
export const Pulse = PulseChart;
export type Pulse = PulseState;
