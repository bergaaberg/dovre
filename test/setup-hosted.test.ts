/** A new instance hosted (WP-N6): what it has and lacks, by name only; the page before Access says how to add each. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedSetup, setupPage, tablesOk } from "../src/hosted/setup.ts";
import { openDb } from "../src/db.ts";
import { H, assertInert } from "./helpers.ts";

const on = (lines: ReturnType<typeof hostedSetup>) => Object.fromEntries(lines.map((l) => [l.name, l.on]));

test("hostedSetup: the essentials needed, the rest advised; a half-set bridge says so; a pack that's off is named", () => {
  const empty = hostedSetup({});
  assert.deepEqual(empty.filter((l) => l.needed).map((l) => [l.name, l.on]), [["Database (D1)", false], ["Its tables", false], ["Cloudflare Access", false]]);
  const db = { prepare: () => ({}) };
  const ready = hostedSetup({ DB: db, CF_ACCESS_TEAM: "t", CF_ACCESS_AUD: "a", HUB: {}, BRIDGE_CLIENT_ID: "x" }, { tables: true, off: [{ id: "shop", name: H, why: H }] });
  assert.ok(ready.filter((l) => l.needed).every((l) => l.on));
  assert.equal(on(ready)["Live pages and Bino (HUB)"], true);
  assert.equal(on(ready)["Allowed emails"], false);
  assert.match(ready.find((l) => l.name.startsWith("The Mac"))!.what, /Half set up/);
  assert.equal(ready.at(-1)!.name, `Pack: ${H}`);
  assert.equal(on(hostedSetup({ DB: db, CF_ACCESS_TEAM: " ", CF_ACCESS_AUD: "a" }, { tables: false }))["Its tables"], false);
});

test("tablesOk: a database with Dovre's migrations answers; without them, or no database, not", async () => {
  assert.equal(await tablesOk(openDb().DB), true);
  assert.equal(await tablesOk(undefined), false);
  assert.equal(await tablesOk({ prepare: () => ({ first: async () => { throw new Error("no such table: settings"); } }) }), false);
});

test("setupPage: only what's needed and missing, each with how; hostile text inert", () => {
  const page = setupPage([{ name: H, on: false, needed: true, what: H, fix: `run \`${H}\`` }, { name: "Advised", on: false, what: "x" }, { name: "Done", on: true, needed: true, what: "y" }]);
  assertInert("setup page", page);
  assert.doesNotMatch(page, /Advised|Done/);
  assert.match(page, /<code>/);
});
