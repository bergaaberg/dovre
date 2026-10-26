/** What Dovre did for me: a card on Today and /actions; Deploys keeps only deploy decisions (2026-10-23). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { logAction } from "../src/actions/deploys.ts";
import { whatOf, whereOf } from "../src/pages/actions.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { assertInert, H, signedIn, snapshot } from "./helpers.ts";

/** A pack that logs writes to its app ("notes.post", target "thread <id>") and names them on the log. */
const notesPack: Pack = {
  manifest: { api: PACK_API, id: "notes", name: "Notes", description: "A made-up app", domain: "work" },
  slots: () => ({
    "actions.what": ({ kind }) => (kind === "notes.post" ? "Posted a note" : undefined),
    "actions.where": ({ kind, target }) => (kind === "notes.post" && target === "thread t-1" ? "the design thread" : undefined),
  }),
};

test("Today's Actions card says what was done in words; Deploys shows deploy decisions only; /actions has them all", async () => {
  const { get, db } = signedIn(snapshot(), {}, { packs: [notesPack] });
  await logAction(db.DB, { kind: "deploy.approved", target: "ACME/people run 10", ok: true });
  await logAction(db.DB, { kind: "notes.post", target: "thread t-1", detail: "12 characters", ok: true });
  await logAction(db.DB, { kind: "task.create", target: `ACME/x#13 ${H}`, ok: false, error: `GHE said no ${H}` });
  await logAction(db.DB, { kind: "data.prod.open", target: "ledger:prod", ok: true });

  const today = await (await get("/")).text();
  assertInert("today", today);
  const card = today.slice(today.indexOf('id="actions-card"'), today.indexOf("</section>", today.indexOf('id="actions-card"')));
  for (const words of ["Approved a deploy", "Posted a note", "Created a dev task", "Asked to open production", "the design thread", "GHE said no"]) assert.ok(card.includes(words), words);
  assert.doesNotMatch(card, /thread t-1/, "where, as the pack names it");

  const deploys = await (await get("/deploys")).text();
  const decided = deploys.slice(deploys.indexOf("Decided here"));
  assert.match(decided, /deploy\.approved/);
  assert.doesNotMatch(decided, /notes\.post|ticket\.create|data\.prod\.open/);
  assert.match(decided, /href="\/actions"/);

  const all = await (await get("/actions")).text();
  assertInert("actions", all);
  assert.equal((all.match(/class="pill /g) ?? []).length, 4);
});

test("a pack names what it logged and where; the core's own kinds and the rest stay as they are", () => {
  const said = (kind: string) => (kind === "notes.post" ? "Posted a note" : kind === "deploy.approved" ? "not this" : undefined);
  const named = (a: { kind: string; target: string }) => (a.target === "thread t-1" ? "the design thread" : undefined);
  assert.equal(whatOf("notes.post", said), "Posted a note");
  assert.equal(whatOf("deploy.approved", said), "Approved a deploy", "a core kind keeps its words");
  assert.equal(whatOf("other.thing", said), "other.thing");
  assert.equal(whereOf({ kind: "notes.post", target: "thread t-1" }, named), "the design thread");
  assert.equal(whereOf({ kind: "deploy.approved", target: "ACME/x run 1" }, named), "ACME/x run 1");
});
