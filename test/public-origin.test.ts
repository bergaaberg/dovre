/**
 * Local Dovre behind a sign-in proxy (#74, docs/REMOTE.md): PUBLIC_ORIGIN lets in exactly one more
 * Host and one more Origin, still with the launch cookie. Unset, nothing changes. Near misses
 * (another port, http for https, a suffix or a prefix) get nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowed, isOwnOrigin, publicOriginOf } from "../src/access.ts";
import { loadEnv } from "../src/env.ts";
import { signedIn, snapshot } from "./helpers.ts";

const PUB = "https://dovre.example.com";
const COOKIE = { cookie: "u_tk=test-token" };

test("PUBLIC_ORIGIN must be exactly scheme://host[:port]; anything looser stops the start", () => {
  assert.equal(publicOriginOf(undefined), undefined);
  assert.equal(publicOriginOf("  "), undefined);
  assert.equal(publicOriginOf("https://dovre.example.com"), PUB);
  assert.equal(publicOriginOf("https://dovre.example.com/"), PUB);
  assert.equal(publicOriginOf("https://Dovre.Example.com"), PUB);
  assert.equal(publicOriginOf("http://box.lan:8080"), "http://box.lan:8080");
  for (const bad of ["dovre.example.com", "https://dovre.example.com/app", "https://*.example.com", "https://u:p@dovre.example.com", "https://dovre.example.com?x=1", "https://dovre.example.com#x", "ftp://dovre.example.com", "https://dovre.example.com:443", "*", "javascript:alert(1)"])
    assert.throws(() => publicOriginOf(bad), /PUBLIC_ORIGIN/, bad);
});

test("the checks: one more Host and one more Origin, exactly", () => {
  const r = (url: string) => new Request(url, { headers: COOKIE });
  assert.ok(allowed(r("http://dovre.example.com/"), "test-token", PUB), "the proxy's request, TLS ended in front");
  assert.ok(allowed(r("https://dovre.example.com/"), "test-token", PUB));
  assert.ok(allowed(r("http://localhost:4848/"), "test-token", PUB), "localhost still works");
  for (const url of ["http://dovre.example.com:8443/", "http://evil-dovre.example.com/", "http://dovre.example.com.evil.example/", "http://example.com/"])
    assert.ok(!allowed(r(url), "test-token", PUB), url);
  assert.ok(!allowed(r("http://dovre.example.com/"), "test-token"), "unset: a public name is refused");
  assert.ok(!allowed(new Request("http://dovre.example.com/"), "test-token", PUB), "no cookie");
  const at = new Request("http://dovre.example.com/");
  assert.ok(isOwnOrigin(at, PUB, PUB));
  assert.ok(isOwnOrigin(at, "http://dovre.example.com", PUB), "the request's own origin, as before");
  for (const o of ["http://dovre.example.com:80x", "https://dovre.example.com:8443", "https://dovre.example.co", "null", "", undefined]) assert.ok(!isOwnOrigin(at, o, PUB), String(o));
  assert.ok(!isOwnOrigin(new Request("http://localhost/"), PUB), "unset: the public origin isn't this app's");
});

test("behind PUBLIC_ORIGIN the app answers at that host, signs in with a Secure cookie there, and takes forms from that origin only", async () => {
  const { app } = signedIn(snapshot(), {}, { env: { PUBLIC_ORIGIN: PUB } });
  assert.equal((await app.request("http://dovre.example.com/", { headers: COOKIE })).status, 200);
  assert.equal((await app.request("http://dovre.example.com/")).status, 404, "no cookie");
  for (const host of ["dovre.example.com:8443", "evil-dovre.example.com", "dovre.example.com.evil.example"])
    assert.equal((await app.request(`http://${host}/`, { headers: COOKIE })).status, 404, host);
  const login = await app.request("http://dovre.example.com/login?tk=test-token");
  assert.equal(login.status, 303);
  assert.match(login.headers.get("set-cookie") ?? "", /; Secure/);
  assert.doesNotMatch((await app.request("http://localhost/login?tk=test-token")).headers.get("set-cookie") ?? "", /Secure/, "not on localhost: Safari drops a Secure cookie on http");
  assert.equal((await app.request("http://dovre.example.com/login?tk=wrong")).status, 404);
  const form = (origin: string, host = "dovre.example.com") =>
    app.request(`http://${host}/todo`, { method: "POST", headers: { ...COOKIE, origin, "content-type": "application/x-www-form-urlencoded" }, body: "text=x" });
  const refused = async (r: Response) => r.status === 403 && (await r.text()) === "Cross-origin form.";
  assert.ok(!(await refused(await form(PUB))), "the public origin");
  assert.ok(!(await refused(await form(PUB, "localhost:4848"))), "the public origin, Host rewritten by the proxy");
  for (const o of ["https://evil.example", "https://dovre.example.com:8443", "https://dovre.example.co"]) assert.ok(await refused(await form(o)), o);
  const unset = signedIn(snapshot()).app;
  const plain = await unset.request("http://localhost/todo", { method: "POST", headers: { ...COOKIE, origin: PUB, "content-type": "application/x-www-form-urlencoded" }, body: "text=x" });
  assert.ok(await refused(plain), "unset: the public origin's form is refused");
});

test("Settings warns while PUBLIC_ORIGIN is set; a bad one stops the app", async () => {
  const { get } = signedIn(snapshot(), {}, { env: { PUBLIC_ORIGIN: PUB } });
  const page = await (await get("/settings")).text();
  assert.match(page, /Public address/);
  assert.match(page, /dot warn/);
  assert.doesNotMatch(await (await signedIn(snapshot()).get("/settings")).text(), /Public address/);
  assert.throws(() => signedIn(snapshot(), {}, { env: { PUBLIC_ORIGIN: "https://*.example.com" } }), /PUBLIC_ORIGIN/);
});

test("PUBLIC_ORIGIN comes from the environment or .dev.vars, never from Settings", () => {
  const before = process.env.PUBLIC_ORIGIN;
  delete process.env.PUBLIC_ORIGIN;
  try {
    assert.equal(loadEnv({ PUBLIC_ORIGIN: "https://evil.example" }).PUBLIC_ORIGIN, undefined);
  } finally {
    if (before !== undefined) process.env.PUBLIC_ORIGIN = before;
  }
});
