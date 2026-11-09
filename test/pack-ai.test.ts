/** Packs talk to the model (#466): off until I allow it on the pack's Settings page; the size I allowed; a day's cap; logged by cost only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aiAskOf, grantOf, NO_GRANT } from "../src/packs/ai.ts";
import { assertInert, HOSTILE, packApp } from "../src/packs/testing.ts";
import { type Pack, PACK_API, type PackCompleteAsk } from "../src/packs/types.ts";

/** A pack that asks the model what its page is told to, and says what came back. */
function asker(why: string | undefined): Pack {
  return {
    manifest: { api: PACK_API, id: "asker", name: "Asker", description: "Asks", domain: "general", ...(why ? { ai: { text: { why } } } : {}) },
    routes(app, ctx) {
      app.get("/asker", async (c) => {
        const size = c.req.query("size") === "large" ? "large" : "small";
        try {
          const r = await ctx.complete({ system: "s", user: "u", size });
          return c.json({ text: r.text, cost: r.cost, ai: ctx.ai() });
        } catch (e) {
          return c.json({ error: (e as Error).message, ai: ctx.ai() });
        }
      });
    },
  };
}

function model(cost = 0.4) {
  const asked: { model?: string }[] = [];
  return { asked, route: { via: "Claude Code", models: { small: "haiku", large: "sonnet" }, complete: async (p: { model?: string } & Omit<PackCompleteAsk, "size">) => (asked.push({ model: p.model }), { text: "a summary", cost }) } };
}

const ask = async (get: (p: string) => Promise<Response> | Response, q = "") => (await (await get(`/asker${q}`)).json()) as { text?: string; error?: string; ai: { text: boolean; why?: string } };

test("off until I allow it: the pack is told why, and the model is never asked", async () => {
  const m = model();
  const { get } = packApp([asker("Summaries of my PRs")], { ai: m.route });
  const r = await ask(get);
  assert.match(r.error ?? "", /not allowed/);
  assert.equal(r.ai.text, false);
  assert.equal(m.asked.length, 0);
});

test("allowed on its Settings page: the small model answers; large needs 'any'; each call logged by cost", async () => {
  const m = model(0.1);
  const { get, post, db } = packApp([asker("Summaries of my PRs")], { ai: m.route });
  const page = await (await get("/settings/packs/asker")).text();
  assert.match(page, /id="ai"[\s\S]*Summaries of my PRs[\s\S]*Not allowed/);
  assert.equal((await post("/settings/packs/asker/ai", { level: "text", size: "small", dayUsd: "1" }, { origin: "https://evil.example" })).status, 403, "another site can't allow it");
  assert.equal((await post("/settings/packs/asker/ai", { level: "text", size: "small", dayUsd: "1" })).status, 303);
  const r = await ask(get);
  assert.equal(r.text, "a summary");
  assert.deepEqual(m.asked, [{ model: "haiku" }]);
  assert.match((await ask(get, "?size=large")).error ?? "", /only the small model/);
  await post("/settings/packs/asker/ai", { level: "text", size: "any", dayUsd: "1" });
  assert.equal((await ask(get, "?size=large")).text, "a summary");
  assert.equal(m.asked.at(-1)?.model, "sonnet");
  const calls = (await db.DB.prepare("SELECT * FROM pack_ai_calls WHERE pack = 'asker'").all<Record<string, unknown>>()).results;
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[0]).sort(), ["at", "cost", "kind", "ok", "pack", "place", "repo", "run", "state"], "when, cost and whether: never the prompt or the reply");
  assert.deepEqual([calls[0].kind, calls[0].run, calls[0].state], ["text", null, null], "the agent's columns stay empty for a text call");
  const logged = (await db.DB.prepare("SELECT kind, target FROM actions WHERE kind = 'packs.ai'").all<{ target: string }>()).results;
  assert.equal(logged.length, 2, "each change of grant is in the actions log");
  assert.match(await (await get("/settings/packs/asker")).text(), /\$0\.20 of \$1\.00 today/);
});

test("the day's dollars: once spent, it can't ask until tomorrow; taking it back stops it at once", async () => {
  const m = model(0.6);
  const { get, post } = packApp([asker("x")], { ai: m.route });
  await post("/settings/packs/asker/ai", { level: "text", size: "small", dayUsd: "1" });
  assert.equal((await ask(get)).text, "a summary");
  assert.equal((await ask(get)).text, "a summary", "0.60 spent is under the cap: one more");
  assert.match((await ask(get)).error ?? "", /today's cap \(\$1\.00\) is spent/);
  assert.equal(m.asked.length, 2);
  await post("/settings/packs/asker/ai", { level: "off", size: "small", dayUsd: "5" });
  assert.match((await ask(get)).error ?? "", /not allowed/);
});

test("a pack that didn't ask in its manifest gets nothing, and has no form to allow it", async () => {
  const { get, post } = packApp([asker(undefined)], { ai: model().route });
  assert.match((await ask(get)).error ?? "", /didn't ask/);
  assert.equal((await post("/settings/packs/asker/ai", { level: "text" })).status, 404);
});

test("no model here: allowed or not, it's told so", async () => {
  const { get, post } = packApp([asker("x")]);
  await post("/settings/packs/asker/ai", { level: "text", size: "small", dayUsd: "1" });
  assert.match((await ask(get)).error ?? "", /no model here/);
});

test("its why is one line of text, cut short, drawn inert; a grant is read safely", async () => {
  assert.equal(aiAskOf({ ai: { text: { why: "a\n\nb" } } })?.text?.why, "a b");
  assert.equal(aiAskOf({ ai: { text: { why: 3 } } }), undefined);
  assert.equal(aiAskOf({ ai: "text" }), undefined);
  assert.equal(aiAskOf({ ai: { text: { why: "x".repeat(500) } } })?.text?.why.length, 200);
  assert.deepEqual(grantOf({ level: "agent", size: "huge", dayUsd: "-3" }), { ...NO_GRANT, level: "off", size: "small", dayUsd: 1 });
  assert.deepEqual(grantOf({ level: "text", size: "any", dayUsd: "9999" }), { ...NO_GRANT, level: "text", size: "any", dayUsd: 50 });
  const { get } = packApp([asker(HOSTILE)], { ai: model().route });
  assertInert("pack AI panel", await (await get("/settings/packs/asker")).text());
});

test("AI summaries keep what they had as a core pack: allowed text, small, $1 a day", async () => {
  const { db } = packApp([]);
  const row = await db.DB.prepare("SELECT level, size, day_usd FROM pack_ai WHERE pack = 'summaries'").first<{ level: string; size: string; day_usd: number }>();
  assert.deepEqual({ ...row }, { level: "text", size: "small", day_usd: 1 });
});
