/**
 * Who gets in (src/access.ts, PLAN D16): local mode by localhost and the launch cookie only;
 * hosted mode by a Cloudflare Access token whose signature, issuer, audience and expiry check out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { accessConfigOf, allowed, createAccessVerifier, operatorOf } from "../src/access.ts";
import worker, { createWorker, resetHostedApp } from "../src/worker.ts";
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

test("another issuer (AUTH_ISSUER): it wins over Access, must be https, and a half-set one lets nobody in", () => {
  const iss = "https://login.example.dev";
  assert.deepEqual(accessConfigOf({ AUTH_ISSUER: iss, AUTH_AUD: "t-alice" }), { issuer: iss, jwksUrl: `${iss}/.well-known/jwks.json`, aud: "t-alice", allowedEmails: [] });
  assert.equal(accessConfigOf({ AUTH_ISSUER: `${iss}/`, AUTH_AUD: "a" })?.jwksUrl, `${iss}/.well-known/jwks.json`);
  assert.equal(accessConfigOf({ AUTH_ISSUER: iss, AUTH_AUD: "a", AUTH_JWKS_URL: "https://keys.example.dev/k.json" })?.jwksUrl, "https://keys.example.dev/k.json");
  const access = { CF_ACCESS_TEAM: "t", CF_ACCESS_AUD: "a" };
  assert.equal(accessConfigOf({ ...access, AUTH_ISSUER: iss, AUTH_AUD: "x" })?.issuer, iss, "wins over Access");
  for (const [why, env] of [
    ["no audience", { AUTH_ISSUER: iss }],
    ["http issuer", { AUTH_ISSUER: "http://login.example.dev", AUTH_AUD: "a" }],
    ["not a URL", { AUTH_ISSUER: "login.example.dev", AUTH_AUD: "a" }],
    ["http keys", { AUTH_ISSUER: iss, AUTH_AUD: "a", AUTH_JWKS_URL: "http://keys.example.dev/k.json" }],
    ["credentials in the URL", { AUTH_ISSUER: "https://u:p@login.example.dev", AUTH_AUD: "a" }],
  ] as const) assert.equal(accessConfigOf({ ...access, ...env }), undefined, `${why}: shut, never Access instead`);
});

test("another issuer: its keys from its JWKS URL, and only its own iss and aud", async () => {
  const iss = "https://login.example.dev";
  const k = await keyPair("d1");
  const { fetchFn, calls } = certsServer(() => [k.jwk]);
  const verify = createAccessVerifier({ issuer: iss, jwksUrl: `${iss}/.well-known/jwks.json`, aud: "t-alice", allowedEmails: ["me@example.dev"], fetchFn, now });
  const mine = { iss, aud: "t-alice", email: "me@example.dev", exp: NOW + 60 };
  assert.deepEqual(await verify(req(await k.sign(mine))), { email: "me@example.dev" });
  assert.equal(calls[0], `${iss}/.well-known/jwks.json`);
  assert.equal(await verify(req(await k.sign({ ...mine, aud: "t-bob" }))), undefined, "another tenant's token");
  assert.equal(await verify(req(await k.sign({ ...mine, iss: ISS }))), undefined, "Access's issuer");
  assert.equal(await verify(req(await k.sign({ ...mine, iss: `${iss}/` }))), undefined, "iss must match exactly");
  assert.equal(await verify(req(await k.sign({ ...mine, email: "else@example.dev" }))), undefined, "not on the list");
  assert.equal(await createAccessVerifier({ aud: "a", fetchFn })(req(await k.sign(mine))), undefined, "neither team nor issuer: nobody");
});

test("worker: with AUTH_ISSUER set, the setup gate opens and its tokens get in", async () => {
  resetHostedApp();
  const iss = "https://login.example.dev";
  const k = await keyPair("d1");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url) === `${iss}/.well-known/jwks.json` ? new Response(JSON.stringify({ keys: [k.jwk] })) : realFetch(url)) as typeof fetch;
  try {
    const bindings = { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", AUTH_ISSUER: iss, AUTH_AUD: "t-alice", ALLOWED_EMAILS: "me@example.dev" };
    const jwt = await k.sign({ iss, aud: "t-alice", email: "me@example.dev", exp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal((await worker.fetch(new Request("https://alice.example.dev/todo", { headers: { "cf-access-jwt-assertion": jwt } }), bindings)).status, 200);
    resetHostedApp();
    const res = await worker.fetch(new Request("https://alice.example.dev/todo"), bindings);
    assert.notEqual(res.status, 200, "no token: refused");
    assert.doesNotMatch(await res.text(), /isn't set up yet/, "but it is set up");
    resetHostedApp();
    assert.match(await (await worker.fetch(new Request("https://alice.example.dev/todo"), { ...bindings, AUTH_ISSUER: "http://login.example.dev" })).text(), /isn't set up yet/, "an http issuer: the setup page");
  } finally {
    globalThis.fetch = realFetch;
    resetHostedApp();
  }
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

test("worker: an instance's GitHub token provider wins over GITHUB_TOKEN, is asked with the bindings, and its failure shows on the page", async () => {
  const k = await keyPair("k1");
  const realFetch = globalThis.fetch;
  const auth: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === `${ISS}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [k.jwk] }));
    auth.push(new Request(url, init).headers.get("authorization") ?? "");
    return new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } }));
  }) as typeof fetch;
  let broken = false;
  const asked: unknown[] = [];
  const w = createWorker({ githubToken: async (b) => { asked.push(b.TOKEN_KEY); if (broken) throw new Error("GitHub is disconnected: reconnect it"); return "brokered"; } });
  const page = async () => {
    w.reset();
    const headers = { "cf-access-jwt-assertion": await k.sign({ ...good, exp: Math.floor(Date.now() / 1000) + 3600 }) };
    const res = await w.fetch(new Request("https://dovre.example.dev/prs", { headers }), { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, GITHUB_TOKEN: "static", TOKEN_KEY: "k" });
    assert.equal(res.status, 200);
    return res.text();
  };
  try {
    assert.doesNotMatch(await page(), /didn't load/);
    assert.ok(auth.length > 0 && auth.every((a) => a === "Bearer brokered"), auth.join());
    assert.equal(asked[0], "k");
    broken = true;
    assert.match(await page(), /didn't load\.<\/strong> GitHub is disconnected: reconnect it/);
  } finally {
    globalThis.fetch = realFetch;
    w.reset();
  }
});

test("worker: a person's POST goes to GitHub with their own token; pages and the gather it starts use the instance's", async () => {
  const k = await keyPair("k1");
  const realFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; auth: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === `${ISS}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [k.jwk] }));
    const r = new Request(url, init);
    const path = new URL(r.url).pathname;
    calls.push({ path, method: r.method, auth: r.headers.get("authorization") ?? "" });
    if (path.endsWith("/pending_deployments") && r.method === "GET") return Response.json([{ current_user_can_approve: true, environment: { id: 7, name: "prod" } }]);
    if (path.endsWith("/pending_deployments")) return Response.json([]);
    return new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } }));
  }) as typeof fetch;
  const w = createWorker({ githubToken: async (_b, actor) => (actor ? `as-${actor.email}` : "instance") });
  const bindings = { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD };
  const jwt = await k.sign({ ...good, email: "Per@Example.dev", exp: Math.floor(Date.now() / 1000) + 3600 });
  const later: Promise<unknown>[] = [];
  try {
    w.reset();
    const page = await w.fetch(new Request("https://dovre.example.dev/deploys", { headers: { "cf-access-jwt-assertion": jwt } }), bindings);
    assert.equal(page.status, 200);
    assert.ok(calls.length && calls.every((c) => c.auth === "Bearer instance"), "a page reads as the instance");
    calls.length = 0;
    const res = await w.fetch(
      new Request("https://dovre.example.dev/deploys/approve", { method: "POST", body: new URLSearchParams({ repo: "dovre-user/app", run: "42" }), headers: { "cf-access-jwt-assertion": jwt, origin: "https://dovre.example.dev" } }),
      bindings,
      { waitUntil: (p) => void later.push(p) },
    );
    assert.equal(res.status, 303);
    await Promise.allSettled(later);
    const writes = calls.filter((c) => c.path.startsWith("/repos/dovre-user/app/actions/runs/42/"));
    assert.deepEqual(writes.map((c) => `${c.method} ${c.auth}`), ["GET Bearer as-per@example.dev", "POST Bearer as-per@example.dev"]);
    const rest = calls.filter((c) => !writes.includes(c));
    assert.ok(rest.length && rest.every((c) => c.auth === "Bearer instance"), `the gather the action started: ${rest.map((c) => c.auth).join()}`);
  } finally {
    globalThis.fetch = realFetch;
    w.reset();
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
        if (new URL(q.url).pathname === "/mac") return Response.json({ watching: false, machines: [{ id: "mac", online: false, seen: Date.now() - 3 * 3600e3 }] });
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
    assert.equal(await (await worker.fetch(upgrade(await token("abc123.access"), { upgrade: "websocket", "x-dovre-machine": "0123456789abcdef" }), bindings)).text(), "to the hub");
    assert.equal(handed.length, 1);
    assert.equal(new URL(handed[0]!.url).pathname, "/bridge");
    assert.equal(handed[0]!.headers.get("upgrade"), "websocket");
    assert.equal(handed[0]!.headers.get("x-dovre-machine"), "mac", "Access's token is the Mac; what the request said is replaced");

    // A person's page: the agents are the Mac's, and it says when the Mac is away.
    const agents = await worker.fetch(new Request("https://dovre.example.dev/agents", { headers: { "cf-access-jwt-assertion": person } }), bindings);
    assert.equal(agents.status, 200);
    assert.match(await agents.text(), /Your Mac is offline, last seen 3 h ago/);
  } finally {
    globalThis.fetch = realFetch;
    resetHostedApp();
  }
});

test("H6: a machine an issuer names (its `service` claim) is never a person, and /bridge takes it as that machine", async () => {
  const iss = "https://dovre.example.dev";
  const k = await keyPair("d1");
  const { fetchFn } = certsServer(() => [k.jwk]);
  const verify = createAccessVerifier({ issuer: iss, aud: "t-alice", allowedEmails: ["me@example.dev"], fetchFn, now });
  const machine = { iss, aud: "t-alice", service: "0123456789abcdef", exp: NOW + 600 };
  assert.deepEqual(await verify(req(await k.sign(machine))), { service: "0123456789abcdef", machine: true });
  assert.deepEqual(await verify(req(await k.sign({ ...machine, email: "me@example.dev" }))), { service: "0123456789abcdef", machine: true }, "a machine's token is a machine's, whatever else it says");
  for (const bad of ["mac", "../x", "0123", "0123456789ABCDEF", 42, ""]) assert.equal(await verify(req(await k.sign({ ...machine, service: bad }))), undefined, `service ${JSON.stringify(bad)}`);
  assert.equal(await verify(req(await k.sign({ ...machine, aud: "t-bob" }))), undefined, "another tenant's machine");

  resetHostedApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url) === `${iss}/.well-known/jwks.json` ? new Response(JSON.stringify({ keys: [k.jwk] })) : realFetch(url)) as typeof fetch;
  const handed: Request[] = [];
  const HUB = { idFromName: () => "hub", get: () => ({ fetch: async (r: Request | string) => (handed.push(new Request(r)), new Response("to the hub")) }) };
  const exp = Math.floor(Date.now() / 1000) + 600;
  const bindings = { DB: mockD1(), GITHUB_USER: "dovre-user", IS_HOSTED: "1", AUTH_ISSUER: iss, AUTH_AUD: "t-alice", ALLOWED_EMAILS: "me@example.dev", HUB, BRIDGE_KEY: "k".repeat(40) };
  const jwt = await k.sign({ ...machine, exp });
  const upgrade = (j: string) => new Request("https://alice.example.dev/bridge", { headers: { "cf-access-jwt-assertion": j, upgrade: "websocket", "x-dovre-machine": "mac" } });
  try {
    assert.equal((await worker.fetch(new Request("https://alice.example.dev/todo", { headers: { "cf-access-jwt-assertion": jwt } }), bindings)).status, 404, "a machine opens no page");
    assert.equal((await worker.fetch(upgrade(jwt), bindings)).status, 200);
    assert.equal(handed[0]?.headers.get("x-dovre-machine"), "0123456789abcdef", "the machine its token names, not the one it said");
    resetHostedApp();
    assert.equal((await worker.fetch(upgrade(jwt), { ...bindings, BRIDGE_KEY: undefined })).status, 404, "no BRIDGE_KEY: no bridge");
    resetHostedApp();
    assert.equal((await worker.fetch(upgrade(await k.sign({ iss, aud: "t-alice", email: "me@example.dev", exp })), bindings)).status, 404, "a person isn't a machine");
    assert.equal(handed.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    resetHostedApp();
  }
});
