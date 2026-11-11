/**
 * A read shared by the requests that ask while it runs (a store's load from D1). On a Worker, one
 * started by a request that was then cancelled never settles, nor do its timers. So each caller
 * waits on its own timer, and a read in flight longer than that is dropped and started again: a
 * stuck one can't hold every later page or write. Same idea as the Access keys' fetch (src/access.ts).
 *
 * A caller joins a read already in flight for JOIN_MS at most, then starts its own. Hosted, the
 * stores start their first read while the app is built, often in a request that isn't a page (the
 * live socket coming back, the cron): every page after a deploy waited out READ_MS on it (#294).
 */

/** How long a caller waits on a shared read, and how old one in flight may be before it's started again. */
export const READ_MS = 5_000;
/** How long a caller waits on a read someone else started before starting its own (a D1 read takes tens of ms). */
export const JOIN_MS = 250;

/** Waits on `p` at most `ms`, with the timer in this caller's request. */
export function within(p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((res) => (t = setTimeout(res, ms)))]).finally(() => clearTimeout(t));
}

type SharedRead = {
  /** Starts a read unless a recent one is in flight; resolves when it ends, or after `ms` at most. */
  read(): Promise<void>;
  /** Whether a read has finished at least once. */
  readonly done: boolean;
};

/** `run` does the read and keeps what it read; its errors are its own (a throw counts as finished). */
export function sharedRead(run: () => Promise<void>, o: { ms?: number; joinMs?: number; now?: () => number } = {}): SharedRead {
  const ms = o.ms ?? READ_MS;
  const joinMs = Math.min(o.joinMs ?? JOIN_MS, ms);
  const now = o.now ?? Date.now;
  let done = false;
  let inflight: { p: Promise<void>; at: number } | undefined;
  const start = () => {
    const mine: { p: Promise<void>; at: number } = { at: now(), p: Promise.resolve() };
    mine.p = run()
      .catch(() => undefined)
      .finally(() => {
        done = true;
        if (inflight === mine) inflight = undefined;
      });
    inflight = mine;
    return mine.p;
  };
  return {
    async read() {
      const there = inflight && now() - inflight.at < ms ? inflight : undefined;
      if (there) {
        let ended = false;
        await within(there.p.then(() => (ended = true)), joinMs);
        if (ended) return;
        // Begun elsewhere and not done: maybe in a request that's gone. A newer one, else this caller's own.
        if (inflight && inflight !== there) return within(inflight.p, ms);
      }
      return within(start(), ms);
    },
    get done() {
      return done;
    },
  };
}
