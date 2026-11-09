/**
 * The pack contract's version, "major.minor" (#360). A pack's manifest names the oldest core API
 * it works with; a core of that major and at least that minor runs it. The old integer `api: 1`
 * reads as "1.0". docs/ARCHITECTURE.md lists what each minor added.
 *
 * Since 1.24 (#473) the contract is what `src/pack.ts` exports (`dovre/pack.ts`), not only
 * `types.ts`: a name added there is a minor, one removed or changed is a major.
 */
import { PACK_API } from "./types.ts";

type ApiVersion = { major: number; minor: number };

/** "1.5" or 1 (= 1.0) as numbers; null for anything else. */
export function parseApi(v: unknown): ApiVersion | null {
  const s = typeof v === "number" ? (Number.isInteger(v) && v >= 0 ? `${v}.0` : "") : typeof v === "string" ? v.trim() : "";
  const m = s.match(/^(\d{1,4})(?:\.(\d{1,4}))?$/);
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : null;
}

export const apiText = (v: ApiVersion) => `${v.major}.${v.minor}`;

/** Why a pack needing `need` can't run on a core speaking `have`, or null when it can. */
export function apiGap(need: unknown, have: string = PACK_API): string | null {
  const n = parseApi(need);
  const h = parseApi(have)!;
  if (!n) return `its api ${JSON.stringify(need) ?? "?"} isn't a version like ${have}`;
  if (n.major !== h.major) return `written for pack contract ${n.major}, this Dovre speaks ${h.major}`;
  if (n.minor > h.minor) return `needs core API ${apiText(n)}, this is ${apiText(h)}`;
  return null;
}

/** Orders two API versions (-1, 0, 1); an unreadable one sorts first. */
export function apiCompare(a: unknown, b: unknown): number {
  const x = parseApi(a);
  const y = parseApi(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  return Math.sign(x.major - y.major || x.minor - y.minor);
}
