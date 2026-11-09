/**
 * `ctx.run`, `ctx.onPath` and `ctx.dir` (API 1.26, #474): a pack runs a program without reaching
 * for core's `runOff` and `findTool`. Local only. It starts only what its manifest names
 * (`requiredBinaries`, `binaries`), by name, off the main thread, in one of the checkouts or in the
 * pack's own folder. Agent CLIs are never started here: agent turns go through the agent host.
 *
 * The folder is where the program starts, not a fence around it: what a program does with its
 * arguments is the program's. The rule keeps a pack's own code from starting something it never
 * named, or somewhere it never meant.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { runOff } from "../spawn.ts";
import { AGENT_CLIS, findTool, type Tool } from "../tools.ts";
import type { PackManifest, PackRan, PackRunOpts } from "./types.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const bare = (name: string) => name.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
const isAgentCli = (name: string) => (AGENT_CLIS as readonly string[]).includes(bare(name));

/** The programs a pack named, agent CLIs and anything that isn't a plain name left out. */
export function programsOf(m: Pick<PackManifest, "requiredBinaries" | "binaries">): string[] {
  const named = [...(m.requiredBinaries ?? []), ...(m.binaries ?? [])];
  return [...new Set(named.filter((b) => typeof b === "string" && NAME.test(b) && !isAgentCli(b)))];
}

/** A pack's own folder: `packs/<id>` next to the database. */
export const packDirOf = (dbPath: string | undefined, id: string) => join(resolve(dbPath || "data/dovre.sqlite"), "..", "packs", id);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const within = (dir: string, base: string) => dir === base || dir.startsWith(base.endsWith(sep) ? base : base + sep);

export type ProgramsDeps = {
  /** The pack's own folder (made when first asked for). */
  dir: string;
  /** The checkouts' folders now. */
  checkouts: () => string[];
  find?: (name: string) => Tool | undefined;
  runOff?: typeof runOff;
};

export function programsFor(m: Pick<PackManifest, "id" | "requiredBinaries" | "binaries">, deps: ProgramsDeps) {
  const find = deps.find ?? ((name: string) => findTool(name));
  const start = deps.runOff ?? runOff;
  const found = new Map<string, Tool>();
  const dir = () => {
    mkdirSync(deps.dir, { recursive: true });
    return deps.dir;
  };
  /** Throws on a name the pack may never run; undefined when it may but it isn't on PATH. */
  const tool = (binary: string): Tool | undefined => {
    if (typeof binary !== "string" || !NAME.test(binary)) throw new TypeError(`ctx.run: ${JSON.stringify(binary)} isn't a program's name (no paths)`);
    if (isAgentCli(binary)) throw new Error(`ctx.run: ${binary} is an agent, and agents don't start here (ctx.agent)`);
    if (!programsOf(m).includes(binary)) throw new Error(`ctx.run: ${m.id} doesn't name ${binary} in its manifest (binaries)`);
    let t = found.get(binary);
    if (!t && (t = find(binary))) found.set(binary, t);
    return t;
  };
  const cwdOf = (cwd: string | undefined): string => {
    if (cwd === undefined) return dir();
    const at = typeof cwd === "string" && cwd ? real(resolve(cwd)) : undefined;
    const bases = [real(dir()), ...deps.checkouts().map(real)].filter((b): b is string => !!b);
    if (!at || !bases.some((b) => within(at, b))) throw new Error(`ctx.run: ${JSON.stringify(cwd)} isn't in a checkout or in ${m.id}'s own folder`);
    return at;
  };
  return {
    dir,
    onPath: (binary: string): boolean => !!tool(binary),
    run: async (binary: string, args: string[], opts: PackRunOpts = {}): Promise<PackRan> => {
      const t = tool(binary);
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new TypeError("ctx.run: args is a list of strings");
      const cwd = cwdOf(opts.cwd);
      if (!t) throw new Error(`${binary} isn't on PATH`);
      return start(t.bin, [...t.pre, ...args], { ...opts, cwd });
    },
  };
}
