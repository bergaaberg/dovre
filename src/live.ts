/**
 * Liveness: the server keeps the snapshot fresh on its own and tells open pages when something
 * changed, over Server-Sent Events (GET /events). A page then swaps its live regions in place
 * (src/ui/app.js.ts); nothing reloads.
 *
 * Topics: "snapshot" (anything on the pages), "run:<sessionId>" (an agent turn running here), and
 * each pack's id. The refresher gathers everything every `remoteMs` (GHE) and publishes only when
 * what the pages show actually changed. What's on this machine (agents' sessions, worktrees) the
 * agents pack reads and publishes itself (src/packs/core/agents/here.ts).
 */
import { createHash } from "node:crypto";
import { type Gatherer, type Snapshot, shownOf } from "./gather.ts";
import type { Note } from "./notify.ts";

export type Change = { topics: string[]; at: number; notes?: Note[] };
export type Hub = {
  publish(topics: string[], notes?: Note[]): void;
  /** `notifies`: that page has notification permission, so it shows notes itself. */
  subscribe(fn: (c: Change) => void, opts?: { notifies?: boolean }): () => void;
  size(): number;
  /** How many open pages can show a notification themselves. */
  notifiers(): number;
};

export function createHub(now: () => number = Date.now): Hub {
  const subs = new Set<(c: Change) => void>();
  const loud = new Set<(c: Change) => void>();
  return {
    publish(topics, notes) {
      const c: Change = notes?.length ? { topics, at: now(), notes } : { topics, at: now() };
      for (const fn of subs) {
        try {
          fn(c);
        } catch {}
      }
    },
    subscribe(fn, opts) {
      subs.add(fn);
      if (opts?.notifies) loud.add(fn);
      return () => {
        subs.delete(fn);
        loud.delete(fn);
      };
    },
    size: () => subs.size,
    notifiers: () => loud.size,
  };
}

/** What the pages show, boiled down: when this changes, they need redrawing. */
export function signature(s: Snapshot): string {
  return createHash("sha1").update(shownOf(s)).digest("base64url");
}

/** Calls `fn` at most once per `ms`, with the latest arguments, trailing. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  return (...a: A) => {
    pending = a;
    const wait = last + ms - Date.now();
    if (wait <= 0 && !timer) {
      last = Date.now();
      fn(...pending);
      pending = undefined;
      return;
    }
    timer ??= setTimeout(() => {
      timer = undefined;
      last = Date.now();
      if (pending) fn(...pending);
      pending = undefined;
    }, Math.max(0, wait));
  };
}

export function startRefresher(opts: {
  gatherer: Gatherer;
  hub: Hub;
  remoteMs?: number;
  /** What's new in this snapshot, to notify about. */
  news?: (s: Snapshot) => Note[];
  /** Notes nobody's page is open to show. */
  unheard?: (notes: Note[]) => void;
}): { stop(): void; kick(): void; seen(s: Snapshot): void } {
  const { gatherer, hub } = opts;
  let sig = "";
  /** A snapshot came in (from here, or a gather a page or an action started): publish it if it changed. */
  const seen = (s: Snapshot) => {
    const next = signature(s);
    if (next === sig) return;
    sig = next;
    const notes = opts.news?.(s) ?? [];
    hub.publish(["snapshot"], notes);
    if (notes.length && !hub.size()) opts.unheard?.(notes);
  };
  let busy = false;
  let again = false;
  const run = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      seen(await gatherer.get({ fresh: true }));
    } catch (e) {
      console.error("refresh failed:", (e as Error).message);
    } finally {
      busy = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };
  const remote = setInterval(() => void run(), opts.remoteMs ?? 60_000);
  void run();
  return {
    stop() {
      clearInterval(remote);
    },
    kick: () => void run(),
    seen,
  };
}
