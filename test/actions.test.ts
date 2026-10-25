/** What Dovre did for me: a card on Today and /actions; Deploys keeps only deploy decisions (2026-10-23). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { logAction } from "../src/actions/deploys.ts";
import { whereOf } from "../src/pages/actions.ts";
import { assertInert, H, signedIn, snapshot } from "./helpers.ts";

test("Today's Actions card says what was done in words; Deploys shows deploy decisions only; /actions has them all", async () => {
  const { get, db } = signedIn(snapshot());
  await logAction(db.DB, { kind: "deploy.approved", target: "ACME/people run 10", ok: true });
  await logAction(db.DB, { kind: "task.create", target: `ACME/x#13 ${H}`, ok: false, error: `GHE said no ${H}` });
  await logAction(db.DB, { kind: "relay.answer", target: "db", detail: "allowed", ok: true });

  const today = await (await get("/")).text();
  assertInert("today", today);
  const card = today.slice(today.indexOf('id="actions-card"'), today.indexOf("</section>", today.indexOf('id="actions-card"')));
  for (const words of ["Approved a deploy", "Created a dev task", "Answered a question", "GHE said no"]) assert.ok(card.includes(words), words);

  const deploys = await (await get("/deploys")).text();
  const decided = deploys.slice(deploys.indexOf("Decided here"));
  assert.match(decided, /deploy\.approved/);
  assert.doesNotMatch(decided, /task\.create|relay\.answer/);
  assert.match(decided, /href="\/actions"/);

  const all = await (await get("/actions")).text();
  assertInert("actions", all);
  assert.equal((all.match(/class="pill /g) ?? []).length, 3);
});

test("a target shows by the name the pack gave it, or its raw target", () => {
  const named = (a: { kind: string; target: string }) => (a.target === "custom:123" ? "Friendly Name" : undefined);
  assert.equal(whereOf({ kind: "custom.action", target: "custom:123" }, named), "Friendly Name");
  assert.equal(whereOf({ kind: "deploy.approved", target: "ACME/x run 1" }), "ACME/x run 1");
});
