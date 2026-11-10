import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { html } from "hono/html";
import { checkoutIn, checkoutsIn } from "../src/packs/checkouts.ts";
import { sessionPath } from "../src/app.ts";
import { assertInert, HOSTILE, packApp } from "../src/packs/testing.ts";
import { argsOf, firstPage, flagsOf, mcpAddLine, packIn, sessionTurn, settingsOf } from "../src/run.ts";
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

test("settingsOf takes only the pack's own keys: --set, then the environment, then the local instance", () => {
  assert.deepEqual(settingsOf(pack, { env: { HTTP_ENVS: "{}", GHE_TOKEN: "secret" } }), { values: { HTTP_ENVS: "{}" }, from: { HTTP_ENVS: "environment" } });
  assert.deepEqual(settingsOf(pack, { env: {}, instance: { HTTP_ENVS: "i", GHE_TOKEN: "t" } }), { values: { HTTP_ENVS: "i" }, from: { HTTP_ENVS: "local instance" } });
  assert.deepEqual(settingsOf(pack, { flags: { HTTP_ENVS: "f" }, env: { HTTP_ENVS: "e" }, instance: { HTTP_ENVS: "i" } }).from, { HTTP_ENVS: "--set" });
  assert.deepEqual(settingsOf(pack, { env: { HTTP_ENVS: " " }, instance: { HTTP_ENVS: "i" } }).values, { HTTP_ENVS: "i" });
});

test("argsOf reads the pack, the checkout and each --set", () => {
  assert.deepEqual(argsOf(["http", "--set", "A=1", "repo", "--set=B=x=y"]), { id: "http", checkout: "repo", sets: [["A", "1"], ["B", "x=y"]] });
  assert.throws(() => argsOf(["http", "--set", "novalue"]), /KEY=value/);
  assert.throws(() => argsOf(["http", "--set"]), /KEY=value/);
  assert.throws(() => argsOf(["http", "--verbose"]), /unknown option/);
});

test("flagsOf takes the pack's own keys, and never a secret on the command line", () => {
  const p = { manifest: { id: "x", settings: [{ key: "URL", label: "u" }, { key: "TOKEN", label: "t", secret: true }] } } as unknown as Pack;
  assert.deepEqual(flagsOf(p, [["URL", "https://a"]]), { URL: "https://a" });
  assert.throws(() => flagsOf(p, [["TOKEN", "s3cret"]]), /secret/);
  assert.throws(() => flagsOf(p, [["GHE_TOKEN", "s"]]), /no setting GHE_TOKEN/);
});


const tool = (name: string) =>
  ({
    manifest: { api: "2.0", id: "tool", name, description: "x", domain: "general", execution: "local-only" },
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

const needy = (name: string) => ({ ...tool(name), manifest: { ...tool(name).manifest, settings: [{ key: "TOOL_URL", label: "Its address", required: true }, { key: "TOOL_KEY", label: "Its key", secret: true }] } }) as Pack;

test("a session waiting for a setting: its Settings page, kept in memory, then the pack turns on", async () => {
  const env: Record<string, string> = {};
  const { get, post } = packApp([needy("Tool")], { session: { pack: "tool" }, env });
  assert.equal((await get("/tool")).status, 404);
  const page = await (await get("/settings/packs/tool")).text();
  assert.match(page, /TOOL_URL isn&#39;t set/);
  assert.match(page, /for this session only/);
  assert.match(page, /action="\/packs\/tool\/settings"/);
  assert.ok(!page.includes('href="/settings"'), "no other settings areas");
  assert.ok(!page.includes('href="/packs'), "no Packs page link");
  const saved = await post("/packs/tool/settings", { TOOL_URL: "https://tool.test", TOOL_KEY: "s3cret" });
  assert.equal(saved.status, 303);
  assert.equal(env.TOOL_URL, "https://tool.test");
  assert.equal(env.TOOL_KEY, "s3cret");
  assert.equal((await get("/tool")).status, 200);
  const after = await (await get("/settings/packs/tool")).text();
  assert.ok(!after.includes("s3cret"), "a secret isn't drawn back");
  assert.match(after, /Saved/);
  assert.match(await (await get("/tool")).text(), /href="\/settings\/packs\/tool"/);
});

test("a session's settings answer only for its pack, and only from this app's origin", async () => {
  const { get, post } = packApp([needy("Tool")], { session: { pack: "tool" } });
  for (const p of ["/settings/packs/other", "/settings/packs", "/settings", "/settings/writes"]) assert.equal((await get(p)).status, 404, p);
  assert.equal((await post("/packs/other/settings", {})).status, 404);
  assert.equal((await post("/packs/tool/switch", { on: "1" })).status, 404);
  assert.notEqual((await post("/packs/tool/settings", { TOOL_URL: "x" }, { origin: "https://evil.example" })).status, 303);
});

test("a session's Settings page escapes the pack's name", async () => {
  const { get } = packApp([needy(HOSTILE)], { session: { pack: "tool" } });
  assertInert("session settings", await (await get("/settings/packs/tool")).text());
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

const TOKEN = "t".repeat(32);
const withTools = {
  ...tool("Tool"),
  tools: () => [{ name: "echo", description: "says it back", input: { type: "object" }, run: async (a: Record<string, unknown>, _ctx: unknown, call: { repo: string }) => ({ text: `${String(a.x)} in ${call.repo}` }) }],
} as unknown as Pack;
const rpc = (app: { request: (u: string, i: RequestInit) => Response | Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
  app.request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });

test("sessionTurn: only the session's own token", () => {
  const turn = { id: "session-tool", repo: "a", cwd: "/c/a" };
  const of = sessionTurn(TOKEN, turn);
  assert.equal(of(TOKEN), turn);
  for (const bad of ["", "t".repeat(31), "t".repeat(33), "u".repeat(32), "test-token"]) assert.equal(of(bad), undefined, bad);
});

test("a session's tools answer on /mcp with its own token, never the launch token or a browser", async () => {
  const { app, get } = packApp([withTools], { session: { pack: "tool", checkout: "a" }, mcpTurns: sessionTurn(TOKEN, { id: "session-tool", repo: "a", cwd: "/c/a" }) });
  const list = await (await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["tool_echo"]);
  const call = await (await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tool_echo", arguments: { x: "hi" } } })).json();
  assert.equal(call.result.content[0].text, "hi in a");
  assert.equal((await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { authorization: "Bearer test-token" })).status, 401);
  assert.equal((await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { authorization: `Bearer ${"x".repeat(32)}` })).status, 401);
  assert.equal((await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { origin: "https://evil.example" })).status, 403);
  // The page doors are unchanged: still no cockpit.
  assert.equal((await get("/settings")).status, 404);
});

test("without a session token, /mcp isn't there in a session", async () => {
  const { app } = packApp([withTools], { session: { pack: "tool" } });
  assert.equal((await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
});

test("mcpAddLine names the pack, the session's port and its token", () => {
  assert.equal(mcpAddLine("http", 5123, TOKEN), `claude mcp add --transport http dovre-http http://127.0.0.1:5123/mcp --header "Authorization: Bearer ${TOKEN}"`);
});
