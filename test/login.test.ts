/**
 * #522: the built-in login. A made-up authenticator with real WebCrypto keys makes and uses
 * passkeys; every check a browser's answer must pass is tried with that check broken.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { addressOf, claimSql, createLogin, hashOf, mintClaim, SESSION_COOKIE } from "../src/hosted/login/login.ts";
import { b64url, cborDecode, derToRaw, ES256, RS256, verifyAssertion, verifyRegistration } from "../src/hosted/login/webauthn.ts";
import { DIAL_HEADER, dialProof, dialProofOk } from "../src/bridge/wire.ts";
import { bridgeIn, createWorker } from "../src/worker.ts";

const ORIGIN = "https://home.me.workers.dev";
const RP = "home.me.workers.dev";

// ── a made-up authenticator ──

function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return Uint8Array.from([...head(3, b.length), ...b]);
  }
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (v instanceof Map) return Uint8Array.from([...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])]);
  throw new Error("cbor: unsupported");
}
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const cat = (...xs: Uint8Array[]) => Uint8Array.from(xs.flatMap((x) => [...x]));
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let v = [...x];
    while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.slice(1);
    if (v[0]! & 0x80) v = [0, ...v];
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

async function authenticator(o: { alg?: number; rp?: string; flags?: number } = {}) {
  const rsa = o.alg === RS256;
  const kp = rsa
    ? await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const b = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));
  const cose = rsa ? new Map<number, unknown>([[1, 3], [3, RS256], [-1, b(jwk.n!)], [-2, b(jwk.e!)]]) : new Map<number, unknown>([[1, 2], [3, ES256], [-1, 1], [-2, b(jwk.x!)], [-3, b(jwk.y!)]]);
  const credId = crypto.getRandomValues(new Uint8Array(32));
  let count = 0;
  const authData = async (attested: boolean, flags = o.flags ?? 0x05) => {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, count);
    const head = cat(await sha(new TextEncoder().encode(o.rp ?? RP)), Uint8Array.of(flags | (attested ? 0x40 : 0)), c);
    return attested ? cat(head, new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cbor(cose)) : head;
  };
  const clientData = (type: string, challenge: string, origin = ORIGIN) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64url(credId),
    async create(challenge: string, x: { origin?: string; type?: string } = {}) {
      return { clientDataJSON: b64url(clientData(x.type ?? "webauthn.create", challenge, x.origin)), attestationObject: b64url(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", await authData(true)]]))) };
    },
    async get(challenge: string, x: { origin?: string; tamper?: boolean; count?: number } = {}) {
      count = x.count ?? count + 1;
      const ad = await authData(false);
      const cd = clientData("webauthn.get", challenge, x.origin);
      const signed = cat(ad, await sha(cd));
      let sig: Uint8Array = new Uint8Array(rsa ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, signed) : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, signed));
      if (!rsa) sig = rawToDer(sig);
      if (x.tamper) sig[sig.length - 1]! ^= 1;
      return { clientDataJSON: b64url(cd), authenticatorData: b64url(ad), signature: b64url(sig) };
    },
  };
}

const E = { challenge: "c".repeat(43), origin: ORIGIN, rpId: RP };

test("webauthn: an ES256 and an RS256 passkey made and used; each broken check refused", async () => {
  for (const alg of [ES256, RS256]) {
    const a = await authenticator({ alg });
    const made = await verifyRegistration(await a.create(E.challenge), E);
    assert.equal(made.id, a.id);
    assert.equal(made.alg, alg);
    const used = await verifyAssertion(await a.get(E.challenge), E, made);
    assert.equal(used.signCount, 1);
    await assert.rejects(verifyAssertion(await a.get(E.challenge, { tamper: true }), E, made), /signature/, `${alg}: tampered`);
  }
  const a = await authenticator();
  const refusedMake: [string, () => Promise<unknown>][] = [
    ["another challenge", async () => verifyRegistration(await a.create("x".repeat(43)), E)],
    ["another origin", async () => verifyRegistration(await a.create(E.challenge, { origin: "https://evil.example" }), E)],
    ["a get, not a create", async () => verifyRegistration(await a.create(E.challenge, { type: "webauthn.get" }), E)],
    ["another site's key", async () => verifyRegistration(await (await authenticator({ rp: "evil.example" })).create(E.challenge), E)],
    ["nobody present", async () => verifyRegistration(await (await authenticator({ flags: 0x04 })).create(E.challenge), E)],
    ["not verified", async () => verifyRegistration(await (await authenticator({ flags: 0x01 })).create(E.challenge), E)],
    ["garbage", async () => verifyRegistration({ clientDataJSON: b64url(new TextEncoder().encode("{}")), attestationObject: "AAAA" }, E)],
    ["not base64url", async () => verifyRegistration({ clientDataJSON: "<script>", attestationObject: 7 }, E)],
  ];
  for (const [why, f] of refusedMake) await assert.rejects(f(), Error, why);
  const made = await verifyRegistration(await a.create(E.challenge), E);
  await assert.rejects(verifyAssertion(await a.get(E.challenge, { origin: "https://evil.example" }), E, made), /origin/);
  await assert.rejects(verifyAssertion(await a.get(E.challenge, { count: 5 }), E, { ...made, signCount: 9 }), /counter/);
  assert.throws(() => cborDecode(Uint8Array.of(0x9f)), /unsupported/);
  assert.throws(() => cborDecode(Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff)), /short/);
  assert.throws(() => derToRaw(Uint8Array.of(0x30, 2, 2, 0)), /DER/);
});

// ── the flow ──

function client(login: ReturnType<typeof createLogin>, origin = ORIGIN) {
  const jar = new Map<string, string>();
  const send = async (path: string, body?: unknown, x: { origin?: string; type?: string; raw?: string } = {}) => {
    const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (body !== undefined || x.raw !== undefined) {
      headers.origin = x.origin ?? origin;
      headers["content-type"] = x.type ?? "application/json";
    }
    const res = (await login.handle(new Request(`${origin}${path}`, { method: body !== undefined || x.raw !== undefined ? "POST" : "GET", headers, body: x.raw ?? (body === undefined ? undefined : JSON.stringify(body)) })))!;
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const v = kv!.slice(i + 1);
      if (v) jar.set(kv!.slice(0, i), v);
      else jar.delete(kv!.slice(0, i));
    }
    return res;
  };
  const page = (path = "/") => new Request(`${origin}${path}`, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  return { jar, send, page };
}

async function claim(c: ReturnType<typeof client>, a: Awaited<ReturnType<typeof authenticator>>, code: string) {
  const o = (await (await c.send("/_auth/options", { kind: "claim", code })).json()) as { publicKey: { challenge: string; user: { name: string } } };
  return c.send("/_auth/finish", { response: await a.create(o.publicKey.challenge), name: "Mac<script>" });
}
async function signIn(c: ReturnType<typeof client>, a: Awaited<ReturnType<typeof authenticator>>) {
  const o = (await (await c.send("/_auth/options", { kind: "login" })).json()) as { publicKey: { challenge: string } };
  return c.send("/_auth/finish", { id: a.id, response: await a.get(o.publicKey.challenge) });
}

test("login: a claim link makes a passkey once; it signs in; sign out ends it; a removed email or passkey ends its sessions", async () => {
  const { DB } = openDb();
  let t = Date.parse("2026-11-13T12:00:00Z");
  const login = createLogin({ db: DB, allowedEmails: ["Me@x.dev"], now: () => t });
  const code = await mintClaim(DB, "Me@x.dev", t);
  const a = await authenticator();
  const c = client(login);
  assert.equal(await login.verify(c.page()), undefined);

  const made = await claim(c, a, code);
  assert.equal(made.status, 200, await made.clone().text());
  assert.ok(c.jar.has(SESSION_COOKIE));
  assert.deepEqual(await login.verify(c.page()), { email: "me@x.dev" });
  const row = await DB.prepare("SELECT name FROM login_passkeys").first<{ name: string }>();
  assert.equal(row?.name, "Macscript", "only letters, digits and a few marks");

  // The link again, from anyone: spent.
  const again = await (await client(login).send("/_auth/options", { kind: "claim", code })).json();
  assert.equal(again.ok, false);

  // A fresh browser signs in with the passkey.
  const c2 = client(login);
  assert.equal((await signIn(c2, a)).status, 200);
  assert.deepEqual(await login.verify(c2.page()), { email: "me@x.dev" });
  // A challenge is good once.
  const o = (await (await c2.send("/_auth/options", { kind: "login" })).json()) as { publicKey: { challenge: string } };
  const resp = await a.get(o.publicKey.challenge);
  assert.equal((await c2.send("/_auth/finish", { id: a.id, response: resp })).status, 200);
  assert.equal((await c2.send("/_auth/finish", { id: a.id, response: resp })).status, 400, "replayed");

  // Sign out: that session ends, the other stays.
  const out = await c2.send("/_auth/logout", undefined, { raw: "" });
  assert.equal(out.status, 303);
  assert.equal(await login.verify(c2.page()), undefined);
  assert.deepEqual(await login.verify(c.page()), { email: "me@x.dev" });

  // An email no longer allowed: its sessions are worth nothing.
  const narrower = createLogin({ db: DB, allowedEmails: ["other@x.dev"], now: () => t });
  assert.equal(await narrower.verify(c.page()), undefined);
  // Thirty days on: expired.
  t += 31 * 86_400_000;
  assert.equal(await createLogin({ db: DB, now: () => t }).verify(c.page()), undefined);
  t -= 31 * 86_400_000;
  // A passkey removed: its sessions too.
  await DB.prepare("DELETE FROM login_passkeys").run();
  assert.equal(await createLogin({ db: DB, now: () => t }).verify(c.page()), undefined);
});

test("login: an expired link, another site's form, a stranger's passkey, odd bodies, and too many tries are refused", async () => {
  const { DB } = openDb();
  let t = Date.parse("2026-11-13T12:00:00Z");
  const login = createLogin({ db: DB, now: () => t });
  const old = await mintClaim(DB, "me@x.dev", t);
  t += 25 * 3_600_000;
  assert.equal((await client(login).send("/_auth/options", { kind: "claim", code: old })).status, 403, "a day old");

  const code = await mintClaim(DB, "me@x.dev", t);
  const c = client(login);
  assert.equal((await c.send("/_auth/options", { kind: "claim", code }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await c.send("/_auth/options", { kind: "claim", code }, { type: "text/plain" })).status, 403, "not JSON");
  for (const raw of ["[]", "null", "{", "x".repeat(70_000), JSON.stringify({ kind: "claim", code: "'; DROP TABLE login_claims; --" }), JSON.stringify({ kind: "admin" })]) {
    const r = await c.send("/_auth/options", undefined, { raw });
    assert.ok(r.status >= 400, raw.slice(0, 30));
  }
  assert.equal((await c.send("/_auth/finish", { response: {} })).status, 400, "no challenge");
  assert.equal((await client(login).send("/_auth/nope")).status, 404);
  assert.equal(await login.handle(new Request(`${ORIGIN}/prs`)), undefined, "not ours");

  // A passkey that isn't this Dovre's.
  const stranger = await authenticator();
  assert.equal((await signIn(client(login), stranger)).status, 403);

  // Pages carry nothing from the request.
  const html = await (await client(login).send("/_auth/claim?x=<script>alert(1)</script>")).text();
  assert.doesNotMatch(html, /alert/);

  // Twenty tries in ten minutes from one address, then a wait.
  const flood = createLogin({ db: openDb().DB, now: () => t });
  const f = client(flood);
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await f.send("/_auth/options", { kind: "login" })).status;
  assert.equal(last, 429);
  t += 11 * 60_000;
  assert.equal((await f.send("/_auth/options", { kind: "login" })).status, 200);
});

test("login: provision's SQL stores only the code's hash", async () => {
  const { code, sql } = await claimSql("Me@x.dev", 1000);
  assert.ok(!sql.includes(code));
  assert.ok(sql.includes(await hashOf(code)));
  assert.match(sql, /'me@x\.dev', 86401000\);$/);
  await assert.rejects(claimSql("x'); DROP TABLE x; --@y.z"), /isn't an email/);
  const { DB } = openDb();
  await DB.prepare(sql).run();
  assert.equal((await DB.prepare("SELECT email FROM login_claims").first<{ email: string }>())?.email, "me@x.dev");
});

test("worker, AUTH_MODE=passkey: no Access needed; a page without a session goes to sign-in; with one it draws", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } }))) as typeof fetch;
  const w = createWorker();
  const { DB } = openDb();
  const bindings = { DB, IS_HOSTED: "1", AUTH_MODE: "passkey", ALLOWED_EMAILS: "me@x.dev", GITHUB_USER: "me", GITHUB_TOKEN: "t" };
  try {
    const anon = await w.fetch(new Request(`${ORIGIN}/prs`, { headers: { accept: "text/html" } }), bindings as never);
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get("location"), "/_auth/login");
    assert.equal((await w.fetch(new Request(`${ORIGIN}/prs`, { method: "POST", headers: { origin: ORIGIN } }), bindings as never)).status, 404);
    assert.equal((await w.fetch(new Request(`${ORIGIN}/_auth/login`), bindings as never)).status, 200);

    const login = createLogin({ db: DB });
    const c = client(login);
    assert.equal((await claim(c, await authenticator(), await mintClaim(DB, "me@x.dev"))).status, 200);
    const page = await w.fetch(new Request(`${ORIGIN}/`, { headers: { accept: "text/html", cookie: c.page().headers.get("cookie")! } }), bindings as never);
    assert.equal(page.headers.get("location"), "/welcome", "past sign-in: the app's own first-run page");
    const welcome = await w.fetch(new Request(`${ORIGIN}/welcome`, { headers: { accept: "text/html", cookie: c.page().headers.get("cookie")! } }), bindings as never);
    assert.equal(welcome.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    w.reset();
  }
});

test("bridge without Access: the dial proves BRIDGE_KEY before the hub sees it; stale, forged or missing proofs are turned away", async () => {
  const key = "k".repeat(40);
  const handed: Request[] = [];
  const h = { hub: { bridge: async (q: Request) => (handed.push(q), new Response("to the hub")) }, verify: async () => undefined, login: {} as never } as unknown as Parameters<typeof bridgeIn>[2];
  const dial = (proof?: string, extra: Record<string, string> = {}) =>
    bridgeIn(new Request(`${ORIGIN}/bridge`, { headers: { upgrade: "websocket", "x-dovre-machine": "0123456789abcdef", "x-dovre-owner": "evil@x.dev", ...(proof ? { [DIAL_HEADER]: proof } : {}), ...extra } }), { BRIDGE_KEY: key }, h);
  const now = Date.now();
  const refused: [string, string | undefined][] = [
    ["none", undefined],
    ["another key", await dialProof("z".repeat(40), now)],
    ["three minutes old", await dialProof(key, now - 3 * 60_000)],
    ["garbage", "1.2.3"],
    ["tampered", (await dialProof(key, now)).replace(/.$/, (c) => (c === "0" ? "1" : "0"))],
  ];
  for (const [why, proof] of refused) assert.equal((await dial(proof)).status, 404, why);
  assert.equal(handed.length, 0);
  assert.equal(await (await dial(await dialProof(key))).text(), "to the hub");
  assert.equal(handed[0]!.headers.get("x-dovre-machine"), "mac", "the machine is ours to say");
  assert.equal(handed[0]!.headers.get("x-dovre-owner"), null);
  assert.equal((await bridgeIn(new Request(`${ORIGIN}/bridge`, { headers: { upgrade: "websocket", [DIAL_HEADER]: await dialProof(key) } }), { BRIDGE_KEY: "short" }, h)).status, 404, "no real key");
  assert.equal(await dialProofOk(undefined, await dialProof(key)), false);
});

test("login: user verification is required, a link isn't spent on a passkey already here, and one count signs in once", async () => {
  const { DB } = openDb();
  const t = Date.parse("2026-11-13T12:00:00Z");
  const login = createLogin({ db: DB, now: () => t });
  const o = (await (await client(login).send("/_auth/options", { kind: "login" })).json()) as { publicKey: { userVerification: string } };
  assert.equal(o.publicKey.userVerification, "required");

  // A key with no PIN (present, not verified) can't sign in, even once it's here.
  const a = await authenticator();
  assert.equal((await claim(client(login), a, await mintClaim(DB, "me@x.dev", t))).status, 200);
  const noPin = await authenticator({ flags: 0x01 });
  assert.equal((await claim(client(login), noPin, await mintClaim(DB, "me@x.dev", t))).status, 403);
  const flags = { flags: 0x05 };
  const lapsed = await authenticator(flags);
  assert.equal((await claim(client(login), lapsed, await mintClaim(DB, "me@x.dev", t))).status, 200);
  flags.flags = 0x01; // the same key, now signing without its PIN (validly signed)
  assert.equal((await signIn(client(login), lapsed)).status, 403);
  flags.flags = 0x05;
  assert.equal((await signIn(client(login), lapsed)).status, 200);

  // The same passkey again: 409, and the link still works for a new one.
  const code = await mintClaim(DB, "me@x.dev", t);
  assert.equal((await claim(client(login), a, code)).status, 409);
  assert.equal((await claim(client(login), await authenticator(), code)).status, 200, "the link wasn't spent");

  // A counting key: two uses with the same count, sent together: one signs in.
  const k = await authenticator();
  assert.equal((await claim(client(login), k, await mintClaim(DB, "me@x.dev", t))).status, 200);
  const [c1, c2] = [client(login), client(login)];
  const [o1, o2] = await Promise.all([c1, c2].map(async (c) => ((await (await c.send("/_auth/options", { kind: "login" })).json()) as { publicKey: { challenge: string } }).publicKey.challenge));
  const r1 = await k.get(o1!, { count: 7 });
  const r2 = await k.get(o2!, { count: 7 });
  const st = await Promise.all([c1.send("/_auth/finish", { id: k.id, response: r1 }), c2.send("/_auth/finish", { id: k.id, response: r2 })]);
  assert.deepEqual(st.map((r) => r.status).sort(), [200, 403]);
});

test("login: expired challenges and sessions are swept; an IPv6 /64 counts as one address", async () => {
  const { DB } = openDb();
  let t = Date.parse("2026-11-13T12:00:00Z");
  const login = createLogin({ db: DB, now: () => t });
  for (let i = 0; i < 5; i++) await client(login).send("/_auth/options", { kind: "login" });
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM login_challenges").first<{ n: number }>())?.n, 5);
  await DB.prepare("INSERT INTO login_sessions (hash, email, passkey, expires_at) VALUES ('h', 'me@x.dev', 'p', ?)").bind(t + 1000).run();
  t += 10 * 60_000;
  await client(login).send("/_auth/options", { kind: "login" });
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM login_challenges").first<{ n: number }>())?.n, 1, "only the new one");
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM login_sessions").first<{ n: number }>())?.n, 0);

  const at = (ip: string) => addressOf(new Request(ORIGIN, { headers: { "cf-connecting-ip": ip } }));
  assert.equal(at("2001:db8:0:1::5"), at("2001:0db8:0000:0001:ffff:1:2:3"));
  assert.notEqual(at("2001:db8:0:1::5"), at("2001:db8:0:2::5"));
  assert.equal(at("::1"), "0:0:0:0::/64");
  assert.equal(at("203.0.113.9"), "203.0.113.9");
  assert.equal(addressOf(new Request(ORIGIN)), "?");
});
