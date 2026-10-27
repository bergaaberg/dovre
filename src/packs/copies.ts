/**
 * Local only (#152 step 2): the packs this machine's PACKS folders copied from dovre-packs, their
 * state against the local checkout (src/packs/update.ts, no network), and Update as a job. The
 * Packs page reads `get()`, the newest kept answer, worked out again in the background. An update
 * re-checks the state, rewrites the pack (all or nothing), then runs the instance's typecheck and
 * test; if either fails, the pack's files go back as they were. The new code loads on a restart.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePacksRepo } from "./cli.ts";
import { type FileChange, filesOf, instancePath, META, outdated, type PackState, readMeta, updatePack } from "./update.ts";

export type CopyJob = { at: number; state: "running" | "done" | "failed"; step: string; changes?: FileChange[]; /** The end of the failing check's output. */ out?: string };
export type Copy = { id: string; into: string; state: PackState; source: string | null; commit: string | null; job?: CopyJob };
export type Check = (into: string) => Promise<{ ok: boolean; step: string; out: string }>;

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
export const instanceCheck: Check = async (into) => {
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

export function createCopies(o: { packs: string | undefined; home?: string; repo?: () => string; check?: Check; onChange?: () => void; env?: Record<string, string | undefined>; now?: () => number }) {
  const now = o.now ?? Date.now;
  const repoOf = o.repo ?? (() => resolvePacksRepo(undefined, undefined, false));
  const check = o.check ?? instanceCheck;
  const folders = foldersOf(o.packs, o.home);
  const jobs = new Map<string, CopyJob>();
  let kept: { at: number; copies: Map<string, Copy> } | undefined;
  let pending = false;

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

  function refresh(): Map<string, Copy> {
    try {
      kept = { at: now(), copies: compute() };
    } catch {
      kept = { at: now(), copies: new Map() };
    }
    return kept.copies;
  }

  const changed = () => {
    refresh();
    o.onChange?.();
  };

  return {
    /** The kept answer, with each job's progress; worked out again in the background once a minute old. */
    get(): Map<string, Copy> {
      if ((!kept || now() - kept.at > 60_000) && !pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          changed();
        }, 0);
      }
      const out = new Map<string, Copy>();
      for (const [id, c] of kept?.copies ?? []) out.set(id, { ...c, job: jobs.get(id) });
      return out;
    },
    refresh,
    /**
     * Starts updating pack `id` if, checked again now, it's tracked and upstream has something new.
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
            jobs.set(id, { at: now(), state: "done", step: "updated; restart Dovre to load it", changes });
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
