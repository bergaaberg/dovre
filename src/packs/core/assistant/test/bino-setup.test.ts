/**
 * Bino walks through a pack's setup (#420): the pack's own step drawn as a card in the conversation,
 * Next saving it as the setup page's Next does, with no model call between steps. Bino is asked only
 * when I write, and is told which step is shown and which are done, never what I typed in them.
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
import { CheckRows } from "../../../../ui/kit.ts";
import { type Conv, createBino } from "../bino/bino.ts";
import { DovreHub, type HubState } from "../../../../hosted/hub.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { looksLikeKey, setupLine } from "../bino/routes.ts";
import { withAssistant } from "./withAssistant.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

/** Three steps: a form step, a plain one, and one that runs a job (it draws itself again). */
function kitPack(o: { name?: string; title?: string } = {}) {
  const saved: Record<string, string | string[]>[] = [];
  const pack: Pack = {
    manifest: {
      api: PACK_API,
      id: "kit",
      name: o.name ?? "Kit",
      description: "",
      domain: "work",
      onboard: { steps: [{ id: "pick", title: o.title ?? "Pick repos" }, { id: "read", title: "Read this" }, { id: "job", title: "Index them" }] },
    },
    setup: {
      draw: (_c, step) =>
        step === "pick"
          ? { form: true, body: CheckRows({ name: "repo", label: "Repos", rows: [{ value: "a/web", label: o.title ?? "a/web", checked: true }] }) }
          : step === "read"
            ? { body: html`<p>Kit reads your repos once a day.</p>` }
            : { body: html`<p>Indexing…</p>`, refresh: 5 },
      save: async (_c, _step, form) => (saved.push(form), form.repo === "none" ? { ok: false, error: o.title ?? "Pick one." } : { ok: true }),
    },
  };
  return { pack, saved };
}

function setup(packs: Pack[], reply = "Sure.") {
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: reply, cost: 0 }) };
  const file = join(mkdtempSync(join(tmpdir(), "bino-setup-")), "bino.json");
  const db = openDb();
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no"), file }, packs: withAssistant(packs) });
  const req = (path: string, body?: Record<string, string | string[]>, headers: Record<string, string> = { origin: "http://localhost" }) => {
    if (body === undefined) return app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) form.append(k, x);
    return app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", ...headers }, body: form.toString() });
  };
  const until = async (at: string, re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const page = await (await req(at)).text();
      if (re.test(page)) return page;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${re}`);
  };
  return { req, until, asked };
}

test("a setup conversation: a fixed opening, the step as a card, Next saves it, and moving on asks nothing", async () => {
  const k = kitPack();
  const s = setup([k.pack]);
  const start = await s.req("/bino/new", { setup: "kit", dock: "1" });
  const at = start.headers.get("location")!;
  assert.match(at, /^\/bino\/dock\/c\/[0-9a-f-]{36}$/, "from the pane, back to the pane");
  const id = at.split("/").pop()!;
  const first = await (await s.req(at)).text();
  assert.match(first, /Setting up Kit: 3 steps\. Each one is below/);
  assert.match(first, /<meta name="u-topics" content="bino:[0-9a-f-]{36} kit">/, "it changes when Kit's setup does");
  assert.match(first, /Setting up Kit · 1 of 3<\/p><p class="bino-step-t">Pick repos/);
  assert.match(first, new RegExp(`<form method="post" action="/bino/c/${id}/setup\\?dock=1" class="bino-plan bino-step"><input type="hidden" name="step" value="pick">`));
  assert.match(first, /data-pack="kit">.*name="repo" value="a\/web" checked/s, "the pack's own body, boxed");
  assert.match(first, /href="\/setup\/kit\?at=pick" target="_top">Open its page</);
  assert.doesNotMatch(first, /Retry/, "an opening of Bino's own isn't asked again");
  assert.equal(s.asked.length, 0, "no model call to open");

  assert.equal((await s.req(`/bino/c/${id}/setup?dock=1`, { step: "pick", repo: "a/web" }, {})).status, 403, "Next only from Dovre itself");
  const refused = await s.req(`/bino/c/${id}/setup?dock=1`, { step: "pick", repo: "none" });
  assert.equal(refused.status, 422, "refused: the conversation again, in this answer");
  assert.match(await refused.text(), /value="pick">.*Not kept\.<\/strong> Pick one\./s);

  const next = await s.req(`/bino/c/${id}/setup?dock=1`, { step: "pick", repo: ["a/web", "a/api"] });
  assert.equal(next.headers.get("location"), `/bino/dock/c/${id}#bino-setup`);
  assert.deepEqual(k.saved.at(-1), { repo: ["a/web", "a/api"] }, "the dock's own fields stay out of the pack's form");
  const second = await (await s.req(at)).text();
  assert.match(second, /<ul class="bino-done"><li><span aria-hidden="true">✓<\/span> Pick repos<\/li><\/ul>/);
  assert.match(second, /Kit · 2 of 3.*Read this.*Kit reads your repos/s);
  assert.equal(s.asked.length, 0, "moving on costs no model call");
  assert.match(await (await s.req("/")).text(), />2 of 3 left</, "the same setup as the page's");

  await s.req(`/bino/c/${id}/setup?dock=1`, { step: "read" });
  const third = await (await s.req(at)).text();
  assert.match(third, /Kit · 3 of 3.*This one runs for a minute on its own page.*href="\/setup\/kit\?at=job" target="_top">Open it on its page/s, "a job step is a link");
  assert.doesNotMatch(third, /action="\/bino\/c\/[^"]+\/setup/, "no Next for it here");

  // Done on its own page: the conversation picks up.
  await s.req("/setup/kit/next", { step: "job" });
  const done = await (await s.req(at)).text();
  assert.match(done, /That's it\.<\/strong> Kit is set up\./);
  assert.match(done, /Pick repos.*Read this.*Index them/s);
});

test("a setup conversation is told the step, never the values; a key is refused before it's said; the full page works too", async () => {
  const k = kitPack();
  const s = setup([k.pack]);
  const at = (await s.req("/bino/new", { setup: "kit" })).headers.get("location")!;
  assert.match(at, /^\/bino\/c\/[0-9a-f-]{36}$/, "without the pane, the full page");
  const id = at.split("/").pop()!;
  const page = await (await s.req(at)).text();
  assert.match(page, new RegExp(`action="/bino/c/${id}/setup" class="bino-plan bino-step"`));

  await s.req(`/bino/c/${id}/setup`, { step: "pick", repo: "secret/repo-name" });
  const key = "ghp_" + "a1".repeat(18);
  const no = await s.req(`/bino/c/${id}/say`, { text: `here it is ${key}` });
  assert.equal(no.status, 422);
  assert.match(await no.text(), /Not sent: that looks like a key\.<\/strong> Keys don't go in chat\. Set it on <a href="\/settings\/packs\/kit">/);
  assert.equal(s.asked.length, 0, "never reached the model");
  assert.doesNotMatch(await (await s.req(at)).text(), new RegExp(key), "nor the conversation");

  await s.req(`/bino/c/${id}/say`, { text: "What does reading do?" });
  await s.until(at, /Sure\./);
  const told = s.asked.at(-1)!.user;
  assert.match(told, /setting up Kit in this chat: step 2 of 3 \("Read this"\) is shown, done: "Pick repos"/);
  assert.doesNotMatch(told, /secret\/repo-name/, "what I picked stays out");
});

test("setup conversations: only for a pack with a setup here, hostile names inert, the engine keeps them apart", async () => {
  const k = kitPack({ name: H, title: H });
  const s = setup([k.pack]);
  assert.equal((await s.req("/bino/new", { setup: "nope" })).headers.get("location"), "/bino");
  assert.equal((await s.req("/bino/new", { setup: "../kit", dock: "1" })).headers.get("location"), "/bino/dock");
  const at = (await s.req("/bino/new", { setup: "kit", dock: "1" })).headers.get("location")!;
  const id = at.split("/").pop()!;
  assertInert("bino setup card", await (await s.req(at)).text());
  assertInert("bino setup refused", await (await s.req(`/bino/c/${id}/setup?dock=1`, { step: "pick", repo: "none" })).text());
  assert.equal((await s.req("/bino/c/00000000-0000-0000-0000-000000000000/setup", { step: "pick" })).status, 404);
  const plain = (await s.req("/bino/new", { text: "hi" })).headers.get("location")!;
  assert.equal((await s.req(`${plain}/setup`, { step: "pick" })).status, 404, "a conversation that isn't a setup has no Next");

  const engine = createBino({ route: { via: "claude", ready: true, ask: async () => ({ text: "x", cost: 0 }) } as unknown as Route, memory: noMemory("no"), context: async () => "" });
  const c = engine.start("Opening.", { setup: { pack: "kit", title: "Setting up Kit" } });
  assert.deepEqual([c.setup, c.app, c.title, c.thinking, c.msgs.map((m) => m.role)], ["kit", "kit", "Setting up Kit", false, ["assistant"]]);
  assert.equal(engine.retry(c.id), false, "nothing to ask again");
  assert.equal(engine.get(c.id)!.msgs.length, 1, "and the opening stays");
  assert.equal(engine.start("x", { setup: { pack: "Bad/Id", title: "t" } }).setup, undefined, "a bad id is an ordinary conversation");
});

test("what looks like a key, and the line Bino is told", () => {
  for (const k of ["sk-ant-api03-abcdefghijklmnop", "ghp_" + "x".repeat(36), "github_pat_" + "1".repeat(22), "xoxb-123-456-abcdef", "lin_api_" + "a".repeat(40), "AKIAABCDEFGHIJKLMNOP", "Zx81".repeat(9)]) assert.ok(looksLikeKey(`it is ${k}`), k);
  for (const t of ["what does reading do?", "https://github.com/acme/web/pull/123", "a".repeat(40), "pick_the_repositories_that_you_care_about"]) assert.ok(!looksLikeKey(t), t);
  const st = { pack: { id: "kit", name: "Kit" }, steps: [{ id: "a", title: "A" }, { id: "b", title: "B" }], done: ["a"], at: 1 };
  assert.equal(setupLine(st), 'setting up Kit in this chat: step 2 of 2 ("B") is shown, done: "A"');
  assert.equal(setupLine({ ...st, done: ["a", "b"], at: 2 }), "the chat's setup of Kit is finished");
});

test("hosted: the object opens a setup conversation without asking the model, and a bad pack id isn't one", async () => {
  const rows = new DatabaseSync(":memory:");
  let alarm = 0;
  const state: HubState = {
    storage: {
      // A write runs when it's sent, as the object's own SQLite does; a read when it's read.
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
  const c = await op({ op: "start", text: "Setting up Kit: 3 steps.", context: "", setup: { pack: "kit", title: "Setting up Kit" } });
  assert.deepEqual([c.setup, c.app, c.title, c.thinking, c.msgs.map((m) => [m.role, m.text])], ["kit", "kit", "Setting up Kit", false, [["assistant", "Setting up Kit: 3 steps."]]]);
  assert.equal((await op({ op: "get", id: c.id })).setup, "kit", "kept");
  assert.equal(calls, 0, "no model call");
  const bad = await op({ op: "start", text: "hi", context: "", setup: { pack: "../x", title: "t" } });
  assert.equal(bad.setup, undefined);
});
