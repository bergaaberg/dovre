/**
 * Bino's pane: on every page but Bino's own, framed only by this app, and what I ask from it carries
 * the page I'm on as names and states only. Private pages are named, never described.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../app.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";
import { viewOf } from "../bino/view.ts";
import { openDb } from "../../../../db.ts";
import { assertInert, fakeGhe, fixedGatherer, H, pr, snapshot } from "../../../../../test/helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
const S = snapshot({
  prs: {
    ok: true,
    value: {
      mine: [pr({ repo: "ACME/shop-api", number: 7, title: "Katalog: vis varene", body: "SECRET-BODY", review: "CHANGES_REQUESTED", reviews: [{ login: "kari", state: "CHANGES_REQUESTED" }], runs: [{ name: "build", state: "bad", url: null }], files: [{ path: "src/Catalog.cs", additions: 3, deletions: 1 }] })],
      review: [],
    },
  },
});

test("the page I'm on, as Bino hears it: names and states, never a body, a prompt or a private page's content", async () => {
  const prView = await viewOf("/prs/ACME/shop-api/7/files", S);
  for (const shown of ["ACME/shop-api#7", "Katalog: vis varene", "changes requested", "kari", "failing checks: build", "src/Catalog.cs", "its files"]) assert.ok(prView.includes(shown), shown);
  assert.doesNotMatch(prView, /SECRET/);
  assert.match(await viewOf("/prs/ACME/other/3", S), /not among the PRs Dovre gathered/);
  // A pack's page: in its own words (cut to a line), or which app; Dovre's own packs say so.
  const notes = { id: "notes", name: "Notes", paths: ["jot"], about: (p: string) => (p === "/jot/1" ? `the note «Plan»\n\n${"x".repeat(800)}` : undefined) };
  const said = await viewOf("/jot/1", S, [notes]);
  assert.match(said, /^the note «Plan» x+$/);
  assert.equal(said.length, 600);
  // Nothing from the pack about this page: which app, its needs that point here, and that Bino knows no more.
  const ONLY = "You only know which page this is, not what it shows: if asked about it, say so in one line first.";
  assert.equal(await viewOf("/notes/2", S, [notes]), `a page of their app Notes (/notes/2). ${ONLY}`);
  assert.equal(await viewOf("/notes/2", S, [{ ...notes, own: true }]), `a page of Dovre's Notes (/notes/2). ${ONLY}`);
  const needy = { ...notes, needs: () => [{ title: "Note «Plan» is overdue", href: "/notes/2" }, { title: "Elsewhere", href: "/notes/9" }, { title: "Out", href: "https://x.example/notes/2" }] };
  assert.equal(await viewOf("/notes/2?x=1", S, [needy]), `a page of their app Notes (/notes/2). What Notes says needs them here: Note «Plan» is overdue. ${ONLY}`);
  // `about` may read its app first (awaited 2 s at most); one that throws leaves the page named.
  assert.equal(await viewOf("/jot/2", S, [{ ...notes, about: async () => "the note «Later», 3 open items" }]), "the note «Later», 3 open items");
  assert.equal(await viewOf("/jot/2", S, [{ ...notes, about: async () => { throw new Error("down"); } }]), `a page of their app Notes (/jot/2). ${ONLY}`);
  assert.equal(await viewOf("/agents/s/s-9", S), "a page in Dovre.", "the core knows nothing of agents");
  // A private pack (Teams: chats, mail): named, never described, whatever its `about` would say, and never its path.
  const chats = { id: "chats", name: "Chats", paths: ["inbox"], private: true, about: () => "the chat with Kari: «secret»" };
  for (const path of ["/chats/c/19%3Aabc%40thread.v2", "/chats", "/inbox/m/7"]) assert.equal(await viewOf(path, S, [chats]), "a page of their app Chats. What it shows is kept from you: don't guess at it.", path);
  for (const [path, name] of [["/terminal/3", "Terminal"], ["/lab/x.html", "Lab"]] as const) {
    const v = await viewOf(path, S);
    assert.equal(v, `the ${name} page. What it shows is kept from you: don't guess at it.`, path);
  }
  assert.equal(await viewOf("/", S), "Today, the overview of their day.");
  assert.equal(await viewOf("/deploys?x=1", S), "the Deploys page.");
  assert.equal(await viewOf("/somewhere/new", S), "a page in Dovre.");
  for (const bad of ["", "https://evil.example/prs/ACME/x/1", "//evil.example/", "javascript:alert(1)", "/%E0%A4%A"]) assert.equal(await viewOf(bad, S), "", bad);
});

function setup(reply = "Ok.") {
  const asked: { system: string; user: string }[] = [];
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async (p) => (asked.push(p), { text: reply, cost: 0 }) };
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(S), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") } });
  const req = (path: string, body?: Record<string, string>) =>
    app.request(`http://localhost${path}`, body === undefined ? { headers: { cookie: "u_tk=test-token" } } : { method: "POST", headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: new URLSearchParams(body).toString() });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  return { req, asked, until };
}

test("the pane is on every page but Bino's own, and only this app may frame it", async () => {
  const s = setup();
  const today = await (await s.req("/")).text();
  assert.match(today, /<div class="docks"><div class="tdock" id="bdock">/);
  assert.doesNotMatch(await (await s.req("/bino")).text(), /id="bdock"/);
  const pane = await s.req("/bino/dock");
  assert.match(pane.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  assert.match(await pane.text(), /name="view" value="" data-view/);
  assert.match((await s.req("/")).headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, "other pages still can't be framed");
});

test("asking from the pane: the page goes with it, as Bino may hear it; a conversation stays in the pane", async () => {
  const s = setup();
  const res = await s.req("/bino/new", { text: "Hva mangler her?", dock: "1", view: "/prs/ACME/shop-api/7" });
  assert.equal(res.status, 303);
  const at = res.headers.get("location")!;
  assert.match(at, /^\/bino\/dock\/c\/[0-9a-f-]{36}$/);
  await s.until(() => s.asked.length > 0);
  assert.match(s.asked[0]!.user, /\[Looking at pull request ACME\/shop-api#7 «Katalog: vis varene»/);
  assert.doesNotMatch(s.asked[0]!.user, /SECRET/);
  const page = await (await s.req(at)).text();
  assert.match(page, /action="\/bino\/c\/[0-9a-f-]{36}\/say"/);
  assert.match(page, /data-dock-close/);

  const id = at.split("/").pop()!;
  await s.until(() => !/thinking/.test(JSON.stringify(s.asked)));
  await new Promise((r) => setTimeout(r, 30));
  const n = s.asked.length;
  assert.equal((await s.req(`/bino/c/${id}/say`, { text: "Og her?", dock: "1", view: "/terminal/3?repo=secret-repo" })).headers.get("location"), at);
  await s.until(() => s.asked.length > n);
  const last = s.asked.at(-1)!.user;
  assert.match(last, /\[Looking at the Terminal page\. What it shows is kept from you/);
  assert.doesNotMatch(last, /secret-repo|\/terminal\/3/, "not even the page's address");

  // From the full page there's no view, whatever is posted.
  const full = await s.req("/bino/new", { text: "x", view: "/prs/ACME/shop-api/7" });
  assert.match(full.headers.get("location")!, /^\/bino\/c\//);
  await s.until(() => s.asked.some((a) => a.user.startsWith("User: x")));
  assert.ok(s.asked.some((a) => /^User: x/.test(a.user) && !a.user.includes("Looking at")));
});

test("the pane keeps hostile text inert", async () => {
  const s = setup(H);
  await s.req("/bino/new", { text: H, dock: "1" });
  await s.until(() => s.asked.length > 0);
  const at = (await s.req("/bino/new", { text: H, dock: "1", view: `/prs/ACME/shop-api/7?${encodeURIComponent(H)}` })).headers.get("location")!;
  await s.until(() => s.asked.length > 1);
  await new Promise((r) => setTimeout(r, 30));
  for (const path of ["/bino/dock", at]) assertInert(path, await (await s.req(path)).text());
});

test("the pane is a chat: its header names the conversation and lists the others; the last answer can be copied or asked for again", async () => {
  const s = setup("Here you go.");
  const first = (await s.req("/bino/new", { text: "Første spørsmål", dock: "1" })).headers.get("location")!;
  await s.until(() => s.asked.length > 0);
  const at = (await s.req("/bino/new", { text: "Andre spørsmål", dock: "1" })).headers.get("location")!;
  await s.until(() => s.asked.length > 1);
  await new Promise((r) => setTimeout(r, 30));
  const id = at.split("/").pop()!;
  const page = await (await s.req(at)).text();
  assert.match(page, /<h1 title="Andre spørsmål">Andre spørsmål<\/h1>/);
  assert.match(page, /<details class="dock-recent">[\s\S]*href="\/bino\/dock\/c\/[0-9a-f-]{36}"><span class="bino-conv-t">Første spørsmål</);
  assert.ok(page.includes(`href="${first}"`), "the other conversation is one click away");
  assert.doesNotMatch(page.slice(page.indexOf("dock-recent"), page.indexOf("</details>")), /Andre spørsmål/, "not itself");
  assert.match(page, /href="\/bino\/dock" title="New chat"/);
  assert.match(page, new RegExp(`href="/bino/c/${id}" target="_top" title="Open as a page"`));
  assert.match(page, /data-copy-msg/);
  assert.match(page, new RegExp(`<form method="post" action="/bino/c/${id}/retry" data-inplace><input type="hidden" name="dock" value="1">`));
  assert.match(page, /<form method="post" action="\/bino\/c\/[0-9a-f-]{36}\/say" class="bino-compose dock-compose" data-ctrl-enter data-chat>/);

  // Retry: the last answer goes, and Bino is asked the same again.
  const n = s.asked.length;
  const res = await s.req(`/bino/c/${id}/retry`, { dock: "1" });
  assert.equal(res.headers.get("location"), at);
  await s.until(() => s.asked.length > n);
  assert.equal(s.asked.at(-1)!.user, s.asked[1]!.user);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await (await s.req(at)).text()).match(/class="bino-msg bino"/g)?.length, 1, "one answer, not two");
  assert.equal((await s.req(`/bino/c/00000000-0000-0000-0000-000000000000/retry`, {})).status, 404);

  // The pane's first view: the recent ones, and the box under them.
  const home = await (await s.req("/bino/dock")).text();
  assert.ok(home.indexOf('id="bino-list"') < home.indexOf("data-chat"), "the box at the bottom");
});

test("the workspace: every chat in a sidebar (searched, renamed, pinned, deleted), the chat in the middle, what Bino sees beside it", async () => {
  const s = setup("Sure.");
  const a = (await s.req("/bino/new", { text: "Sertifikater som går ut" })).headers.get("location")!;
  await s.until(() => s.asked.length > 0);
  const b = (await s.req("/bino/new", { text: "Planlegg uka" })).headers.get("location")!;
  await s.until(() => s.asked.length > 1);
  await new Promise((r) => setTimeout(r, 30));
  const [ida, idb] = [a.split("/").pop()!, b.split("/").pop()!];
  const page = await (await s.req(b)).text();
  assert.match(page, /<div class="bino-ws"><nav class="bino-nav" aria-label="Conversations">/);
  assert.match(page, new RegExp(`<li class="bino-ci on" data-conv="${idb}"[^>]*><a href="/bino/c/${idb}" aria-current="page">`), "the open one is marked");
  assert.match(page, new RegExp(`<li class="bino-ci" data-conv="${ida}"`));
  assert.match(page, /<h2 class="bino-starts-h">Today<\/h2>/);
  assert.match(page, /<aside class="bino-side"><div data-live id="bino-side">[\s\S]*What Bino sees/);
  assert.match(page, /<meta name="u-topics" content="bino bino:/, "the sidebar follows the other chats too");

  // Search: by what was said too, not just the title.
  const found = await (await s.req("/bino?q=sure")).text();
  assert.match(found, /2 with «sure»/);
  const one = await (await s.req("/bino?q=uka")).text();
  assert.ok(one.includes(`data-conv="${idb}"`) && !one.includes(`data-conv="${ida}"`));

  // Rename and pin go back to the page they were on; anywhere else is /bino.
  let res = await s.req(`/bino/c/${ida}/rename`, { title: "Sertifikater", back: b });
  assert.equal(res.headers.get("location"), b);
  res = await s.req(`/bino/c/${ida}/pin`, { on: "1", back: "https://evil.example/" });
  assert.equal(res.headers.get("location"), "/bino");
  const pinned = await (await s.req(b)).text();
  assert.match(pinned, /<h2 class="bino-starts-h">Pinned<\/h2><ul class="bino-convs"><li class="bino-ci" data-conv="[0-9a-f-]{36}" data-title="sertifikater">/);
  assert.match(pinned, /name="on" value="0"><button type="submit" class="ghost">Unpin/);

  // Delete: one click unless Settings asks twice (bino.delete); deleting the chat I'm on goes back to /bino.
  assert.match(pinned, new RegExp(`<form class="post" method="post" action="/bino/c/${ida}/delete"><input type="hidden" name="back" value="${b}"><button type="submit" class="danger">Delete</button>`));
  res = await s.req(`/bino/c/${ida}/delete`, { back: a });
  assert.equal(res.headers.get("location"), "/bino");
  assert.equal((await s.req(a)).status, 404);
  assert.doesNotMatch(await (await s.req("/bino")).text(), new RegExp(`data-conv="${ida}"`));
  assert.equal((await s.req(`/bino/c/00000000-0000-0000-0000-000000000000/rename`, { title: "x" })).status, 404);
});

test("the workspace keeps hostile text inert: titles, search, what was said", async () => {
  const s = setup(H);
  const at = (await s.req("/bino/new", { text: H })).headers.get("location")!;
  await s.until(() => s.asked.length > 0);
  await new Promise((r) => setTimeout(r, 30));
  await s.req(`${at}/rename`, { title: H, back: at });
  await s.req(`${at}/pin`, { on: "1", back: at });
  for (const path of ["/bino", at, `/bino?q=${encodeURIComponent(H)}`, `${at}?q=${encodeURIComponent(H)}`]) assertInert(path, await (await s.req(path)).text());
});
