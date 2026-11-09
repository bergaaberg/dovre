/**
 * Packs' WebAssembly (Pack.wasm) and big files (Pack.files): the rules the app (src/app.ts) and the hosted assets build
 * (src/packs/assets.ts) share, so a module is checked the same way wherever it's served from.
 */
import type { WasmFile } from "./types.ts";

/** Bytes in the bundle: small modules only. */
export const WASM_INLINE_MAX = 8 * 1024 * 1024;
/** A file beside the pack: Workers static assets take 25 MiB a file. */
const WASM_FILE_MAX = 25 * 1024 * 1024;

export const wasmNameOk = (name: string) => /^[a-z][a-z0-9-]{0,31}$/.test(name);
export const isWasm = (b: Uint8Array) => b.length >= 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
export const isWasmFile = (v: unknown): v is WasmFile =>
  !!v && typeof v === "object" && !(v instanceof Uint8Array) && typeof (v as WasmFile).sha256 === "string" && typeof (v as WasmFile).load === "function";
export const shaOk = (sha: string) => /^[0-9a-f]{16}$/.test(sha);

/** Where a file module sits in the static assets, and is served at under `/assets/`. */
export const wasmFileAt = (pack: string, name: string, sha: string) => `wasm/${pack}.${name}.${sha}.wasm`;

/** The first 16 hex digits of the bytes' SHA-256 (WebCrypto: the same under Node and in the Worker). */
export async function sha16(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Why a file module's bytes can't be served ("" when they can). */
export async function fileWhy(bytes: unknown, sha: string): Promise<string> {
  if (!(bytes instanceof Uint8Array) || !isWasm(bytes)) return "isn't WebAssembly";
  return sizeShaWhy(bytes, sha);
}

async function sizeShaWhy(bytes: Uint8Array, sha: string): Promise<string> {
  if (bytes.length > WASM_FILE_MAX) return "is over 25 MB";
  const got = await sha16(bytes);
  return got === sha ? "" : `has SHA-256 ${got}, not the ${sha} it declares (rebuild the pack)`;
}

/**
 * Packs' other big files (Pack.files): a browser library's script or stylesheet, kept out of the
 * Worker bundle the same way. The name says its kind: `mermaid.js`, `katex.css`.
 */
const PACK_FILE_TYPES: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
export const packFileNameOk = (name: string) => /^[a-z][a-z0-9-]{0,31}\.(js|css)$/.test(name);
export const packFileType = (name: string) => PACK_FILE_TYPES[name.slice(name.lastIndexOf(".") + 1)]!;
/** Where a pack file sits in the static assets, and is served at under `/assets/`. */
export const packFileAt = (pack: string, name: string, sha: string) => {
  const dot = name.lastIndexOf(".");
  return `files/${pack}.${name.slice(0, dot)}.${sha}${name.slice(dot)}`;
};

/** Why a pack file's bytes can't be served ("" when they can). */
export async function packFileWhy(bytes: unknown, sha: string): Promise<string> {
  if (!(bytes instanceof Uint8Array)) return "isn't bytes";
  return sizeShaWhy(bytes, sha);
}
