/**
 * The pack SDK for tests (#473): what a pack's tests import from core, as `dovre/pack-testing.ts`,
 * next to `dovre/pack.ts`. Not for a pack's own files: it mounts the whole app.
 */
export * from "./packs/testing.ts";
export { assertDoors, PACK_DOOR, PACK_TEST_DOOR, reachIns } from "./packs/imports.ts";
