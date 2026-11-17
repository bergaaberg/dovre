/**
 * The hosted snapshot kept in D1 (the `settings` row "snapshot"), so a fresh isolate draws the last
 * one at once instead of "Gathering" while GitHub answers. Loaded before the first request
 * (`load()`), written at most every `everyMs` after a gather; the Worker waits on `drain()` so a
 * write isn't cut off with the request.
 *
 * A person's own snapshot (src/hosted/people.ts) is kept the same way in the row
 * "snapshot:<email>" (`personKey`). Each write of one also drops people's rows older than a week,
 * which no version reads any more: someone who left doesn't stay in D1. It's sealed (#544,
 * `sealText` with GITHUB_TOKEN_SEAL, bound to its row): a cockpit's export carries it, and it may
 * name repos only that person can see. A row that doesn't open (from before, or another key) is none.
 */
import type { D1 } from "../db.ts";
import { decodeSnapshot, encodeSnapshot, type Snapshot } from "../gather.ts";
import { sealText, unsealText } from "../seal.ts";

const KEY = "snapshot";
/** The row a person's own snapshot is kept in. */
export const personKey = (email: string) => `${KEY}:${email.trim().toLowerCase()}`;
const WEEK = 7 * 86_400_000;
/** D1 rows top out at 2 MB; a snapshot bigger than this isn't kept (the next isolate gathers). */
export const MAX_BYTES = 1_500_000;

export function d1SnapshotStore(db: D1, version: string, opts: { everyMs?: number; now?: () => number; log?: (line: string) => void; /** A person's row (`personKey`); without it, the instance's. */ key?: string; /** Seal the row with this secret (a person's, #544). */ seal?: string } = {}) {
  const key = opts.key ?? KEY;
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? 5 * 60_000;
  const log = opts.log ?? ((l: string) => console.error(l));
  let savedAt = 0;
  let writing: Promise<void> = Promise.resolve();
  return {
    /** The kept snapshot, if there's one this version can read. */
    async load(): Promise<Snapshot | undefined> {
      try {
        const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
        const text = row && (opts.seal ? await unsealText(opts.seal, key, row.value) : row.value);
        const snap = text ? decodeSnapshot(text, version, now) : undefined;
        if (snap) savedAt = snap.at;
        return snap;
      } catch (e) {
        log(`snapshot: couldn't read the kept one: ${(e as Error)?.message ?? e}`);
        return undefined;
      }
    },
    /** Keeps `snap` unless one was kept within `everyMs`. */
    save(snap: Snapshot): void {
      if (snap.at - savedAt < every) return;
      const plain = encodeSnapshot(snap, version);
      if (!opts.seal && plain.length > MAX_BYTES) return log(`snapshot: ${plain.length} bytes, too big to keep`);
      savedAt = snap.at;
      writing = writing
        .then(async () => {
          const text = opts.seal ? await sealText(opts.seal, key, plain) : plain;
          if (text.length > MAX_BYTES) return log(`snapshot: ${text.length} bytes sealed, too big to keep`);
          await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(key, text, new Date(snap.at).toISOString()).run();
        })
        // `at` is an ISO time, so text order is time order.
        .then(() => (key === KEY ? undefined : db.prepare("DELETE FROM settings WHERE key LIKE ? AND at < ?").bind(`${KEY}:%`, new Date(now() - WEEK).toISOString()).run()))
        .then(
          () => undefined,
          (e) => log(`snapshot: couldn't keep it: ${(e as Error)?.message ?? e}`),
        );
    },
    /** Resolves when the writes started so far are done. */
    drain: (): Promise<void> => writing,
    /** How big `snap` is as it's kept, to hold against MAX_BYTES (Settings → About says, #540). */
    size: (snap: Snapshot): number => encodeSnapshot(snap, version).length,
  };
}
