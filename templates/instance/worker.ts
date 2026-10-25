/** The hosted Worker ({{domain}}): Dovre's core with this instance's packs. */
import { createWorker } from "dovre/worker.ts";
import packs from "./packs.ts";

export default createWorker({ packs });

/** Core's Durable Object: live pages hosted and Bino answering (bound as HUB in wrangler.jsonc). */
export { DovreHub } from "dovre/hosted/hub.ts";
