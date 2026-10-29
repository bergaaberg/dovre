/** Bino streams: the answer grows on the page as it's written, its own blocks hidden until it's done, and nothing of the draft is kept. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../app.ts";
import { type Conv, createBino } from "../bino/bino.ts";
import { draftShown } from "../bino/routes.ts";
import { noMemory } from "../bino/memory.ts";
import { createApiKeyAsk, createCfGatewayAsk, createOpenRouterAsk } from "../bino/gateway.ts";
import { type Route, routeOf } from "../bino/route.ts";
import { openDb } from "../../../../db.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** A route that writes `parts` as it goes, then waits for `done()`. */
function writingRoute(parts: string[]) {
  let release: () => void = () => {};
  let wrote = false;
  const route: Route = {
    via: "claude",
    ready: true,
    model: "sonnet",
    reflectModel: "haiku",
    ask: async (p) => {
      let soFar = "";
      for (const t of parts) p.onText?.((soFar += t));
      wrote = true;
      await new Promise<void>((r) => (release = r));
      return { text: soFar, cost: 0.01 };
    },
  };
  return { route, wrote: () => wrote, done: () => release() };
}

/** A body sent in pieces that split lines (and events) anywhere. */
const sse = (lines: string[]) => {
  const all = lines.map((l) => `data: ${l}\n\n`).join("");
  const parts = [all.slice(0, 7), all.slice(7, 60), all.slice(60)];
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
};

test("the engine keeps the answer so far while it's written, shows it at most every draftMs, and keeps none of it", async () => {
  const w = writingRoute(["Hei", " der", ", Andreas"]);
  const shown: string[] = [];
  const saved: Conv[][] = [];
  const bino = createBino({ route: w.route, memory: noMemory("no"), context: async () => "", draftMs: 0, onDraft: (c) => shown.push(c.draft ?? ""), store: { load: () => [], save: (k) => saved.push(structuredClone(k)) } });
  const c = bino.start("Hei");
  await until(() => w.wrote() && shown.length > 0);
  assert.equal(bino.get(c.id)!.draft, "Hei der, Andreas");
  assert.ok(shown.length >= 1 && shown.at(-1) === "Hei der, Andreas", "the last growth goes out");
  w.done();
  await bino.idle();
  assert.equal(bino.get(c.id)!.draft, undefined);
  assert.equal(bino.get(c.id)!.msgs.at(-1)!.text, "Hei der, Andreas");
  assert.ok(saved.every((k) => k.every((x) => !("draft" in x))), "the draft is never saved");

  // Stopped while writing: the draft goes with it.
  const w2 = writingRoute(["Half"]);
  const b2 = createBino({ route: w2.route, memory: noMemory("no"), context: async () => "", draftMs: 0, onDraft: () => {} });
  const c2 = b2.start("x");
  await until(w2.wrote);
  assert.equal(b2.stop(c2.id), true);
  assert.equal(b2.get(c2.id)!.draft, undefined);
  w2.done();
  await b2.idle();
});

test("a draft hides Bino's own blocks (plan, act, lookup) and the start of one; other code shows", () => {
  assert.equal(draftShown("Here:\n```bino-plan\n{\"title\":"), "Here:");
  assert.equal(draftShown("Here:\n```bino-act\n{}\n```\nAfter it."), "Here:\n\nAfter it.");
  assert.equal(draftShown("Let me check.\n```bino-lookup\n{}\n```"), "Let me check.");
  assert.equal(draftShown("Soon\n``"), "Soon");
  assert.equal(draftShown("Soon\n```bino-p"), "Soon");
  assert.equal(draftShown("Code:\n```ts\nconst x = 1;"), "Code:\n```ts\nconst x = 1;");
});

test("the HTTP routes stream when asked (Messages API and chat completions), and read whole when not", async () => {
  const bodies: Record<string, unknown>[] = [];
  const messages = createCfGatewayAsk({
    accountId: "a",
    apiToken: "t",
    fetchFn: (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      if (!b.stream) return Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "Whole." }], usage: { input_tokens: 1000, output_tokens: 100 } });
      return sse([
        JSON.stringify({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1000 } } }),
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
        JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hei" } }),
        JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " du." } }),
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } }),
      ]);
    }) as typeof fetch,
  });
  const grew: string[] = [];
  assert.deepEqual(await messages({ system: "S", user: "U", onText: (t) => grew.push(t) }), { text: "Hei du.", cost: 0.003 });
  assert.deepEqual(grew, ["Hei", "Hei du."]);
  assert.equal(bodies[0]!.stream, true);
  assert.deepEqual(await messages({ system: "S", user: "U" }), { text: "Whole.", cost: 0.003 });
  assert.equal(bodies[1]!.stream, undefined, "memory's calls aren't streamed");

  const failing = createCfGatewayAsk({ accountId: "a", apiToken: "t", fetchFn: (async () => sse([JSON.stringify({ type: "error", error: { message: "overloaded" } })])) as unknown as typeof fetch });
  await assert.rejects(failing({ system: "S", user: "U", onText: () => {} }), /overloaded/);

  const chat = (usage: Record<string, number>) => (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return sse([JSON.stringify({ choices: [{ delta: { content: "Hal" } }] }), JSON.stringify({ choices: [{ delta: { content: "lo." } }] }), JSON.stringify({ choices: [], usage }), "[DONE]"]);
  }) as typeof fetch;
  const openai = createApiKeyAsk({ apiKey: "sk-test", fetchFn: chat({ prompt_tokens: 1_000_000, completion_tokens: 0 }) });
  const got: string[] = [];
  assert.deepEqual(await openai({ system: "S", user: "U", onText: (t) => got.push(t) }), { text: "Hallo.", cost: 0.15 });
  assert.deepEqual(got, ["Hal", "Hallo."]);
  assert.deepEqual(bodies.at(-1)!.stream_options, { include_usage: true });
  const router = createOpenRouterAsk({ apiKey: "k", fetchFn: chat({ cost: 0.0123 }) });
  assert.deepEqual(await router({ system: "S", user: "U", onText: () => {} }), { text: "Hallo.", cost: 0.0123 });
});

test("the CLI route streams with stream-json, reading text deltas as they come and the cost from the result line", async () => {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Ja" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: ", gjerne." } } },
    { type: "result", subtype: "success", is_error: false, result: "Ja, gjerne.", total_cost_usd: 0.002 },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  const args: string[][] = [];
  const route = routeOf({
    via: "claude",
    claude: { bin: "claude.exe", pre: [], path: "claude.exe" },
    run: async (_b, a, o) => {
      args.push(a);
      if (o.onStdout) for (let i = 0; i < lines.length; i += 37) o.onStdout(lines.slice(i, i + 37));
      return { code: 0, stdout: o.onStdout ? lines : JSON.stringify({ result: "Whole.", total_cost_usd: 0.001 }), stderr: "" };
    },
  });
  const grew: string[] = [];
  assert.deepEqual(await route.ask!({ system: "S", user: "U", onText: (t) => grew.push(t) }), { text: "Ja, gjerne.", cost: 0.002 });
  assert.deepEqual(grew, ["Ja", "Ja, gjerne."]);
  assert.equal(args[0]![args[0]!.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args[0]!.includes("--include-partial-messages") && args[0]!.includes("--verbose"));
  assert.ok(!args[0]!.some((a) => /allowedTools|dangerously|bypass/i.test(a)), "still talk only");
  assert.deepEqual(await route.ask!({ system: "S", user: "U" }), { text: "Whole.", cost: 0.001 });
  assert.equal(args[1]![args[1]!.indexOf("--output-format") + 1], "json");
});

test("the page shows the answer as it's written, inert, without Bino's blocks", async () => {
  const w = writingRoute([`Tenker på ${H}\n`, "```bino-plan\n{\"SECRET-PLAN\":1"]);
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot({})), ghe: fakeGhe({}).ghe, bino: { route: w.route, memory: noMemory("no") } });
  const req = (path: string, body?: Record<string, string>) =>
    app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: new URLSearchParams(body).toString() });
  const at = (await req("/bino/new", { text: "Planlegg" })).headers.get("location")!;
  await until(w.wrote);
  for (const path of [at, `/bino/dock/c/${at.split("/").pop()}`]) {
    const page = await (await req(path)).text();
    assert.match(page, /<li class="bino-msg bino writing" data-stop="2"><p class="bino-who">Bino <span class="t3">writing…<\/span>/, path);
    assert.match(page, /Bino is writing…/);
    assert.doesNotMatch(page, /SECRET-PLAN|bino-plan/);
    assertInert(path, page);
  }
  w.done();
  for (let i = 0; i < 100 && /bino-thinking/.test(await (await req(at)).text()); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(await (await req(at)).text(), /SECRET-PLAN|<li class="bino-msg bino" data-stop="2">/, "then the answer itself");
});
