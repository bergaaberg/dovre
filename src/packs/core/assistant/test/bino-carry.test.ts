/**
 * Bino carries on after the climb (#94): a fixed opening, no model call; Bino told the packs as data
 * with each message; a card per pack it proposes, offering what fits where that pack stands (Add,
 * switch it on, its settings, its setup); a summary of what's set up and what's left, read from state;
 * and a stop after 12 messages or the cost cap. It starts from the summit and from Settings → About.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { html } from "hono/html";
import { createApp } from "../../../../app.ts";
import { openDb } from "../../../../db.ts";
import { type Pack, PACK_API } from "../../../types.ts";
import { type Conv, createBino } from "../bino/bino.ts";
import { carryBrief, carrySpent, MAX_CARRY_TURNS } from "../bino/carry.ts";
import { DovreHub, type HubState } from "../../../../hosted/hub.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { withAssistant } from "./withAssistant.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

const pack = (id: string, o: { name?: string; steps?: boolean } = {}): Pack => ({
  manifest: {
    api: PACK_API,
    id,
    name: o.name ?? id[0]!.toUpperCase() + id.slice(1),
    description: `What ${id} does`,
    domain: "work",
    ...(o.steps ? { onboard: { steps: [{ id: "one", title: "One" }, { id: "two", title: "Two" }] } } : {}),
  },
  ...(o.steps ? { setup: { draw: () => ({ body: html`<p>A step.</p>` }), save: async () => ({ ok: true as const }) } } : {}),
});

const listed = (id: string, more: object = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), description: `${id}, from dovre-packs`, version: "1.0.0", tag: `${id}@1.0.0`, api: PACK_API, needsCore: false, execution: "any" as const, domain: "work", ...more });

function setup(o: { reply?: string; cost?: number; listedName?: string; bino?: boolean } = {}) {
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: o.reply ?? "Sure.", cost: o.cost ?? 0 }) };
  const file = join(mkdtempSync(join(tmpdir(), "bino-carry-")), "bino.json");
  const added: string[] = [];
  const copies = {
    get: () => new Map(),
    refresh: () => new Map(),
    update: () => ({ ok: true as const }),
    listed: () => [listed("sentry", o.listedName ? { name: o.listedName, description: o.listedName } : {}), listed("kit"), listed("newer", { needsCore: true }), listed("fly", { execution: "local-only" as const })],
    target: () => "/inst",
    add: (id: string) => (added.push(id), { ok: true as const }),
  };
  const db = openDb();
  const packs = { ...withAssistant([pack("kit", { steps: true }), pack("chat")]), copies };
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, ...(o.bino === false ? {} : { bino: { route, memory: noMemory("no"), file } }), packs: packs as never });
  const req = (path: string, body?: Record<string, string>, headers: Record<string, string> = { origin: "http://localhost" }) =>
    body === undefined
      ? app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } })
      : app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
  const until = async (at: string, re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const page = await (await req(at)).text();
      if (re.test(page)) return page;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${re}`);
  };
  const start = async () => {
    const r = await req("/bino/new", { carry: "1" });
    assert.equal(r.status, 303);
    const at = r.headers.get("location")!;
    assert.match(at, /^\/bino\/c\/[0-9a-f-]{36}$/);
    return { at, id: at.split("/").pop()! };
  };
  return { req, until, asked, added, start };
}

test("the setup chat opens with a fixed line from state, asks the model nothing, and lists what's left", async () => {
  const s = setup();
  await s.req("/welcome/role", { role: "dev", forge: "github" });
  const { at } = await s.start();
  const page = await (await s.req(at)).text();
  assert.match(page, /You&#39;re up\. Developer, code on GitHub\. On now: Kit and Chat\. What else do you work with\?/);
  assert.equal(s.asked.length, 0, "no model call to open");
  assert.doesNotMatch(page, /Retry/);
  assert.match(page, /<p class="bino-plan-h">Where it stands<\/p>\n<p>Set up: Chat\.<\/p>/, "only what has nothing left, and none of Dovre's own");
  assert.match(page, /<li><span><b>Kit<\/b> · its setup, 2 steps<\/span><form method="post" action="\/bino\/new"><input type="hidden" name="setup" value="kit"><button type="submit" class="sm" data-busy="Starting">Set up Kit<\/button><\/form><\/li>/);
  assert.match(page, /placeholder="What else do you work with\?"/);
});

test("each message tells Bino the packs as data; a card per pack proposed, for where it stands; Add goes through the copies once", async () => {
  const reply = 'Sentry covers errors.\n\n```bino-act\n{"kind": "pack", "id": "sentry"}\n```\n```bino-act\n{"kind": "pack", "id": "kit"}\n```\n```bino-act\n{"kind": "pack", "id": "nope"}\n```';
  const s = setup({ reply });
  const { at, id } = await s.start();
  assert.equal((await s.req(`/bino/c/${id}/say`, { text: "we use sentry" })).status, 303);
  const page = await s.until(at, /Sentry covers errors/);
  const sys = s.asked[0]!.system;
  assert.match(sys, /# This chat: carrying on after the climb/);
  assert.match(sys, /On:\n(- .*\n)*- kit: Kit: What kit does \(its own setup has 2 steps left\)/);
  assert.match(sys, /In dovre-packs, to add:\n- sentry: Sentry: sentry, from dovre-packs\n- fly: Fly: fly, from dovre-packs \(only on the user's own machine\)/);
  assert.doesNotMatch(sys, /newer/, "one this core can't run isn't offered");
  assert.match(sys, /Never ask for a key/);

  assert.match(page, new RegExp(`<p class="bino-plan-h">Add Sentry</p><p>sentry, from dovre-packs</p>.*action="/bino/c/${id}/act/2/0"`, "s"));
  assert.match(page, new RegExp(`<form class="post" method="post" action="/bino/c/${id}/act/2/0">`), "one click, like the Packs page's Add, unless Writes says twice");
  assert.match(page, /<p class="bino-plan-h">Kit<\/p><p>What kit does<\/p><p>It.s on\. Its own setup has 2 steps left\.<\/p>/);
  assert.doesNotMatch(page, /id="act-2-2"/, "a pack Dovre doesn't have isn't drawn");

  assert.equal((await s.req(`/bino/c/${id}/act/2/0`, {}, { origin: "http://evil.example" })).status, 403);
  assert.deepEqual(s.added, []);
  assert.equal((await s.req(`/bino/c/${id}/act/2/0`, {})).status, 303);
  assert.equal((await s.req(`/bino/c/${id}/act/2/0`, {})).status, 303);
  assert.deepEqual(s.added, ["sentry"], "once");
  const done = await (await s.req(at)).text();
  assert.match(done, /Adding Sentry: Dovre fetches it and checks it\. The Packs page shows how it goes\./);
  assert.match(done, /href="\/packs#add-sentry">Open its page/);
});

test("a pack switched off is switched on from its card; a key isn't sent; the chat stops at its cap", async () => {
  const s = setup({ reply: '```bino-act\n{"kind": "pack", "id": "chat"}\n```', cost: 0.6 });
  await s.req("/packs/chat/switch", { on: "0" });
  const { at, id } = await s.start();
  const opening = await (await s.req(at)).text();
  assert.doesNotMatch(opening, /On now: [^.]*Chat/, "what's switched off isn't on");
  const key = await s.req(`/bino/c/${id}/say`, { text: "my token is ghp_abcdefghijklmnopqrstuvwxyz0123" });
  assert.equal(key.status, 422);
  assert.match(await key.text(), /Not sent: that looks like a key\./);
  await s.req(`/bino/c/${id}/say`, { text: "the chat one" });
  const page = await s.until(at, /Switch it on/);
  assert.equal(s.asked.length, 1, "the key never reached the model");
  assert.doesNotMatch(s.asked[0]!.user, /ghp_/);
  assert.equal((await s.req(`/bino/c/${id}/act/2/0`, {})).status, 303);
  const after = await (await s.req(at)).text();
  assert.match(after, /Pack on: Chat|Chat is on\./);
  assert.match(after, /Set up: Chat\./, "the summary reads it from state");

  // The reply cost past the cap: no box, and a message is refused.
  assert.doesNotMatch(page, /placeholder="What else do you work with\?"/);
  assert.match(page, /That&#39;s as far as this chat goes: it has used what a setup chat may\./);
  const more = await s.req(`/bino/c/${id}/say`, { text: "and fly" });
  assert.equal(more.status, 422);
  assert.equal(s.asked.length, 1);
});

test("the cap counts messages; the brief stays out of the conversation; hostile pack names are inert", async () => {
  const msgs = (n: number): Conv["msgs"] => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "x", at: i }));
  const conv = (n: number): Conv => ({ id: "c", title: "t", at: 0, carry: true, msgs: msgs(n), thinking: false });
  assert.equal(carrySpent(conv(MAX_CARRY_TURNS * 2 - 2)), undefined);
  assert.match(carrySpent(conv(MAX_CARRY_TURNS * 2 - 1))!, /12 messages/);
  assert.match(carryBrief([{ id: "x", name: "X\nY", what: "a\n\nb", state: "off", why: "needs X_KEY" }]), /- x: X Y: a b \(needs X_KEY\)/, "one line a pack");

  const asked: string[] = [];
  const route: Route = { via: "claude", ready: true, model: "m", reflectModel: "m", ask: async (p) => (asked.push(p.system), { text: "ok", cost: 0 }) };
  const saved: Conv[][] = [];
  const b = createBino({ route, memory: noMemory("no"), context: async () => "", store: { load: () => [], save: (k) => void saved.push(structuredClone(k)) } });
  const c = b.start("Opening.", { carry: { title: "Setting up" } });
  assert.deepEqual([c.carry, c.title, c.msgs.map((m) => m.role)], [true, "Setting up", ["assistant"]]);
  b.say(c.id, "hi", { brief: "BRIEF-ONE" });
  await b.idle();
  b.retry(c.id, {});
  await b.idle();
  assert.match(asked[0]!, /BRIEF-ONE/);
  assert.doesNotMatch(asked[1]!, /BRIEF-ONE/, "a brief is for one answer");
  assert.doesNotMatch(JSON.stringify(saved), /BRIEF/, "never kept");

  const s = setup({ listedName: H, reply: '```bino-act\n{"kind": "pack", "id": "sentry"}\n```' });
  const { at, id } = await s.start();
  await s.req(`/bino/c/${id}/say`, { text: "sentry" });
  const page = await s.until(at, /act-2-0/);
  assertInert(at, page);
});

test("where it starts: the summit's Carry on with Bino and Settings → About, only while Bino answers", async () => {
  const s = setup();
  await s.req("/welcome/role", { role: "dev", forge: "github" });
  const summit = await (await s.req("/welcome?at=summit")).text();
  assert.match(summit, /<button type="submit" class="climb-link" name="carry" value="1">Carry on with Bino<\/button><\/form>/);
  const done = await s.req("/welcome/done", { carry: "1" });
  assert.equal(done.status, 307, "the same post goes on to start the chat");
  assert.equal(done.headers.get("location"), "/bino/new");
  const about = await (await s.req("/settings/about")).text();
  assert.match(about, /<form method="post" action="\/bino\/new"><input type="hidden" name="carry" value="1"><button type="submit" class="primary" data-busy="Starting">Set up with Bino<\/button><\/form>/);

  const off = setup({ bino: false });
  await off.req("/welcome/role", { role: "dev", forge: "github" });
  assert.doesNotMatch(await (await off.req("/welcome?at=summit")).text(), /Carry on with Bino/);
  assert.equal((await off.req("/welcome/done", { carry: "1" })).headers.get("location"), "/", "no Bino: Today");
  assert.doesNotMatch(await (await off.req("/settings/about")).text(), /Set up with Bino/);
});

test("hosted: the object opens a setup chat without asking the model", async () => {
  const rows = new DatabaseSync(":memory:");
  let alarm = 0;
  const state: HubState = {
    storage: {
      sql: {
        exec: (q, ...b) => {
          if (/^\s*select/i.test(q)) return { toArray: () => rows.prepare(q).all(...(b as never[])) as Record<string, unknown>[] };
          rows.prepare(q).run(...(b as never[]));
          return { toArray: () => [] };
        },
      },
      setAlarm: (at) => void (alarm = at),
      getAlarm: () => alarm || null,
    },
  };
  const hub = new DovreHub(state, { DB: openDb().DB, ASSISTANT_VIA: "api-key", ANTHROPIC_API_KEY: "k" });
  let calls = 0;
  hub.fetchFn = (async () => (calls++, new Response("", { status: 500 }))) as typeof fetch;
  hub.publish = () => {};
  const op = async (body: unknown) => (await hub.fetch(new Request("https://hub.internal/bino", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Conv>;
  const c = await op({ op: "start", text: "You're up.", context: "", carry: { title: "Setting up with Bino" } });
  assert.deepEqual([c.carry, c.title, c.thinking, c.msgs.map((m) => [m.role, m.text])], [true, "Setting up with Bino", false, [["assistant", "You're up."]]]);
  assert.equal((await op({ op: "get", id: c.id })).carry, true, "kept");
  assert.equal(calls, 0);
});
