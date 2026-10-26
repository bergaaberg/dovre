/** `pnpm packs new`: a new pack in the one shape, that the core takes and whose own tests pass as written. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { scaffold, writeScaffold } from "../src/packs/new.ts";

const core = resolve(import.meta.dirname, "..");

test("pack new: the four files, under the pack's id; a bad id refused; nothing overwritten", () => {
  const files = scaffold("my-app");
  assert.deepEqual(Object.keys(files), ["packs/my-app/index.ts", "packs/my-app/data.ts", "packs/my-app/view.ts", "packs/my-app/test/my-app.test.ts"]);
  assert.match(files["packs/my-app/index.ts"]!, /export const myAppPack: Pack/);
  assert.match(files["packs/my-app/index.ts"]!, /name: "My App"/);
  for (const bad of ["My", "1x", "../x", "a/b", ""]) assert.throws(() => scaffold(bad), /isn't a pack id/, bad);
  const dir = mkdtempSync(join(tmpdir(), "dovre-inst-"));
  writeScaffold(dir, files);
  writeFileSync(join(dir, "packs/my-app/view.ts"), "mine");
  assert.throws(() => writeScaffold(dir, files), /already there/);
  assert.equal(readFileSync(join(dir, "packs/my-app/view.ts"), "utf8"), "mine");
});

test("pack new: written into an instance that links core, its own tests pass and the core takes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-inst-"));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(core, join(dir, "node_modules", "dovre"));
  symlinkSync(join(core, "node_modules", "hono"), join(dir, "node_modules", "hono"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeScaffold(dir, scaffold("fresh"));
  writeFileSync(join(dir, "packs.ts"), `import { freshPack } from "./packs/fresh/index.ts";\nexport default [freshPack];\n`);
  const own = spawnSync(process.execPath, ["--test", join(dir, "packs", "fresh", "test", "fresh.test.ts")], { encoding: "utf8" });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  const check = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { loadPacks } = await import(${JSON.stringify(pathToFileURL(join(core, "src/packs/load.ts")).href)});
    const { activePacks } = await import(${JSON.stringify(pathToFileURL(join(core, "src/packs/registry.ts")).href)});
    const { packs, failed } = await loadPacks(${JSON.stringify(dir)}, {});
    const a = activePacks(packs, { env: {}, hosted: false });
    console.log(JSON.stringify({ on: a.on.map((c) => c.manifest.id), off: a.off, failed }));
  `], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), { on: ["fresh"], off: [], failed: [] });
});
