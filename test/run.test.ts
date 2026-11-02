import assert from "node:assert/strict";
import { test } from "node:test";
import { firstPage, packIn, settingsOf } from "../src/run.ts";
import type { Pack } from "../src/packs/types.ts";

const pack = { manifest: { id: "http", name: "HTTP", settings: [{ key: "HTTP_ENVS", label: "x" }] }, nav: () => [{ href: "/http/quick", title: "HTTP" }] } as unknown as Pack;

test("packIn finds the export whose manifest has the id", () => {
  assert.equal(packIn({ other: { manifest: { id: "json" } }, httpPack: pack, n: 1 }, "http"), pack);
  assert.equal(packIn({ httpPack: pack }, "json"), undefined);
});

test("firstPage is the first nav entry, and never another site", () => {
  assert.equal(firstPage(pack), "/http/quick");
  assert.equal(firstPage({ ...pack, nav: () => [{ href: "//evil.example" }] } as unknown as Pack), "/http");
  assert.equal(firstPage({ ...pack, nav: () => { throw new Error("x"); } } as unknown as Pack), "/http");
});

test("settingsOf takes only the pack's own keys from the environment", () => {
  assert.deepEqual(settingsOf(pack, { HTTP_ENVS: "{}", GHE_TOKEN: "secret" }), { HTTP_ENVS: "{}" });
});
