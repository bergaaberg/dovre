/**
 * The hook table (#481, src/packs/hooks.ts): held to the `Pack` type and to ARCHITECTURE's hooks
 * table, and one test over every hook core calls through a `…From`: a pack that throws, and
 * answers of the wrong shape, take nothing down and leave nothing behind.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HOOKS, hooksOf } from "../src/packs/hooks.ts";
import { testContext } from "../src/packs/testing.ts";
import { type Pack, PACK_API, type PackManifest } from "../src/packs/types.ts";
import { H } from "./helpers.ts";

const DOC = readFileSync("docs/ARCHITECTURE.md", "utf8");
const TYPES = readFileSync("src/packs/types.ts", "utf8");

/** The members of `export type Pack = { … };` in types.ts. */
const packMembers = (): string[] => {
  const start = TYPES.indexOf("export type Pack = {\n");
  const body = TYPES.slice(start, TYPES.indexOf("\n};", start));
  return [...body.matchAll(/^  ([A-Za-z_]\w*)\??[(:]/gm)].map((m) => m[1]!);
};

/** ARCHITECTURE's hooks table, a row by its first cell. */
const rows = (): Map<string, string> => {
  const start = DOC.indexOf("**Hooks**, by where they land:");
  const table = DOC.slice(start, DOC.indexOf("**Pages draw from memory.**", start));
  return new Map(table.split("\n").filter((l) => l.startsWith("| ")).map((l) => [l.split("|")[1]!.trim(), l] as const));
};

const said = (ms: number) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`);

test("the table has every member of Pack once, and nothing else", () => {
  const members = packMembers();
  assert.ok(members.includes("routes") && members.includes("email"), "read Pack's names");
  assert.deepEqual(HOOKS.map((h) => h.name).sort(), [...members].sort());
});

test("each hook is in the doc's row it names, with its time box and where it only runs", () => {
  const table = rows();
  for (const h of HOOKS) {
    const row = table.get(h.where);
    assert.ok(row, `${h.name}: the doc's hooks table has no "${h.where}" row`);
    assert.ok(new RegExp("`[^`]*\\b" + h.name + "\\b[^`]*`").test(row), `${h.name} isn't named in the "${h.where}" row`);
    if (typeof h.call === "object") assert.ok(row.includes(said(h.call.ms)), `the "${h.where}" row doesn't say ${h.name}'s ${said(h.call.ms)}`);
    if (h.only) assert.ok(row.includes(`(${h.only})`), `the "${h.where}" row doesn't say ${h.name} is ${h.only} only`);
  }
});

test("every hook core calls from memory or in a time box has its `from`; a special one has none", () => {
  for (const h of HOOKS) assert.equal(!!h.from, h.call !== "special", h.name);
});

test("hooksOf: a pack's labels in the table's order, one for hooks that share a label, none for a bare pack", () => {
  const manifest: PackManifest = { api: PACK_API, id: "p", name: "P", description: "p", domain: "general" };
  assert.deepEqual(hooksOf({ manifest }), []);
  assert.deepEqual(hooksOf({ manifest, stats: () => [], lookups: () => [], tools: () => [], frames: () => [] }), [], "hooks the Packs page doesn't list");
  assert.deepEqual(hooksOf({ manifest, lane: () => undefined, glance: () => [], email: async () => false, routes: () => {}, beforePage: async () => {}, refresh: async () => {} }), ["pages", "Today's briefing", "refresh", "mail"]);
  const every = Object.fromEntries(HOOKS.filter((h) => h.name !== "manifest").map((h) => [h.name, () => []]));
  assert.deepEqual(hooksOf({ ...every, manifest } as Pack), ["pages", "menu", "Today cards", "Today's briefing", "feed", "search", "links", "Bino", "core pages", "Bino's proposals", "Settings", "needs", "bar", "dock", "sign-in return", "ingest", "pulse", "refresh", "cron", "mail", "forge"]);
});

/** What a hook might hand back in place of its shape. */
const HOSTILE: unknown[] = [null, undefined, 42, "nope", H, {}, [], [null, 42, H, {}, []], { length: 3 }, () => H, Promise.resolve(H)];

for (const h of HOOKS.filter((x) => x.from)) {
  test(`${h.name}: a pack that throws is logged and leaves nothing; an answer of the wrong shape takes nothing down`, async () => {
    const manifest = (id: string): PackManifest => ({ api: PACK_API, id, name: id, description: id, domain: "general" });
    const ctxOf = () => testContext();
    const quiet = async (on: Pack[]) => {
      const logged: string[] = [];
      const out = await h.from!(on, ctxOf, (id, line) => logged.push(`${id}: ${line}`));
      return { out, logged };
    };
    const without = await quiet([{ manifest: manifest("bare") }]);
    assert.deepEqual(without.logged, []);
    const boom = await quiet([{ manifest: manifest("boom"), [h.name]: () => { throw new Error("no"); } } as Pack]);
    assert.ok(boom.logged.some((l) => l.startsWith("boom: ")) || JSON.stringify(boom.out).includes('"boom"'), "the throw is logged under the pack, or the answer names it");
    // A hook with a time box reports the pack that failed; the rest answer as if it weren't there.
    if (h.call === "memory") assert.deepEqual(boom.out, without.out);
    for (const answer of HOSTILE) {
      // Not thrown is the point: what each hook keeps of a good answer is its own test's.
      const got = await quiet([{ manifest: manifest("odd"), [h.name]: () => answer } as Pack]);
      if (h.name === "today") assert.deepEqual((got.out as { cards: unknown[] }).cards, [], "no card comes of it");
    }
  });
}
