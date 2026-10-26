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
import { createApp } from "../../../../app.ts";
import { type ActSpec, actOf, fenceOf, MAX_ACTS, splitActs } from "../bino/acts.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { openDb } from "../../../../db.ts";
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

function setup(reply: string) {
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: reply, cost: 0 }) };
  const file = join(mkdtempSync(join(tmpdir(), "bino-acts-")), "bino.json");
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no"), file } });
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
  return { req, until, asked, file };
}

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
