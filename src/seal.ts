/**
 * Sealing secrets at rest (GitHub tokens in D1): AES-256-GCM with a key derived by HKDF
 * from one secret (GITHUB_TOKEN_SEAL, 32+ characters). Each value gets a random 12-byte IV and is
 * bound to `context` (the row it belongs to) as associated data, so a sealed value copied into
 * another row doesn't open. Sealed form: "v1." + base64url(iv ‖ ciphertext).
 */

export const SEAL_MIN = 32;
const enc = new TextEncoder();

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function keyOf(secret: string): Promise<CryptoKey> {
  if (secret.length < SEAL_MIN) throw new Error(`the sealing secret must be ${SEAL_MIN}+ characters`);
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("dovre github tokens v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, context: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await keyOf(secret), enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1.${b64url(out)}`;
}

/** The plain value, or undefined when it doesn't open (another key, another row, tampered). */
export async function unseal(secret: string, context: string, sealed: string): Promise<string | undefined> {
  if (!sealed.startsWith("v1.")) return undefined;
  try {
    const raw = unb64url(sealed.slice(3));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(context) }, await keyOf(secret), raw.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}
