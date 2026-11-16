/** No code host (#421): the forge isn't asked, its packs are held, Today draws none of it, and Settings → Work changes it. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGatherer } from "../src/gather.ts";
import type { Forge } from "../src/forge/types.ts";
import { firstNameOf } from "../src/onboarding.ts";
import { heldOff, NO_CODE_HOST } from "../src/packs/registry.ts";
import type { Pack } from "../src/packs/types.ts";
import { html } from "hono/html";
import { homePage, packPlace } from "../src/pages/home.ts";
import { assertInert, H, move, pr, signedIn, snapshot } from "./helpers.ts";

test("the gather without a code host asks the forge nothing, and is empty; with one again, it asks", async () => {
  let asked = 0;
  const ask = async <T>(v: T) => (asked++, v);
  const forge = { id: "github", name: "GitHub", host: "github.com", can: [], viewer: () => ask({ login: "me", name: null }), prs: () => ask({ mine: [pr()], review: [] }), notes: () => ask([]), moves: () => ask([move()]), prRefs: () => ask(new Map()), prKeyOfUrl: () => undefined } as unknown as Forge;
  let none = true;
  const g = createGatherer({ env: { GHE_ORG: "ACME" }, forge, login: "me", name: "Kari", none: () => none });
  const s = await g.get({ fresh: true });
  assert.equal(asked, 0, "not one call");
  assert.deepEqual(s.prs, { ok: true, value: { mine: [], review: [] } });
  assert.deepEqual(s.moves, { ok: true, value: [] });
  assert.equal(s.name, "Kari");
  none = false;
  const t = await g.get({ fresh: true });
  assert.ok(asked > 0);
  assert.equal(t.prs.ok && t.prs.value.mine.length, 1);
});

test("the packs that go through the forge are held without a code host, and what requires them with them", () => {
  const p = (id: string, m: Partial<Pack["manifest"]> = {}) => ({ manifest: { id, name: id, ...m } }) as Pack;
  const on = [p("prs", { via: "forge" }), p("reviewer", { requires: ["prs"] }), p("todo"), p("off-anyway", { via: "forge" })];
  assert.deepEqual([...heldOff(on, ["off-anyway"])], [["off-anyway", "off-anyway"]], "with a code host: only what's switched off");
  assert.deepEqual(new Map(heldOff(on, ["off-anyway"], { noForge: true })), new Map([["prs", NO_CODE_HOST], ["reviewer", NO_CODE_HOST], ["off-anyway", "off-anyway"]]));
});

test("a first name from a sign-in's email", () => {
  assert.equal(firstNameOf("kari.nordmann@example.com"), "Kari");
  assert.equal(firstNameOf("ola_n+dovre@example.com"), "Ola");
  assert.equal(firstNameOf("2024.åse@example.com"), "Åse", "a word with a letter in it");
  assert.equal(firstNameOf("1234@example.com"), undefined);
  assert.equal(firstNameOf(undefined), undefined);
});

test("Today without a code host: no PR, ship or Merged parts, the packs' feed, no name it doesn't have", async () => {
  const s = snapshot({ prs: { ok: true, value: { mine: [pr({ title: "Mine to ship" })], review: [pr({ number: 2, title: "Theirs" })] } }, moves: { ok: true, value: [move({ at: new Date().toISOString(), verb: "merged" })] } });
  const { get, post } = signedIn(s);
  const before = await (await get("/")).text();
  assert.match(before, /id="prs"/);
  assert.match(before, /<dt>Merged<\/dt>/);
  assert.match(before, /Good [a-z]+, Andreas\./);

  assert.equal((await post("/settings/work/code-host", { host: "none" }, { origin: "https://evil.example" })).status, 403, "cross-site: refused");
  assert.match(await (await get("/")).text(), /id="prs"/, "and nothing changed");
  assert.equal((await post("/settings/work/code-host", { host: "svn" })).headers.get("location"), "/settings/work#code-host");
  assert.match(await (await get("/")).text(), /id="prs"/, "a value it doesn't know changes nothing");

  assert.equal((await post("/settings/work/code-host", { host: "none" })).status, 303);
  const out = await (await get("/")).text();
  assertInert("Today without a code host", out);
  assert.doesNotMatch(out, /id="prs"|id="ship"|Mine to ship|Theirs/, "no PR or ship cards");
  assert.doesNotMatch(out, /<dt>Merged<\/dt>|<dt>Released<\/dt>/);
  assert.doesNotMatch(out, /No reviews waiting|reviews? waits? on you/);
  assert.doesNotMatch(out, /Your merges|Team merges|Waiting for prod/, "the horizon keeps the packs' lanes, not the forge's legend");
  assert.match(out, /What's happening<\/h2><p>in my apps, last 7 days/);
  assert.match(out, /<h1 id="greet">Good [a-z]+\.<\/h1>/, "here, in a test, no machine user: no name");
  assert.equal((await get("/prs")).status, 404, "the PR pack is held");

  const packs = await (await get("/packs")).text();
  assert.match(packs, /needs a code host, and code lives on None here/);
  const work = await (await get("/settings/work")).text();
  assert.match(work, /<option value="none" selected>None<\/option>/);
  assert.match(await (await get("/settings?q=code+lives")).text(), /Code lives on/);

  assert.equal((await post("/settings/work/code-host", { host: "forge" })).status, 303);
  const back = await (await get("/")).text();
  assert.match(back, /id="prs"/, "back on GitHub: the cards are back");
  assert.equal((await get("/prs")).status, 200);
});

test("Today without a code host greets with the name given, and keeps it text", () => {
  const frame = { operator: "me", nav: [] };
  assert.match(String(homePage(frame, snapshot(), () => undefined, { noForge: true, name: "Kari" })), /<h1 id="greet">Good [a-z]+, Kari\.<\/h1>/);
  assertInert("Today's hostile name", String(homePage(frame, snapshot(), () => undefined, { noForge: true, name: H })));
  assert.doesNotMatch(String(homePage(frame, snapshot(), () => undefined, { noForge: true })), /id="hz-h"|class="glance"/, "no lanes and no numbers: no horizon, no glance");
});

test("without a code host My list takes the top right by default; my layout still wins", () => {
  const frame = { operator: "me", nav: [] };
  const card = (id: string, column: "left" | "right", order: number) => ({ id, column, order, render: html`<section id="${id}"></section>` });
  const packs = { cards: [card("todo-list", "left", 30), card("weather-now", "right", 10)], failed: [] };
  const right = (out: string) => out.split('<div class="today-col">')[2] ?? "";
  const none = String(homePage(frame, snapshot(), () => undefined, { noForge: true, own: ["todo"], packs }));
  assert.ok(right(none).indexOf('id="todo-list"') >= 0 && right(none).indexOf('id="todo-list"') < right(none).indexOf('id="weather-now"'), "first on the right, ahead of the packs'");
  const forged = String(homePage(frame, snapshot(), () => undefined, { own: ["todo"], packs }));
  assert.equal(right(forged).indexOf('id="todo-list"'), -1, "with a code host, on the left where its code puts it");
  const mine = String(homePage(frame, snapshot(), () => undefined, { noForge: true, own: ["todo"], packs, cards: { "todo-list": { col: "left", order: 5 } } }));
  assert.equal(right(mine).indexOf('id="todo-list"'), -1, "my layout's place wins");
  assert.deepEqual(packPlace({ id: "todo-list", column: "left", order: 30 }, { own: true }), { col: "left", order: 30 });
  assert.deepEqual(packPlace({ id: "todo-list", column: "left", order: 30 }, { own: true, noForge: true }), { col: "right", order: 10 });
  assert.deepEqual(packPlace({ id: "weather-now", column: "left", order: 30 }, { own: false, noForge: true }), { col: "left", order: 130 });
});
