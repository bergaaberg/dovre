/**
 * Messages written to an agent while it works, as in Claude Code's terminal: they wait here, per
 * session, and go as the next turn when this one ends. A turn that stopped on a permission keeps
 * them for the answer (Allow or No takes them along); a stopped or failed turn keeps them until I
 * send again. Kept on disk (data/queue.json) so a restart doesn't lose what I wrote; nothing else
 * is kept with them.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Run } from "./runner.ts";

export type Queued = { id: string; text: string; at: number; mode?: string; model?: string; effort?: string };

/** At most this many waiting per session. */
export const MAX_QUEUED = 10;

export type Queue = {
  list(sid: string): Queued[];
  add(sid: string, q: { text: string; mode?: string; model?: string; effort?: string }): Queued | undefined;
  remove(sid: string, id: string): boolean;
  /** Everything waiting for the session, taken off the queue. */
  take(sid: string): Queued[];
  /** A turn ended: when it ended well, what waits for its session goes as the next turn. */
  ended(run: Run): void;
  /** How the next turn starts (the app's own; set once it exists). */
  onDrain(fn: (sid: string, items: Queued[]) => Promise<void>): void;
};

/** What waits, as one message: each on its own, in the order written. */
export function joined(items: Pick<Queued, "text">[]): string {
  return items.map((q) => q.text).join("\n\n");
}

export function createQueue(o: { file?: string; now?: () => number; onChange?: (sid: string) => void } = {}): Queue {
  const now = o.now ?? Date.now;
  let all: Record<string, Queued[]> = {};
  if (o.file) {
    try {
      const v = JSON.parse(readFileSync(o.file, "utf8"));
      if (v && typeof v === "object") for (const [sid, list] of Object.entries(v)) if (Array.isArray(list)) all[sid] = list.filter((q): q is Queued => !!q && typeof q.id === "string" && typeof q.text === "string").slice(0, MAX_QUEUED);
    } catch {}
  }
  const save = (sid: string) => {
    if (!all[sid]?.length) delete all[sid];
    if (o.file) {
      try {
        writeFileSync(o.file + ".tmp", JSON.stringify(all));
        renameSync(o.file + ".tmp", o.file);
      } catch {}
    }
    o.onChange?.(sid);
  };
  let drain: ((sid: string, items: Queued[]) => Promise<void>) | undefined;
  const q: Queue = {
    list: (sid) => [...(all[sid] ?? [])],
    add(sid, x) {
      const list = (all[sid] ??= []);
      if (list.length >= MAX_QUEUED || !x.text.trim()) return undefined;
      const item: Queued = { id: randomUUID(), text: x.text, at: now(), mode: x.mode, model: x.model, ...(x.effort ? { effort: x.effort } : {}) };
      list.push(item);
      save(sid);
      return item;
    },
    remove(sid, id) {
      const list = all[sid];
      const i = list?.findIndex((x) => x.id === id) ?? -1;
      if (i < 0) return false;
      list!.splice(i, 1);
      save(sid);
      return true;
    },
    take(sid) {
      const list = all[sid] ?? [];
      if (!list.length) return [];
      delete all[sid];
      save(sid);
      return list;
    },
    ended(run) {
      const sid = run.sessionId;
      if (!sid || !drain || run.status !== "done" || run.events.some((e) => e.t === "denied")) return;
      const items = q.take(sid);
      if (!items.length) return;
      // Back on the queue when the next turn couldn't start.
      drain(sid, items).catch(() => {
        all[sid] = [...items, ...(all[sid] ?? [])].slice(0, MAX_QUEUED);
        save(sid);
      });
    },
    onDrain(fn) {
      drain = fn;
    },
  };
  return q;
}
