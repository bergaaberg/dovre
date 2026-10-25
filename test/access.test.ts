/**
 * Who gets in (src/access.ts, PLAN D16): local mode by localhost and the launch cookie only;
 * hosted mode by a Cloudflare Access token whose signature, issuer, audience and expiry check out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { accessConfigOf, allowed, createAccessVerifier, operatorOf } from "../src/access.ts";
import worker, { resetHostedApp } from "../src/worker.ts";
import type { D1 } from "../src/db.ts";
import { signedIn, snapshot } from "./helpers.ts";

const TEAM = "my-team";
const ISS = "https://my-team.cloudflareaccess.com";
const AUD = "my-aud-tag";
const NOW = 1_700_000_000;
const now = () => NOW * 1000;

const b64url = (b: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof b === "string" ? b : b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid, typ: "JWT" }) => {
    const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    return `${head}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head)))}`;
  };
  return { jwk, sign };
}

/** Access's certs endpoint, counting how often it's asked. */
function certsServer(keys: () => unknown[]) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ keys: keys() }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const req = (jwt?: string, host = "dovre.example.dev") => new Request(`https://${host}/`, { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
const good = { iss: ISS, aud: [AUD], email: "Me@Example.dev", exp: NOW + 3600 };

test("local mode: a localhost Host and the launch cookie; a request can't make itself hosted", async () => {
  const token = "secret-launch-token-123";
  assert.equal(allowed(new Request("http://localhost:4848/", { headers: { cookie: `u_tk=${token}` } }), token), true);
  assert.equal(allowed(new Request("http://localhost:4848/"), token), false);
  assert.equal(allowed(new Request("http://localhost:4848/", { headers: { cookie: "u_tk=wrong" } }), token), false);
  assert.equal(allowed(new Request("http://attacker.com:4848/", { headers: { cookie: `u_tk=${token}` } }), token), false, "DNS rebinding");

  // A rebinding page could send this header itself: it used to switch the guard to hosted mode.
  const forged = `x.${b64url(JSON.stringify({ exp: 9_999_999_999 }))}.y`;
  const { app } = signedIn(snapshot());
  const res = await app.request("http://evil.example:4848/agents", { headers: { "cf-access-jwt-assertion": forged } });
  assert.equal(res.status, 404);
  assert.equal((await app.request("http://evil.example:4848/agents", { headers: { "cf-access-jwt-assertion": forged, cookie: "u_tk=test-token" } })).status, 404, "nor with the cookie");
});

test("hosted mode: only a token Access signed, for this team and app, unexpired", async () => {
  const k = await keyPair("k1");
  const other = await keyPair("k1");
  const { fetchFn, calls } = certsServer(() => [k.jwk]);
  const verify = createAccessVerifier({ team: TEAM, aud: AUD, fetchFn, now });

  assert.deepEqual(await verify(req(await k.sign(good))), { email: "me@example.dev" });
  assert.equal(calls[0], `${ISS}/cdn-cgi/access/certs`);

  const refused: [string, string | undefined][] = [
    ["no token", undefined],
    ["not a JWT", "not-a-jwt"],
    ["unsigned", `${b64url(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64url(JSON.stringify(good))}.fake-sig`],
    ["signed by another key", await other.sign(good)],
    ["alg none", await k.sign(good, { alg: "none", kid: "k1" })],
    ["an unknown key", await k.sign(good, { alg: "RS256", kid: "k9" })],
    ["expired", await k.sign({ ...good, exp: NOW - 60 })],
    ["no exp", await k.sign({ iss: ISS, aud: AUD })],
    ["not yet valid", await k.sign({ ...good, nbf: NOW + 3600 })],
    ["another team", await k.sign({ ...good, iss: "https://evil.cloudflareaccess.com" })],
    ["no issuer", await k.sign({ aud: AUD, exp: NOW + 3600 })],
    ["another app", await k.sign({ ...good, aud: "other-aud" })],
    ["no audience", await k.sign({ iss: ISS, exp: NOW + 3600 })],
  ];
  for (const [why, jwt] of refused) assert.equal(await verify(req(jwt)), undefined, why);

  const tampered = (await k.sign(good)).split(".");
  tampered[1] = b64url(JSON.stringify({ ...good, email: "attacker@evil.dev" }));
  assert.equal(await verify(req(tampered.join("."))), undefined, "payload changed after signing");

  assert.equal(await verify(req(await k.sign(good), "dovre.me.workers.dev")), undefined, "workers.dev is never served");
});

test("hosted mode: the email list, and keys fetched once then again when Access rotates them", async () => {
  const k1 = await keyPair("k1");
  const k2 = await keyPair("k2");
  let keys = [k1.jwk];
  const { fetchFn, calls } = certsServer(() => keys);
  let t = now();
  const verify = createAccessVerifier({ team: `${TEAM}.cloudflareaccess.com`, aud: AUD, allowedEmails: ["me@example.dev"], fetchFn, now: () => t });

  assert.ok(await verify(req(await k1.sign(good))));
  assert.equal(await verify(req(await k1.sign({ ...good, email: "someone@else.dev" }))), undefined);
  assert.equal(await verify(req(await k1.sign({ ...good, email: undefined }))), undefined);
  assert.ok(await verify(req(await k1.sign(good))));
  assert.equal(calls.length, 1, "cached");

  keys = [k2.jwk];
  assert.equal(await verify(req(await k2.sign(good))), undefined, "a new key isn't fetched again within a minute");
  t += 2 * 60_000;
  assert.ok(await verify(req(await k2.sign(good))), "then it is");
  assert.equal(calls.length, 2);
});

test("hosted mode: a keys fetch that never settles (its request was cancelled) holds no page", async () => {
  const k = await keyPair("k1");
  let hang = true;
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (hang) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ keys: [k.jwk] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let t = now();
  const verify = createAccessVerifier({ team: TEAM, aud: AUD, fetchFn, now: () => t, waitMs: 20 });

  assert.equal(await verify(req(await k.sign(good))), undefined, "refused after its own wait, not held");
  hang = false;
  t += 30;
  assert.ok(await verify(req(await k.sign(good))), "the stuck fetch is dropped and started again");
  assert.equal(calls, 2);

  // An hour on, the known key still answers at once while the keys load again (here: never).
  hang = true;
  t += 61 * 60_000;
  const later = await k.sign({ ...good, exp: NOW + 3 * 3600 });
  const started = Date.now();
  assert.ok(await verify(req(later)));
  assert.ok(Date.now() - started < 15, "didn't wait on the refetch");
  assert.equal(calls, 3);
});

test("hosted config needs both team and audience; the operator comes from the verified email", () => {
  assert.equal(accessConfigOf({}), undefined);
  assert.equal(accessConfigOf({ CF_ACCESS_TEAM: "t" }), undefined);
  assert.equal(accessConfigOf({ CF_ACCESS_AUD: "a" }), undefined);
  assert.deepEqual(accessConfigOf({ CF_ACCESS_TEAM: "t", CF_ACCESS_AUD: "a", ALLOWED_EMAILS: " Me@x.dev , ,b@y.dev" }), { team: "t", aud: "a", allowedEmails: ["me@x.dev", "b@y.dev"] });
  assert.equal(operatorOf({ email: "andreas@example.dev" }), "andreas");
  assert.equal(operatorOf(undefined), "operator");
  assert.equal(operatorOf({ service: "abc.access" }, "default-user"), "default-user");
});

function mockD1(): D1 {
  return {
    prepare: () => ({
      bind: () => mockD1().prepare(""),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
    }),
    batch: async () => [],
  };
}

test("worker.fetch: /healthz is public (/health is free for a pack); without Access configured, nobody gets in: the setup page says what's missing", async () => {
  resetHostedApp();
  const bindings = { DB: mockD1(), GITHUB_USER: "bergaaberg", IS_HOSTED: "1", GITHUB_TOKEN: "ghp_secret_value" };
  const early = await worker.fetch(new Request("https://dovre.example.dev/healthz"), bindings);
  assert.equal(early.status, 503);
  assert.deepEqual({ ...((await early.json()) as object), version: undefined }, { ok: false, setUp: false, version: undefined });
  const k = await keyPair("k1");
  for (const jwt of [undefined, await k.sign(good)]) {
    const res = await worker.fetch(req(jwt), bindings);
    assert.equal(res.status, 503, "no team or audience: closed");
    const page = await res.text();
    assert.match(page, /Dovre isn't set up yet/);
    assert.match(page, /CF_ACCESS_TEAM/);
    assert.doesNotMatch(page, /ghp_secret_value|bergaaberg/, "names only, never a value");
  }
  resetHostedApp();
  const ready = { ...bindings, CF_ACCESS_TEAM: "team", CF_ACCESS_AUD: "aud" };
  const health = await worker.fetch(new Request("https://dovre.example.dev/healthz"), ready);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  assert.equal((await worker.fetch(new Request("https://dovre.example.dev/health"), ready)).status, 404, "no pack, no /health");
  resetHostedApp();
});

test("worker: a verified request gets in; /atlas, /code and /issues/new aren't there hosted", async () => {
  resetHostedApp();
  const k = await keyPair("k1");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url) === `${ISS}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [k.jwk] })) : realFetch(url)) as typeof fetch;
  try {
    const bindings = { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD };
    const jwt = await k.sign({ ...good, exp: Math.floor(Date.now() / 1000) + 3600 });
    const headers = { "cf-access-jwt-assertion": jwt };
    assert.equal((await worker.fetch(new Request("https://dovre.example.dev/todo", { headers }), bindings)).status, 200);
    for (const path of ["/atlas", "/code", "/issues/new"]) assert.equal((await worker.fetch(new Request(`https://dovre.example.dev${path}`, { headers }), bindings)).status, 404, path);
  } finally {
    globalThis.fetch = realFetch;
    resetHostedApp();
  }
});

test("worker: GitHub without a token shows as failed, with one it's asked with a User-Agent (a Worker's fetch sends none)", async () => {
  const k = await keyPair("k1");
  const realFetch = globalThis.fetch;
  const asked: Request[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === `${ISS}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [k.jwk] }));
    asked.push(new Request(url, init));
    return new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } }));
  }) as typeof fetch;
  const page = async (bindings: Record<string, unknown>) => {
    resetHostedApp();
    const headers = { "cf-access-jwt-assertion": await k.sign({ ...good, exp: Math.floor(Date.now() / 1000) + 3600 }) };
    const res = await worker.fetch(new Request("https://dovre.example.dev/prs", { headers }), { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, ...bindings });
    assert.equal(res.status, 200);
    return res.text();
  };
  try {
    assert.match(await page({}), /didn't load\.<\/strong> No GITHUB_TOKEN/);
    assert.equal(asked.length, 0, "no token: GitHub isn't asked");
    assert.doesNotMatch(await page({ GITHUB_TOKEN: "t0ken" }), /didn't load/);
    const gh = asked.filter((r) => r.url.startsWith("https://api.github.com/"));
    assert.ok(gh.length > 0);
    for (const r of gh) assert.equal(r.headers.get("user-agent"), "dovre", r.url);
  } finally {
    globalThis.fetch = realFetch;
    resetHostedApp();
  }
});


test("a service token is never a person: pages refuse it, /bridge takes only the bridge's, and only as a socket", async () => {
  const k = await keyPair("k1");
  const { fetchFn } = certsServer(() => [k.jwk]);
  const verify = createAccessVerifier({ team: TEAM, aud: AUD, fetchFn, now, allowedEmails: ["me@example.dev"] });
  const svc = { iss: ISS, aud: [AUD], common_name: "abc123.access", exp: NOW + 3600 };
  assert.deepEqual(await verify(req(await k.sign(svc))), { service: "abc123.access" });
  assert.equal(await verify(req(await k.sign({ iss: ISS, aud: [AUD], exp: NOW + 3600 }))), undefined, "neither a person nor a token");

  resetHostedApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url) === `${ISS}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [k.jwk] })) : realFetch(url)) as typeof fetch;
  const handed: Request[] = [];
  const HUB = {
    idFromName: () => "hub",
    get: () => ({
      fetch: async (r: Request | string) => {
        const q = new Request(r);
        if (new URL(q.url).pathname === "/mac") return Response.json({ online: false, seen: Date.now() - 3 * 3600e3, watching: false });
        handed.push(q);
        return new Response("to the hub");
      },
    }),
  };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const person = await k.sign({ ...good, exp });
  const token = (id: string) => k.sign({ ...svc, common_name: id, exp });
  const upgrade = (jwt: string, extra: Record<string, string> = { upgrade: "websocket" }) => new Request("https://dovre.example.dev/bridge", { headers: { "cf-access-jwt-assertion": jwt, ...extra } });
  const bindings = { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, HUB, BRIDGE_CLIENT_ID: "abc123.access", BRIDGE_KEY: "k".repeat(40) };
  try {
    assert.equal((await worker.fetch(new Request("https://dovre.example.dev/todo", { headers: { "cf-access-jwt-assertion": await token("abc123.access") } }), bindings)).status, 404, "the bridge's token opens no page");
    assert.equal((await worker.fetch(upgrade(person), bindings)).status, 404, "a person's token isn't the bridge");
    assert.equal((await worker.fetch(upgrade(await token("other.access")), bindings)).status, 404, "another service token");
    assert.equal((await worker.fetch(upgrade(await token("abc123.access"), {}), bindings)).status, 404, "not a socket");
    assert.equal(handed.length, 0);
    for (const off of [{ BRIDGE_KEY: undefined }, { BRIDGE_KEY: "short" }, { BRIDGE_CLIENT_ID: undefined }]) {
      resetHostedApp();
      assert.equal((await worker.fetch(upgrade(await token("abc123.access")), { ...bindings, ...off })).status, 404, `not set up: ${JSON.stringify(off)}`);
    }
    resetHostedApp();
    assert.equal(await (await worker.fetch(upgrade(await token("abc123.access")), bindings)).text(), "to the hub");
    assert.equal(handed.length, 1);
    assert.equal(new URL(handed[0]!.url).pathname, "/bridge");
    assert.equal(handed[0]!.headers.get("upgrade"), "websocket");

    // A person's page: the agents are the Mac's, and it says when the Mac is away.
    const agents = await worker.fetch(new Request("https://dovre.example.dev/agents", { headers: { "cf-access-jwt-assertion": person } }), bindings);
    assert.equal(agents.status, 200);
    assert.match(await agents.text(), /Your Mac is offline, last seen 3 h ago/);
  } finally {
    globalThis.fetch = realFetch;
    resetHostedApp();
  }
});
