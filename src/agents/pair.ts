/**
 * The same prompt on two harnesses, side by side (#242). Each run gets a worktree of its own,
 * beside the checkout in the code folder, on a new branch from the checkout's HEAD, so neither
 * sees the other's edits and both are ordinary checkouts there (with their own Diff page).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentEvent, Run } from "./runner.ts";

/** A pair's id: short, so its folders and branches stay readable. */
export const PAIR_ID = /^[0-9a-f]{8}$/;
export const pairId = () => randomBytes(4).toString("hex");

/** The branch and folder name of one side of a pair: `<checkout>-<harness>-<id>`. */
export const pairName = (checkout: string, harness: string, id: string) => `${checkout}-${harness}-${id}`;

/** Creates one side's worktree beside `checkout` (a folder right under the code folder): its path. */
export async function pairWorktree(checkout: string, harness: string, id: string): Promise<string> {
  if (!PAIR_ID.test(id) || !/^[a-z]+$/.test(harness)) throw new Error("Not a pair.");
  const name = pairName(basename(checkout), harness, id);
  const dir = join(dirname(checkout), name);
  if (existsSync(dir)) throw new Error(`${name} is there already.`);
  await new Promise<void>((ok, no) =>
    execFile("git", ["worktree", "add", "-b", `dovre/${name}`, "--", dir, "HEAD"], { cwd: checkout, timeout: 120_000, windowsHide: true }, (e, _out, err) =>
      e ? no(new Error(`Couldn't make a worktree of ${basename(checkout)}: ${String(err || e.message).trim().split("\n").pop()}`)) : ok(),
    ),
  );
  return dir;
}

/** What a run said last: its last message, else its result. */
export function lastSaid(r: Pick<Run, "events">): string {
  const ev = r.events as AgentEvent[];
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i]!;
    if (e.t === "text" && e.text.trim()) return e.text;
  }
  const res = ev.findLast((e) => e.t === "result" || e.t === "error");
  return res && "text" in res ? res.text : "";
}
