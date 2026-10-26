// Writes' clicks (dovre#104): a kind set to one click on Settings draws a Post; a floor keeps asking.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { Confirm, html } from "../src/ui/kit.ts";
import { WRITES } from "../src/writes.ts";
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

test("writes: ask twice by default; ticked kinds take one click; floors and unnamed writes keep asking", async () => {
  const { app, get } = signedIn(snapshot(), {}, { packs: [probe] });
  const before = await (await get("/probe")).text();
  assert.equal((before.match(/<details class="confirm">/g) ?? []).length, 3);

  const settings = await (await get("/settings")).text();
  assert.match(settings, /id="writes"/);
  assert.match(settings, /name="once" value="deploy.approve"/);
  assert.doesNotMatch(settings, /name="once" value="todo.delete"/, "a floor can't be ticked");

  const save = (body: string, origin = "http://localhost") =>
    app.request("http://localhost/settings/writes", { method: "POST", headers: { cookie: "u_tk=test-token", origin, "content-type": "application/x-www-form-urlencoded" }, body });
  assert.equal((await save("once=deploy.approve&once=todo.delete&once=made.up")).status, 303);
  const after = await (await get("/probe")).text();
  assert.match(after, /<form class="post" method="post" action="\/a">/, "approve: one click");
  assert.match(after, /<details class="confirm"><summary>Delete/, "delete: always asks");
  assert.match(after, /<details class="confirm"><summary>None/, "no kind: asks");
  assert.match(await (await get("/settings")).text(), /value="deploy.approve" checked/);

  assert.equal((await save("", "https://evil.example")).status, 403, "only from this app");
  assert.equal((await save("")).status, 303);
  assert.equal(((await (await get("/probe")).text()).match(/<details class="confirm">/g) ?? []).length, 3, "untick: asks again");
});

test("writes: outside a request (no choices), Confirm asks", () => {
  assert.match(String(Confirm({ kind: "deploy.approve", action: "/a", label: "A", question: "Q" })), /details class="confirm"/);
  assert.equal(new Set(WRITES.map((w) => w.kind)).size, WRITES.length, "kinds are unique");
});
