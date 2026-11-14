/** #523: the GitHub App's manifest, the page that posts it, and the code's conversion. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appManifest, convertManifest, manifestPage } from "../src/github-app.ts";

test("github app: the manifest asks only for emails, sends sign-in back to the instance, and the page escapes it", () => {
  const m = appManifest({ host: "home.me.workers.dev", name: `Dovre "><script>alert(1)</script> and a very long name`, redirectUrl: "http://127.0.0.1:5555/done" });
  assert.deepEqual(m.callback_urls, ["https://home.me.workers.dev/_auth/github/callback"]);
  assert.deepEqual(m.default_permissions, { email_addresses: "read" });
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.active, false);
  assert.ok(m.name.length <= 34);
  const page = manifestPage({ manifest: m, state: "s1", org: "a&b" });
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /action="https:\/\/github\.com\/organizations\/a%26b\/settings\/apps\/new\?state=s1"/);
  const value = /name="manifest" value="([^"]*)"/.exec(page)![1]!.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
  assert.deepEqual(JSON.parse(value), m);
  assert.match(manifestPage({ manifest: m, state: "s" }), /action="https:\/\/github\.com\/settings\/apps\/new\?state=s"/);
});

test("github app: a code turns into the app; an odd code never reaches GitHub; a refusal says why", async () => {
  const seen: string[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(url)}`);
    return String(url).endsWith("/bad/conversions")
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
      : new Response(JSON.stringify({ id: 7, slug: "dovre-home", client_id: "Iv1", client_secret: "cs", pem: "PEM", html_url: "https://github.com/apps/dovre-home" }), { status: 201 });
  }) as typeof fetch;
  assert.deepEqual(await convertManifest(f, "abc123"), { id: 7, slug: "dovre-home", clientId: "Iv1", clientSecret: "cs", pem: "PEM", htmlUrl: "https://github.com/apps/dovre-home" });
  assert.deepEqual(seen, ["POST https://api.github.com/app-manifests/abc123/conversions"]);
  await assert.rejects(convertManifest(f, "../x"), /Not a manifest code/);
  await assert.rejects(convertManifest(f, "bad"), /404.*Not Found/);
  assert.equal(seen.length, 2);
});
