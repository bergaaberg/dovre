/**
 * What Bino proposes to do: read strictly, shown as filled-in cards, and done only on my click. A
 * pack's act (Teams' message) is tested with its pack; core's own is the dev task. What I change
 * before pressing stays out of Bino's conversation.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { actionsOf } from "../../../../actions/deploys.ts";
import { createApp } from "../../../../app.ts";
import { type ActSpec, actOf, fenceOf, MAX_ACTS, splitActs } from "../bino/acts.ts";
import { noMemory } from "../bino/memory.ts";
import { findSettings } from "../bino/settings.ts";
import { DEFAULT_KEYS } from "../../../../keys.ts";
import { DEFAULT_POLICY } from "../../../../notify.ts";
import { settingRows } from "../../../../pages/settings.ts";
import { WRITES } from "../../../../writes.ts";
import type { Route } from "../bino/route.ts";
import { openDb } from "../../../../db.ts";
import { withAssistant } from "./withAssistant.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", TICKET_PROJECTS: "DEV" };
const fence = (o: unknown) => `\`\`\`bino-act\n${JSON.stringify(o)}\n\`\`\``;
/** A pack's kind, as the registry hands it over: a note to someone. */
const NOTE: ActSpec = { kind: "notes.post", app: "Notes", when: "x", fields: [{ name: "to", about: "who", required: true, max: 120, text: false }, { name: "text", about: "what", required: true, max: 4000, text: true }] };

test("acts are read strictly: junk and the wrong shape give no card, at most three, fields capped", () => {
  assert.equal(actOf({ kind: "notes.post", to: "Kari" }, [NOTE]), null, "a required field missing");
  assert.equal(actOf({ kind: "teams", to: "x", text: "y" }), null, "not a kind Bino has (Teams' message is its pack's now)");
  assert.equal(actOf({ kind: "email", to: "x", text: "y" }), null, "not a kind Bino has");
  assert.equal(actOf([]), null);
  assert.deepEqual(actOf({ kind: "notes.post", to: " Kari\u0000 ", text: "Hei\r\nder", extra: "dropped" }, [NOTE]), { kind: "notes.post", fields: { to: "Kari", text: "Hei\nder" } });
  assert.equal(actOf({ kind: "ticket", project: "DEV", type: "Story", summary: "x" }), null, "no tickets: they belong to a pack");
  assert.equal((actOf({ kind: "task", title: "x".repeat(999) }) as { title: string }).title.length, 255);
  const reply = `Here.\n${fence({ kind: "task", title: "1" })}\n${fence({ kind: "nope" })}\n\`\`\`bino-act\nnot json\n\`\`\`\n${[2, 3, 4].map((n) => fence({ kind: "task", title: String(n) })).join("\n")}`;
  const { text, acts } = splitActs(reply);
  assert.equal(text, "Here.");
  assert.equal(acts.length, MAX_ACTS);
  assert.deepEqual(acts.map((a) => (a as { title: string }).title), ["1", "2", "3"]);
  assert.doesNotMatch(fenceOf({ kind: "notes.post", fields: { to: "A", text: "1" }, done: { at: 1, text: "Posted in thread t-secret" } }), /t-secret/, "Bino hears its proposal, not how it went");
});

/** `reply`: what Bino says, or what it says to each ask in turn (the last one from then on). */
function setup(reply: string | string[]) {
  const asked: { system: string; user: string }[] = [];
  const replies = [reply].flat();
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: replies[Math.min(asked.length, replies.length) - 1]!, cost: 0 }) };
  const file = join(mkdtempSync(join(tmpdir(), "bino-acts-")), "bino.json");
  const db = openDb();
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no"), file }, packs: withAssistant() });
  const req = (path: string, body?: Record<string, string>) =>
    app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: new URLSearchParams(body).toString() });
  const until = async (at: string, re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const page = await (await req(at)).text();
      if (re.test(page)) return page;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${re}`);
  };
  return { req, until, asked, file, actions: () => actionsOf(db.DB, "settings.change") };
}

test("a bug card (#384) opens the bug form filled in; a page that isn't Dovre's is dropped; hostile text stays inert", async () => {
  assert.deepEqual(actOf({ kind: "bug", title: "It broke", body: "b", page: "//evil.example/x" }), { kind: "bug", title: "It broke", body: "b", page: "" });
  assert.equal(actOf({ kind: "bug", body: "no title" }), null);
  const s = setup(`${H}\n${fence({ kind: "bug", title: H, body: H, page: "/prs" })}`);
  const at = (await s.req("/bino/new", { text: "x" })).headers.get("location")!;
  const page = await s.until(at, /A bug report for Dovre/);
  assertInert("bino bug act", page);
  assert.match(page, /method="get" action="\/bug"/);
  assert.match(page, /name="from" value="\/prs"/);
});

test("a task card goes to the normal preview, filled in; a ticket or an old Teams message gets no card; hostile text stays inert", async () => {
  const s = setup(`${H}\n${fence({ kind: "teams", to: H, text: H })}\n${fence({ kind: "ticket", project: "DEV", type: "Story", summary: H, description: H })}\n${fence({ kind: "task", parent: "ACME/intake#12", repo: "shop-api", title: H, body: H })}`);
  const at = (await s.req("/bino/new", { text: "x" })).headers.get("location")!;
  const page = await s.until(at, /A dev task/);
  assertInert("bino acts", page);
  assert.doesNotMatch(page, /issues\/ticket|Jira|A message in Teams/);
  assert.match(page, /action="\/issues\/task\/preview"/);
  assert.match(page, /name="repo" value="ACME\/shop-api"/, "a short repo name gets the org");
  assert.match(page, /name="parent" value="ACME\/intake#12"/);
});

test("a setting card (#185) shows what it is and would become, changes it through its own route, and Undo puts it back", async () => {
  assert.deepEqual(actOf({ kind: "setting", id: "look.theme", to: " Dark\u0000 ", extra: "dropped" }), { kind: "setting", id: "look.theme", to: "Dark" });
  assert.deepEqual(actOf({ kind: "setting", id: "keys.hints", to: false }), { kind: "setting", id: "keys.hints", to: "off" });
  assert.deepEqual(actOf({ kind: "setting", id: "notify.bundle", to: 60 }), { kind: "setting", id: "notify.bundle", to: "60" });
  for (const id of ["", "../x", "look theme", "<b>", 7]) assert.equal(actOf({ kind: "setting", id, to: "x" }), null, String(id));
  assert.doesNotMatch(fenceOf({ kind: "setting", id: "look.theme", to: "Dark", was: "ember", done: { at: 1, text: "x" } }), /ember/, "Bino hears its proposal, not what it was before");

  const s = setup(`Here.\n${fence({ kind: "setting", id: "look.theme", to: "Ember" })}\n${fence({ kind: "setting", id: "about.version", to: "9" })}\n${fence({ kind: "setting", id: "look.nope", to: "x" })}`);
  const at = (await s.req("/bino/new", { text: "make it warmer" })).headers.get("location")!;
  const page = await s.until(at, /class="bino-plan-h">Theme</);
  const card = /<form[^>]*id="act-1-0"[^]*?<\/form>/.exec(page)![0];
  assert.match(card, /method="post" action="\/bino\/c\/[0-9a-f-]{36}\/act\/1\/0"/);
  assert.match(card, /<span>As the system<\/span><span aria-hidden="true">→<\/span><select name="to"/, "what it is now, then the picker");
  assert.match(card, /<option value="ember" selected>Ember \(warm dark\)<\/option>/, "what it would become, picked");
  assert.match(card, /<option value="dark">/, "and the other values, to pick instead");
  assert.match(page, /id="act-1-1"[^]*?Version[^]*?only changed on its own page[^]*?href="\/settings\/about"/, "one that isn't changed from a card is a link");
  assert.doesNotMatch(page, /id="act-1-1"[^>]*>[^]*?<button[^]*?id="act-1-2"|id="act-1-2"/, "one Dovre doesn't have isn't drawn; the link card has no button");
  const themeNow = async () => /<html[^>]*data-theme="([^"]*)"/.exec(await (await s.req("/settings/look")).text())?.[1];
  assert.equal(await themeNow(), undefined, "nothing changed before the press");

  // I pick another value than Bino's on the card: that's what's set, and what the line says.
  const pressed = await s.req(`${at}/act/1/0`, { to: "dark" });
  assert.equal(pressed.headers.get("location"), `${at}#act-1-0`);
  assert.equal(await themeNow(), "dark");
  const done = await (await s.req(at)).text();
  assert.match(done, /class="bino-plan done" id="act-1-0"><p>Theme: As the system → Dark \(night\) <span class="t3">· <span data-at/);
  assert.match(done, /action="\/bino\/c\/[0-9a-f-]{36}\/act\/1\/0\/undo"[^]*?>Undo</);
  assert.equal((await s.req(`${at}/act/1/0`, { to: "ember" })).status, 303, "pressed again once done: nothing more happens");
  assert.equal(await themeNow(), "dark");
  assert.match(JSON.stringify(await s.actions()), /"target":"look.theme","detail":"As the system → Dark[^"]* · proposed by Bino"/);

  await s.req(`${at}/act/1/0/undo`, {});
  assert.equal(await themeNow(), undefined, "as the system again");
  assert.match(await (await s.req(at)).text(), /<form[^>]*id="act-1-0"/, "and the card proposes again");

  // A value it doesn't take is refused by the catalogue, and said on the card; the never list and junk aren't cards to press.
  await s.req(`${at}/act/1/0`, { to: "<script>" });
  assert.match(await (await s.req(at)).text(), /Not changed\.<\/strong> That isn&#39;t a value it takes\./);
  await s.req(`${at}/act/1/1`, { to: "9" });
  assert.match(await (await s.req(at)).text(), /id="act-1-1"[^]*?only changed on its own page/, "pressing a link card changes nothing");
  assert.equal((await s.req(`${at}/act/1/1/undo`, {})).status, 303);
  assert.equal((await s.req(`${at}/act/9/9`, { to: "dark" })).status, 404);
});

test("a setting card for a write: stricter is one press, to one click is asked again, and so is undoing the stricter one", async () => {
  const s = setup(`${fence({ kind: "setting", id: "writes.deploy.approve", to: "twice" })}`);
  const at = (await s.req("/bino/new", { text: "ask twice for deploys" })).headers.get("location")!;
  const page = await s.until(at, /Approve a waiting deploy/);
  const card = /<form[^>]*id="act-1-0"[^]*?<\/form>/.exec(page)![0];
  assert.match(card, /<span>One click<\/span><span aria-hidden="true">→<\/span><strong>Asks twice<\/strong>/);
  assert.doesNotMatch(card, /<select|<details/, "as proposed, not picked; stricter needs no second click");
  await s.req(`${at}/act/1/0`, { to: "twice" });
  const done = await (await s.req(at)).text();
  assert.match(done, /Approve a waiting deploy: One click → Asks twice/);
  assert.match(done, /act\/1\/0\/undo"[^]*?<details class="confirm"><summary>Undo…[^]*?name="twice" value="1"/, "undo loosens it again: asked");
  await s.req(`${at}/act/1/0/undo`, {});
  assert.match(await (await s.req(at)).text(), /Not undone\.<\/strong> That lets a write through on one click\./, "without the second click, nothing is undone");
  assert.match(await (await s.req("/settings/writes")).text(), /value="deploy.approve" checked/);
  await s.req(`${at}/act/1/0/undo`, { twice: "1" });
  assert.doesNotMatch(await (await s.req("/settings/writes")).text(), /value="deploy.approve" checked/);

  const loose = setup(`${H}\n${fence({ kind: "setting", id: "writes.deploy.approve", to: "once" })}\n${fence({ kind: "setting", id: H, to: H })}\n${fence({ kind: "setting", id: "look.theme", to: H })}`);
  const where = (await loose.req("/bino/new", { text: "x" })).headers.get("location")!;
  await loose.req("/settings/writes", { twice: "deploy.approve" });
  const shown = await loose.until(where, /Approve a waiting deploy/);
  assertInert("bino setting acts", shown);
  assert.match(shown, /<details class="confirm"><summary>Change…[^]*?name="twice" value="1"/, "to one click: behind a second click, whatever Settings says");
  assert.match(shown, /Bino&#39;s suggestion isn&#39;t a value it takes: pick one\./, "a hostile value is no value; the card still offers the real ones");
  await loose.req(`${where}/act/1/0`, { to: "once" });
  assert.match(await (await loose.req("/settings/writes")).text(), /value="deploy.approve" checked/, "one press isn't enough");
  await loose.req(`${where}/act/1/0`, { to: "once", twice: "1" });
  assert.doesNotMatch(await (await loose.req("/settings/writes")).text(), /value="deploy.approve" checked/);
});

test("Bino finds a setting by looking it up: its id, what it is now and what it takes; what a card can't change comes without its value", async () => {
  const rows = settingRows({
    layout: { textSize: "large" },
    policy: DEFAULT_POLICY,
    notifier: true,
    rings: [],
    writes: { chosen: new Map(), kinds: WRITES },
    keys: DEFAULT_KEYS,
    switches: [{ id: "quill", name: "Quill" }],
    packs: [{ id: "quill", name: "Quill", on: true, panel: false, settings: [{ key: "QUILL_HOST", label: "Host", set: true, now: "quill.internal.example" }] }],
    canRestart: true,
  });
  const find = async (q: string) => (await findSettings({ rows: async () => rows }, { q })).text;
  assert.equal(await find("text size"), `- id "look.textSize": Text size (Look). Now "large" (Large). Takes: "small" (Small), "" (Default), "large" (Large), "larger" (Larger).`);
  assert.match(await find("bigger letters"), /^- id "look\.textSize"/, "no row has every word: any of them");
  assert.match(await find("quill"), /^- id "pack\.quill": Pack on: Quill \(Layout\)\. Now "on"\. Takes: "on", "off"\./, "what a card can change comes first");
  assert.match(await find("quill"), /- id "packs\.quill\.QUILL_HOST": Quill: Host \(Packs\)\. Not changed from a card: the user changes it on its page, \/settings\/packs\/quill\./);
  assert.doesNotMatch(await find("quill"), /internal\.example/, "a pack's own setting is named, never told");
  assert.match(await find("restart"), /"about\.restart": Restart Dovre \(About\)\. Not changed from a card/);
  assert.match(await find("bundle"), /"notify\.bundle"[^\n]*Now 45\. Takes a whole number from 0 to 600\./);
  assert.match(await find("approve deploy"), /"writes\.deploy\.approve"[^\n]*Now "once" \(One click\)[^\n]*To "once" loosens a guard: the user is asked twice\./);
  assert.match(await find("zebra"), /^No setting goes by "zebra"/);
  assert.ok((await find("ring")).split("\n").length <= 13, "a dozen at most, and how many more");
  assert.deepEqual(await findSettings({ rows: async () => Promise.reject(new Error("x")) }, { q: "theme" }), { text: "Dovre's settings can't be read right now.", error: true });
});

test("asked to change a setting, Bino looks it up, then proposes it with the id and a value it was given", async () => {
  const s = setup(["```bino-lookup\n" + JSON.stringify({ kind: "dovre.settings", q: "text size" }) + "\n```", `Bigger it is.\n${fence({ kind: "setting", id: "look.textSize", to: "large" })}`]);
  const at = (await s.req("/bino/new", { text: "make the text bigger" })).headers.get("location")!;
  const page = await s.until(at, /class="bino-plan-h">Text size</);
  assert.equal(s.asked.length, 2);
  assert.ok(s.asked[0]!.system.includes(`${"```"}bino-act\n{"kind": "setting", "id": "the setting's id, exactly as the dovre.settings lookup gave it"`), "told how to propose a setting");
  assert.match(s.asked[0]!.system, /From Dovre: Find one of Dovre's own settings/);
  assert.match(s.asked[1]!.user, /- id "look\.textSize": Text size \(Look\)\. Now "" \(Default\)\. Takes: "small" \(Small\)/, "what the lookup found goes with the next ask");
  assert.match(page, /looked up Dovre: settings text size/);
  assert.match(page, /<span>Default<\/span><span aria-hidden="true">→<\/span><select name="to"[^>]*>[^]*?<option value="large" selected>Large<\/option>/);
  await s.req(`${at}/act/1/0`, { to: "large" });
  assert.match(await (await s.req(at)).text(), /Text size: Default → Large/);
  assert.match(await (await s.req("/")).text(), /<html[^>]*data-size="large"/, "the page is drawn with it");
  // In the pane, the conversation says how Dovre looks now, so the page around it takes the change on at once.
  const pane = await (await s.req(at.replace("/bino/c/", "/bino/dock/c/"))).text();
  assert.match(pane, /<html lang="en" data-look="\{&quot;theme&quot;:&quot;&quot;,[^"]*&quot;size&quot;:&quot;large&quot;[^"]*\}">/);
  assert.match(pane, /action="\/bino\/c\/[0-9a-f-]{36}\/act\/1\/0\/undo"><input type="hidden" name="dock" value="1">/, "Undo from the pane comes back to the pane");
  const plain = setup("Hello.");
  const other = (await plain.req("/bino/new", { text: "x" })).headers.get("location")!;
  await plain.until(other, /Hello\./);
  assert.match(await (await plain.req(other.replace("/bino/c/", "/bino/dock/c/"))).text(), /<html lang="en">/, "a conversation that proposes no setting says nothing of Look");
});
