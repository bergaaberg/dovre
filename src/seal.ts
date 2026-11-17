/**
 * Sealing secrets at rest (GitHub tokens in D1): AES-256-GCM with a key derived by HKDF
 * from one secret (GITHUB_TOKEN_SEAL, 32+ characters). Each value gets a random 12-byte IV and is
 * bound to `context` (the row it belongs to) as associated data, so a sealed value copied into
 * another row doesn't open. Sealed form: "v1." + base64url(iv ‖ ciphertext).
 */

export const SEAL_MIN = 32;
const enc = new TextEncoder();

/** base64url, a chunk at a time: a snapshot's megabyte would overflow the stack as one spread. */
const b64url = (b: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
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

const pipe = async (bytes: Uint8Array, through: CompressionStream | DecompressionStream): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(through)).arrayBuffer());

/**
 * A large text sealed (#544: a person's kept snapshot, weeks and reads): gzipped, then sealed as
 * above, bound to `context`. Sealed form: "v1z." + base64url(iv ‖ ciphertext). Smaller than the text.
 */
export async function sealText(secret: string, context: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await pipe(enc.encode(plain), new CompressionStream("gzip"));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await keyOf(secret), packed as BufferSource));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1z.${b64url(out)}`;
}

/** The text `sealText` sealed, or undefined when it doesn't open (another key or row, tampered, or not sealed at all). */
export async function unsealText(secret: string, context: string, sealed: string): Promise<string | undefined> {
  if (!sealed.startsWith("v1z.")) return undefined;
  try {
    const raw = unb64url(sealed.slice(4));
    const packed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(context) }, await keyOf(secret), raw.slice(12)));
    return new TextDecoder().decode(await pipe(packed, new DecompressionStream("gzip")));
  } catch {
    return undefined;
  }
}

/** A key that names what it keeps without saying it (a read's path names its repo): hex SHA-256. */
export async function hashKey(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(key)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
