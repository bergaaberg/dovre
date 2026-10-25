/**
 * Dovre's own working folder: where an agent started here runs when the work isn't in one repo
 * (drafting an issue, an item from My list, a question). It's ~/.dovre/agents unless AGENT_DIR
 * moves it, never under CODE_DIR by default (a checkout there may have any name, an instance repo
 * included), isn't a repo, and holds a short note for the agent saying so. Sessions that ran in it were started here, so they can be cleared away.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Env } from "../env.ts";

/** The form value for "Dovre's own folder" in a repo picker (never a folder name: those can't hold "@"). */
export const WORK = "@dovre";
export const WORK_LABEL = "Dovre's own folder (no repo)";

export const workDirOf = (env: Pick<Env, "AGENT_DIR">, home = homedir()) => resolve(env.AGENT_DIR || join(home, ".dovre", "agents"));

const NOTE = `# Dovre's working folder

Agents started from Dovre run here when the work isn't in one repo: drafting an issue or an
issue, an item from a to-do list, a question. This folder isn't a repo. Work on code in its own
checkout, never here. Notes and scratch files may go here.
`;

/** Makes the folder (and its note for agents: CLAUDE.md for Claude Code, AGENTS.md for omp) when missing. */
export function ensureWorkDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const f = join(dir, name);
    if (!existsSync(f)) writeFileSync(f, NOTE);
  }
  return dir;
}

/** Whether a session ran in the working folder (or a folder inside it). */
export function inWorkDir(dir: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const a = resolve(cwd).toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(b + sep);
}
