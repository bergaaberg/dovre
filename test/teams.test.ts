/**
 * Teams: reads and two writes on a list both sides hold; chats read strictly; the store sealed;
 * history paged in; writes re-checked and logged without their text; the crawler only on Copilot,
 * with no tools, its answers read strictly; pages render chat text inert.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { onPath } from "../src/env.ts";
import { chatPage, teamsCard, teamsPage } from "../src/pages/teams.ts";
import { batchesOf, type Crawler, findingsOf } from "../src/teams/crawl.ts";
import { ALLOWED, allowedPath, createHelper, type Helper, PATHS, parseGraph, REACTIONS, skiptokenOf } from "../src/teams/helper.ts";
import { chatsOf, messageOf, newIn, teamsUrl, textOf } from "../src/teams/model.ts";
import { createStore, loadKey, sealerOf, type StoredMessage } from "../src/teams/store.ts";
import { createTeams } from "../src/teams/teams.ts";
import { listTodos } from "../src/todo/store.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/teams.ps1", import.meta.url));
const ME = "me-0000";
const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
const tmp = () => mkdtempSync(join(tmpdir(), "dovre-copilot-"));
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const chat = (o: { id: string; type?: string; topic?: string | null; from?: string; fromName?: string; at?: string; readAt?: string; html?: string; members?: [string, string][]; hidden?: boolean; kind?: string; webUrl?: string }) => ({
  id: o.id,
  chatType: o.type ?? "oneOnOne",
  topic: o.topic ?? null,
  webUrl: o.webUrl ?? `https://teams.microsoft.com/l/chat/${o.id}/0`,
  viewpoint: { isHidden: o.hidden ?? false, lastMessageReadDateTime: o.readAt ?? "2026-10-22T08:00:00Z" },
  members: (o.members ?? [[ME, "Me Myself"], ["u1", "Kari Nordmann"]]).map(([userId, displayName]) => ({ userId, displayName })),
  lastMessagePreview: { createdDateTime: o.at ?? "2026-10-22T09:00:00Z", messageType: o.kind ?? "message", isDeleted: false, from: { user: { id: o.from ?? "u1", displayName: o.fromName ?? "Kari Nordmann" } }, body: { contentType: "html", content: o.html ?? "<p>Hei</p>" } },
});
const msg = (id: string, at: string, from = "u1", o: { text?: string; mention?: boolean; type?: string; reactions?: [string, string][] } = {}) => ({
  id,
  messageType: o.type ?? "message",
  createdDateTime: at,
  from: { user: { id: from, displayName: from === ME ? "Me Myself" : "Kari Nordmann" } },
  body: { contentType: "html", content: o.text ?? `<p>message ${id}</p>` },
  mentions: o.mention ? [{ mentioned: { user: { id: ME } } }] : [],
  reactions: (o.reactions ?? []).map(([reactionType, user]) => ({ reactionType, user: { user: { id: user } } })),
});

test("the lists are the same on both sides, and nothing else gets through", () => {
  const ps = readFileSync(SCRIPT, "utf8");
  const block = ps.slice(ps.indexOf("$Allowed = @("), ps.indexOf("\n)", ps.indexOf("$Allowed = @(")));
  assert.deepEqual([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]), ALLOWED.map((r) => r.source.replaceAll("\\/", "/")), "scripts/teams.ps1 and src/teams/helper.ts read the same paths");
  const reactions = /\$Reactions = @\(([^)]*)\)/.exec(ps)![1]!;
  assert.deepEqual([...reactions.matchAll(/'([^']+)'/g)].map((m) => m[1]), [...REACTIONS], "and offer the same reactions");
  // Writes: only the two the script builds itself, never a path from outside.
  assert.deepEqual([...ps.matchAll(/-Method (\w+)/g)].map((m) => m[1]), ["GET", "POST", "POST"]);
  assert.match(ps, /contentType = 'text'/, "a message is plain text, built in the script");
  for (const p of [PATHS.me, PATHS.chats(30), PATHS.chatsAfter(50, "a+b/c=="), PATHS.messages("19:abc_def@thread.v2", 20), PATHS.messagesAfter("19:a@thread.v2", 50, "tok!'()*"), PATHS.message("19:a@thread.v2", "1729600000000"), PATHS.inbox, PATHS.mail(25), PATHS.joinedTeams, PATHS.channels("0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"), PATHS.posts("0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0", "19:abc_def@thread.tacv2", 25)]) assert.ok(allowedPath(p), p);
  // Mail: only the reads above, never a body, an attachment, another folder or a write. No calendar.
  for (const p of ["/v1.0/me/calendarView?startDateTime=2026-10-22T22:00:00Z&endDateTime=2026-10-24T22:00:00Z&$select=id,subject,start,end&$top=50", "/v1.0/me/mailFolders/inbox/messages?$top=5", "/v1.0/me/messages/abc", "/v1.0/me/messages/abc/attachments", "/v1.0/me/mailFolders/sentitems/messages?$select=id,subject,from,receivedDateTime,isRead,importance,flag,webLink,bodyPreview,inferenceClassification&$orderby=receivedDateTime%20desc&$top=5", "/v1.0/me/sendMail", "/v1.0/me/events", "/v1.0/users/x/calendarView?startDateTime=2026-10-22T00:00:00Z&endDateTime=2026-10-23T00:00:00Z", "/v1.0/teams/not-a-team/channels", "/v1.0/teams/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/members", "/v1.0/teams/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/channels/19:a@thread.tacv2/messages?$top=5"])
    assert.ok(!allowedPath(p), p);
  assert.equal(PATHS.channels("../../users"), "/v1.0/teams/x/channels", "a team id that isn't one goes nowhere");
  assert.doesNotMatch(ps, /'consent'|'scopes'|Calendars/, "and never asks Microsoft for more scopes");
  for (const p of ["/v1.0/me/messages", "/v1.0/users", "/v1.0/me/chats?$top=5", "/v1.0/chats/x/messages?$top=5&$filter=a", "/v1.0/chats/a/../../users/messages?$top=1", "/beta/me?$select=id,displayName", "/v1.0/chats/a?b/messages?$top=1", "/v1.0/chats/a/messages/1/replies", "/v1.0/chats/a/messages?$top=5&$skiptoken=a&b"])
    assert.ok(!allowedPath(p), p);
  assert.ok(allowedPath(PATHS.messages("19:x?y#z@thread.v2", 5)), "an odd chat id is encoded, so it stays one segment");
  assert.equal(skiptokenOf("https://graph.microsoft.com/v1.0/chats/x/messages?$top=50&$skiptoken=abc%3D"), "abc=");
  assert.equal(skiptokenOf("https://evil.example/v1.0/x?$skiptoken=abc"), undefined, "only Graph's own links");
});

test("the helper refuses a path, a chat or a reaction off the list before anything starts", async () => {
  const h = createHelper({ pwsh: "pwsh", script: SCRIPT, spawnFn: (() => assert.fail("nothing may start")) as unknown as typeof spawn });
  await assert.rejects(h.get("/v1.0/me/messages"), /not an allowed Graph path/);
  await assert.rejects(h.send("19:a@thread.v2/../users", "hi"), /not a chat id/);
  await assert.rejects(h.send("19:a@thread.v2", "x".repeat(4001)), /1 to 4000/);
  await assert.rejects(h.react("19:a@thread.v2", "1", "💩", true), /not one of Teams' reactions/);
  await assert.rejects(h.react("19:a@thread.v2", "1; drop", "👍", true), /not a chat message/);
});

const pwshHere = process.platform === "win32" && onPath("pwsh");
test("the script itself refuses what's off its lists, and reads or writes nothing before a sign-in", { skip: pwshHere ? false : "needs pwsh" }, async () => {
  const c = spawn("pwsh", ["-NoLogo", "-NoProfile", "-File", SCRIPT], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const lines: Record<string, unknown>[] = [];
  createInterface({ input: c.stdout }).on("line", (l) => lines.push(JSON.parse(l)));
  const answer = async (id: number) => {
    const end = Date.now() + 60_000;
    while (!lines.some((l) => l.id === id)) {
      if (Date.now() > end || c.exitCode !== null) throw new Error(`no answer ${id}: ${JSON.stringify(lines)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return lines.find((l) => l.id === id)!;
  };
  if ((await answer(0)).ok !== true) {
    c.kill();
    return; // Graph PowerShell isn't installed here: the helper says so, and that's all it can do.
  }
  const ask = (id: number, req: Record<string, unknown>) => c.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
  ask(1, { op: "get", path: "/v1.0/me/messages" });
  ask(2, { op: "get", path: "/V1.0/ME?$select=id,displayName" });
  ask(3, { op: "get", path: PATHS.me });
  ask(4, { op: "post", path: PATHS.me });
  ask(5, { op: "send", chatId: "19:a@thread.v2/../../users", text: "hi" });
  ask(6, { op: "send", chatId: "19:a@thread.v2", text: "hi" });
  ask(7, { op: "react", chatId: "19:a@thread.v2", messageId: "1", reaction: "💩", on: true });
  ask(8, { op: "Get", path: PATHS.me });
  ask(9, { op: "consent", scope: "Mail.Send" });
  ask(10, { op: "scopes" });
  assert.deepEqual(await answer(1), { id: 1, ok: false, error: "not an allowed path" });
  assert.deepEqual(await answer(2), { id: 2, ok: false, error: "not an allowed path" }, "case counts");
  assert.deepEqual(await answer(3), { id: 3, ok: false, error: "not signed in" });
  assert.deepEqual(await answer(4), { id: 4, ok: false, error: "unknown op" });
  assert.deepEqual(await answer(5), { id: 5, ok: false, error: "not a chat id" });
  assert.deepEqual(await answer(6), { id: 6, ok: false, error: "not signed in" });
  assert.deepEqual(await answer(7), { id: 7, ok: false, error: "not one of Teams' reactions" });
  assert.deepEqual(await answer(8), { id: 8, ok: false, error: "unknown op" }, "ops are case-sensitive too");
  assert.deepEqual(await answer(9), { id: 9, ok: false, error: "unknown op" }, "no asking Microsoft for more scopes");
  assert.deepEqual(await answer(10), { id: 10, ok: false, error: "unknown op" });
  c.stdin.end();
  c.kill();
});

test("chats and messages read strictly: names, plain text, what's new to me, reactions; hidden chats, events and odd links go", () => {
  const raw = {
    value: [
      chat({ id: "a", at: "2026-10-22T09:00:00Z", html: "<p>Kan du se p&aring; <b>PR</b>&nbsp;863?</p><attachment id=\"1\"></attachment>" }),
      chat({ id: "b", type: "group", topic: "Team FORMS", at: "2026-10-22T07:00:00Z", members: [[ME, "Me"], ["u2", "A"], ["u3", "B"], ["u4", "C"], ["u5", "D"]] }),
      chat({ id: "c", type: "group", topic: null, from: ME, fromName: "Me Myself", members: [[ME, "Me"], ["u2", "Ola"], ["u3", "Per"]] }),
      chat({ id: "d", hidden: true }),
      chat({ id: "e", kind: "systemEventMessage", webUrl: "javascript:alert(1)" }),
      { nothing: true },
    ],
  };
  const chats = chatsOf(raw, ME);
  assert.deepEqual(chats.map((c) => [c.id, c.name, c.unread]), [["a", "Kari Nordmann", true], ["b", "Team FORMS", false], ["c", "Ola, Per", false], ["e", "Kari Nordmann", false]]);
  assert.equal(chats[0]!.last!.text, "Kan du se på PR 863? [attachment]");
  assert.equal(chats[2]!.last!.from, "You");
  assert.equal(chats[3]!.webUrl, undefined, "only Teams' own https links");
  assert.equal(teamsUrl("https://teams.microsoft.com.evil.example/l/chat"), undefined);
  assert.equal(textOf("&#128512; &lt;b&gt; &bogus; &Aring;"), "😀 <b> &bogus; Å");
  const m = messageOf(msg("17", "2026-10-22T09:00:00Z", "u1", { mention: true, reactions: [["👍", ME], ["👍", "u2"], ["❤️", "u2"]] }), ME)!;
  assert.deepEqual(m.reactions, [{ emoji: "👍", count: 2, mine: true }, { emoji: "❤️", count: 1, mine: false }]);
  assert.equal(m.mentionsMe, true);
  assert.equal(messageOf(msg("18", "2026-10-22T09:00:00Z", "u1", { type: "systemEventMessage" }), ME), undefined);
  assert.equal(messageOf({ ...msg("19", "2026-10-22T09:00:00Z"), deletedDateTime: "2026-10-22T10:00:00Z" }, ME), undefined);
  assert.equal(messageOf(msg("not-a-number", "2026-10-22T09:00:00Z"), ME), undefined);
  assert.deepEqual(newIn({ value: [msg("4", "2026-10-22T09:03:00Z", "u1", { mention: true }), msg("3", "2026-10-22T09:02:00Z", ME)] }, ME, "2026-10-22T08:00:00Z"), { count: 1, mentioned: true });
  assert.deepEqual(parseGraph(`{"v":"ding${String.fromCharCode(7)}dong"}`), { v: `ding${String.fromCharCode(7)}dong` }, "a raw control character still parses");
});

test("the store seals what chats say, each value bound to its row, and its key unwraps only through DPAPI", async () => {
  const dir = tmp();
  const wraps: string[] = [];
  const dpapi = { wrap: async (k: string) => (wraps.push(k), `sealed:${k}`), unwrap: async (s: string) => s.replace(/^sealed:/, "") };
  const key = await loadKey(join(dir, "teams.key"), dpapi);
  assert.equal(key.length, 32);
  assert.ok(readFileSync(join(dir, "teams.key"), "utf8").startsWith("sealed:"), "only the wrapped key on disk");
  assert.deepEqual(await loadKey(join(dir, "teams.key"), dpapi), key, "the same key next time");
  assert.equal(wraps.length, 1);
  await assert.rejects(loadKey(join(dir, "teams.key"), { wrap: dpapi.wrap, unwrap: async () => "c2hvcnQ=" }), /didn't unwrap/, "a key that won't unwrap is an error, never replaced");
  const s = sealerOf(key);
  const sealed = s.seal("hemmelig", "msg:a:1:text");
  assert.equal(s.open(sealed, "msg:a:1:text"), "hemmelig");
  assert.throws(() => s.open(sealed, "msg:a:2:text"), "a value moved to another row doesn't open");

  const db = openDb();
  const store = createStore(db.DB, s);
  await store.putChat({ id: "a", kind: "oneOnOne", name: "Kari Nordmann" });
  await store.putMessages("a", [messageOf(msg("1", "2026-10-22T09:00:00Z", "u1", { text: "kundenummer 12345678901" }), ME)!]);
  const rows = JSON.stringify([db.raw.prepare("SELECT * FROM teams_chat").all(), db.raw.prepare("SELECT * FROM teams_message").all()]);
  for (const plain of ["Kari", "kundenummer", "12345678901"]) assert.ok(!rows.includes(plain), `${plain} sealed`);
  assert.equal((await store.messages("a"))[0]!.text, "kundenummer 12345678901");
});

/** A Graph that answers like Graph: chats, paged messages, and what was asked and written. */
function fakeHelper(o: { fail?: string; history?: number } = {}) {
  const asked: string[] = [];
  const sent: { chatId: string; text: string }[] = [];
  const reacted: string[] = [];
  const n = o.history ?? 3;
  // Chat a: n messages, newest first, one a minute back from 09:00, in pages of 2.
  const all = Array.from({ length: n }, (_, i) => msg(String(1000 + n - i), new Date(Date.parse("2026-10-22T09:00:00Z") - i * 60_000).toISOString(), i % 2 ? ME : "u1", { text: i === 0 ? H : `<p>m${i}</p>`, mention: i === 0 }));
  const page = (start: number) => ({ value: all.slice(start, start + 2), ...(start + 2 < all.length ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/chats/a/messages?$top=50&$skiptoken=p${start + 2}` } : {}) });
  const helper: Helper = {
    async connect() {
      return { account: "me@example.com" };
    },
    async disconnect() {},
    async get(path) {
      asked.push(path);
      if (o.fail) throw new Error(o.fail);
      if (path === PATHS.me) return { id: ME, displayName: "Me" };
      if (path === PATHS.chats(50)) return { value: [chat({ id: "a", html: H, at: "2026-10-22T09:00:00Z" }), chat({ id: "b", type: "group", topic: H, at: "2026-10-22T07:00:00Z" })] };
      if (path === PATHS.messages("a", 50)) return page(0);
      const more = /chats\/a\/messages\?\$top=50&\$skiptoken=p(\d+)$/.exec(path);
      if (more) return page(Number(more[1]));
      if (path === PATHS.messages("b", 50)) return { value: [msg("2000", "2026-10-22T07:00:00Z")] };
      if (path === PATHS.messages("a", 1)) return page(0);
      if (path === PATHS.message("a", String(1000 + n))) return all[0];
      throw new Error(`unexpected ${path}`);
    },
    async send(chatId, text) {
      sent.push({ chatId, text });
      return "9999";
    },
    async react(chatId, messageId, reaction, on) {
      reacted.push(`${chatId}/${messageId} ${reaction} ${on}`);
    },
    wrap: async (k) => `w:${k}`,
    unwrap: async (s) => s.slice(2),
    stop() {},
  };
  return { helper, asked, sent, reacted };
}

const LOG: { kind: string; target: string; detail?: string; ok: boolean }[] = [];
function connectedTeams(o: { history?: number; crawler?: Crawler; fail?: string } = {}) {
  const dir = tmp();
  const db = openDb();
  const fake = fakeHelper(o);
  LOG.length = 0;
  const teams = createTeams({ helper: fake.helper, marker: join(dir, "teams.json"), db: db.DB, keyFile: join(dir, "teams.key"), sinceDays: 3650, now: () => Date.parse("2026-10-22T10:00:00Z"), log: async (a) => void LOG.push(a), crawler: o.crawler, crawlEveryMs: 0 });
  return { teams, db, dir, ...fake };
}

test("connecting reads the chats, keeps their messages sealed with history paged in, and on disk otherwise only that it connected", async () => {
  const { teams, asked, dir } = connectedTeams({ history: 5 });
  assert.equal((await teams.connect()).ok, true);
  const v = teams.view();
  assert.equal(v.state, "ok", v.error);
  assert.deepEqual(v.chats.map((c) => [c.id, c.unread, c.mentioned ?? false]), [["a", true, true], ["b", false, false]]);
  const store = teams.store()!;
  assert.deepEqual((await store.messages("a")).map((m) => m.id), ["1001", "1002", "1003", "1004", "1005"], "all five, oldest first, through the pages");
  assert.ok(asked.includes(PATHS.messagesAfter("a", 50, "p2")) && asked.includes(PATHS.messagesAfter("a", 50, "p4")), "paged with the skiptoken, never the link as given");
  assert.ok((await store.chat("a"))!.backfilled);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "teams.json"), "utf8"))), ["account", "at"]);
  assert.ok(readFileSync(join(dir, "teams.key"), "utf8").startsWith("w:"));
  // Nothing new: the next read asks for the chats, not their messages again.
  asked.length = 0;
  teams.kick();
  await until(() => asked.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!asked.some((p) => p.includes("/messages")), JSON.stringify(asked));
  teams.stop();
});

test("sending and reacting check the chat first, log without the text, and refuse what isn't offered", async () => {
  const { teams, sent, reacted, asked } = connectedTeams();
  await teams.connect();
  asked.length = 0;
  assert.equal((await teams.send("a", "Hei, ser på det nå")).ok, true);
  assert.deepEqual(sent, [{ chatId: "a", text: "Hei, ser på det nå" }]);
  assert.equal(asked[0], PATHS.messages("a", 1), "the chat is read right before the write");
  assert.deepEqual(LOG.map((l) => [l.kind, l.detail, l.ok]), [["teams.send", "18 characters", true]]);
  assert.ok(!JSON.stringify(LOG).includes("ser på"), "the log never holds what was said");
  assert.equal((await teams.react("a", "1003", "👍", true)).ok, true);
  assert.deepEqual(reacted, ["a/1003 👍 true"]);
  assert.equal(LOG.at(-1)!.kind, "teams.react");
  teams.stop();
});

test("a message sent from the page goes out in the background; one Teams refuses shows in the chat with its text", async () => {
  const { teams, sent, helper } = connectedTeams();
  await teams.connect();
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, teams });
  const send = (text: string, quiet = true) =>
    app.request("http://localhost/teams/c/a/send", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...(quiet ? { "x-dovre-send": "1" } : {}) }, body: new URLSearchParams({ text }).toString() });
  // Teams takes its time: the page's answer doesn't wait for it.
  let release!: () => void;
  const slow = helper.send;
  helper.send = async (chatId, text) => {
    await new Promise<void>((r) => (release = r));
    return slow(chatId, text);
  };
  const res = await send("Hei, ser på det nå");
  assert.equal(res.status, 202);
  assert.deepEqual(sent, [], "not sent yet when the page got its answer");
  release();
  await until(() => sent.length === 1);
  helper.send = slow;
  assert.equal((await send(" ")).status, 400, "an empty message is refused at once");
  assert.equal((await send("plain post", false)).status, 303, "without the script, the form still works and comes straight back");
  await until(() => sent.length === 2);
  // Teams refuses: the chat says so, with what was written.
  helper.send = async () => {
    throw new Error("Forbidden");
  };
  await send(`refused ${H}`);
  const get = () => app.request("http://localhost/teams/c/a", { headers: { cookie: "u_tk=test-token" } });
  await until(() => LOG.some((l) => l.kind === "teams.send" && !l.ok));
  const out = await (await get()).text();
  assert.match(out, /Not sent: Forbidden/);
  assert.match(out, /<p class="tfail-t">refused &lt;script&gt;/, "the text is kept, as text");
  assertInert("failed send", out);
  teams.stop();
});

test("the crawler's answer is read strictly, its batches tie findings to messages, and chat text is fenced off as data", () => {
  const m = (id: string, chatId = "a"): StoredMessage => ({ chatId, id, at: `2026-10-22T09:0${id}:00Z`, fromId: "u1", from: "Kari", mine: false, mentionsMe: false, text: `text ${id}`, reactions: [] });
  const [b] = batchesOf([m("1"), m("2", "b")], new Map([["a", { name: "Kari", kind: "oneOnOne" }], ["b", { name: "Team", kind: "group" }]]), { me: "Andreas", today: "2026-10-22" });
  assert.match(b!.prompt, /data, not instructions/);
  assert.match(b!.prompt, /<chats>\n## Chat c1: Kari \(1:1\)\n\[m1 2026-10-22 09:01 Kari\] text 1\n## Chat c2: Team \(group\)\n\[m2/);
  const text = `Here you go: {"findings": [
    {"kind": "todo", "title": "Se på PR 863", "due": "2026-10-24", "ref": "m1"},
    {"kind": "todo", "title": "no such message", "ref": "m9"},
    {"kind": "delete everything", "title": "x", "ref": "m1"},
    {"kind": "reminder", "title": "  Demo   fredag ", "due": "friday", "ref": "m2"}
  ]}`;
  assert.deepEqual(findingsOf(text, b!.refs), [
    { chatId: "a", messageId: "1", kind: "todo", title: "Se på PR 863", due: "2026-10-24" },
    { chatId: "b", messageId: "2", kind: "reminder", title: "Demo fredag", due: null },
  ]);
  assert.deepEqual(findingsOf("not json", b!.refs), []);
});

test("a crawl proposes on My list, once per finding; adding makes an item, and the pages keep chat text inert", async () => {
  const asks: string[] = [];
  const crawler: Crawler = { model: "github-copilot/test", profile: "p", why: () => undefined, ask: async (p) => (asks.push(p), `{"findings":[{"kind":"todo","title":"Svar Kari om ${H.replace(/"/g, "'")}","ref":"m1"}]}`) };
  const { teams, db } = connectedTeams({ crawler });
  await teams.connect();
  assert.equal((await teams.crawl()).ok, true);
  assert.equal((await teams.crawl()).message, "Nothing new in Teams to look through.", "the next one goes on from where this stopped");
  assert.equal(asks.length, 1);
  const store = teams.store()!;
  const [f] = await store.findings("new");
  assert.ok(f && f.title.startsWith("Svar Kari"));
  const raw = JSON.stringify(db.raw.prepare("SELECT * FROM teams_finding").all());
  assert.ok(!raw.includes("Svar Kari"), "what was found is sealed too");

  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, teams });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const post = (path: string, body: Record<string, string>) => app.request(`http://localhost${path}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  for (const path of ["/", "/teams", "/teams/c/a", "/todo", "/teams/dock", "/teams/dock/c/a"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const out = await res.text();
    assertInert(path, out);
    assert.ok(!out.includes('href="javascript:'), path);
  }
  const chatOut = await (await get("/teams/c/a")).text();
  assert.match(chatOut, /<form method="post" action="\/teams\/c\/a\/send" class="tcompose" data-send>/, "sending is one click, in the background");
  assert.doesNotMatch(chatOut, /tsend"><summary>/, "no confirm before sending (the user's call, 2026-10-23)");
  assert.match(chatOut, /<details class="treact-pick" id="r-1003"><summary[^>]*>☺<\/summary>/, "reacting too: open the picker, then pick");
  // A line between days (what it says depends on today's date: the fixtures are from 22 October).
  assert.match(chatOut, /<li class="tday"><span>[^<]+<\/span><\/li>/);
  assert.match(chatOut, /<span id="end"><\/span>/, "lists open a chat at its newest message");
  // The dock: on other pages, not on Teams' own; its pages may be framed by this app only, the rest by nothing.
  const home = await get("/");
  assert.match(await home.text(), /<a class="tdock-btn" id="tdock-btn" href="\/teams"/);
  assert.match(home.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.ok(!(await (await get("/teams")).text()).includes("tdock-btn"));
  const dock = await get("/teams/dock/c/a");
  assert.match(dock.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  assert.equal(dock.headers.get("x-frame-options"), "SAMEORIGIN");
  const dockOut = await dock.text();
  assert.ok(!dockOut.includes('class="top"'), "no top bar inside the dock");
  assert.match(dockOut, /class="tcompose dock-compose" data-send>/, "the dock sends the same way");
  assert.match(dockOut, /<input type="hidden" name="dock" value="1">/);
  const sent = await post("/teams/c/a/send", { text: " ", dock: "1" });
  assert.equal(sent.headers.get("location"), "/teams/dock/c/a#end", "a write from the dock comes back to the dock");
  assert.equal((await post("/teams/c/a/send", { text: " " })).headers.get("location"), "/teams/c/a#end");
  assert.match(await (await get("/teams/dock/c/a")).text(), /nothing was sent/);
  assert.equal((await get("/teams/dock/c/nope")).status, 404);
  assert.match(await (await get("/todo")).text(), /From Teams/);
  assert.equal((await get("/teams/c/nope")).status, 404);
  assert.equal((await get(`/teams/c/${encodeURIComponent("a/../b")}`)).status, 404);
  assert.equal((await post("/teams/c/a/react", { message: "1003", on: "💩" })).status, 303);
  assert.equal((await post(`/teams/finding/${f!.id}/add`, {})).status, 303);
  const items = await listTodos(db.DB);
  assert.equal(items.length, 1);
  // m1 is the oldest message looked at: chat b's (its name is the hostile topic).
  assert.match(items[0]!.notes, /^From Teams: .+ https:\/\/teams\.microsoft\.com\/l\/chat\/b\/0$/);
  assert.equal((await store.findings("new")).length, 0);
  assert.ok(String(teamsCard(teams.view())).includes("teams-card"));
  assert.ok(String(teamsPage({ operator: "me", nav: [] }, teams.view())).includes("Look through now"));
  assert.ok(String(chatPage({ operator: "me", nav: [] }, (await store.chat("a"))!, await store.messages("a"), { canWrite: false })).includes("Connect Teams to write here"));
  const off = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, teams: createTeams({ marker: join(tmp(), "t.json"), off: "off in tests" }) });
  assert.equal((await off.request("http://localhost/teams", { headers: { cookie: "u_tk=test-token" } })).status, 404);
  teams.stop();
});

test("a sign-in that ran out asks to connect again", async () => {
  const { teams } = connectedTeams({ fail: "InvalidAuthenticationToken: Access token has expired" });
  await teams.connect();
  assert.equal(teams.view().state, "connect");
  assert.match(teams.view().why!, /connect again/);
  teams.stop();
});
