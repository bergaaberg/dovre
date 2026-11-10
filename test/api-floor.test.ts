/**
 * A pack's declared `api` is checked (#482): `apiOver` and `assertApi` (src/packs/floor.ts) read a
 * pack against what each minor added (`API_ADDED`) and name what's newer than its manifest says.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as testingDoor from "../src/pack-testing.ts";
import { API_1, API_ADDED } from "../src/packs/api.ts";
import { apiOver, apiUses, assertApi } from "../src/packs/floor.ts";
import { scaffold } from "../src/packs/new.ts";
import { PACK_API, type Pack, type PackManifest } from "../src/packs/types.ts";

const packOf = (api: string | number, over: Partial<PackManifest> = {}, hooks: Partial<Pack> = {}): Pack => ({
  manifest: { api, id: "x", name: "X", description: "", domain: "personal", ...over },
  ...hooks,
});

/** A pack's folder with these files. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dovre-floor-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

test("API_ADDED has every minor up to PACK_API, and each name one way of being seen", () => {
  const [major, minor] = PACK_API.split(".").map(Number);
  assert.deepEqual(Object.keys(API_ADDED), Array.from({ length: minor! }, (_, n) => `${major}.${n + 1}`), "a new minor gets its entry (an empty list when nothing of it can be seen)");
  // 1.x's table, the record 2.0 started from, is what the tests below read the floor against.
  assert.deepEqual(Object.keys(API_1), Array.from({ length: 41 }, (_, n) => `1.${n + 1}`));
  const all = [...Object.values(API_1), ...Object.values(API_ADDED)].flat();
  for (const u of all) assert.equal([u.has, u.text, u.door, u.testing].filter(Boolean).length, 1, u.name);
  assert.equal(new Set(all.map((u) => u.name)).size, all.length, "a name is added once");
  for (const u of all) if (u.testing) assert.ok(u.testing in testingDoor, `${u.testing} is exported by dovre/pack-testing.ts`);
});

test("a pack using a newer name than it declares is named, with the minor", () => {
  const dir = folder({ "index.ts": `import type { Pack } from "dovre/pack.ts";\nexport const p: Pack = { routes(app, ctx) { void ctx.agent.can(); } };\n` });
  assert.deepEqual(apiOver(packOf("1.6"), dir, API_1), ["uses ctx.agent (1.23), declares 1.6", "uses dovre/pack.ts (1.24), declares 1.6"]);
  assert.deepEqual(apiOver(packOf("1.24"), dir, API_1), [], "declaring it is enough");
  assert.deepEqual(apiOver(packOf(PACK_API), dir, API_1), [], "and declaring more is harmless");
  assert.throws(() => assertApi(packOf("1.6"), dir, API_1), /x: raise its manifest's api/);
  assert.doesNotThrow(() => assertApi(packOf("1.24"), dir, API_1));
  assert.throws(() => assertApi(packOf("1.24"), join(dir, "nowhere"), API_1), /no folder/);
  assert.deepEqual(apiOver(packOf("soon"), dir, API_1), [`its api "soon" isn't a version`]);
});

test("what the door gives is seen by the names imported, types and renames too, over several lines", () => {
  const dir = folder({
    "view.ts": `import {\n  html,\n  format as f,\n  type Forge,\n} from "dovre/pack.ts";\nimport type { PackStore } from 'dovre/pack.ts';\n`,
    "test/x.test.ts": `import { testContext, openDb } from "dovre/pack-testing.ts";\n`,
    "node_modules/y/index.ts": `import { owners } from "dovre/pack.ts";\n`,
    "notes.md": "ctx.mcp",
  });
  assert.deepEqual(apiUses(packOf("1.0"), dir, API_1), [
    { name: "dovre/pack.ts", api: "1.24" },
    { name: "Forge", api: "1.27" },
    { name: "openDb", api: "1.27" },
    { name: "format", api: "1.29" },
    { name: "PackStore", api: "1.33" },
  ]);
});

test("ctx members, forge calls, slots and shares are seen in the text", () => {
  const dir = folder({
    "index.ts": [
      `const { store, log } = ctx;`,
      `const who = ctx.viewer();`,
      `const n = await ctx.forge()?.untriaged();`,
      `const forge = ctx.forge()!; await forge.pr("a/b", 1);`,
      `slots: () => ({ "pr.file": () => "" }),`,
      `const list = ctx.required("todo", "list");`,
      `const tally = ctx.required("counter", "tally"); ctx.required("agents", "agent"); ctx.required("agents", "auto");`,
      `ctx.directory; ctx.runner; forge.prs;`,
      // Another pack's place (#477) is a key of slots; a path in a table, a ternary's branch or a MIME type isn't (below).
      `const actions = ctx.fillOwn("span.actions", span); slots: () => ({ "otel-sink/span.actions": spanActions }),`,
      `if (following) ctx.soon(15_000); // "soon" in a sentence, or a.soon, isn't it`,
    ].join("\n"),
  });
  assert.deepEqual(
    apiUses(packOf("1.0"), dir, API_1).map((u) => `${u.api} ${u.name}`),
    ["1.2 slot pr.file", "1.11 share list", "1.12 share agent", "1.20 forge().untriaged", "1.21 forge().pr", "1.31 ctx.viewer", "1.33 ctx.store", "1.38 a pack's own share in ctx.required", "1.39 ctx.fillOwn", "1.39 another pack's place in slots", "1.40 ctx.soon"],
  );
  const not = folder({ "index.ts": `const signal = { "v1/traces": "traces" }; const t = xml ? "a/b" : c; const draw = { "text/html": page };` });
  assert.deepEqual(apiUses(packOf("1.0"), not, API_1), []);
});

test("manifest fields and hooks are seen on the pack as loaded", () => {
  const dir = folder({ "index.ts": "" });
  const pack = packOf(
    "1.0",
    { version: "1.0.0", uses: ["todo"], binaries: ["dot"], ai: { text: { why: "sums" }, mcp: { why: "reads", server: "s", reads: [] } as never }, settings: [{ key: "K", label: "K", namesKeys: true }, { key: "V", label: "V", choices: [{ value: "a", label: "A" }] }] },
    { migrations: ["create table x_a (id)"], files: { "big.js": { sha256: "0", load: () => new Uint8Array(), wasm: true } } },
  );
  assert.deepEqual(
    apiUses(pack, dir, API_1).map((u) => `${u.api} ${u.name}`),
    ["1.1 Pack.files", "1.3 a file with wasm: true", "1.6 manifest.version", "1.11 manifest.uses", "1.15 a setting's choices", "1.22 manifest.ai", "1.26 manifest.binaries", "1.34 manifest.ai.mcp", "1.35 Pack.migrations", "1.36 a setting's namesKeys"],
  );
  assert.deepEqual(apiUses(packOf("1.0"), dir, API_1), [], "a bare pack uses nothing");
});

test("a scaffolded pack declares what it uses", () => {
  const files = scaffold("fresh");
  const dir = folder(Object.fromEntries(Object.entries(files).map(([p, body]) => [p.replace("packs/fresh/", ""), body])));
  assert.deepEqual(apiOver(packOf(PACK_API, { version: "0.1.0" }), dir, API_1), []);
  assert.match(files["packs/fresh/test/fresh.test.ts"]!, /assertApi\(freshPack, join\(import\.meta\.dirname, "\.\."\)\)/);
  assert.ok(apiOver(packOf("1.0"), dir, API_1).includes("uses assertApi (1.37), declares 1.0"));
});
