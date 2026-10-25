/**
 * What Bino proposes to do: read strictly, shown as filled-in cards, and done only on my click.
 * Bino never gets Teams' chats; the card finds the chat. What I change before sending stays out of
 * Bino's conversation and off disk.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../../../app.ts";
import { actOf, chatsFor, fenceOf, fold, MAX_ACTS, splitActs } from "../bino/acts.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { openDb } from "../../../../db.ts";
import type { TeamsChat } from "../../../../teams/model.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", TICKET_PROJECTS: "DEV" };
const chat = (id: string, name: string, kind: TeamsChat["kind"] = "oneOnOne"): TeamsChat => ({ id, name, kind, unread: false });
const fence = (o: unknown) => `\`\`\`bino-act\n${JSON.stringify(o)}\n\`\`\``;

test("acts are read strictly: junk and the wrong shape give no card, at most three, fields capped", () => {
  assert.equal(actOf({ kind: "teams", to: "Kari" }), null, "no text");
  assert.equal(actOf({ kind: "email", to: "x", text: "y" }), null, "not a kind Bino has");
  assert.equal(actOf([]), null);
  assert.deepEqual(actOf({ kind: "teams", to: " Kari\u0000 ", text: "Hei\r\nder", extra: "dropped" }), { kind: "teams", to: "Kari", text: "Hei\nder" });
  assert.equal(actOf({ kind: "ticket", project: "DEV", type: "Story", summary: "x" }), null, "no tickets: they belong to a pack");
  assert.equal((actOf({ kind: "task", title: "x".repeat(999) }) as { title: string }).title.length, 255);
  const reply = `Here.\n${fence({ kind: "teams", to: "A", text: "1" })}\n${fence({ kind: "nope" })}\n\`\`\`bino-act\nnot json\n\`\`\`\n${[2, 3, 4].map((n) => fence({ kind: "teams", to: "A", text: String(n) })).join("\n")}`;
  const { text, acts } = splitActs(reply);
  assert.equal(text, "Here.");
  assert.equal(acts.length, MAX_ACTS);
  assert.deepEqual(acts.map((a) => (a as { text: string }).text), ["1", "2", "3"]);
  assert.doesNotMatch(fenceOf({ kind: "teams", to: "A", text: "1", sent: { at: 1, chat: "19:secret" } }), /19:secret/, "Bino hears its proposal, not where it went");
});

test("the card finds the chat Bino named: word starts, Norwegian letters, one-on-one first, newest first", () => {
  const chats = [chat("g", "Kari, Ola og Per", "group"), chat("k1", "Kari Nordmann"), chat("k2", "Kari Hansen"), chat("b", "Bjørn Åsheim"), chat("t", "Team Skytjenester", "group")];
  assert.equal(fold("Bjørn Åse Ærlig"), "bjorn ase aerlig");
  assert.deepEqual(chatsFor("Kari", chats).map((c) => c.id), ["k1", "k2", "g"]);
  assert.deepEqual(chatsFor("kari hansen", chats).map((c) => c.id), ["k2"]);
  assert.deepEqual(chatsFor("Bjorn", chats).map((c) => c.id), ["b"]);
  assert.deepEqual(chatsFor("asheim", chats).map((c) => c.id), ["b"]);
  assert.deepEqual(chatsFor("tjenester", chats).map((c) => c.id), ["t"], "inside a word counts, for less");
  assert.deepEqual(chatsFor("Nobody", chats), []);
  assert.deepEqual(chatsFor("  ", chats), []);
});

/** A Teams that's connected with these chats; what was sent. */
function fakeTeams(chats: TeamsChat[], o: { refuse?: string } = {}) {
  const sent: { chat: string; text: string }[] = [];
  const teams = {
    view: () => ({ state: "ok" as const, chats }),
    kick() {},
    connect: async () => ({ ok: true, message: "" }),
    disconnect: async () => {},
    store: () => ({ chat: async (id: string) => chats.find((c) => c.id === id) }) as never,
    refreshChat: async () => {},
    async send(chat: string, text: string) {
      if (o.refuse) return { ok: false, message: o.refuse };
      sent.push({ chat, text });
      return { ok: true, message: "Sent." };
    },
    react: async () => ({ ok: true, message: "" }),
    crawl: async () => ({ ok: true, message: "" }),
    stop() {},
  };
  return { teams, sent };
}

function setup(reply: string, o: { refuse?: string; chats?: TeamsChat[] } = {}) {
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: reply, cost: 0 }) };
  const file = join(mkdtempSync(join(tmpdir(), "bino-acts-")), "bino.json");
  const t = fakeTeams(o.chats ?? [chat("19:g@thread.v2", "Kari, Ola og Per", "group"), chat("19:k@unq.gbl.spaces", "Kari Nordmann")], o);
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no"), file }, teams: t.teams });
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
  return { req, until, asked, sent: t.sent, file };
}

test("a Teams message goes on my click only, to the chat the card picked, as the card says; Bino never sees chats or what I changed", async () => {
  const s = setup(`Her er et forslag.\n${fence({ kind: "teams", to: "Kari", text: "Hei! Kan du se på PR-en?" })}`);
  const at = (await s.req("/bino/new", { text: "Skriv til Kari at hun må se på PR-en" })).headers.get("location")!;
  const page = await s.until(at, /A message in Teams/);
  assert.match(page, /<option value="19:k@unq.gbl.spaces" selected>Kari Nordmann<\/option>/, "the one-on-one first, picked");
  assert.match(page, /2 chats match «Kari»/);
  assert.match(page, /Hei! Kan du se på PR-en\?<\/textarea>/);
  assert.equal(s.sent.length, 0, "nothing sent before the click");
  for (const a of s.asked) assert.doesNotMatch(a.system + a.user, /Nordmann|Ola og Per|19:/, "Bino is never told the chats");

  const send = await s.req(`${at}/act/1/0`, { chat: "19:k@unq.gbl.spaces", text: "Hei! Kan du se på PR-en i dag? (endret av meg)" });
  assert.equal(send.status, 303);
  await s.until(at, /Sent to <strong>Kari Nordmann<\/strong>/);
  assert.deepEqual(s.sent, [{ chat: "19:k@unq.gbl.spaces", text: "Hei! Kan du se på PR-en i dag? (endret av meg)" }]);
  await s.req(`${at}/act/1/0`, { chat: "19:k@unq.gbl.spaces", text: "again" });
  assert.equal(s.sent.length, 1, "a second press sends nothing");
  assert.doesNotMatch(readFileSync(s.file, "utf8"), /endret av meg/, "what I sent isn't kept on disk");

  await s.req(`${at}/say`, { text: "Takk" });
  await s.until(at, /Takk/);
  const last = s.asked.filter((a) => !a.system.includes("memory")).at(-1)!;
  assert.match(last.user, /bino-act/, "Bino hears its own proposal");
  assert.doesNotMatch(last.user, /endret av meg|19:k@/, "but not what I changed, or the chat");
});

test("a refused send keeps my text to try again; a chat I don't have, or no text, sends nothing", async () => {
  const s = setup(fence({ kind: "teams", to: "Nobody", text: "Hei" }), { refuse: "Not sent: Graph said 403" });
  const at = (await s.req("/bino/new", { text: "x" })).headers.get("location")!;
  const page = await s.until(at, /A message in Teams/);
  assert.match(page, /No chat matches «Nobody»: pick one/);
  assert.match(page, /<option value="">Pick a chat…<\/option>/);
  await s.req(`${at}/act/1/0`, { chat: "19:not-mine@thread.v2", text: "Hei" });
  assert.match(await s.until(at, /Not sent\./), /Pick a chat you have in Teams/);
  await s.req(`${at}/act/1/0`, { chat: "19:k@unq.gbl.spaces", text: "   " });
  assert.match(await s.until(at, /1 to 4000/), /Not sent\./);
  await s.req(`${at}/act/1/0`, { chat: "19:k@unq.gbl.spaces", text: "Min egen tekst" });
  const after = await s.until(at, /Graph said 403/);
  assert.match(after, /Min egen tekst<\/textarea>/, "my text, to try again");
  assert.doesNotMatch(readFileSync(s.file, "utf8"), /Min egen tekst/);
  assert.equal((await s.req(`${at}/act/0/5`, { chat: "x", text: "y" })).status, 404, "an act that isn't there");
});

test("a task card goes to the normal preview, filled in; a ticket gets no card; hostile text stays inert", async () => {
  const s = setup(`${H}\n${fence({ kind: "teams", to: H, text: H })}\n${fence({ kind: "ticket", project: "DEV", type: "Story", summary: H, description: H })}\n${fence({ kind: "task", parent: "ACME/intake#12", repo: "shop-api", title: H, body: H })}`);
  const at = (await s.req("/bino/new", { text: "x" })).headers.get("location")!;
  const page = await s.until(at, /A dev task/);
  assertInert("bino acts", page);
  assert.doesNotMatch(page, /issues\/ticket|Jira/);
  assert.match(page, /action="\/issues\/task\/preview"/);
  assert.match(page, /name="repo" value="ACME\/shop-api"/, "a short repo name gets the org");
  assert.match(page, /name="parent" value="ACME\/intake#12"/);
});
