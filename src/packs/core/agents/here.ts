/**
 * The agents on this machine, as the agents pack keeps them (PLAN WP-H9d4): the sessions every
 * harness here has (src/sources/sessions.ts) and the worktrees under CODE_DIR, read again every
 * 15 s and soon after Claude Code rewrites a session file (it does on every busy/idle change, the
 * fastest signal there is). Pages read what's here and never wait for a read; a read that changed
 * what they show tells them. Hosted there's nothing on the machine: the Mac's come over the desk.
 */
import { type FSWatcher, existsSync, watch } from "node:fs";
import { throttle } from "../../../live.ts";
import type { Sessions } from "../../../sources/sessions.ts";
import type { Worktree } from "../../../sources/worktrees.ts";

export type { Sessions };

export type Here = {
  /** The newest read (empty before the first). */
  sessions(): Sessions;
  worktrees(): Worktree[];
  /** The sessions, waiting for the first read if there's been none (the desk, before a turn). */
  ready(): Promise<Sessions>;
  /** Reads again now (one at a time; one asked for meanwhile follows). True when what pages show changed. */
  read(): Promise<boolean>;
  /** Reads now, then on the schedule and the watcher, calling `changed` after a read that changed something. Returns stop. */
  start(changed: () => void): () => void;
};

const EMPTY: Sessions = { live: [], recent: [] };

export function createHere(o: {
  sessions: () => Promise<Sessions>;
  worktrees: () => Worktree[];
  /** A folder whose changes mean a read soon (Claude Code's sessions/). */
  watch?: string;
  everyMs?: number;
  log?: (line: string) => void;
}): Here {
  let sessions = EMPTY;
  let worktrees: Worktree[] = [];
  let shown = "";
  let first: Promise<unknown> | undefined;
  let busy: Promise<boolean> | undefined;
  let again = false;
  let onChange = () => {};

  const once = async (): Promise<boolean> => {
    const [s, w] = await Promise.all([
      o.sessions().catch((e) => (o.log?.(`agents: couldn't read the sessions (${(e as Error)?.message ?? e})`), sessions)),
      Promise.resolve().then(o.worktrees).catch(() => worktrees),
    ]);
    sessions = s;
    worktrees = w;
    const next = JSON.stringify([s, w]);
    if (next === shown) return false;
    shown = next;
    return true;
  };
  const read = (): Promise<boolean> => {
    if (busy) {
      again = true;
      return busy;
    }
    const p = once().finally(() => {
      busy = undefined;
      if (again) {
        again = false;
        void read().then((c) => c && onChange());
      }
    });
    busy = p;
    first ??= p;
    return p;
  };

  return {
    sessions: () => sessions,
    worktrees: () => worktrees,
    async ready() {
      await (first ?? read());
      return sessions;
    },
    read,
    start(changed) {
      onChange = changed;
      const go = () => void read().then((c) => c && changed());
      go();
      const timer = setInterval(go, o.everyMs ?? 15_000);
      timer.unref?.();
      let watcher: FSWatcher | undefined;
      const soon = throttle(go, 1500);
      try {
        if (o.watch && existsSync(o.watch)) watcher = watch(o.watch, () => soon());
      } catch {}
      return () => {
        clearInterval(timer);
        watcher?.close();
        onChange = () => {};
      };
    },
  };
}

/** What's on a machine that reads nothing (hosted), or a test's fixed one. */
export function fixedHere(sessions: Sessions = EMPTY, worktrees: Worktree[] = []): Here {
  return { sessions: () => sessions, worktrees: () => worktrees, ready: async () => sessions, read: async () => false, start: () => () => {} };
}
