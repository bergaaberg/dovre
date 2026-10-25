/**
 * One snapshot of everything the pages show, gathered together and kept for a short while so
 * a page load doesn't hit the forge (GitHub, or a pack's) each time. A source that fails is reported as failed;
 * the rest of the page still renders.
 */
import { ownersIn } from "./owners.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Summaries, deployPrompt, prPrompt } from "./ai/summaries.ts";
import type { Env } from "./env.ts";
import type { Changelog } from "./sources/changelog.ts";
import type { Deploy, Fetch, Move, Note, Pr, PrRef, RedBranch } from "./sources/ghe.ts";
import type { Forge } from "./forge/types.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type Snapshot = {
  at: number;
  /** When its gather began: anything decided before this is in it. */
  began?: number;
  login: string;
  org: string;
  prs: Result<{ mine: Pr[]; review: Pr[] }>;
  notes: Result<Note[]>;
  moves: Result<Move[]>;
  deploys: Result<Deploy[]>;
  /** State and title of PRs the packs' pages link (`linked`: agents) or events mention without a title. */
  refs: Map<string, PrRef>;
  /** What each waiting deploy ships, by run id. */
  changelogs: Map<number, Result<Changelog>>;
  /** Branches whose newest run of a workflow failed (from CI notifications, checked). */
  red: RedBranch[];
  /** How the pages greet me: my first name on GHE, else my login. */
  name: string;
};

/** Where a summary is kept: what it's of, at which commit. */
export const prSummaryKey = (p: { repo: string; number: number; headSha: string }) => `pr:${p.repo}#${p.number}@${p.headSha}`;
export const deploySummaryKey = (c: { repo: string; prodSha: string | null; head: string }) => `deploy:${c.repo}@${c.prodSha}..${c.head}`;

const settle = <T>(p: Promise<T>): Promise<Result<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }),
  );

/**
 * Pages never wait for GHE when there's something to show: `get()` answers with the newest
 * snapshot there is and gathers again in the background when it's old. It waits only when
 * there's nothing yet, or (briefly) after `stale()`, so a page after an action shows its effect.
 */
export type Gatherer = {
  /** `fresh`: wait for a new gather (joins one under way). */
  /** `wait: false`: never wait on a gather `stale()` started (the page shows what it decided itself). */
  get(opts?: { fresh?: boolean; wait?: boolean }): Promise<Snapshot>;
  /** I just changed something: gather again now; the next page waits a moment for it. */
  stale(): void;
  /** A gather is under way. */
  gathering(): boolean;
  /** The newest snapshot, if there is one, without waiting. */
  peek(): Snapshot | undefined;
  /** A kept snapshot that loaded after the start (hosted: from D1); taken only when it's newer than what's here. */
  seed?(s: Snapshot): void;
};

/**
 * The Snapshot type's version: bump it when its shape changes, so a snapshot kept by older code is
 * dropped instead of drawn wrong. (Not a hash of the code: any change there threw the kept one
 * away, and the next start showed "Gathering" instead of the last view.)
 */
export const SNAPSHOT_SHAPE = "2";

/** Where the last snapshot is kept between runs (data/, never committed), so a restart draws at once. */
export type SnapshotStore = { load(): Snapshot | undefined; save(s: Snapshot): void };

const MAP = "__map";
const WEEK = 7 * 86_400_000;

/** A snapshot as text, Maps and all, marked with the version that wrote it. */
export function encodeSnapshot(snap: Snapshot, version: string): string {
  return JSON.stringify({ version, snap }, (_k, v) => (v instanceof Map ? { [MAP]: [...v.entries()] } : v));
}

/** The snapshot back from encodeSnapshot's text; one from another version, older than a week, or unreadable is ignored. */
export function decodeSnapshot(text: string, version: string, now: () => number = Date.now): Snapshot | undefined {
  try {
    const doc = JSON.parse(text, (_k, v) => (v && typeof v === "object" && Array.isArray(v[MAP]) ? new Map(v[MAP]) : v)) as { version?: string; snap?: Snapshot };
    if (doc.version !== version || !doc.snap || typeof doc.snap.at !== "number" || now() - doc.snap.at > WEEK) return undefined;
    return doc.snap;
  } catch {
    return undefined;
  }
}

/** A JSON file, Maps and all. One from another version, or older than a week, is ignored. */
export function snapshotStore(file: string, version: string, now: () => number = Date.now): SnapshotStore {
  return {
    load() {
      try {
        return decodeSnapshot(readFileSync(file, "utf8"), version, now);
      } catch {
        return undefined;
      }
    },
    save(snap) {
      try {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, encodeSnapshot(snap, version));
        renameSync(tmp, file);
      } catch (e) {
        console.error("couldn't keep the snapshot:", (e as Error).message);
      }
    },
  };
}

/** What the pages show of `s`, as text: two snapshots that draw the same give the same text. */
export function shownOf(s: Snapshot): string {
  return JSON.stringify({ ...s, at: undefined }, (_k, v) => (v instanceof Map ? [...v.entries()] : v));
}

export function createGatherer(deps: {
  env: Pick<Env, "GHE_ORG"> & Partial<Pick<Env, "OWNERS">>;
  /** Where PRs, notifications, movement and deploys come from (src/forge/). */
  forge: Forge;
  login: string;
  /** First name for the greeting. */
  name?: string;
  fetchFn?: Fetch;
  summaries?: Summaries;
  /** PR links the packs' pages show (src/packs/registry.ts linkedFrom): their state and title go in `refs`. */
  linked?: () => string[];
  ttlMs?: number;
  now?: () => number;
  /** Keeps the last snapshot between runs. */
  store?: SnapshotStore;
  /** After every gather that worked (the refresher publishes what changed). */
  onGathered?: (s: Snapshot) => void;
  /** How long a page waits after `stale()` for the new gather (default 1.5 s). */
  staleWaitMs?: number;
  /**
   * A gather running longer than this is given up and the next asks again (hosted: a Worker
   * request that was cancelled takes its fetches with it, and its gather never settles).
   */
  maxGatherMs?: number;
}): Gatherer {
  const { env, forge, login } = deps;
  const ttl = deps.ttlMs ?? 45_000;
  const now = deps.now ?? Date.now;
  /** The newest snapshot that worked; `at` is when it was gathered. */
  let last: Snapshot | undefined = deps.store?.load();
  let inflight: Promise<Snapshot> | undefined;
  let inflightAt = 0;
  /** stale() was called: the next page waits a moment for the gather. */
  let dirty = false;

  async function gather(): Promise<Snapshot> {
    const began = now();
    const [prs, notes, moves] = await Promise.all([
      settle(forge.prs(login, ownersIn(env))),
      settle(forge.notes()),
      settle(forge.moves(login, ownersIn(env))),
    ]);
    let linked: string[] = [];
    try {
      linked = deps.linked?.() ?? [];
    } catch {}

    // Deploys: repos a deploy notification named, and the repos my open PRs are in.
    const deployRepos = [
      ...(notes.ok ? notes.value.filter((n) => n.reason === "approval_requested").map((n) => n.repo) : []),
      ...(prs.ok ? prs.value.mine.map((p) => p.repo) : []),
    ];
    const known = new Set(prs.ok ? [...prs.value.mine, ...prs.value.review].map((p) => forge.prKeyOfUrl(p.url)) : []);
    const wanted = [
      ...linked.map((u) => forge.prKeyOfUrl(u)),
      ...(moves.ok ? moves.value.filter((m) => m.ref && !m.title).map((m) => m.ref) : []),
    ].filter((k): k is string => !!k && !known.has(k));
    const [deploys, refs, red] = await Promise.all([
      settle(forge.deploys?.(deployRepos) ?? Promise.resolve([])),
      forge.prRefs(wanted),
      notes.ok && forge.red ? forge.red(notes.value, prs.ok ? prs.value.mine.map((p) => p.repo) : []).catch(() => []) : Promise.resolve([]),
    ]);
    if (prs.ok) for (const p of [...prs.value.mine, ...prs.value.review]) refs.set(forge.prKeyOfUrl(p.url)!, { state: "OPEN", title: p.title, url: p.url });

    const changelogs = new Map<number, Result<Changelog>>();
    const changelog = forge.changelog;
    if (deploys.ok && changelog)
      await Promise.all(deploys.value.map(async (d) => changelogs.set(d.id, await settle(changelog(d.repo, d.envs[0]?.name ?? "prod", d.headSha)))));

    // Summaries in the background: every open PR at its head commit, every deploy's changelog.
    const sum = deps.summaries;
    if (sum) {
      if (prs.ok)
        for (const p of [...prs.value.review, ...prs.value.mine])
          if (p.headSha) sum.want(prSummaryKey(p), () => prPrompt({ ...p, files: p.files }));
      for (const [, c] of changelogs)
        if (c.ok && c.value.changes.length) {
          const days = c.value.prodAt ? Math.max(1, Math.round((now() - Date.parse(c.value.prodAt)) / 86400e3)) : 0;
          sum.want(deploySummaryKey(c.value), () => deployPrompt({ repo: c.value.repo, days, items: c.value.changes.map((x) => ({ kind: x.kind, title: x.title, author: x.author })) }));
        }
    }

    return { at: now(), began, login, org: env.GHE_ORG, prs, notes, moves, deploys, refs, changelogs, red, name: deps.name ?? login };
  }

  /** A stale() came while a gather ran: gather once more after it. */
  let again = false;
  function start(): Promise<Snapshot> {
    if (inflight && deps.maxGatherMs && now() - inflightAt > deps.maxGatherMs) {
      console.error(`gather: gave up on one running ${Math.round((now() - inflightAt) / 1000)} s; gathering again`);
      inflight = undefined;
    }
    if (inflight) return inflight;
    const p = gather().then((snap) => {
      last = snap;
      // stale() during this gather: it may have begun before the change, so another follows.
      if (!again) dirty = false;
      for (const after of [() => deps.store?.save(snap), () => deps.onGathered?.(snap)]) {
        try {
          after();
        } catch (e) {
          console.error("after a gather:", (e as Error).message);
        }
      }
      return snap;
    });
    inflight = p;
    inflightAt = now();
    // A failed gather keeps serving the last good snapshot; the next get() tries again.
    p.catch(() => undefined).finally(() => {
      if (inflight !== p) return;
      inflight = undefined;
      if (again) {
        again = false;
        void start().catch(() => undefined);
      }
    });
    return p;
  }

  const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms).unref?.());

  async function get(opts: { fresh?: boolean; wait?: boolean } = {}): Promise<Snapshot> {
    if (opts.fresh || !last) return start();
    if (now() - last.at >= ttl) void start().catch(() => undefined);
    if (dirty && inflight && opts.wait !== false) {
      const p = inflight;
      await Promise.race([p.catch(() => undefined), wait(deps.staleWaitMs ?? 1500)]);
    }
    return last;
  }

  return {
    get,
    stale() {
      dirty = true;
      if (inflight) again = true;
      void start().catch(() => undefined);
    },
    gathering: () => !!inflight,
    peek: () => last,
    seed(s) {
      if (!last || s.at > last.at) last = s;
    },
  };
}
