import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { layoutOf } from "../src/layout.ts";
import { systemOpener, webUrl } from "../src/open-link.ts";
import { fakeGhe, fixedGatherer, snapshot } from "./helpers.ts";

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };

function appWith(o: { opener?: boolean; hosted?: boolean } = {}) {
  const opened: string[] = [];
  const app = createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, openUrl: o.opener === false ? undefined : (h) => opened.push(h) });
  const headers = { cookie: "u_tk=test-token", origin: "http://localhost" };
  const get = (path: string) => app.request(`http://localhost${path}`, { headers: { cookie: headers.cookie } });
  const form = (path: string, body: Record<string, string>) => app.request(`http://localhost${path}`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const open = (url: unknown, extra: Record<string, string> = {}) => app.request("http://localhost/open-link", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body: JSON.stringify({ url }) });
  return { opened, get, form, open };
}

test("webUrl: only a plain http(s) address, as the parser writes it", () => {
  assert.equal(webUrl("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&c=2");
  assert.equal(webUrl("http://example.com/a b\"c"), "http://example.com/a%20b%22c");
  for (const bad of ["javascript:alert(1)", "file:///C:/Windows/system32/calc.exe", "ms-settings:", "dovre://open", "\\\\host\\share", "https://u:p@example.com/", "not a url", "", 42, null, "https://example.com/" + "x".repeat(5000)])
    assert.equal(webUrl(bad), undefined, String(bad).slice(0, 40));
});

test("systemOpener: one argument to the system's opener, never a shell", () => {
  const calls: [string, string[]][] = [];
  const fake = (cmd: string, args: string[]) => (calls.push([cmd, args]), { on() {}, unref() {} });
  systemOpener("win32", fake)("https://example.com/?a=1&b=2");
  systemOpener("darwin", fake)("https://example.com/");
  systemOpener("linux", fake)("https://example.com/");
  assert.deepEqual(calls, [
    ["rundll32.exe", ["url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"]],
    ["open", ["https://example.com/"]],
    ["xdg-open", ["https://example.com/"]],
  ]);
});

test("Links to other sites: off by default; on, the page says so and /open-link opens only a web address", async () => {
  const { opened, get, form, open } = appWith();
  assert.doesNotMatch(await (await get("/prs")).text(), /u-links/, "off until picked");
  assert.equal((await open("https://example.com/")).status, 404, "nothing opens while it's off");
  assert.match(await (await get("/settings/layout")).text(), /<select name="links">/);

  await form("/settings/layout", { links: "default" });
  assert.match(await (await get("/prs")).text(), /<meta name="u-links" content="default">/);
  assert.match(await (await get("/settings/layout")).text(), /<option value="default" selected>In your default browser/);

  assert.equal((await open("https://example.com/x?a=1&b=2")).status, 204);
  assert.deepEqual(opened, ["https://example.com/x?a=1&b=2"]);

  // Hostile: other schemes, junk, another site's request, no Origin, no cookie.
  for (const bad of ["javascript:alert(1)", "file:///C:/x.exe", "ms-settings:", { href: "https://x" }, "<script>"]) assert.equal((await open(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await open("https://example.com/", { "sec-fetch-site": "cross-site" })).status, 404);
  assert.equal((await open("https://example.com/", { origin: "https://evil.example" })).status, 403);
  assert.deepEqual(opened, ["https://example.com/x?a=1&b=2"], "none of those opened anything");

  await form("/settings/layout", { links: "" });
  assert.equal((await open("https://example.com/")).status, 404, "off again");
  assert.deepEqual(layoutOf({ links: "chrome" }), {}, "only what it knows");
});

test("Links to other sites: not offered where nothing can open them", async () => {
  const { get, form, open } = appWith({ opener: false });
  assert.doesNotMatch(await (await get("/settings/layout")).text(), /name="links"/);
  await form("/settings/layout", { links: "default" });
  assert.doesNotMatch(await (await get("/prs")).text(), /u-links/);
  assert.equal((await open("https://example.com/")).status, 404);
});
