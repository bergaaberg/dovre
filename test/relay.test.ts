/** The relay's questions: read narrowly, answered only by a click here, the safe answer first. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentActions } from "../src/actions/deploys.ts";
import { choicesOf, createAsks } from "../src/relay/asks.ts";
import { assertInert, H, signedIn, snapshot } from "./helpers.ts";

// db-cli's prod gate, as it asks (internal/mcpserver/prodgate.go).
const DB_SCHEMA = { type: "object", properties: { decision: { type: "string", title: "Production access to ledger:prod", enum: ["deny", "allow"] } }, required: ["decision"] };

test("a form is answerable only when it's one field with a few choices or a yes/no; the first choice is the safe one", () => {
  assert.deepEqual(choicesOf(DB_SCHEMA), { field: "decision", choices: [{ value: "deny", safe: true }, { value: "allow", safe: false }] });
  assert.deepEqual(choicesOf({ type: "object", properties: { ok: { type: "boolean" } } }).choices.map((c) => c.value), ["false", "true"]);
  for (const odd of [null, "x", {}, { properties: { a: { type: "string" }, b: { type: "string" } } }, { properties: { a: { type: "string" } } }, { properties: { a: { enum: [1, 2] } } }])
    assert.deepEqual(choicesOf(odd).choices, [], JSON.stringify(odd));
});

test("a question waits for my answer, and the relay gets exactly what I chose", async () => {
  const changes: number[] = [];
  const asks = createAsks({ onChange: () => changes.push(1) });
  const q = asks.put({ server: "db", message: "Open PRODUCTION ledger:prod?", schema: DB_SCHEMA });
  assert.equal(asks.list().length, 1);
  assert.deepEqual(await asks.wait(q.id, 10), { state: "waiting" });
  const waiting = asks.wait(q.id, 5000);
  assert.equal(asks.answer(q.id, { choice: "allow" })?.id, q.id);
  assert.deepEqual(await waiting, { state: "answered", answer: { action: "accept", content: { decision: "allow" } } });
  assert.deepEqual(await asks.wait(q.id, 10), { state: "gone" }, "delivered once");
  assert.equal(asks.list().length, 0);
  assert.ok(changes.length >= 2);
});

test("a choice the form didn't offer isn't an answer; declining always is; an abandoned question goes away", async () => {
  let t = 0;
  const asks = createAsks({ now: () => t, staleMs: 1000 });
  const q = asks.put({ server: "db", message: "?", schema: DB_SCHEMA });
  assert.equal(asks.answer(q.id, { choice: "yes please" }), undefined);
  assert.equal(asks.answer(q.id, {}), undefined);
  asks.answer(q.id, { decline: true });
  assert.deepEqual(await asks.wait(q.id, 10), { state: "answered", answer: { action: "decline" } });
  const odd = asks.put({ server: "x", message: "free text?", schema: { properties: { a: { type: "string" } } } });
  assert.equal(asks.answer(odd.id, { choice: "anything" }), undefined, "an unanswerable form can only be declined");
  t = 5000;
  assert.equal(asks.list().length, 0, "nobody asked for it for a while: the session ended");
});

test("through the app: the relay asks, every page shows it with Deny first and Allow behind a second click, my click answers it", async () => {
  const { app, get, post } = signedIn(snapshot());
  const ask = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("http://localhost/relay/ask", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await ask({ server: "db", message: "x" })).status, 404, "no cookie, nothing here");
  const made = await ask({ server: `db${H}`, message: `An agent is asking to read the PRODUCTION database ledger:prod.${H}`, schema: DB_SCHEMA }, { cookie: "u_tk=test-token" });
  assert.equal(made.status, 200);
  const { id } = (await made.json()) as { id: string };
  for (const path of ["/", "/agents", "/settings"]) {
    const out = await (await get(path)).text();
    assertInert(path, out);
    assert.match(out, /class="approval"/, path);
    assert.match(out, /PRODUCTION database ledger:prod/);
    const bar = out.slice(out.indexOf('id="approvals"'));
    assert.ok(bar.indexOf('value="deny"') < bar.indexOf('value="allow"'), "deny comes first");
    assert.match(bar, /<details class="confirm"><summary>Allow…<\/summary>/, "allow takes a second click");
  }
  assert.equal((await post(`/relay/ask/${id}/answer`, { choice: "allow" }, { origin: "http://evil.example" })).status, 403, "only this app's own form answers");
  const answered = await post(`/relay/ask/${id}/answer`, { choice: "deny" });
  assert.equal(answered.status, 303);
  const got = await app.request(`http://localhost/relay/ask/${id}`, { headers: { cookie: "u_tk=test-token" } });
  assert.deepEqual(await got.json(), { state: "answered", answer: { action: "accept", content: { decision: "deny" } } });
  assert.doesNotMatch(await (await get("/")).text(), /class="approval"/, "answered: gone from the pages");
});

test("several questions from db at once: one bar, Deny all first, Allow all behind a second click, each answered and logged", async () => {
  const { app, get, post, db } = signedIn(snapshot());
  const ask = async (t: string) => {
    const r = await app.request("http://localhost/relay/ask", { method: "POST", headers: { "content-type": "application/json", cookie: "u_tk=test-token" }, body: JSON.stringify({ server: "db", message: `Open ${t}?${H}`, schema: DB_SCHEMA }) });
    return ((await r.json()) as { id: string }).id;
  };
  const ids = [await ask("ledger:prod"), await ask("shop:prod"), await ask("warehouse:prod")];
  const out = await (await get("/")).text();
  assertInert("grouped bar", out);
  const bar = out.slice(out.indexOf('id="approvals"'));
  assert.match(bar, /db asks 3 questions/);
  assert.equal((bar.match(/class="approval"/g) ?? []).length, 1, "one bar for the three");
  assert.ok(bar.indexOf(">Deny all<") > 0 && bar.indexOf(">Deny all<") < bar.indexOf("Allow all 3"), "deny all comes first");
  assert.match(bar, /<details class="confirm"><summary>Allow all 3…<\/summary>/, "allow all takes a second click");
  assert.equal((await post("/relay/asks/answer", { ids: ids.join(","), choice: "allow" }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post("/relay/asks/answer", { ids: `${ids.join(",")},not-an-id`, choice: "allow" })).status, 303);
  for (const id of ids) {
    const got = await app.request(`http://localhost/relay/ask/${id}`, { headers: { cookie: "u_tk=test-token" } });
    assert.deepEqual(await got.json(), { state: "answered", answer: { action: "accept", content: { decision: "allow" } } });
  }
  const logged = (await recentActions(db.DB)).filter((a) => a.kind === "relay.answer");
  assert.equal(logged.length, 3, "each answer logged");
  assert.doesNotMatch(await (await get("/")).text(), /class="approval"/);
});

test("one question alone keeps its own bar", async () => {
  const { app, get } = signedIn(snapshot());
  await app.request("http://localhost/relay/ask", { method: "POST", headers: { "content-type": "application/json", cookie: "u_tk=test-token" }, body: JSON.stringify({ server: "db", message: "Open ledger:prod?", schema: DB_SCHEMA }) });
  const bar = await (await get("/")).text();
  assert.doesNotMatch(bar, /Allow all/);
  assert.match(bar, /<summary>Allow…<\/summary>/);
});
