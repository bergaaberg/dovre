/** What Dovre did for me: a card on Today and /actions; Deploys keeps only deploy decisions (2026-10-23). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { logAction } from "../src/actions/deploys.ts";
import { whereOf } from "../src/pages/actions.ts";
import { assertInert, H, signedIn, snapshot } from "./helpers.ts";

test("Today's Actions card says what was done in words; Deploys shows deploy decisions only; /actions has them all", async () => {
  const { get, db } = signedIn(snapshot());
  await logAction(db.DB, { kind: "deploy.approved", target: "ACME/people run 10", ok: true });
  await logAction(db.DB, { kind: "teams.send", target: "chat 19:abc@thread.v2", detail: "12 characters", ok: true });
  await logAction(db.DB, { kind: "task.create", target: `ACME/x#13 ${H}`, ok: false, error: `GHE said no ${H}` });
  await logAction(db.DB, { kind: "data.prod.open", target: "ledger:prod", ok: true });

  const today = await (await get("/")).text();
  assertInert("today", today);
  const card = today.slice(today.indexOf('id="actions-card"'), today.indexOf("</section>", today.indexOf('id="actions-card"')));
  for (const words of ["Approved a deploy", "Sent a Teams message", "Created a dev task", "Asked to open production", "a chat", "GHE said no"]) assert.ok(card.includes(words), words);
  assert.doesNotMatch(card, /19:abc/, "a chat by name (or just «a chat»), never its id");

  const deploys = await (await get("/deploys")).text();
  const decided = deploys.slice(deploys.indexOf("Decided here"));
  assert.match(decided, /deploy\.approved/);
  assert.doesNotMatch(decided, /teams\.send|ticket\.create|data\.prod\.open/);
  assert.match(decided, /href="\/actions"/);

  const all = await (await get("/actions")).text();
  assertInert("actions", all);
  assert.equal((all.match(/class="pill /g) ?? []).length, 4);
});

test("a Teams chat shows by the name Teams gave it, even when the log cut its id short", () => {
  const names = (id: string) => (id === "19:abc@thread.v2" ? "Kari Nordmann" : undefined);
  assert.equal(whereOf({ kind: "teams.send", target: "chat 19:abc@thread.v2" }, names), "Kari Nordmann");
  assert.equal(whereOf({ kind: "teams.react", target: "chat 19:zzz@thread.v2 message 17" }, names), "a chat");
  assert.equal(whereOf({ kind: "deploy.approved", target: "ACME/x run 1" }), "ACME/x run 1");
});
