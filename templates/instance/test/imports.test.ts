/** One door: packs import core as dovre/pack.ts (dovre/pack-testing.ts in their tests), nothing else. */
import { join } from "node:path";
import { test } from "node:test";
import { assertDoors } from "dovre/pack-testing.ts";

test("packs import core only through its SDK", () => {
  // A reach-in that can't go yet is listed with its count ({ "dovre/strict.ts": 1 }). The list only shrinks.
  assertDoors(join(import.meta.dirname, "..", "packs"), {});
});
