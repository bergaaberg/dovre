/**
 * The agent harnesses core runs turns in, one folder each (src/agents/harnesses/<id>/): its adapter
 * (which program, which flags per mode, how its stream reads) and, in the agent host, its filter
 * (launcher/keep_<id>.go). Adding one touches its folder, its keep file, and this list.
 *
 * They stay in core, not packs: the flags and what's kept are the security boundary (#107).
 */
import type { Harness, HarnessId } from "../runner.ts";
import { findTool, type Tool } from "../../tools.ts";
import { agy } from "./agy/harness.ts";
import { claude } from "./claude/harness.ts";
import { codex } from "./codex/harness.ts";
import { omp } from "./omp/harness.ts";
import type { HarnessCtx, HarnessDef } from "./shared.ts";

export type { HarnessCtx, HarnessDef } from "./shared.ts";

export const HARNESS_DEFS: readonly HarnessDef[] = [claude, omp, agy, codex];

export const harnessDef = (id: HarnessId): HarnessDef => HARNESS_DEFS.find((d) => d.id === id)!;

let found: ((id: HarnessId) => { value: string; label: string }[]) | undefined;
/** The local server reads each CLI's own config for its models (#238); hosted, the fixed lists stay. */
export const useFoundModels = (f: typeof found) => void (found = f);

/** The models a turn in this harness may pick: the CLI's default, then those its config names, else the fixed list. */
export const modelsOf = (id: HarnessId) => {
  const fixed = harnessDef(id).models;
  const mine = found?.(id) ?? [];
  return mine.length ? [fixed[0]!, ...mine] : fixed;
};

/** The options a turn in this harness may pick besides the model (#236). */
export const optionsOf = (id: HarnessId) => harnessDef(id).options;

/** Each harness's program, where this machine has it. */
export function findHarnessTools(env: Partial<Record<HarnessDef["binVar"], string>>): Partial<Record<HarnessId, Tool>> {
  const out: Partial<Record<HarnessId, Tool>> = {};
  for (const d of HARNESS_DEFS) {
    const t = findTool(d.bin, env[d.binVar]);
    if (t) out[d.id] = t;
  }
  return out;
}

/** The runner's adapters: each harness this machine has and the settings leave on. */
export function harnessesFor(tools: Partial<Record<HarnessId, Tool>>, on: (id: HarnessId) => boolean, ctx: HarnessCtx = {}): Partial<Record<HarnessId, Harness>> {
  const out: Partial<Record<HarnessId, Harness>> = {};
  for (const d of HARNESS_DEFS) {
    const t = tools[d.id];
    if (t && on(d.id)) out[d.id] = d.make(t, ctx);
  }
  return out;
}
