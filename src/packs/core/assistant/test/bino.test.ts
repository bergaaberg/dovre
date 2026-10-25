/** Bino: talks only, is told only names and states, proposes plans that reach my list only on my click, remembers only what was said. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../app.ts";
import { createBino } from "../bino/bino.ts";
import { contextOf, MAX_STEPS, planOf, splitReply, transcriptOf } from "../bino/context.ts";
import { loadMemory, noMemory } from "../bino/memory.ts";
import { binoArgs, type Route, routeOf, viaOf } from "../bino/route.ts";
import { openDb } from "../../../../db.ts";
import { addTodo, listTodos } from "../../../../todo/store.ts";
import { assertInert, fakeGhe, fixedGatherer, H, pr, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

test("the CLI route only talks: no tools, no MCP servers, no settings, no session kept; the conversation goes in on stdin", async () => {
  const args = binoArgs("SYSTEM", "sonnet");
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(at("--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(at("--mcp-config"), '{"mcpServers":{}}');
  assert.equal(at("--setting-sources"), "");
  assert.ok(args.includes("--no-session-persistence") && args.includes("--disable-slash-commands"));
  assert.ok(!args.some((a) => /allowedTools|dangerously|bypass/i.test(a)));
  const calls: { bin: string; args: string[]; input?: string }[] = [];
  const route = routeOf({
    via: "claude",
    claude: { bin: "claude.exe", pre: [], path: "claude.exe" },
    run: async (bin, a, o) => (calls.push({ bin, args: a, input: o.input }), { code: 0, stdout: JSON.stringify({ result: "Hei.", total_cost_usd: 0.004 }), stderr: "" }),
  });
  assert.ok(route.ready);
  assert.deepEqual(await route.ask!({ system: "S", user: "U" }), { text: "Hei.", cost: 0.004 });
  assert.equal(calls[0]!.input, "U", "the conversation on stdin, not in an argument");
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--model") + 1], "sonnet");
  assert.equal((await route.ask!({ system: "S", user: "U", model: "haiku" }), calls[1]!.args[calls[1]!.args.indexOf("--model") + 1]), "haiku");
});

test("BINO_VIA: claude when it's here, off when nothing is; a route that can't run says why", () => {
  assert.equal(viaOf(undefined, true), "claude");
  assert.equal(viaOf(undefined, false), "off");
  assert.equal(viaOf("OFF", true), "off");
  assert.equal(viaOf("nonsense", true), "claude");
  for (const via of ["omp", "off"] as const) {
    const r = routeOf({ via });
    assert.equal(r.ready, false);
    assert.ok(r.why, via);
  }
  assert.match(routeOf({ via: "claude" }).why ?? "", /Claude Code/);
});

test("Bino is told names and states only: no PR bodies, prompts, recaps or tool output", () => {
  const s = snapshot({
    prs: { ok: true, value: { mine: [pr({ title: "Mine", body: "SECRET-BODY", number: 7 })], review: [pr({ title: "Theirs", author: "kari", body: "SECRET-BODY-2" })] } },
  });
  const todos = [{ id: 1, parent: null, title: "Renew certs", notes: "SECRET-NOTES-ARE-FINE?", state: "next" as const, due: null, pos: 1, createdAt: 0, updatedAt: 0, doneAt: null }];
  const ctx = contextOf({ todos, s, now: Date.parse("2026-10-22T12:00:00Z") });
  for (const shown of ["Mine", "Theirs", "#1 [next] Renew certs"]) assert.ok(ctx.includes(shown), shown);
  for (const hidden of ["SECRET-BODY", "SECRET-PROMPT", "SECRET-RECAP", "SECRET-NOTES"]) assert.ok(!ctx.includes(hidden), hidden);
  assert.ok(!/data[\\/]lab/.test(ctx));
});

test("a plan is read strictly: junk, injection and the wrong shape give no card; steps are capped and states checked", () => {
  const ok = splitReply('Sure.\n\n```bino-plan\n{"title":"Certs","notes":"n","steps":[{"title":"List them","state":"doing","due":"2026-10-30"},{"title":"Renew","state":"done"},{"title":"x","due":"tomorrow"}],"evil":1}\n```');
  assert.equal(ok.text, "Sure.");
  assert.deepEqual(ok.plan, { title: "Certs", notes: "n", steps: [{ title: "List them", state: "doing", due: "2026-10-30" }, { title: "Renew", state: "next", due: null }, { title: "x", state: "next", due: null }] });
  assert.equal(splitReply("```bino-plan\nnot json\n```").plan, null);
  assert.equal(splitReply('```bino-plan\n{"steps":[]}\n```').plan, null, "no title, no plan");
  assert.equal(splitReply('```json\n{"title":"t","steps":[]}\n```').plan, null, "only the agreed fence counts");
  const many = planOf({ title: "t", steps: Array.from({ length: 40 }, (_, i) => ({ title: `s${i}` })) });
  assert.equal(many?.steps.length, MAX_STEPS);
  assert.equal(planOf({ title: "a\u0000b\u001bc", steps: [] })?.title, "a b c", "control characters out");
  assert.equal(planOf(["title"]), null);
});

test("the conversation goes to the model labelled, newest last; long ones lose their oldest turns", () => {
  const t = transcriptOf([{ role: "user", text: "Hei" }, { role: "assistant", text: "Hallo" }, { role: "user", text: "Hjelp" }]);
  assert.match(t, /^User: Hei\n\nBino: Hallo\n\nUser: Hjelp/);
  const long = transcriptOf([{ role: "user", text: "x".repeat(30_000) }, { role: "user", text: "last" }], 1000);
  assert.match(long, /earlier turns left out/);
  assert.match(long, /User: last/);
});

/** A model that answers with a plan, and keeps what it was asked. */
function fakeRoute(reply: string, asked: { system: string; user: string; model?: string }[] = []): Route {
  return { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: p.model === "haiku" ? '{"ops":[{"op":"add","text":"The user groups work into small initiatives.","kind":"preference"}]}' : reply, cost: 0.01 }) };
}

test("a plan reaches my list only on Add, as the card's form says, once", async () => {
  const db = openDb();
  const route = fakeRoute('Here.\n```bino-plan\n{"title":"Certs","steps":[{"title":"List them"},{"title":"Renew"}]}\n```');
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") } });
  const req = (path: string, body?: string) => app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body });
  const started = await req("/bino/new", "text=Help+with+certs");
  assert.equal(started.status, 303);
  const at = started.headers.get("location")!;
  assert.match(at, /^\/bino\/c\/[0-9a-f-]{36}$/);
  // Fill in: the reply comes in the background.
  for (let i = 0; i < 50 && !/A breakdown for your list/.test(await (await req(at)).text()); i++) await new Promise((r) => setTimeout(r, 20));
  const page = await (await req(at)).text();
  assert.match(page, /Add these to my list/);
  assert.equal((await listTodos(db.DB)).length, 0, "nothing written before the click");
  const form = new URLSearchParams([["title", "Certs, renamed"], ["step_title", "List them"], ["step_state", "doing"], ["step_due", ""], ["step_title", ""], ["step_state", "next"], ["step_due", ""], ["step_title", "Added by me"], ["step_state", "waiting"], ["step_due", "2026-11-01"], ["target", "new"]]);
  const add = await req(`${at}/plan/1`, form.toString());
  assert.equal(add.status, 303);
  const list = await listTodos(db.DB);
  assert.deepEqual(list.map((t) => [t.title, t.state, t.due, t.parent === null]), [["Certs, renamed", "next", null, true], ["List them", "doing", null, false], ["Added by me", "waiting", "2026-11-01", false]]);
  await req(`${at}/plan/1`, form.toString());
  assert.equal((await listTodos(db.DB)).length, 3, "a second press adds nothing");
  assert.match(await (await req(at)).text(), /Added to your list/);
});

test("memory: recalled into every conversation, kept from what was said only, listed and forgettable", async () => {
  const db = openDb();
  const memory = await loadMemory(db.DB);
  assert.ok(memory.available, "memlet is installed here");
  const asked: { system: string; user: string; model?: string }[] = [];
  const route = fakeRoute("Noted.", asked);
  const bino = createBino({ route, memory, context: async () => "## My open pull requests\n- ACME/x#1 CONTEXT-ONLY-TITLE" });
  bino.start("I like small initiatives.");
  await bino.idle();
  const reflectCall = asked.find((a) => a.model === "haiku");
  assert.ok(reflectCall, "the cheap model keeps the memory");
  assert.ok(!reflectCall.user.includes("CONTEXT-ONLY-TITLE") && !reflectCall.system.includes("CONTEXT-ONLY-TITLE"), "reflect sees what was said, not what Bino was shown");
  const mems = await memory.list();
  assert.deepEqual(mems.map((m) => m.text), ["The user groups work into small initiatives."]);
  // The next conversation is told.
  bino.start("Again");
  await bino.idle();
  assert.match(asked.filter((a) => a.model !== "haiku").at(-1)!.system, /small initiatives/);
  assert.equal(await memory.forget(mems[0]!.id), true);
  assert.equal((await memory.list()).length, 0);
});

test("Bino's pages keep hostile text inert, and with Bino off they say how to turn it on", async () => {
  const db = openDb();
  const route = fakeRoute(`${H}\n\`\`\`bino-plan\n{"title":"${H.replace(/"/g, "'")}","steps":[{"title":"${H.replace(/"/g, "'")}"}]}\n\`\`\``);
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") } });
  const req = (path: string, body?: string) => app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body });
  const at = (await req("/bino/new", `text=${encodeURIComponent(H)}`)).headers.get("location")!;
  for (let i = 0; i < 50 && !/A breakdown/.test(await (await req(at)).text()); i++) await new Promise((r) => setTimeout(r, 20));
  for (const path of ["/bino", at]) assertInert(path, await (await req(path)).text());
  const off = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route: routeOf({ via: "off" }), memory: noMemory("no") } });
  const page = await (await off.request("http://localhost/bino", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.match(page, /Settings → Panes/);
  assert.doesNotMatch(page, /href="\/bino"[^>]*>Bino</, "no nav entry while it can't answer");
});

test("the Bino page offers openings and my open items to break down, each a one-click start", async () => {
  const db = openDb();
  const route = fakeRoute("Sure.");
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") } });
  const open = (await addTodo(db.DB, { title: "Move the CI pipelines" }))!;
  const done = (await addTodo(db.DB, { title: "Old thing", state: "done" }))!;
  const page = await (await app.request("http://localhost/bino", { headers: { cookie: "u_tk=test-token" } })).text();
  assert.match(page, /<form method="post" action="\/bino\/new" class="bino-compose" data-ctrl-enter>/);
  assert.match(page, /name="q" value="What should I do first today\?" formnovalidate/);
  assert.match(page, new RegExp(`name="todo" value="${open.id}" formnovalidate`));
  assert.doesNotMatch(page, new RegExp(`name="todo" value="${done.id}"`), "done items aren't offered");
  const res = await app.request("http://localhost/bino/new", { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: `text=&todo=${open.id}` });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /^\/bino\/c\/[0-9a-f-]{36}$/);
});
