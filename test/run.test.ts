import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { html } from "hono/html";
import { checkoutIn, checkoutsIn } from "../src/packs/checkouts.ts";
import { sessionPath } from "../src/app.ts";
import { assertInert, HOSTILE, packApp } from "../src/packs/testing.ts";
import { firstPage, packIn, settingsOf } from "../src/run.ts";
import type { Pack } from "../src/packs/types.ts";

const pack = { manifest: { id: "http", name: "HTTP", settings: [{ key: "HTTP_ENVS", label: "x" }] }, nav: () => [{ href: "/http/quick", title: "HTTP" }] } as unknown as Pack;

test("packIn finds the export whose manifest has the id", () => {
  assert.equal(packIn({ other: { manifest: { id: "json" } }, httpPack: pack, n: 1 }, "http"), pack);
  assert.equal(packIn({ httpPack: pack }, "json"), undefined);
});

test("firstPage is the first nav entry, and never another site", () => {
  assert.equal(firstPage(pack), "/http/quick");
  assert.equal(firstPage({ ...pack, nav: () => [{ href: "//evil.example" }] } as unknown as Pack), "/http");
  assert.equal(firstPage({ ...pack, nav: () => { throw new Error("x"); } } as unknown as Pack), "/http");
});

test("settingsOf takes only the pack's own keys from the environment", () => {
  assert.deepEqual(settingsOf(pack, { HTTP_ENVS: "{}", GHE_TOKEN: "secret" }), { HTTP_ENVS: "{}" });
});


const tool = (name: string) =>
  ({
    manifest: { api: "1.6", id: "tool", name, description: "x", domain: "general", execution: "local-only" },
    nav: () => [{ href: "/tool", title: "Tool" }],
    routes(app, ctx) {
      app.get("/tool", (c) => ctx.page(c, { title: name, body: html`<p>the tool</p>` }));
    },
  }) as Pack;

test("sessionPath: the pack's own paths, sign-in, assets and events; nothing else", () => {
  for (const p of ["/tool", "/tool/x", "/extra/y", "/login", "/events", "/assets/app.css"]) assert.ok(sessionPath(p, ["tool", "extra"]), p);
  for (const p of ["/", "/prs", "/settings", "/packs", "/bino", "/toolx", "/search", "/refresh"]) assert.ok(!sessionPath(p, ["tool", "extra"]), p);
});

test("a session serves the pack in a shell without the cockpit, and 404s the cockpit's pages", async () => {
  const { get, post } = packApp([tool("Tool")], { session: { pack: "tool" } });
  const res = await get("/tool");
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /the tool/);
  assert.match(page, /throw-away session/);
  for (const href of ["/search", "/prs", "/settings", "/packs", "/bino"]) assert.ok(!page.includes(`href="${href}"`), href);
  assert.ok(!page.includes('action="/refresh"'));
  for (const p of ["/prs", "/settings", "/packs", "/bino", "/code", "/todo", "/search"]) assert.equal((await get(p)).status, 404, p);
  assert.equal((await post("/refresh", {})).status, 404);
});

test("a session's shell escapes the pack's name", async () => {
  const { get } = packApp([tool(HOSTILE)], { session: { pack: "tool" } });
  assertInert("session shell", await (await get("/tool")).text());
});

/** A code folder with checkouts a and b, a folder without .git, and c, a symlink to a. */
function codeFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "dovre-run-"));
  for (const r of ["a", "b"]) mkdirSync(join(dir, r, ".git"), { recursive: true });
  mkdirSync(join(dir, "plain"));
  symlinkSync(join(dir, "a"), join(dir, "c"));
  return dir;
}

test("checkouts: real git folders directly under the code folder; `only` narrows to one", (t) => {
  const dir = codeFolder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(checkoutsIn(dir), ["a", "b"]);
  assert.deepEqual(checkoutsIn(dir, "a"), ["a"]);
  assert.deepEqual(checkoutsIn(dir, ""), []);
  assert.equal(checkoutIn(dir, "a"), join(dir, "a"));
  assert.equal(checkoutIn(dir, "b", "a"), null);
  for (const bad of ["c", "plain", "..", ".", "../a", "a/b", "", 7, undefined]) assert.equal(checkoutIn(dir, bad), null, String(bad));
  assert.deepEqual(checkoutsIn(join(dir, "nope")), []);
});

test("a session's packs see only its checkout through ctx", async (t) => {
  const dir = codeFolder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lister = {
    ...tool("Tool"),
    routes(app, ctx) {
      app.get("/tool", (c) => c.text(`${ctx.checkouts?.().join(",")}|${ctx.checkout?.("b") ?? "none"}`));
    },
  } as Pack;
  assert.equal(await (await packApp([lister], { codeDir: dir, session: { pack: "tool", checkout: "a" } }).get("/tool")).text(), "a|none");
  assert.equal(await (await packApp([lister], { codeDir: dir }).get("/tool")).text(), `a,b|${join(dir, "b")}`);
});
