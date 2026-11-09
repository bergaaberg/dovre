/**
 * The pack SDK for tests (#473): what a pack's tests import from core, as `dovre/pack-testing.ts`,
 * next to `dovre/pack.ts`. Not for a pack's own files: it mounts the whole app.
 */
export * from "./packs/testing.ts";
export { assertDoors, PACK_DOOR, PACK_TEST_DOOR, reachIns } from "./packs/imports.ts";
/** A fresh in-memory database with core's tables, for a pack's store tests. */
export { openDb } from "./db.ts";
/** For a packs repo's own tests: which of its packs core takes, and whether a pack's `api` runs on this core. */
export { activePacks } from "./packs/registry.ts";
export { apiGap } from "./packs/api.ts";
/** Core's client script (`dovreOn`), for testing a pack script that listens with it. */
export { ON_JS } from "./ui/on.js.ts";
/** My time zone and greeting for a test, and back. */
export { resetWhen, setWhen } from "./when.ts";
/** Hosted: the Worker around these packs, and a token for a pack's ingest route. */
export { createWorker } from "./worker.ts";
export { createToken as ingestToken } from "./packs/ingest.ts";
