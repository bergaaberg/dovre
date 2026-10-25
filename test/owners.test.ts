/** One host, many owners (PLAN WP-N9): orgs and users tracked alike, guards keep to them, searches ask for all. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { repoIn } from "../src/actions/deploys.ts";
import { reposOf } from "../src/env.ts";
import { parseRef } from "../src/issues/tasks.ts";
import { ownerQuery, owns, ownersIn, ownersOf, primaryOf } from "../src/owners.ts";
import { loadMoves } from "../src/sources/ghe.ts";
import { fakeGhe } from "./helpers.ts";

const OWNERS = "bergaaberg, andreasberg";

test("owners: a comma list, each once (any case), plain logins only; the first is primary", () => {
  assert.deepEqual(ownersOf(" bergaaberg,andreasberg ,BERGAABERG,, evil/x, .., a b"), ["bergaaberg", "andreasberg"]);
  assert.equal(primaryOf(OWNERS), "bergaaberg");
  assert.equal(primaryOf(""), "");
  assert.ok(owns(OWNERS, "AndreasBerg"));
  assert.ok(!owns(OWNERS, "evil"));
  assert.equal(ownerQuery(OWNERS), "user:bergaaberg user:andreasberg");
  assert.equal(ownersIn({ GHE_ORG: "ACME" }), "ACME");
  assert.equal(ownersIn({ GHE_ORG: "bergaaberg", OWNERS }), OWNERS);
});

test("the guard: a repo of any owner passes; others, odd shapes and dot paths never reach a URL", () => {
  assert.equal(repoIn(OWNERS, "andreasberg/dovre"), "andreasberg/dovre");
  assert.equal(repoIn(OWNERS, "bergaaberg/toolkit"), "bergaaberg/toolkit");
  for (const bad of ["evil/x", "andreasberg", "andreasberg/../x", "andreasberg/..", "a/b/c", 42, undefined]) assert.equal(repoIn(OWNERS, bad), null, String(bad));
  assert.equal(repoIn("ACME", "ACME/x"), "ACME/x", "one owner works as before");
});

test("repo lists and references: short names are the first owner's, a full name any owner's", () => {
  assert.deepEqual(reposOf(OWNERS, "intake, andreasberg/forms, evil/x, a/b/c, ..", ""), ["bergaaberg/intake", "andreasberg/forms"]);
  assert.deepEqual(parseRef("intake#6", OWNERS), { repo: "bergaaberg/intake", number: 6 });
  assert.deepEqual(parseRef("andreasberg/dovre#12", OWNERS), { repo: "andreasberg/dovre", number: 12 });
  assert.equal(parseRef("evil/x#1", OWNERS), null);
});

test("moves: an org's feed for me, and my own events kept to my repos", async () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const ev = (repo: string, at = "2026-10-24T10:00:00Z") => ({ type: "PushEvent", created_at: at, actor: { login: "andreasberg" }, repo: { name: repo }, payload: { ref: "refs/heads/main", size: 1 } });
  const { ghe, calls } = fakeGhe({
    "GET /users/andreasberg/events/orgs/bergaaberg?per_page=100&page=1": [ev("bergaaberg/toolkit")],
    "GET /users/andreasberg/events?per_page=100&page=1": [ev("andreasberg/dovre"), ev("bergaaberg/toolkit"), ev("andreasberg/old", "2026-10-20T00:00:00Z")],
  });
  const moves = await loadMoves(ghe, "andreasberg", OWNERS, 24, now);
  assert.deepEqual(moves.map((m) => m.repo).sort(), ["andreasberg/dovre", "bergaaberg/toolkit"], "each once, within the day");
  assert.deepEqual(calls.map((c) => c.path).sort(), ["/users/andreasberg/events/orgs/bergaaberg?per_page=100&page=1", "/users/andreasberg/events?per_page=100&page=1"]);
});
