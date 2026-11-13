/**
 * WebAuthn for the built-in login (#522), on WebCrypto alone: a passkey made (registration, attestation
 * "none": we trust the key, not the device maker) and a passkey used (an assertion). ES256 (P-256) and
 * RS256 keys. Everything a browser sends is hostile until it has passed every check here.
 */

export const ES256 = -7;
export const RS256 = -257;

// ── bytes ──

export const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function fromB64url(s: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof s !== "string" || s.length > 16384 || !/^[A-Za-z0-9_-]*$/.test(s)) return undefined;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}
const sha256 = async (b: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── CBOR: the subset an attestation object and a COSE key use ──

type Cbor = number | bigint | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | boolean | null | undefined;

/** Decodes one CBOR item at `at`. Throws on anything malformed, too deep or too long. */
export function cborDecode(buf: Uint8Array, at = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 8) throw new Error("cbor: too deep");
  const need = (n: number) => {
    if (at + n > buf.length) throw new Error("cbor: short");
  };
  need(1);
  const first = buf[at++]!;
  const major = first >> 5;
  const info = first & 31;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) (need(1), (len = buf[at]!), (at += 1));
  else if (info === 25) (need(2), (len = (buf[at]! << 8) | buf[at + 1]!), (at += 2));
  else if (info === 26) (need(4), (len = ((buf[at]! << 24) >>> 0) + (buf[at + 1]! << 16) + (buf[at + 2]! << 8) + buf[at + 3]!), (at += 4));
  else throw new Error("cbor: unsupported length");
  switch (major) {
    case 0:
      return { value: len, end: at };
    case 1:
      return { value: -1 - len, end: at };
    case 2:
      need(len);
      return { value: buf.slice(at, at + len), end: at + len };
    case 3:
      need(len);
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(buf.slice(at, at + len)), end: at + len };
    case 4: {
      if (len > 64) throw new Error("cbor: array too long");
      const arr: Cbor[] = [];
      for (let i = 0; i < len; i++) {
        const r = cborDecode(buf, at, depth + 1);
        arr.push(r.value);
        at = r.end;
      }
      return { value: arr, end: at };
    }
    case 5: {
      if (len > 64) throw new Error("cbor: map too long");
      const m = new Map<Cbor, Cbor>();
      for (let i = 0; i < len; i++) {
        const k = cborDecode(buf, at, depth + 1);
        const v = cborDecode(buf, k.end, depth + 1);
        m.set(k.value, v.value);
        at = v.end;
      }
      return { value: m, end: at };
    }
    case 7:
      if (info === 20) return { value: false, end: at };
      if (info === 21) return { value: true, end: at };
      if (info === 22) return { value: null, end: at };
      throw new Error("cbor: unsupported simple value");
    default:
      throw new Error("cbor: unsupported type");
  }
}

// ── authenticator data ──

type AuthData = { rpIdHash: Uint8Array; up: boolean; uv: boolean; signCount: number; credId?: Uint8Array; coseKey?: Map<Cbor, Cbor> };

function parseAuthData(d: Uint8Array): AuthData {
  if (d.length < 37) throw new Error("authData: short");
  const flags = d[32]!;
  const out: AuthData = { rpIdHash: d.slice(0, 32), up: !!(flags & 0x01), uv: !!(flags & 0x04), signCount: new DataView(d.buffer, d.byteOffset + 33, 4).getUint32(0) };
  if (flags & 0x40) {
    if (d.length < 55) throw new Error("authData: short attested data");
    const n = (d[53]! << 8) | d[54]!;
    if (n < 16 || n > 1023 || d.length < 55 + n) throw new Error("authData: bad credential id");
    out.credId = d.slice(55, 55 + n);
    const key = cborDecode(d, 55 + n).value;
    if (!(key instanceof Map)) throw new Error("authData: no key");
    out.coseKey = key;
  }
  return out;
}

/** A COSE key as a JWK we can import, and its algorithm. Only ES256 on P-256 and RS256. */
export function coseToJwk(k: Map<Cbor, Cbor>): { jwk: JsonWebKey; alg: number } {
  const kty = k.get(1);
  const alg = k.get(3);
  const bytes = (v: Cbor) => {
    if (!(v instanceof Uint8Array)) throw new Error("cose: missing coordinate");
    return v;
  };
  if (kty === 2 && alg === ES256 && k.get(-1) === 1) {
    const x = bytes(k.get(-2));
    const y = bytes(k.get(-3));
    if (x.length !== 32 || y.length !== 32) throw new Error("cose: bad P-256 point");
    return { jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y), ext: true }, alg: ES256 };
  }
  if (kty === 3 && alg === RS256) {
    const n = bytes(k.get(-1));
    if (n.length < 256) throw new Error("cose: RSA key too small");
    return { jwk: { kty: "RSA", n: b64url(n), e: b64url(bytes(k.get(-2))), alg: "RS256", ext: true }, alg: RS256 };
  }
  throw new Error("cose: unsupported key");
}

const importKey = (jwk: JsonWebKey, alg: number) =>
  alg === ES256 ? crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) : crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);

/** An ECDSA signature as WebAuthn sends it (DER) in the raw r‖s form WebCrypto checks. */
export function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const fail = () => {
    throw new Error("signature: bad DER");
  };
  if (der[0] !== 0x30 || der.length < 8 || der[1] !== der.length - 2) fail();
  let at = 2;
  const int = () => {
    if (der[at] !== 0x02) fail();
    const n = der[at + 1]!;
    if (n < 1 || n > 33 || at + 2 + n > der.length) fail();
    let v = der.slice(at + 2, at + 2 + n);
    at += 2 + n;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) fail();
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (at !== der.length) fail();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

// ── client data ──

async function checkClientData(raw: Uint8Array<ArrayBuffer>, type: string, challenge: string, origin: string): Promise<void> {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("clientData: not JSON");
  }
  if (c.type !== type) throw new Error("clientData: wrong type");
  if (typeof c.challenge !== "string" || c.challenge !== challenge) throw new Error("clientData: wrong challenge");
  if (c.origin !== origin) throw new Error("clientData: wrong origin");
  if (c.crossOrigin === true) throw new Error("clientData: cross-origin");
}

export type Expect = { challenge: string; origin: string; rpId: string };
export type NewPasskey = { id: string; jwk: JsonWebKey; alg: number; signCount: number };

/** A passkey being made: what `navigator.credentials.create()` returned, checked. */
export async function verifyRegistration(r: { clientDataJSON: unknown; attestationObject: unknown }, e: Expect): Promise<NewPasskey> {
  const cd = fromB64url(r.clientDataJSON);
  const ao = fromB64url(r.attestationObject);
  if (!cd || !ao) throw new Error("registration: not base64url");
  await checkClientData(cd, "webauthn.create", e.challenge, e.origin);
  const att = cborDecode(ao).value;
  if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array)) throw new Error("registration: no authData");
  const ad = parseAuthData(att.get("authData") as Uint8Array);
  if (!same(ad.rpIdHash, await sha256(new TextEncoder().encode(e.rpId)))) throw new Error("registration: wrong rpId");
  if (!ad.up) throw new Error("registration: user not present");
  if (!ad.credId || !ad.coseKey) throw new Error("registration: no credential");
  const { jwk, alg } = coseToJwk(ad.coseKey);
  await importKey(jwk, alg); // throws on a key WebCrypto won't take
  return { id: b64url(ad.credId), jwk, alg, signCount: ad.signCount };
}

/** A passkey being used: what `navigator.credentials.get()` returned, against the stored key. */
export async function verifyAssertion(
  r: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown },
  e: Expect,
  key: { jwk: JsonWebKey; alg: number; signCount: number },
): Promise<{ signCount: number }> {
  const cd = fromB64url(r.clientDataJSON);
  const ad = fromB64url(r.authenticatorData);
  const sig = fromB64url(r.signature);
  if (!cd || !ad || !sig) throw new Error("assertion: not base64url");
  await checkClientData(cd, "webauthn.get", e.challenge, e.origin);
  const parsed = parseAuthData(ad);
  if (!same(parsed.rpIdHash, await sha256(new TextEncoder().encode(e.rpId)))) throw new Error("assertion: wrong rpId");
  if (!parsed.up) throw new Error("assertion: user not present");
  const signed = new Uint8Array(ad.length + 32);
  signed.set(ad);
  signed.set(await sha256(cd), ad.length);
  const k = await importKey(key.jwk, key.alg);
  const ok =
    key.alg === ES256 ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, derToRaw(sig), signed) : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, sig, signed);
  if (!ok) throw new Error("assertion: bad signature");
  // A counter that went back means a copied authenticator; passkeys that sync keep it at 0.
  if ((parsed.signCount || key.signCount) && parsed.signCount <= key.signCount) throw new Error("assertion: counter went back");
  return { signCount: parsed.signCount };
}
