/**
 * Bino hosted (WP-N2): it answers in the Durable Object (src/hosted/hub.ts) through AI Gateway,
 * with what the Worker sent, keeps its conversations in the object's SQLite, tells open pages
 * over the object's event stream, and keeps memory per app.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../../../../app.ts";
import { ACT_FENCE } from "../bino/acts.ts";
import { appsOf, defaultBinoOf } from "../bino/context.ts";
import { loadMemory, noMemory } from "../bino/memory.ts";
import { viewOf } from "../bino/view.ts";
import { activePacks } from "../../../registry.ts";
import { type Pack, PACK_API } from "../../../types.ts";
import { openDb } from "../../../../db.ts";
import { hubClient, type HubNamespace, remoteBino } from "../../../../hosted/client.ts";
import { DovreHub, type HubEnv, type HubState, hostedBinoRoute, sqlConvStore } from "../../../../hosted/hub.ts";
import { assertInert, fakeGhe, fixedGatherer, H, pr, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "github.com", GHE_ORG: "me", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

/** The object's storage: SQLite in memory, and its alarm. */
function fakeState() {
  const db = new DatabaseSync(":memory:");
  const box = { alarm: null as number | null };
  const state: HubState = {
    storage: {
      sql: {
        exec(q, ...b) {
          const st = db.prepare(q);
          const rows = /^\s*select/i.test(q) ? (st.all(...(b as never[])) as Record<string, unknown>[]) : (st.run(...(b as never[])), []);
          return { toArray: () => rows };
        },
      },
      setAlarm: (t) => void (box.alarm = t),
      getAlarm: () => box.alarm,
    },
  };
  return { state, box };
}

type Call = { url: string; headers: Record<string, string>; body: { model: string; system: string; messages: { content: string }[] } };

/** The gateway: a reply for talking, memlet's ops for Haiku keeping memory. */
function fakeGateway(reply: string, calls: Call[] = [], hold?: Promise<void>) {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    if (hold) await hold;
    const text = body.model === "claude-haiku-5-5" ? '{"ops":[{"op":"add","text":"Quill is for small schools.","kind":"fact"}]}' : reply;
    if (body.stream) {
      // As the Messages API streams: the reply in two deltas.
      const ev = [
        { type: "message_start", message: { model: body.model, usage: { input_tokens: 100 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(0, 5) } },
        { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(5) } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
      ];
      return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 10 } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const nsOf = (hub: DovreHub): HubNamespace => ({ idFromName: () => "hub", get: () => ({ fetch: (input, init) => hub.fetch(new Request(input, init)) }) });

/** Reads an event stream until `want` shows up (or gives up). */
async function heard(res: Response, want: string, ms = 2000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let got = "";
  const until = Date.now() + ms;
  while (!got.includes(want) && Date.now() < until) {
    const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), until - Date.now()))]);
    if (r.done) break;
    got += dec.decode(r.value);
  }
  reader.cancel().catch(() => {});
  return got;
}

test("hosted Bino answers in the Durable Object: through the gateway, with what the Worker sent, and open pages hear it", async () => {
  const db = openDb();
  const { state, box } = fakeState();
  const env: HubEnv = { DB: db.DB, CF_ACCOUNT_ID: "acc-1", CF_AIG_TOKEN: "aig-tok" };
  const calls: Call[] = [];
  let release!: () => void;
  const hub = new DovreHub(state, env);
  hub.fetchFn = fakeGateway("Start with the trials ending this week.", calls, new Promise<void>((r) => (release = r)));
  const page = await hub.fetch(new Request("https://hub.internal/events"));
  assert.match(page.headers.get("content-type") ?? "", /text\/event-stream/);

  const client = hubClient(nsOf(hub));
  const memory = await loadMemory(db.DB);
  const bino = remoteBino(client, { route: hostedBinoRoute(env), memory });
  assert.equal(bino.route.ready, true);
  const c = await bino.start("What should I do about Quill?", { app: "quill", context: "## Quill (one of the user's apps)\n12 trials, 3 end this week" });
  assert.equal((await bino.get(c.id))?.thinking, true, "answering in the object, not in the request");
  assert.ok(box.alarm, "an alarm keeps the object awake while it answers");
  release();
  const events = heard(page, `bino:${c.id}`);
  await hub.idle();
  assert.match(await events, new RegExp(`event: change\\ndata: .*"bino:${c.id}"`), "the page hears the reply");

  const conv = await bino.get(c.id);
  assert.equal(conv?.thinking, false);
  assert.equal(conv?.msgs.at(-1)?.text, "Start with the trials ending this week.");
  const talk = calls.find((x) => x.body.model === "claude-sonnet-5-5")!;
  assert.equal(talk.url, "https://gateway.ai.cloudflare.com/v1/acc-1/dovre/anthropic/v1/messages");
  assert.equal(talk.headers["cf-aig-authorization"], "Bearer aig-tok");
  assert.match(talk.body.system, /12 trials, 3 end this week/, "what the Worker sent");
  assert.ok(!talk.body.system.includes(ACT_FENCE), "hosted, Bino proposes no Teams messages or tickets");
  assert.match(talk.body.system, /can't propose sending messages/);
  assert.ok(calls.some((x) => x.body.model === "claude-haiku-5-5"), "memory is kept on Haiku");

  // Memory: what was said about Quill stays with Quill, and both are recalled there.
  const mems = await memory.list();
  assert.deepEqual(mems.map((m) => [m.scope, m.text]), [["app:quill", "Quill is for small schools."]]);
  assert.equal(await memory.prompt(), "", "not in a conversation about something else");
  assert.match(await memory.prompt("app:quill"), /About the app quill:[\s\S]*small schools/);
  assert.equal(await memory.forget(mems[0]!.id), true);

  // The sidebar's ops go to the object too.
  assert.equal(await bino.rename(c.id, "Quill"), true);
  assert.equal(await bino.pin(c.id, true), true);
  const gone = await bino.start("Throwaway");
  assert.equal(await bino.remove(gone.id), true);
  assert.equal(await bino.get(gone.id), undefined);
  await hub.idle();

  // A restart (a new object on the same storage) keeps the conversation, its new name and its pin.
  const again = new DovreHub(state, env);
  const ask = async (o: unknown) => (await (await again.fetch(new Request("https://hub.internal/bino", { method: "POST", body: JSON.stringify(o) }))).json()) as { msgs: unknown[]; title: string; pinned?: boolean } | null;
  const kept = (await ask({ op: "get", id: c.id }))!;
  assert.deepEqual([kept.msgs.length, kept.title, kept.pinned], [2, "Quill", true]);
  assert.equal(await ask({ op: "get", id: gone.id }), null, "deleted stays deleted");
});

test("an answer cut off by the object going away says so, and the hub refuses what isn't its protocol", async () => {
  const { state } = fakeState();
  sqlConvStore(state.storage.sql).save([{ id: "11111111-2222-3333-4444-555555555555", title: "t", at: 1, msgs: [{ role: "user", text: "hi", at: 1 }], thinking: false }]);
  const hub = new DovreHub(state, { DB: openDb().DB });
  const c = (await (await hub.fetch(new Request("https://hub.internal/bino", { method: "POST", body: JSON.stringify({ op: "get", id: "11111111-2222-3333-4444-555555555555" }) }))).json()) as { error?: string };
  assert.match(c.error ?? "", /interrupted/);
  assert.equal((await hub.fetch(new Request("https://hub.internal/anything"))).status, 404);
  // Not configured: Bino says what's missing rather than failing on a call.
  assert.match(hostedBinoRoute({ DB: openDb().DB }).why ?? "", /CF_ACCOUNT_ID and CF_AIG_TOKEN/);
  assert.equal(hostedBinoRoute({ DB: openDb().DB, CF_ACCOUNT_ID: "a", CF_AIG_TOKEN: "t", BINO_VIA: "off" }).ready, false);
  // A publish with junk topics publishes only strings.
  const r = (await (await hub.fetch(new Request("https://hub.internal/publish", { method: "POST", body: JSON.stringify({ topics: ["ok", 1, { x: 1 }] }) }))).json()) as { ok: boolean };
  assert.equal(r.ok, true);
});

test("a hosted gather tells open pages when it finished, and \"snapshot\" only when something changed", async () => {
  const { state } = fakeState();
  const hub = new DovreHub(state, { DB: openDb().DB });
  const client = hubClient(nsOf(hub));
  const page = await hub.fetch(new Request("https://hub.internal/events"));
  const events = heard(page, '"synced":2000');
  client.gathered(1000, true);
  client.gathered(2000, false);
  await client.drain();
  const got = await events;
  assert.match(got, /data: \{"topics":\["snapshot"\],"at":\d+,"synced":1000\}/);
  assert.match(got, /data: \{"topics":\[\],"at":\d+,"synced":2000\}/, "unchanged: the time only, so the sidebar says Synced without a swap");
  // Junk for synced is dropped, and with no topics nothing goes out.
  const r = (await (await hub.fetch(new Request("https://hub.internal/publish", { method: "POST", body: JSON.stringify({ synced: "soon" }) }))).json()) as { ok: boolean };
  assert.equal(r.ok, true);
});

test("hosted pages: Bino through the object, what packs share instead of GitHub, the app a page belongs to, and /events from the hub", async () => {
  const db = openDb();
  const { state } = fakeState();
  const env: HubEnv = { DB: db.DB, CF_ACCOUNT_ID: "acc-1", CF_AIG_TOKEN: "aig-tok" };
  const calls: Call[] = [];
  const hub = new DovreHub(state, env);
  hub.fetchFn = fakeGateway(`Reply ${H}`, calls);
  const client = hubClient(nsOf(hub));
  const quill: Pack = { manifest: { api: PACK_API, id: "quill", name: "Quill", description: "", domain: "personal" }, bino: () => `12 trials\u0007, 3 end this week ${H}` };
  const broken: Pack = { manifest: { api: PACK_API, id: "broken", name: "Broken", description: "", domain: "personal" }, bino: () => { throw new Error("no memory"); } };
  // No `bino` of its own: Bino hears what it shows on Today. A private pack's stays out.
  const lark: Pack = { manifest: { api: PACK_API, id: "lark", name: "Lark", description: "", domain: "personal" }, glance: () => [{ label: "queued", value: 4 }], needs: () => [{ key: "a", title: "Lark job failed: nightly", href: "/lark", tone: "bad", at: 1 }] };
  const mail: Pack = { manifest: { api: PACK_API, id: "mail", name: "Mail", description: "", domain: "personal", private: true }, needs: () => [{ key: "m", title: "MAIL-SUBJECT", href: "/mail", tone: "warn", at: 1 }] };
  const s = snapshot({ prs: { ok: true, value: { mine: [pr({ title: "GITHUB-ONLY-TITLE" })], review: [] } } as never });
  const app = createApp(
    { ...ENV, DB: db.DB, IS_HOSTED: "1" },
    {
      gatherer: fixedGatherer(s),
      ghe: fakeGhe({}).ghe,
      access: async () => ({ email: "me@example.dev" }),
      hub: client,
      events: client.events,
      bino: { remote: remoteBino(client, { route: hostedBinoRoute(env), memory: noMemory("no"), sees: "My list and what your apps share" }) },
      packs: { ...activePacks([quill, broken, lark, mail], { env: {}, hosted: true }), env: {} },
    },
  );
  const at = "https://dovre.example.dev";
  const page = await (await app.fetch(new Request(`${at}/bino`))).text();
  assert.match(page, /class="bino-sees">My list and what your apps share/);
  assert.match(page, /href="\/bino"/, "Bino is in the menu hosted");

  const form = new URLSearchParams({ text: "How is it going?", dock: "1", view: "/quill/writers" });
  const res = await app.fetch(new Request(`${at}/bino/new`, { method: "POST", body: form, headers: { origin: at, "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(res.status, 303);
  const id = res.headers.get("location")!.split("/").pop()!;
  await hub.idle();
  const system = calls.find((x) => x.body.model === "claude-sonnet-5-5")!.body.system;
  assert.match(system, /## Quill \(one of the user's apps\)\n12 trials , 3 end this week/, "the pack's lines, control characters out");
  assert.ok(!system.includes("GITHUB-ONLY-TITLE"), "no GitHub snapshot hosted");
  assert.ok(!system.includes("Broken"), "a pack that fails says nothing");
  assert.match(system, /## Lark \(one of the user's apps\)\nqueued: 4\.\nNeeds them: Lark job failed: nightly\./, "a pack without `bino`: its glance and needs");
  assert.ok(system.indexOf("## Quill") < system.indexOf("## Lark"), "packs that speak for themselves first");
  assert.ok(!system.includes("MAIL-SUBJECT") && !system.includes("## Mail"), "a private pack says nothing it didn't choose to");
  const user = calls.find((x) => x.body.model === "claude-sonnet-5-5")!.body.messages[0]!.content;
  assert.match(user, /\[Looking at a page of their app Quill \(\/quill\/writers\)\. You only know which page this is/);
  const conv = (await (await hub.fetch(new Request("https://hub.internal/bino", { method: "POST", body: JSON.stringify({ op: "get", id }) }))).json()) as { app?: string };
  assert.equal(conv.app, "quill", "a conversation started on Quill's page is about Quill");

  const shown = await (await app.fetch(new Request(`${at}/bino/c/${id}`))).text();
  assertInert("conversation", shown);
  const ev = await app.fetch(new Request(`${at}/events`));
  assert.match(ev.headers.get("content-type") ?? "", /text\/event-stream/);
  await ev.body?.cancel();
  await client.drain();
});

test("appsOf: plain text, capped, nameless or empty packs left out; viewOf names a pack's page without describing it", async () => {
  const long = "x".repeat(5000);
  const got = appsOf([
    { name: "Quill", text: `a\r\nb\u0000c\n\n\n\nd` },
    { name: "Long", text: long },
    { name: "", text: "no name" },
    { name: "Empty", text: "   " },
    { name: "Obj", text: { toString: () => "nope" } },
  ]);
  assert.deepEqual(got.map((a) => a.name), ["Quill", "Long"]);
  assert.equal(got[0]!.text, "a\nb c\n\nd");
  assert.equal(got[1]!.text.length, 1500);
  assert.match(await viewOf("/quill/x?y=1", undefined, [{ id: "quill", name: "Quill" }]), /^a page of their app Quill \(\/quill\/x\)\. You only know which page/);
  assert.equal(await viewOf("/quilller", undefined, [{ id: "quill", name: "Quill" }]), "a page in Dovre.");
});

test("defaultBinoOf: a pack's glance, pulse, needs and last day's feed as plain lines; junk and old events left out", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const got = defaultBinoOf(
    {
      glance: [{ label: "trials", value: 12 }, { label: "", value: 3 }, "junk", { label: "mrr", value: "4 200 kr" }],
      pulse: { working: 2, asking: 0, trouble: { level: "fire", why: "queue stuck" } },
      needs: [...Array.from({ length: 7 }, (_, i) => ({ title: `need ${i}` })), { title: "  " }],
      feed: [{ at: now - 1000, what: "signed up", title: "a writer" }, { at: now - 2 * 86_400_000, what: "OLD" }, { at: now - 10, what: "deployed" }],
    },
    now,
  );
  assert.equal(got, "trials: 12, mrr: 4 200 kr.\nNow: 2 working, trouble: queue stuck.\nNeeds them: need 0; need 1; need 2; need 3; need 4 (and 2 more).\nLately: deployed; signed up a writer.");
  assert.equal(defaultBinoOf({}), "");
  assert.equal(defaultBinoOf({ glance: "x", needs: { title: "y" }, pulse: 3, feed: null }), "");
});
