/** This instance's packs: each one Dovre's core would take (ids, contract), none twice. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { activePacks } from "dovre/packs/registry.ts";
import packs from "../packs.ts";

test("every pack has a manifest core takes, and no id twice", () => {
  const { off } = activePacks(packs, { env: {}, bindings: {}, hosted: true });
  const bad = off.filter((o) => /lowercase|same id|contract/.test(o.why));
  assert.deepEqual(bad, []);
});
