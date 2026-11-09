/**
 * Local only (#152 step 2): the packs this machine's PACKS folders copied from dovre-packs, their
 * state against the local checkout's releases (src/packs/update.ts; tags fetched in the background
 * at most every 10 minutes), and Update to the newest release as a job. The
 * Packs page reads `get()`, the newest kept answer, worked out again in the background. An update
 * re-checks the state, rewrites the pack (all or nothing), then runs the instance's typecheck and
 * test; if either fails, the pack's files go back as they were. The new code loads on a restart.
 * Add (#88) copies a pack the instance doesn't have yet into the first PACKS folder with a packs.ts
 * (`pnpm packs add`'s work), runs the same checks, and takes it all out again if they fail.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addPack, listAvailablePacks, resolvePacksRepo } from "./cli.ts";
import { type Listed, listedOf } from "./releases.ts";
import { type FileChange, filesOf, gitShow, instancePath, META, outdated, type PackState, readMeta, releasesOf, sourceAllowed, sourceOf, updatePack, upstreamPath } from "./update.ts";

type CopyJob = { at: number; state: "running" | "done" | "failed"; step: string; changes?: FileChange[]; /** The end of the failing check's output. */ out?: string; /** Hosted Add: the PR it opened. */ url?: string };
export type Copy = { id: string; into: string; state: PackState; source: string | null; commit: string | null; job?: CopyJob };
export type Check = (into: string) => Promise<{ ok: boolean; step: string; out: string }>;
/** A pack in the checkout, to add, and how its add went. */
export type ToAdd = Listed & { job?: CopyJob };

/** Each pack in a dovre-packs checkout, as its newest release's index.ts says (HEAD's when it has none). */
function listedIn(repo: string): Listed[] {
  return listAvailablePacks(repo).flatMap((id) => {
    const at = upstreamPath(repo, id);
    if (!at) return [];
    const r = releasesOf(repo, id)[0] ?? null;
    let index: string | undefined;
    try {
      index = r ? gitShow(repo, r.tag, `${at}/index.ts`)?.toString("utf8") : readFileSync(join(repo, at, "index.ts"), "utf8");
    } catch {}
    return index === undefined ? [] : [listedOf(id, index, r)];
  });
}

/** The instance file that lists its packs: packs.ts. */
const entryOf = (into: string) => [join(into, "packs.ts")].find((f) => existsSync(f));

/** The instance folders in a PACKS setting (a file entry means the folder it's in). */
export function foldersOf(list: string | undefined, home = process.env.HOME ?? "~"): string[] {
  return [
    ...new Set(
      (list ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^~(?=\/|$)/, home).replace(/\/$/, ""))
        .filter(Boolean)
        .map((p) => (/\.(ts|js|mjs)$/.test(p) ? dirname(p) : p)),
    ),
  ];
}

const run = (cwd: string, script: string) =>
  new Promise<{ ok: boolean; out: string }>((done) =>
    execFile(process.execPath, ["--run", script], { cwd, timeout: 600_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}` })),
  );

/** The instance's own typecheck, then its tests (each only if its package.json has it). */
const instanceCheck: Check = async (into) => {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(into, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {}
  for (const step of ["typecheck", "test"]) {
    if (!scripts[step]) continue;
    const r = await run(into, step);
    if (!r.ok) return { ok: false, step, out: r.out };
  }
  return { ok: true, step: "checked", out: "" };
};

export function createCopies(o: { packs: string | undefined; home?: string; repo?: () => string; check?: Check; onChange?: () => void; env?: Record<string, string | undefined>; now?: () => number; /** false: never fetch tags (tests). */ fetch?: boolean }) {
  const now = o.now ?? Date.now;
  const repoOf = o.repo ?? (() => resolvePacksRepo(undefined, undefined, false));
  const check = o.check ?? instanceCheck;
  const folders = foldersOf(o.packs, o.home);
  const jobs = new Map<string, CopyJob>();
  const adds = new Map<string, CopyJob>();
  let kept: { at: number; copies: Map<string, Copy>; listed: Listed[] } | undefined;
  /** Where Add puts a pack: the first PACKS folder that lists its packs in a file. */
  const target = () => folders.find((f) => entryOf(f));
  let pending = false;
  let fetchedAt = -Infinity;
  /** Fetches the checkout's tags without blocking, at most every 10 minutes; offline is fine. */
  const fetchTags = () =>
    new Promise<void>((done) => {
      if (now() - fetchedAt < 600_000 || o.fetch === false) return done();
      fetchedAt = now();
      let repo: string;
      try {
        repo = repoOf();
      } catch {
        return done();
      }
      execFile("git", ["-C", repo, "fetch", "--tags", "--quiet", "origin"], { timeout: 20_000 }, () => done());
    });

  function compute(): Map<string, Copy> {
    const out = new Map<string, Copy>();
    let repo: string;
    try {
      repo = repoOf();
    } catch {
      return out;
    }
    for (const into of folders)
      for (const state of outdated(into, repo)) {
        if (out.has(state.id)) continue;
        let meta;
        try {
          meta = readMeta(instancePath(into, state.id));
        } catch {}
        out.set(state.id, { id: state.id, into, state, source: meta?.source ?? null, commit: meta?.commit ?? null });
      }
    return out;
  }

  function listedNow(): Listed[] {
    try {
      return listedIn(repoOf());
    } catch {
      return [];
    }
  }

  function refresh(): Map<string, Copy> {
    let copies: Map<string, Copy>;
    try {
      copies = compute();
    } catch {
      copies = new Map();
    }
    kept = { at: now(), copies, listed: kept?.listed ?? [] };
    return copies;
  }

  const changed = () => {
    refresh();
    kept!.listed = listedNow();
    o.onChange?.();
  };

  return {
    /** The kept answer, with each job's progress; worked out again in the background once a minute old. */
    get(): Map<string, Copy> {
      if ((!kept || now() - kept.at > 60_000) && !pending) {
        pending = true;
        setTimeout(() => {
          void fetchTags().then(() => {
            pending = false;
            changed();
          });
        }, 0);
      }
      const out = new Map<string, Copy>();
      for (const [id, c] of kept?.copies ?? []) out.set(id, { ...c, job: jobs.get(id) });
      return out;
    },
    refresh,
    /** The checkout's packs, each with its Add's progress (the page leaves out those already here). */
    listed(): ToAdd[] {
      return (kept?.listed ?? []).map((l) => ({ ...l, job: adds.get(l.id) }));
    },
    /** The instance folder Add writes into, if PACKS has one with a packs.ts. */
    target,
    /**
     * Starts adding pack `id` from the checkout, if, checked again now, it's there, this core can run
     * it, the checkout comes from an allowed source and the instance doesn't have it. `done` hears how
     * it ended (for the actions log).
     */
    add(id: string, done?: (ok: boolean, detail: string) => void): { ok: true } | { ok: false; why: string } {
      if (adds.get(id)?.state === "running") return { ok: false, why: "already adding" };
      const into = target();
      if (!into) return { ok: false, why: "PACKS has no instance folder with a packs.ts" };
      let repo: string;
      try {
        repo = repoOf();
      } catch (e) {
        return { ok: false, why: (e as Error)?.message ?? String(e) };
      }
      const l = listedIn(repo).find((x) => x.id === id);
      if (!l) return { ok: false, why: "not a pack in dovre-packs" };
      if (l.needsCore) return { ok: false, why: `needs core API ${l.api}: update Dovre first` };
      if (!sourceAllowed(sourceOf(repo), o.env)) return { ok: false, why: "the dovre-packs checkout comes from a repo outside REPO_OWNERS" };
      const dirs = [join(into, "packs", id)];
      if (dirs.some((d) => existsSync(d))) return { ok: false, why: "already in the instance" };
      const entry = entryOf(into)!;
      const listing = readFileSync(entry);
      const undo = () => {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
        writeFileSync(entry, listing);
      };
      try {
        addPack({ id, into, from: repo, allowClone: false, to: l.tag ?? undefined });
      } catch (e) {
        undo();
        const why = (e as Error)?.message ?? String(e);
        adds.set(id, { at: now(), state: "failed", step: why });
        done?.(false, why);
        changed();
        return { ok: true };
      }
      adds.set(id, { at: now(), state: "running", step: "running the instance's typecheck and tests" });
      changed();
      void check(into)
        .catch((e: unknown) => ({ ok: false, step: "check", out: String((e as Error)?.message ?? e) }))
        .then((r) => {
          if (r.ok) {
            adds.set(id, { at: now(), state: "done", step: `added${l.version ? ` ${l.version}` : ""}; restart Dovre to load it` });
            done?.(true, l.version ?? "HEAD");
          } else {
            undo();
            adds.set(id, { at: now(), state: "failed", step: `${r.step} failed, so the pack was taken out again`, out: r.out.slice(-2000) });
            done?.(false, `${r.step} failed; taken out`);
          }
          changed();
        });
      return { ok: true };
    },
    /**
     * Starts updating pack `id` to its newest release if, checked again now, it's tracked and that
     * release has something new.
     * `done` hears how it ended (for the actions log).
     */
    update(id: string, done?: (ok: boolean, detail: string) => void): { ok: true } | { ok: false; why: string } {
      if (jobs.get(id)?.state === "running") return { ok: false, why: "already updating" };
      const c = refresh().get(id);
      if (!c) return { ok: false, why: "not a pack copied from dovre-packs here" };
      if (!c.state.tracked) return { ok: false, why: `copied before .pack.json: run pnpm packs track ${id}` };
      if (c.state.gone) return { ok: false, why: "no longer in dovre-packs" };
      if (!c.state.upstream.length) return { ok: false, why: "already up to date" };
      const dir = instancePath(c.into, id);
      const before = new Map([...filesOf(dir), ...(existsSync(join(dir, META)) ? [META] : [])].map((f) => [f, readFileSync(join(dir, f))]));
      let changes: FileChange[];
      try {
        changes = updatePack({ id, into: c.into, repo: repoOf(), env: o.env }).changes;
      } catch (e) {
        const why = (e as Error)?.message ?? String(e);
        jobs.set(id, { at: now(), state: "failed", step: why });
        done?.(false, why);
        changed();
        return { ok: true };
      }
      jobs.set(id, { at: now(), state: "running", step: "running the instance's typecheck and tests", changes });
      changed();
      void check(c.into)
        .catch((e: unknown) => ({ ok: false, step: "check", out: String((e as Error)?.message ?? e) }))
        .then((r) => {
          if (r.ok) {
            jobs.set(id, { at: now(), state: "done", step: `updated${c.state.newest ? ` to ${c.state.newest}` : ""}; restart Dovre to load it`, changes });
            done?.(true, `${changes.length} file${changes.length === 1 ? "" : "s"}`);
          } else {
            for (const f of filesOf(dir)) if (!before.has(f)) rmSync(join(dir, f), { force: true });
            for (const [f, body] of before) {
              mkdirSync(dirname(join(dir, f)), { recursive: true });
              writeFileSync(join(dir, f), body);
            }
            jobs.set(id, { at: now(), state: "failed", step: `${r.step} failed, so the update was undone`, changes, out: r.out.slice(-2000) });
            done?.(false, `${r.step} failed; rolled back`);
          }
          changed();
        });
      return { ok: true };
    },
  };
}
export type Copies = ReturnType<typeof createCopies>;
