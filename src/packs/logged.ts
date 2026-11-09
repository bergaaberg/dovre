/**
 * `ctx.logged` (API 1.25, #474): a pack's write, in the actions table, without the pack reaching
 * for core's `logAction` and the database. Core puts the pack's id on the kind (`send` is logged
 * as `http.send`), clips the text, and adds who pressed when hosted.
 */
import { logAction } from "../actions/deploys.ts";
import type { D1 } from "../db.ts";
import type { PackLogged } from "./types.ts";

const KIND = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const clip = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : undefined);

/** The row a pack's write becomes; throws on a kind that isn't one word, since that's the pack's own code. */
export function loggedRow(id: string, a: PackLogged) {
  if (typeof a?.kind !== "string" || !KIND.test(a.kind)) throw new TypeError(`ctx.logged: kind ${JSON.stringify(a?.kind)} isn't a word (letters, digits, dashes); "${id}." is added for you`);
  return { kind: `${id}.${a.kind}`, target: clip(a.target, 300) ?? "", detail: clip(a.detail, 200), ok: a.ok === true, error: clip(a.error, 300) };
}

/** A pack's `ctx.logged`. The write has happened by now, so a log that can't be kept is said in the pack's log, not thrown. */
export function loggedFor(id: string, db: D1 | undefined, log: (line: string) => void): (a: PackLogged) => Promise<void> {
  return async (a) => {
    const row = loggedRow(id, a);
    if (!db) return;
    await logAction(db, row).catch((e) => log(`logged ${row.kind}: not kept: ${(e as Error)?.message ?? e}`));
  };
}
