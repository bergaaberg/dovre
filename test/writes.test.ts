// Writes' clicks (dovre#104): a Post by default; a kind set to ask twice on Settings draws a Confirm.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { Confirm, html } from "../src/ui/kit.ts";
import { WRITES, writeKinds } from "../src/writes.ts";
import { signedIn, snapshot } from "./helpers.ts";

const probe: Pack = {
  manifest: { api: PACK_API, id: "probe", name: "Probe", description: "", domain: "personal" },
  routes: (app, ctx) =>
    app.get("/probe", (c) =>
      ctx.page(c, {
        title: "Probe",
        body: html`${[
          Confirm({ kind: "deploy.approve", action: "/a", label: "Approve", question: "Approve?" }),
          Confirm({ kind: "todo.delete", action: "/d", label: "Delete", question: "Delete?" }),
          Confirm({ action: "/n", label: "None", question: "No kind?" }),
        ]}`,
      }),
    ),
};

test("writes: one click by default; ticked kinds ask twice; unnamed writes take one click", async () => {
  const { app, get } = signedIn(snapshot(), {}, { packs: [probe] });
  const before = await (await get("/probe")).text();
  assert.equal((before.match(/<details class="confirm">/g) ?? []).length, 0);
  assert.match(before, /<form class="post" method="post" action="\/d">/, "deleting too: one click until I say");

  const settings = await (await get("/settings/writes")).text();
  assert.match(settings, /id="writes"/);
  assert.match(settings, /name="twice" value="deploy.approve"/);
  assert.match(settings, /name="twice" value="todo.delete"/, "every kind can be ticked");

  const save = (body: string, origin = "http://localhost") =>
    app.request("http://localhost/settings/writes", { method: "POST", headers: { cookie: "u_tk=test-token", origin, "content-type": "application/x-www-form-urlencoded" }, body });
  assert.equal((await save("twice=todo.delete&twice=made.up")).status, 303);
  const after = await (await get("/probe")).text();
  assert.match(after, /<form class="post" method="post" action="\/a">/, "approve: one click");
  assert.match(after, /<details class="confirm"><summary>Delete/, "delete: ticked, asks twice");
  assert.match(after, /<form class="post" method="post" action="\/n">/, "no kind: one click");
  assert.match(await (await get("/settings/writes")).text(), /value="todo.delete" checked/);

  assert.equal((await save("", "https://evil.example")).status, 403, "only from this app");
  assert.equal((await save("")).status, 303);
  assert.equal(((await (await get("/probe")).text()).match(/<details class="confirm">/g) ?? []).length, 0, "untick: one click again");
});

test("writes: outside a request (no choices), Confirm is one click", () => {
  assert.match(String(Confirm({ kind: "deploy.approve", action: "/a", label: "A", question: "Q" })), /<form class="post"/);
  assert.equal(new Set(WRITES.map((w) => w.kind)).size, WRITES.length, "kinds are unique");
});

const shop: Pack = {
  manifest: { api: PACK_API, id: "shop", name: "Shop", description: "", domain: "personal" },
  writes: [
    { kind: "refund", label: "Refund an order" },
    { kind: "wipe", label: "Delete a customer", floor: "twice" },
    { kind: "Bad Kind", label: "Dropped" },
    { kind: "refund", label: "A repeat, dropped" },
  ],
  routes: (app, ctx) =>
    app.get("/shop", (c) =>
      ctx.page(c, {
        title: "Shop",
        body: html`${[
          Confirm({ kind: "shop.refund", action: "/shop/r", label: "Refund", question: "Refund?" }),
          Confirm({ kind: "shop.wipe", action: "/shop/w", label: "Wipe", question: "Wipe?" }),
        ]}`,
      }),
    ),
};

test("writes: a pack's own kinds (dovre#104) are on Settings under its name and ask twice when ticked; an old floor is ignored", async () => {
  const kinds = writeKinds([shop]);
  assert.deepEqual(kinds.slice(WRITES.length), [
    { kind: "shop.refund", label: "Refund an order", group: "Shop" },
    { kind: "shop.wipe", label: "Delete a customer", group: "Shop" },
  ]);
  const { app, get } = signedIn(snapshot(), {}, { packs: [shop] });
  const settings = await (await get("/settings/writes")).text();
  assert.match(settings, /<legend>Shop<\/legend><label class="write-row"><input type="checkbox" name="twice" value="shop.refund">/);
  assert.match(settings, /value="shop.wipe"/);
  const save = (body: string) =>
    app.request("http://localhost/settings/writes", { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body });
  assert.equal((await save("twice=shop.wipe&twice=other.refund")).status, 303);
  const page = await (await get("/shop")).text();
  assert.match(page, /<form class="post" method="post" action="\/shop\/r">/, "refund: one click");
  assert.match(page, /<details class="confirm"><summary>Wipe/, "wipe: ticked, asks twice");
});
