/**
 * The hosted snapshot kept in D1 (the `settings` row "snapshot"), so a fresh isolate draws the last
 * one at once instead of "Gathering" while GitHub answers. Loaded before the first request
 * (`load()`), written at most every `everyMs` after a gather; the Worker waits on `drain()` so a
 * write isn't cut off with the request.
 */
import type { D1 } from "../db.ts";
import { decodeSnapshot, encodeSnapshot, type Snapshot } from "../gather.ts";

const KEY = "snapshot";
/** D1 rows top out at 2 MB; a snapshot bigger than this isn't kept (the next isolate gathers). */
const MAX_BYTES = 1_500_000;

export function d1SnapshotStore(db: D1, version: string, opts: { everyMs?: number; now?: () => number; log?: (line: string) => void } = {}) {
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? 5 * 60_000;
  const log = opts.log ?? ((l: string) => console.error(l));
  let savedAt = 0;
  let writing: Promise<void> = Promise.resolve();
  return {
    /** The kept snapshot, if there's one this version can read. */
    async load(): Promise<Snapshot | undefined> {
      try {
        const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>();
        const snap = row ? decodeSnapshot(row.value, version, now) : undefined;
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
      const text = encodeSnapshot(snap, version);
      if (text.length > MAX_BYTES) return log(`snapshot: ${text.length} bytes, too big to keep`);
      savedAt = snap.at;
      writing = writing
        .then(() => db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES (?, ?, ?)").bind(KEY, text, new Date(snap.at).toISOString()).run())
        .then(
          () => undefined,
          (e) => log(`snapshot: couldn't keep it: ${(e as Error)?.message ?? e}`),
        );
    },
    /** Resolves when the writes started so far are done. */
    drain: (): Promise<void> => writing,
  };
}
