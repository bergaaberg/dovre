/**
 * Outlook and followed team channels, through the Teams helper's sign-in: read strictly, held in
 * memory only (only which channels I follow is on disk, as ids), and pages that keep what mail and
 * posts say inert.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { mailCard, outlookPage } from "../src/pages/outlook.ts";
import { channelPage, channelsPanel, channelsPickPage } from "../src/pages/teams.ts";
import { channelsOf, createChannels, freshIn, joinedTeamsOf, postsOf } from "../src/teams/channels.ts";
import { type Helper, PATHS } from "../src/teams/helper.ts";
import { createOutlook, inboxOf, mailOf, outlookUrl } from "../src/teams/outlook.ts";
import { assertInert, fakeGhe, fixedGatherer, H, snapshot } from "./helpers.ts";

const ME = "me-0000";
const TEAM = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
const CHANNEL = "19:abc_def@thread.tacv2";
const NOW = Date.parse("2026-10-23T09:10:00Z"); // 11:10 in Oslo
const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const mail = (o: { id?: string; subject?: string; from?: string; at?: string; read?: boolean; other?: boolean; link?: string; preview?: string } = {}) => ({
  id: o.id ?? "AAMk1=",
  subject: o.subject ?? "Release i dag",
  from: { emailAddress: { name: o.from ?? "Kari Nordmann", address: "kari@example.com" } },
  receivedDateTime: o.at ?? "2026-10-23T08:00:00Z",
  isRead: o.read ?? false,
  importance: "normal",
  flag: { flagStatus: "notFlagged" },
  webLink: o.link ?? "https://outlook.office365.com/owa/?ItemID=AAMk1%3D&exvsurl=1&viewmodel=ReadMessageItem",
  bodyPreview: o.preview ?? "Hei, kan du se på dette?",
  inferenceClassification: o.other ? "other" : "focused",
});
const post = (id: string, at: string, o: { from?: string; text?: string; subject?: string; mention?: boolean; replies?: unknown[] } = {}) => ({
  id,
  messageType: "message",
  createdDateTime: at,
  subject: o.subject ?? null,
  from: { user: { id: o.from ?? "u1", displayName: o.from === ME ? "Me Myself" : "Kari Nordmann" } },
  body: { contentType: "html", content: o.text ?? `<p>post ${id}</p>` },
  mentions: o.mention ? [{ mentioned: { user: { id: ME } } }] : [],
  webUrl: `https://teams.microsoft.com/l/message/${CHANNEL}/${id}`,
  replies: o.replies ?? [],
});

test("mail is read strictly: only Outlook's own links, junk left out", () => {
  const m = mailOf({ value: [mail({ subject: H, from: H, preview: `${H} &amp; more` }), mail({ id: "", subject: "no id" }), mail({ id: "B", read: true, other: true, link: "https://evil.example/owa" }), { nothing: true }] });
  assert.equal(m.length, 2);
  assert.equal(m[0]!.subject, H, "kept as text; the page escapes it");
  assert.equal(m[0]!.unread, true);
  assert.equal(m[1]!.focused, false);
  assert.equal(m[1]!.webUrl, undefined, "only Outlook's own links");
  assert.equal(outlookUrl("javascript:alert(1)"), undefined);
  assert.equal(outlookUrl("https://outlook.office365.com.evil.example/"), undefined);
  assert.deepEqual(inboxOf({ unreadItemCount: 3, totalItemCount: -1 }), { unread: 3, total: 0 });
});

/** A Graph with an inbox, teams and a channel; what was asked. */
function fakeGraph(o: { mailFail?: string; postsFail?: string } = {}) {
  const asked: string[] = [];
  const helper: Helper = {
    connect: async () => ({ account: "me@example.com" }),
    disconnect: async () => {},
    async get(path) {
      asked.push(path);
      if (path === PATHS.me) return { id: ME };
      if (path === PATHS.inbox) return { unreadItemCount: 2, totalItemCount: 40 };
      if (path === PATHS.mail(25)) {
        if (o.mailFail) throw new Error(o.mailFail);
        return { value: [mail({ subject: H }), mail({ id: "B", read: true, subject: "Lest" })] };
      }
      if (path === PATHS.joinedTeams) return { value: [{ id: TEAM, displayName: H }, { id: "not-a-guid", displayName: "Odd" }] };
      if (path === PATHS.channels(TEAM)) return { value: [{ id: "19:other@thread.tacv2", displayName: "Ops" }, { id: CHANNEL, displayName: "General", membershipType: "standard", webUrl: "https://teams.microsoft.com/l/channel/x" }, { id: "../x", displayName: "Bad" }] };
      if (path === PATHS.posts(TEAM, CHANNEL, 25)) {
        if (o.postsFail) throw new Error(o.postsFail);
        return { value: [post("10", "2026-10-23T07:00:00Z", { subject: H, text: H, replies: [post("12", "2026-10-23T09:00:00Z", { mention: true }), post("11", "2026-10-23T08:00:00Z", { from: ME })] }), post("9", "2026-10-22T07:00:00Z")] };
      }
      throw new Error(`unexpected ${path}`);
    },
    send: async () => "",
    react: async () => {},
    wrap: async (k) => k,
    unwrap: async (k) => k,
    stop() {},
  };
  return { helper, asked };
}

test("Outlook waits for the Microsoft sign-in, then reads the inbox and nothing else", async () => {
  let on = false;
  const g = fakeGraph();
  const o = createOutlook({ helper: g.helper, connected: () => on, now: () => NOW });
  o.kick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(o.view().state, "waiting");
  assert.equal(g.asked.length, 0, "nothing is read before Microsoft is connected");
  on = true;
  o.kick();
  await until(() => o.view().state === "ok" && !!o.view().mail);
  const v = o.view();
  assert.equal(v.mail!.unread, 2);
  assert.equal(v.mail!.items.length, 2);
  assert.deepEqual(g.asked.sort(), [PATHS.inbox, PATHS.mail(25)].sort(), "the inbox only");
  o.stop();
});

test("an inbox that won't read says why", async () => {
  const g = fakeGraph({ mailFail: "Graph said 403" });
  const o = createOutlook({ helper: g.helper, connected: () => true, now: () => NOW });
  o.kick();
  await until(() => !!o.view().mailError);
  assert.equal(o.view().state, "ok");
  assert.match(o.view().mailError!, /403/);
  assert.match(String(mailCard(o.view())), /Didn&#39;t read just now/);
  o.stop();
});

test("channels: posts with replies read strictly, what's new counted against when I last looked, and only ids on disk", async () => {
  const posts = postsOf({ value: [post("10", "2026-10-23T07:00:00Z", { replies: [post("12", "2026-10-23T09:00:00Z", { mention: true }), { id: "x", messageType: "systemEventMessage" }] }), post("9", "2026-10-23T08:30:00Z"), { id: "../1" }] }, ME);
  assert.deepEqual(posts.map((p) => [p.id, p.lastAt]), [["10", "2026-10-23T09:00:00.000Z"], ["9", "2026-10-23T08:30:00.000Z"]], "newest activity first");
  assert.deepEqual(freshIn(posts, "2026-10-23T08:00:00.000Z"), { fresh: 2, mentioned: true });
  assert.deepEqual(joinedTeamsOf({ value: [{ id: TEAM, displayName: "B" }, { id: "x", displayName: "A" }] }).map((t) => t.id), [TEAM]);
  assert.deepEqual(channelsOf({ value: [{ id: "19:b@thread.tacv2", displayName: "Ops" }, { id: "19:a@thread.tacv2", displayName: "General" }, { id: "../x", displayName: "x" }] }).map((c) => c.name), ["General", "Ops"]);

  const db = openDb();
  const g = fakeGraph();
  const ch = createChannels({ helper: g.helper, db: db.DB, connected: () => true, now: () => NOW });
  ch.kick();
  await until(() => ch.view().state === "ok");
  ch.loadTeams();
  await until(() => (ch.view().teams ?? []).length === 1);
  ch.loadChannels(TEAM);
  await until(() => !!ch.view().teams![0]!.channels);
  assert.deepEqual(ch.view().teams![0]!.channels!.map((c) => c.name), ["General", "Ops"]);
  await ch.follow(TEAM, CHANNEL, true);
  await until(() => ch.view().followed[0]?.posts.length === 2);
  const f = ch.view().followed[0]!;
  assert.equal(f.name, "General");
  assert.equal(f.fresh, 0, "nothing is new from before I followed it");
  const rows = JSON.stringify(db.raw.prepare("SELECT * FROM teams_follow").all());
  assert.ok(!rows.includes("General") && !rows.includes("post"), "only ids on disk");
  await ch.follow(TEAM, "../../x", true);
  assert.equal(ch.view().followed.length, 1, "an odd id is never followed");
  await ch.follow(TEAM, CHANNEL, false);
  assert.equal(ch.view().followed.length, 0);
  ch.stop();
});

test("a channel Graph won't read says so, and why", async () => {
  const db = openDb();
  const g = fakeGraph({ postsFail: "Forbidden (403)" });
  const ch = createChannels({ helper: g.helper, db: db.DB, connected: () => true, now: () => NOW });
  await ch.follow(TEAM, CHANNEL, true);
  await until(() => !!ch.view().followed[0]?.error);
  assert.match(ch.view().followed[0]!.error!, /ChannelMessage\.Read\.All/);
  ch.stop();
});

test("Outlook and channel pages keep what mail and posts say inert, and the routes are there only with Teams", async () => {
  const frame = { operator: "me", nav: [] };
  const g = fakeGraph();
  const o = createOutlook({ helper: g.helper, connected: () => true, now: () => NOW });
  o.kick();
  await until(() => !!o.view().mail);
  for (const [name, out] of [
    ["outlook", String(outlookPage(frame, o.view()))],
    ["mail card", String(mailCard(o.view()))],
  ] as const) {
    assertInert(name, out);
    assert.ok(!out.includes('href="javascript:'), name);
  }
  assert.doesNotMatch(String(outlookPage(frame, o.view())), /[Cc]alendar/);

  const db = openDb();
  const ch = createChannels({ helper: g.helper, db: db.DB, connected: () => true, now: () => NOW });
  await ch.follow(TEAM, CHANNEL, true);
  await until(() => ch.view().followed[0]?.posts.length === 2);
  ch.loadTeams();
  await until(() => (ch.view().teams ?? []).length === 1);
  for (const [name, out] of [
    ["channels panel", String(channelsPanel(ch.view()))],
    ["channel page", String(channelPage(frame, ch.view().followed[0]!))],
    ["pick page", String(channelsPickPage(frame, ch.view(), TEAM))],
  ] as const) assertInert(name, out);

  // Routes: only with Teams; a channel I don't follow, or an odd id, is a 404.
  const teams = { view: () => ({ state: "ok" as const, chats: [] }), kick() {}, connect: async () => ({ ok: true, message: "" }), disconnect: async () => {}, store: () => undefined, refreshChat: async () => {}, send: async () => ({ ok: true, message: "" }), react: async () => ({ ok: true, message: "" }), crawl: async () => ({ ok: true, message: "" }), stop() {} };
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, teams, outlook: o, channels: ch });
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  for (const path of ["/outlook", "/teams", "/teams/channels", `/teams/channels?team=${TEAM}`, `/teams/ch/${TEAM}/${encodeURIComponent(CHANNEL)}`, "/"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assertInert(path, await res.text());
  }
  assert.equal((await get(`/teams/ch/${TEAM}/${encodeURIComponent("19:other@thread.tacv2")}`)).status, 404, "not followed");
  assert.equal((await get(`/teams/ch/not-a-team/${encodeURIComponent(CHANNEL)}`)).status, 404);
  const bare = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe });
  assert.equal((await bare.request("http://localhost/outlook", { headers: { cookie: "u_tk=test-token" } })).status, 404);
  o.stop();
  ch.stop();
});
