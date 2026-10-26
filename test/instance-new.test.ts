/** `pnpm instance new`: a new instance from the template, placeholders filled, never over a file; its own test passes and its Worker loads. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { instanceFiles, writeInstance } from "../src/instance-new.ts";

const core = resolve(import.meta.dirname, "..");

test("instance new: the template's files, every placeholder filled; bad names refused; nothing overwritten", () => {
  const files = instanceFiles({ name: "acme-home", domain: "dovre.acme.dev" });
  assert.deepEqual(Object.keys(files).sort(), [".gitignore", "README.md", "package.json", "packs.ts", "test/packs.test.ts", "tsconfig.json", "worker.ts", "wrangler.jsonc"]);
  for (const [p, body] of Object.entries(files)) assert.doesNotMatch(body, /\{\{\w+\}\}/, p);
  assert.match(files["wrangler.jsonc"]!, /"pattern": "dovre\.acme\.dev"/);
  assert.match(files["package.json"]!, /migrations apply acme-home-db --remote/);
  assert.equal(JSON.parse(files["package.json"]!).name, "acme-home");
  const jsonc = JSON.parse(files["wrangler.jsonc"]!.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(jsonc.d1_databases[0].binding, "DB");
  for (const bad of [{ name: "Acme" }, { name: "a/b" }, { name: "ok", domain: "not a host" }, { name: "ok", domain: "x.y/z" }]) assert.throws(() => instanceFiles(bad));
  const dir = mkdtempSync(join(tmpdir(), "dovre-inst-"));
  writeInstance(dir, files);
  writeFileSync(join(dir, "packs.ts"), "mine");
  assert.throws(() => writeInstance(dir, files), /already there/);
  assert.equal(readFileSync(join(dir, "packs.ts"), "utf8"), "mine");
});

test("instance new: written beside core, its own test passes and its Worker answers with the setup page", () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-inst-"));
  writeInstance(dir, instanceFiles({ name: "fresh", domain: "dovre.fresh.dev" }));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(core, join(dir, "node_modules", "dovre"));
  const own = spawnSync(process.execPath, ["--test", join(dir, "test", "packs.test.ts")], { encoding: "utf8" });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { default: worker } = await import(${JSON.stringify(pathToFileURL(join(dir, "worker.ts")).href)});
    const res = await worker.fetch(new Request("https://dovre.fresh.dev/"), { IS_HOSTED: "1" });
    console.log(res.status, (await res.text()).includes("Dovre isn't set up yet"));
  `], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "503 true");
});
