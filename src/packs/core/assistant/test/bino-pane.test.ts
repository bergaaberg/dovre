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

test("the page I'm on, as Bino hears it: names and states, never a body, a prompt or a private page's content", () => {
  const prView = viewOf("/prs/ACME/shop-api/7/files", S);
  for (const shown of ["ACME/shop-api#7", "Katalog: vis varene", "changes requested", "kari", "failing checks: build", "src/Catalog.cs", "its files"]) assert.ok(prView.includes(shown), shown);
  assert.doesNotMatch(prView, /SECRET/);
  assert.match(viewOf("/prs/ACME/other/3", S), /not among the PRs Dovre gathered/);
  // A pack's page: in its own words (cut to a line), or which app; Dovre's own packs say so.
  const notes = { id: "notes", name: "Notes", paths: ["jot"], about: (p: string) => (p === "/jot/1" ? `the note «Plan»\n\n${"x".repeat(400)}` : undefined) };
  const said = viewOf("/jot/1", S, [notes]);
  assert.match(said, /^the note «Plan» x+$/);
  assert.equal(said.length, 300);
  assert.equal(viewOf("/notes/2", S, [notes]), "a page of their app Notes (/notes/2).");
  assert.equal(viewOf("/notes/2", S, [{ ...notes, own: true }]), "a page of Dovre's Notes (/notes/2).");
  assert.equal(viewOf("/agents/s/s-9", S), "a page in Dovre.", "the core knows nothing of agents");
  for (const [path, name] of [["/teams/c/19%3Aabc%40thread.v2", "Teams"], ["/teams", "Teams"], ["/outlook", "Outlook"], ["/data/table?db=ledger:prod&t=Kunde", "Data"], ["/terminal/3", "Terminal"], ["/lab/x.html", "Lab"]] as const) {
    const v = viewOf(path, S);
    assert.equal(v, `the ${name} page. What it shows is kept from you: don't guess at it.`, path);
  }
  assert.equal(viewOf("/", S), "Today, the overview of their day.");
  assert.equal(viewOf("/deploys?x=1", S), "the Deploys page.");
  assert.equal(viewOf("/somewhere/new", S), "a page in Dovre.");
  for (const bad of ["", "https://evil.example/prs/ACME/x/1", "//evil.example/", "javascript:alert(1)", "/%E0%A4%A"]) assert.equal(viewOf(bad, S), "", bad);
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
  assert.equal((await s.req(`/bino/c/${id}/say`, { text: "Og her?", dock: "1", view: "/teams/c/19%3Asecret%40thread.v2" })).headers.get("location"), at);
  await s.until(() => s.asked.length > n);
  const last = s.asked.at(-1)!.user;
  assert.match(last, /\[Looking at the Teams page\. What it shows is kept from you/);
  assert.doesNotMatch(last, /19:secret|secret@thread/, "not even the chat's address");

  // From the full page there's no view, whatever is posted.
  const full = await s.req("/bino/new", { text: "x", view: "/prs/ACME/shop-api/7" });
  assert.match(full.headers.get("location")!, /^\/bino\/c\//);
  await s.until(() => s.asked.some((a) => a.user.startsWith("User: x")));
  assert.ok(s.asked.some((a) => /^User: x/.test(a.user) && !a.user.includes("Looking at")));
});

test("the pane keeps hostile text inert", async () => {
  const s = setup(H);
  const at = (await s.req("/bino/new", { text: H, dock: "1", view: `/prs/ACME/shop-api/7?${encodeURIComponent(H)}` })).headers.get("location")!;
  await s.until(() => s.asked.length > 0);
  await new Promise((r) => setTimeout(r, 30));
  for (const path of ["/bino/dock", at]) assertInert(path, await (await s.req(path)).text());
});
