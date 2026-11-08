/**
 * Sessions cleared away from Dovre's lists (migrations/0008). Only Dovre forgets them:
 * the agent's transcript stays where its CLI keeps it, and a new turn brings the session back.
 * Kept in memory after the first read, since every page filters by it.
 */
import type { D1 } from "../db.ts";
import { sharedRead } from "../shared-read.ts";

export type Dismissed = {
  ready: Promise<void>;
  has(sessionId: string): boolean;
  add(sessionIds: string[], at?: number): Promise<void>;
  remove(sessionId: string): Promise<void>;
};

export function createDismissed(db: D1): Dismissed {
  const set = new Set<string>();
  // A read that never settles (its request was cancelled) is started again by the next to wait (src/shared-read.ts).
  const r = sharedRead(async () => {
    const rows = await db.prepare("SELECT session_id FROM agent_dismissed").all<{ session_id: string }>();
    for (const row of rows.results) set.add(row.session_id);
  });
  void r.read();
  return {
    get ready() {
      return r.done ? Promise.resolve() : r.read();
    },
    has: (sid) => set.has(sid),
    async add(sids, at = Date.now()) {
      const fresh = sids.filter((s) => !set.has(s));
      if (!fresh.length) return;
      for (const s of fresh) set.add(s);
      await db.batch(fresh.map((s) => db.prepare("INSERT OR IGNORE INTO agent_dismissed (session_id, at) VALUES (?, ?)").bind(s, at)));
    },
    async remove(sid) {
      if (!set.delete(sid)) return;
      await db.prepare("DELETE FROM agent_dismissed WHERE session_id = ?").bind(sid).run();
    },
  };
}
