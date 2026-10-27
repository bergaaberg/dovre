/** A session in a checkout links to that checkout's diff (dovre#105); elsewhere, no link. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffOf } from "../routes.ts";
import { agentPage } from "../session.view.ts";

const SID = "11111111-1111-4111-8111-111111111111";

test("diffOf: only a checkout directly under CODE_DIR", () => {
  assert.equal(diffOf("/u/code", "/u/code/dovre"), "/code/dovre/diff");
  assert.equal(diffOf("/u/code/", "/u/code/dovre/"), "/code/dovre/diff");
  assert.equal(diffOf("C:\\code", "C:\\code\\my repo"), "/code/my%20repo/diff");
  assert.equal(diffOf("/u/code", "/u/code/dovre/src"), undefined);
  assert.equal(diffOf("/u/code", "/u/other/dovre"), undefined);
  assert.equal(diffOf("/u/code", "/u/code"), undefined);
  assert.equal(diffOf(undefined, "/u/code/dovre"), undefined);
  assert.equal(diffOf("/u/code", undefined), undefined);
});

test("the session page shows the Diff link only when given one", () => {
  const withLink = String(agentPage({ sessionId: SID, turns: [], diff: "/code/dovre/diff" }).body);
  assert.match(withLink, /<a class="btn ghost" href="\/code\/dovre\/diff"[^>]*>Diff<\/a>/);
  assert.doesNotMatch(String(agentPage({ sessionId: SID, turns: [] }).body), />Diff</);
});
