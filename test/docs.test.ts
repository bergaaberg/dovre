/**
 * docs/ARCHITECTURE.md and the pack contract agree (#483), for the parts that can be counted: the
 * slots, what `PackContext` and `PackForge` give, the hooks, the API table and core's own packs. The
 * doc is written by hand; this only says "you added `ctx.soon` and the doc doesn't know". Names are
 * read out of the sources as text, the way test/style.test.ts reads classes.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACK_API } from "../src/packs/types.ts";

const DOC = readFileSync("docs/ARCHITECTURE.md", "utf8");
const TYPES = readFileSync("src/packs/types.ts", "utf8");
const CORE_PACKS = "src/packs/core";

/** The body of `export type <name> = { … };` in types.ts. */
const typeBody = (name: string): string => {
  const start = TYPES.indexOf(`export type ${name} = {\n`);
  assert.ok(start >= 0, `types.ts has ${name}`);
  const end = TYPES.indexOf("\n};", start);
  assert.ok(end > start, `${name} closes`);
  return TYPES.slice(start, end);
};

/** A type's own members: the names at one indent, not what's nested in them or written in a comment. */
const members = (name: string): string[] => [...typeBody(name).matchAll(/^ {2}"?([A-Za-z][\w.]*)"?\??[(:<]/gm)].map((m) => m[1]);

/** The doc from one marker up to the next (or to its end). */
const part = (from: string, to?: string): string => {
  const start = DOC.indexOf(from);
  assert.ok(start >= 0, `the doc has "${from}"`);
  const end = to ? DOC.indexOf(to, start + from.length) : DOC.length;
  assert.ok(end > start, `the doc has "${to}" after "${from}"`);
  return DOC.slice(start, end);
};

/** The names a piece of the doc writes as code: `fill(slot, arg)` and `manifest.ai` name `fill`, `manifest` and `ai`. */
const named = (text: string): Set<string> => new Set([...text.matchAll(/`([^`\n]+)`/g)].flatMap((m) => m[1].match(/[A-Za-z_]\w*/g) ?? []));

const unnamed = (names: string[], text: string): string[] => {
  const seen = named(text);
  return names.filter((n) => !seen.has(n));
};

test("the doc counts the slots SlotMap has", () => {
  const slots = members("SlotMap");
  assert.ok(slots.length > 10, "read SlotMap's names");
  const said = /`slots` \((\d+) in `SlotMap`\)/.exec(DOC);
  assert.ok(said, "the hooks table says how many slots there are");
  assert.equal(Number(said[1]), slots.length, "a slot was added or removed: fix the count in docs/ARCHITECTURE.md");
});

test("everything PackContext gives is in the doc's list", () => {
  const list = part("**`PackContext`** gives a pack:", "**Hooks**");
  assert.deepEqual(unnamed(members("PackContext"), list), [], "a ctx member the doc's PackContext list doesn't name");
  // What `forge()` answers is a list of its own inside that one.
  const forge = members("PackForge");
  assert.ok(forge.includes("propose"), "read PackForge's names");
  assert.deepEqual(unnamed(forge, list), [], "a forge() member the doc's PackContext list doesn't name");
});

test("every Pack hook is in the doc's hooks table", () => {
  const hooks = members("Pack");
  assert.ok(hooks.includes("routes") && hooks.includes("email"), "read Pack's names");
  assert.deepEqual(unnamed(hooks, part("**Hooks**, by where they land:", "**Pages draw from memory.**")), [], "a hook the doc's table doesn't name");
});

test("the API table has a row for every minor up to PACK_API, as one table", () => {
  const table = part("  | API | Added |", "\n## ");
  const lines = table.split("\n").filter((l) => l.trim().startsWith("|"));
  // A row that loses the list's indent starts a second table.
  assert.deepEqual(lines.filter((l) => !l.startsWith("  | ")), [], "every row keeps the two-space indent");
  const rows = lines.slice(2).map((l) => l.split("|")[1].trim());
  const [major, minor] = PACK_API.split(".").map(Number);
  assert.deepEqual(rows, Array.from({ length: minor + 1 }, (_, n) => `${major}.${n}`), "one row a minor, in order, the last being PACK_API");
  assert.ok(DOC.includes(`(PACK_API = "${PACK_API}")`), "the layers diagram names this PACK_API");
});

test("the layers diagram lists core's packs by id", () => {
  const ids = readdirSync(CORE_PACKS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const source = readFileSync(join(CORE_PACKS, e.name, "index.ts"), "utf8");
      // The manifest's id: a literal, or a constant set in the same file.
      const id = /^\s+id: (?:"([a-z-]+)"|([A-Z_]+)),$/m.exec(source);
      assert.ok(id, `${e.name}/index.ts has a manifest id`);
      const value = id[1] ?? new RegExp(`const ${id[2]} = "([a-z-]+)"`).exec(source)?.[1];
      assert.ok(value, `${e.name}/index.ts sets ${id[2]}`);
      return value;
    });
  const listed = part("Core's packs (src/packs/core/)\n", "\n Core (this repo)")
    .split("\n")
    .slice(1)
    .flatMap((l) => l.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(listed.sort(), ids.sort());
});
