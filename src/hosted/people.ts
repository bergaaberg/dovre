/**
 * A snapshot per person (#538). Hosted, a cockpit used to gather once, as its operator: every
 * member saw the operator's PRs, review requests and notifications. Where the instance tells
 * people's GitHub tokens apart, a signed-in person who has a token of their own gets their own
 * gatherer here: gathered as them, with their token, and kept apart.
 *
 * Who gets one, by the request's viewer (src/viewer.ts):
 * - No viewer (cron, Bino's lookups, a pack session): the instance's snapshot, as before.
 * - A person with no token of their own, or whose login is the instance's own (the operator):
 *   the instance's snapshot, as before. A cockpit with one person gathers exactly as it did.
 * - Anyone else: their own.
 *
 * The cron still gathers the instance's snapshot only. A person's own is gathered while they have
 * pages open, and the last one is kept (src/hosted/snapshot.ts) for their next visit.
 */
import type { Gatherer, Snapshot } from "../gather.ts";

/** A person without a token of their own is asked about again after this. */
export const MISS_MS = 60_000;
/** A person whose login is the instance's own stays on its snapshot this long before being asked about again. */
export const SAME_MS = 10 * 60_000;
/** How long a page waits to learn whose snapshot is its viewer's. Past it, the page draws the instance's and the answer lands for the next one. */
export const FIND_MS = 2_000;
/** A question running longer than this is asked again (a cancelled Worker request never settles what it started). */
export const STUCK_MS = 30_000;
/** People with a gatherer of their own in one isolate: far above a real team. The oldest goes first. */
export const PEOPLE_MAX = 50;

/** A person's own gatherer, and what waits for its kept snapshot's writes. */
export type Own = { gatherer: Gatherer; drain(): Promise<void> };
/** Who a person is on the forge, and how to start their gatherer. */
export type Found = { login: string; start(): Promise<Own> };

type Mine = ({ kind: "own" } & Own) | { kind: "shared"; until: number };

export type People = {
  /** The gatherer every page and pack reads: it answers for whoever the request is for. */
  gatherer: Gatherer;
  /** Waits for questions and people's gathers under way, and their kept snapshots' writes (the Worker holds a request open for it). */
  settle(): Promise<void>;
  /** How many people have a gatherer of their own here. */
  size(): number;
};

export function perPerson(o: {
  /** The instance's own gatherer. */
  shared: Gatherer;
  /** The login the instance gathers as. */
  login: string;
  /** Whom the current request is for. */
  viewer: () => string | undefined;
  /** That person on the forge, asked with their own token. Rejects when they have none. */
  find: (email: string) => Promise<Found>;
  now?: () => number;
  log?: (line: string) => void;
  findMs?: number;
}): People {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.error(l));
  const known = new Map<string, Mine>();
  const asking = new Map<string, { p: Promise<Mine>; at: number }>();

  const remember = (email: string, mine: Mine): Mine => {
    known.delete(email);
    known.set(email, mine);
    for (const old of known.keys()) {
      if (known.size <= PEOPLE_MAX) break;
      known.delete(old);
    }
    return mine;
  };

  async function ask(email: string): Promise<Mine> {
    let found: Found;
    try {
      found = await o.find(email);
    } catch {
      // No token of their own, or it couldn't be asked just now: the instance's snapshot, as before.
      return remember(email, { kind: "shared", until: now() + MISS_MS });
    }
    if (!found.login || found.login.toLowerCase() === o.login.toLowerCase()) return remember(email, { kind: "shared", until: now() + SAME_MS });
    try {
      return remember(email, { kind: "own", ...(await found.start()) });
    } catch (e) {
      log(`people: couldn't start a gatherer: ${(e as Error)?.message ?? e}`);
      return remember(email, { kind: "shared", until: now() + MISS_MS });
    }
  }

  /** What's known of this person, if it still holds. */
  const settled = (email: string): Mine | undefined => {
    const m = known.get(email);
    return m && (m.kind === "own" || now() < m.until) ? m : undefined;
  };

  function mineOf(email: string): Mine | Promise<Mine> {
    const hit = settled(email);
    if (hit) return hit;
    const a = asking.get(email);
    if (a && now() - a.at < STUCK_MS) return a.p;
    const p: Promise<Mine> = ask(email).finally(() => {
      if (asking.get(email)?.p === p) asking.delete(email);
    });
    asking.set(email, { p, at: now() });
    return p;
  }

  // In Node (tests) the timer doesn't keep the process up; a Worker's timer has no unref.
  const wait = (ms: number) => new Promise<undefined>((res) => void (setTimeout(res, ms) as unknown as { unref?: () => void }).unref?.());

  const pick = (m: Mine | undefined): Gatherer => (m?.kind === "own" ? m.gatherer : o.shared);

  /**
   * The gatherer for the current request. Someone not asked about yet is waited for a moment, so
   * their first page is their own. Someone on the instance's snapshot whose answer has lapsed is
   * asked about again behind the page, which draws at once (`settle` keeps the question alive).
   */
  async function mine(): Promise<Gatherer> {
    const v = o.viewer();
    if (!v) return o.shared;
    const had = known.get(v);
    const m = mineOf(v);
    if (!(m instanceof Promise)) return pick(m);
    if (had) return pick(had);
    return pick(await Promise.race([m, wait(o.findMs ?? FIND_MS)]));
  }

  /** The same without waiting: undefined while a person hasn't been asked about yet. */
  function atOnce(): Gatherer | undefined {
    const v = o.viewer();
    if (!v) return o.shared;
    const m = known.get(v);
    if (!m) return undefined;
    return m.kind === "own" ? m.gatherer : o.shared;
  }

  const owns = () => [...known.values()].filter((m): m is { kind: "own" } & Own => m.kind === "own");

  return {
    gatherer: {
      get: async (opts) => (await mine()).get(opts),
      stale: () => (atOnce() ?? o.shared).stale(),
      gathering: () => atOnce()?.gathering() ?? false,
      peek: (): Snapshot | undefined => atOnce()?.peek(),
      seed: (s) => o.shared.seed?.(s),
    },
    async settle() {
      // Questions first: one answered now may start a gatherer, whose first gather is then waited for too.
      await Promise.all([...asking.values()].map((a) => a.p.catch(() => undefined)));
      await Promise.all(
        owns().map(async (m) => {
          if (m.gatherer.gathering()) await m.gatherer.get({ fresh: true }).catch(() => undefined);
          await m.drain();
        }),
      );
    },
    size: () => owns().length,
  };
}
