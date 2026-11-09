/** ctx.logged (#474): a pack's write in the actions log under its own id, clipped, and never the write's failure. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentActions } from "../src/actions/deploys.ts";
import type { D1 } from "../src/db.ts";
import { type Pack, PACK_API, type PackContext } from "../src/pack.ts";
import { HOSTILE, packApp, testContext } from "../src/pack-testing.ts";
import { loggedFor, loggedRow } from "../src/packs/logged.ts";

test("ctx.logged: logged as <id>.<kind>, long text clipped, hostile text escaped on the Actions page", async () => {
  let ctx: PackContext | undefined;
  const pack: Pack = {
    manifest: { api: PACK_API, id: "shop", name: "Shop", description: "", domain: "personal" },
    routes: (app, c) => {
      ctx = c;
      app.post("/shop/send", async (cx) => {
        await c.logged({ kind: "send", target: HOSTILE, detail: "d".repeat(500), ok: true });
        await c.logged({ kind: "send", target: "t".repeat(500), ok: false, error: `no: ${HOSTILE}` });
        return cx.text("sent");
      });
    },
  };
  const { post, get, db } = packApp([pack]);
  assert.equal(await (await post("/shop/send", {})).text(), "sent");
  const rows = await recentActions(db.DB);
  assert.deepEqual(rows.map((r) => [r.kind, r.ok, r.target.length, r.detail?.length ?? null]), [["shop.send", 0, 300, null], ["shop.send", 1, HOSTILE.length, 200]]);
  assert.equal(rows[0]!.error, `no: ${HOSTILE}`);
  const page = await (await get("/actions")).text();
  assert.match(page, /shop\.send/);
  assert.ok(!page.includes("<script>x</script>") && !page.includes("<img src=x"), "hostile text got through");
  await assert.rejects(ctx!.logged({ kind: "shop.send", target: "x", ok: true }), /isn't a word/, "the id is core's to add");
});

test("ctx.logged: a kind that isn't one word throws; a log that can't be kept is a line in the pack's log, not an error", async () => {
  for (const kind of ["", "a.b", "a b", "1a", "x".repeat(41), HOSTILE, undefined, 3]) assert.throws(() => loggedRow("shop", { kind: kind as string, target: "t", ok: true }), TypeError, String(kind));
  assert.deepEqual(loggedRow("shop", { kind: "agentRun", target: "t", ok: true }), { kind: "shop.agentRun", target: "t", detail: undefined, ok: true, error: undefined });
  assert.equal(loggedRow("shop", { kind: "x", target: 3 as unknown as string, ok: "yes" as unknown as boolean }).ok, false, "only true is ok");
  const lines: string[] = [];
  const broken = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("disk full")) }) }) } as unknown as D1;
  await loggedFor("shop", broken, (l) => void lines.push(l))({ kind: "send", target: "t", ok: true });
  assert.deepEqual(lines, ["logged shop.send: not kept: disk full"]);
  await testContext().logged({ kind: "send", target: "t", ok: true });
  await assert.rejects(testContext().logged({ kind: "a.b", target: "t", ok: true }), TypeError, "a pack's test finds a bad kind too");
});
