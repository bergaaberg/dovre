/** Report a bug (#384): where it goes, what it carries, the link, and filing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyOf, CORE_REPO, fileBug, linkOf, pathOf, reportOf, whereFor, wheres } from "../src/bugs.ts";
import { recentActions } from "../src/actions/deploys.ts";
import { HOME_SOURCE } from "../src/packs/releases.ts";
import { fakeGhe } from "./helpers.ts";
import { openDb } from "../src/db.ts";

const r = (more: Record<string, unknown> = {}) => reportOf({ title: "It broke", what: "I pressed it", page: "/prs", ...more }, { version: "0.6.0", mode: "local" });

test("pathOf keeps a same-app path only, never the bug page itself", () => {
  assert.equal(pathOf("/prs?x=1"), "/prs?x=1");
  assert.equal(pathOf("http://localhost:4848/deploys", "localhost:4848"), "/deploys");
  assert.equal(pathOf("https://evil.example/deploys", "localhost:4848"), "");
  assert.equal(pathOf("//evil.example/x"), "");
  assert.equal(pathOf("/a b"), "");
  assert.equal(pathOf("javascript:alert(1)", "localhost"), "");
  assert.equal(pathOf("/bug?from=/x"), "");
  assert.equal(pathOf(42), "");
});

test("whereFor: core's pages to Dovre, a pack's to where it comes from", () => {
  const packs: Record<string, { id: string; name: string; home: "core" | "packs" | "instance" }> = { agents: { id: "agents", name: "Agents", home: "core" }, topo: { id: "topo", name: "Topo", home: "instance" }, md: { id: "markdown", name: "Markdown", home: "packs" } };
  const of = (s: string) => packs[s];
  assert.deepEqual(whereFor("/prs", of), { home: "core" });
  assert.equal(whereFor("/agents/x", of).home, "core");
  assert.equal(whereFor("/md?q=1", of).home, "packs");
  assert.equal(whereFor("/topo", of, "me/inst").home, "instance");
  assert.equal(whereFor("/topo", of).home, "core", "no instance repo: Dovre's");
  assert.deepEqual(wheres("me/inst").map((w) => w.repo), [CORE_REPO, HOME_SOURCE, "me/inst"]);
  assert.equal(wheres().length, 2);
});

test("the body carries the context; the link is prefilled, labelled bug, and cut to fit", () => {
  const b = bodyOf(r({ error: "boom ```x```", pack: "md" }));
  assert.match(b, /I pressed it/);
  assert.match(b, /Page: `\/prs`/);
  assert.match(b, /Dovre: 0\.6\.0 \(local\)/);
  assert.doesNotMatch(b, /```x```/, "an error can't close the fence");
  const u = new URL(linkOf("github.com", "o/r", r()));
  assert.equal(u.origin + u.pathname, "https://github.com/o/r/issues/new");
  assert.equal(u.searchParams.get("title"), "It broke");
  assert.equal(u.searchParams.get("labels"), "bug");
  const long = linkOf("github.com", "o/r", r({ what: "é".repeat(6000) }));
  assert.ok(long.length <= 7500, `${long.length}`);
  assert.match(new URL(long).searchParams.get("body")!, /cut to fit/);
});

test("fileBug files in the owners' repos only, re-checks the repo, and logs either way", async () => {
  const db = openDb();
  const { ghe, calls } = fakeGhe({ "GET /repos/me/r": { has_issues: true }, "POST /repos/me/r/issues": { html_url: "https://github.com/me/r/issues/7", number: 7 }, "GET /repos/me/off": { has_issues: false } });
  assert.deepEqual(await fileBug(ghe, db.DB, "me", "me/r", r()), { ok: true, url: "https://github.com/me/r/issues/7", number: 7 });
  assert.deepEqual((calls.at(-1)!.body as { labels: string[] }).labels, ["bug"]);
  const out = await fileBug(ghe, db.DB, "me", "bergaaberg/dovre", r());
  assert.equal(out.ok, false);
  assert.ok(!calls.some((c) => c.path.includes("bergaaberg")), "outside the owners: GitHub isn't asked");
  assert.equal((await fileBug(ghe, db.DB, "me", "me/off", r())).ok, false);
  assert.ok(!calls.some((c) => c.method === "POST" && c.path === "/repos/me/off/issues"));
  const log = await recentActions(db.DB, 10);
  assert.deepEqual(log.map((a) => [a.kind, a.ok]).sort(), [["bug.file", 0], ["bug.file", 0], ["bug.file", 1]].sort());
});
