/**
 * What Bino proposes to do: read strictly, shown as filled-in cards, and done only on my click.
 * What I change before sending stays out of Bino's conversation and off disk.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../../../app.ts";
import { actOf, chatsFor, fenceOf, fold, MAX_ACTS, splitActs, type ActSpec } from "../bino/acts.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { openDb } from "../../../../db.ts";
import type { Pack } from "../../../../packs/types.ts";
import { html } from "../../../../html.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", TICKET_PROJECTS: "DEV" };
const fence = (o: unknown) => `\`\`\`bino-act\n${JSON.stringify(o)}\n\`\`\``;

test("acts are read strictly: junk and the wrong shape give no card, at most three, fields capped", () => {
  const spec: ActSpec = {
    kind: "slack.message",
    app: "Slack",
    when: "to send a Slack message",
    fields: [
      { name: "to", about: "recipient", required: true, max: 120, text: false },
      { name: "text", about: "message body", required: true, max: 4000, text: true },
    ],
  };
  assert.equal(actOf({ kind: "slack.message", to: "Kari" }, [spec]), null, "no text");
  assert.equal(actOf({ kind: "email", to: "x", text: "y" }), null, "not a kind Bino has");
  assert.equal(actOf([]), null);
  assert.deepEqual(actOf({ kind: "slack.message", to: " Kari\u0000 ", text: "Hei\r\nder", extra: "dropped" }, [spec]), { kind: "slack.message", fields: { to: "Kari", text: "Hei\nder" } });
  assert.equal(actOf({ kind: "ticket", project: "DEV", type: "Story", summary: "x" }), null, "no tickets: they belong to a pack");
  assert.equal((actOf({ kind: "task", title: "x".repeat(999) }) as { title: string }).title.length, 255);
  const reply = `Here.\n${fence({ kind: "task", title: "1" })}\n${fence({ kind: "nope" })}\n\`\`\`bino-act\nnot json\n\`\`\`\n${[2, 3, 4].map((n) => fence({ kind: "task", title: String(n) })).join("\n")}`;
  const { text, acts } = splitActs(reply);
  assert.equal(text, "Here.");
  assert.equal(acts.length, MAX_ACTS);
  assert.deepEqual(acts.map((a) => (a as { title: string }).title), ["1", "2", "3"]);
  assert.match(fenceOf({ kind: "slack.message", fields: { to: "A", text: "1" } }), /slack\.message/);
});

test("the card finds the chat: word starts, Norwegian letters, one-on-one first, newest first", () => {
  const chats = [
    { id: "g", name: "Kari, Ola og Per", kind: "group" },
    { id: "k1", name: "Kari Nordmann", kind: "oneOnOne" },
    { id: "k2", name: "Kari Hansen", kind: "oneOnOne" },
    { id: "b", name: "Bjørn Åsheim", kind: "oneOnOne" },
    { id: "t", name: "Team Skytjenester", kind: "group" },
  ];
  assert.equal(fold("Bjørn Åse Ærlig"), "bjorn ase aerlig");
  assert.deepEqual(chatsFor("Kari", chats).map((c) => c.id), ["k1", "k2", "g"]);
  assert.deepEqual(chatsFor("kari hansen", chats).map((c) => c.id), ["k2"]);
  assert.deepEqual(chatsFor("Bjorn", chats).map((c) => c.id), ["b"]);
  assert.deepEqual(chatsFor("asheim", chats).map((c) => c.id), ["b"]);
  assert.deepEqual(chatsFor("tjenester", chats).map((c) => c.id), ["t"], "inside a word counts, for less");
  assert.deepEqual(chatsFor("Nobody", chats), []);
  assert.deepEqual(chatsFor("  ", chats), []);
});

function setup(reply: string, o: { refuse?: string; pack?: Pack } = {}) {
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: reply, cost: 0 }) };
  const file = join(mkdtempSync(join(tmpdir(), "bino-acts-")), "bino.json");
  const packs = o.pack ? { on: [o.pack], off: [], env: {} } : undefined;
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no"), file }, packs });
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

test("a pack act executes on click only, via the pack's act hook", async () => {
  const sent: { form: Record<string, string>; act: Record<string, string> }[] = [];
  const fakePack: Pack = {
    manifest: {
      api: 1,
      id: "slack",
      name: "Slack",
      description: "Slack integration",
      domain: "general",
    },
    acts: () => [
      {
        kind: "message",
        title: "Send a Slack message",
        when: "to send a message in Slack",
        button: "Send",
        oneClick: true,
        fields: [
          { name: "to", about: "recipient", required: true, max: 120 },
          { name: "text", about: "body", required: true, max: 4000, text: true },
        ],
        inputs: (act, kept) => html`<input name="to" value="${kept?.to ?? act.to ?? ""}" /><textarea name="text">${kept?.text ?? act.text ?? ""}</textarea>`,
        run: async (form, act) => {
          sent.push({ form, act });
          return { ok: true, done: `Sent to ${form.to || act.to}` };
        },
      },
    ],
  };

  const s = setup(`Her er et forslag.\n${fence({ kind: "slack.message", to: "Kari", text: "Hei! Kan du se på PR-en?" })}`, { pack: fakePack });
  const at = (await s.req("/bino/new", { text: "Skriv til Kari at hun må se på PR-en" })).headers.get("location")!;
  const page = await s.until(at, /Send a Slack message/);
  assert.match(page, /Hei! Kan du se på PR-en\?/);
  assert.equal(sent.length, 0, "nothing sent before the click");

  const actRes = await s.req(`${at}/act/1/0`, { to: "Kari Nordmann", text: "Hei! Kan du se på PR-en i dag? (endret av meg)" });
  assert.equal(actRes.status, 303);
  await s.until(at, /Sent to Kari Nordmann/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.form.to, "Kari Nordmann");
  assert.equal(sent[0]!.form.text, "Hei! Kan du se på PR-en i dag? (endret av meg)");
});

test("a task card goes to the normal preview, filled in; a ticket gets no card; hostile text stays inert", async () => {
  const s = setup(`${H}\n${fence({ kind: "ticket", project: "DEV", type: "Story", summary: H, description: H })}\n${fence({ kind: "task", parent: "ACME/intake#12", repo: "shop-api", title: H, body: H })}`);
  const at = (await s.req("/bino/new", { text: "x" })).headers.get("location")!;
  const page = await s.until(at, /A dev task/);
  assertInert("bino acts", page);
  assert.doesNotMatch(page, /issues\/ticket|Jira/);
  assert.match(page, /action="\/issues\/task\/preview"/);
  assert.match(page, /name="repo" value="ACME\/shop-api"/, "a short repo name gets the org");
  assert.match(page, /name="parent" value="ACME\/intake#12"/);
});
