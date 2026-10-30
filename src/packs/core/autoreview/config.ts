/**
 * A repo's say on Auto review (#326 step 5): `.dovre/auto.json`, read at the PR's base commit (as
 * `.dovre/sandbox.json` is read at a run's base), so the PR under review can't change it.
 *
 *   { "merge": true, "sizeLimit": 400 }
 *
 * - `merge`: Auto review may merge PRs that reach level 5. Off unless it says `true`.
 * - `sizeLimit`: changed lines above which the level is capped at 3 (default SIZE_LIMIT).
 * - `threshold`: 5 only. A repo can't lower it; another value is ignored and said so.
 */
import type { Ghe } from "../../../sources/ghe.ts";

export const AUTO_CONFIG = ".dovre/auto.json";

export type AutoConfig = { merge: boolean; sizeLimit?: number; notes: string[] };

export const NO_CONFIG: AutoConfig = { merge: false, notes: [] };

export function autoConfigOf(text: string | undefined): AutoConfig {
  if (text === undefined) return NO_CONFIG;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { merge: false, notes: [`${AUTO_CONFIG} isn't JSON, so automerge is off.`] };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { merge: false, notes: [`${AUTO_CONFIG} isn't an object, so automerge is off.`] };
  const o = v as Record<string, unknown>;
  const notes: string[] = [];
  const size = o.sizeLimit;
  const sizeLimit = typeof size === "number" && Number.isInteger(size) && size >= 1 && size <= 100_000 ? size : undefined;
  if (size !== undefined && sizeLimit === undefined) notes.push("Its sizeLimit isn't a whole number from 1 to 100000: the default applies.");
  if (o.threshold !== undefined && o.threshold !== 5) notes.push("Its threshold is ignored: Auto review merges only at level 5.");
  return { merge: o.merge === true, ...(sizeLimit ? { sizeLimit } : {}), notes };
}

/** The file at `sha`; none, or one the forge won't give, is automerge off. */
export async function loadAutoConfig(ghe: Pick<Ghe, "rest">, repo: string, sha: string): Promise<AutoConfig> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return NO_CONFIG;
  try {
    const r = await ghe.rest<{ content?: string; encoding?: string; size?: number }>(`/repos/${repo}/contents/${AUTO_CONFIG}?ref=${sha}`);
    if (typeof r?.content !== "string" || r.encoding !== "base64" || (r.size ?? 0) > 10_000) return NO_CONFIG;
    const bytes = Uint8Array.from(atob(r.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    return autoConfigOf(new TextDecoder().decode(bytes));
  } catch {
    return NO_CONFIG;
  }
}
