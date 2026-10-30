/**
 * The Mac's side of the bridge (PLAN D24, WP-N10): the calls a hosted page may make of the Mac's
 * desk, and the state the hub is told of. A call is one of the desk's own (src/agents/desk.ts),
 * which checks what it's given as a route would; nothing else is answered: no terminals, no shell,
 * no files.
 *
 * What the hub keeps (`stateOf`) is metadata only: runs' ids, status, mode and model, the first
 * line of the prompt, cost, and the specs of calls that were denied; sessions as the snapshot holds
 * them. What a turn said goes only in answer to a call.
 */
import type { Desk } from "../agents/desk.ts";
import type { Run } from "../agents/runner.ts";
import { harnessDef, modelsOf } from "../agents/harnesses/index.ts";
import type { Session } from "../sources/claude.ts";
import { type Call, MAX_FRAME, type MacState } from "./wire.ts";

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length <= max ? v : "");

/** A run as the hub may keep it: what lists draw (status, the denied calls, the prompt's first line), never what was said. */
export function runMeta(r: Run): Run {
  // What a sandbox run made: its branch and PR, not its commits' subjects or paths (the agent wrote those).
  const out = r.out?.state === "ready" ? { ...r.out, commits: [], files: [] } : r.out;
  return {
    ...r,
    ...(out ? { out } : {}),
    prompt: r.prompt.split("\n")[0]!.slice(0, 200),
    events: r.events.filter((e) => e.t === "denied"),
    partial: "",
  };
}

export function stateOf(desk: Desk, sessions: { live: Session[]; recent: Session[] }, o: { at?: number; version?: string; name?: string } = {}): MacState {
  const v = desk.view();
  // The models found in each CLI's config here (#238); a harness on its fixed list sends none.
  const found = v.harnesses.flatMap((h) => (modelsOf(h) === harnessDef(h).models ? [] : [[h, modelsOf(h)] as const]));
  return { at: o.at ?? Date.now(), version: o.version, ...(o.name ? { name: o.name } : {}), harnesses: v.harnesses, runs: v.runs.map(runMeta), sessions, workDir: v.workDir, ...(v.sandbox?.ok ? { sandbox: true } : {}), ...(found.length ? { models: Object.fromEntries(found) } : {}) };
}

/** Leaves room for the frame around an answer. */
const ROOM = MAX_FRAME - 20_000;

/** Answers one call of the desk. An unknown op is an error, never a guess. */
export async function answerCall(desk: Desk, c: Call): Promise<unknown> {
  const sid = str(c.sid, 64);
  const id = str(c.id, 64);
  switch (c.op) {
    case "view":
      return desk.view();
    case "repos":
      return desk.repos();
    case "run":
      return (await desk.run(id)) ?? null;
    case "session": {
      const v = await desk.session(sid);
      if (!v) return null;
      // A long conversation is sent from its end: the oldest turns go until it fits one frame.
      let turns = v.turns;
      while (turns.length > 1 && JSON.stringify({ ...v, turns }).length > ROOM) turns = turns.slice(Math.ceil(turns.length / 10));
      return { ...v, turns };
    }
    case "start":
      return desk.start({ repo: c.repo, prompt: c.prompt, harness: c.harness, mode: c.mode, model: c.model, effort: c.effort, sandbox: c.sandbox, caps: c.caps, also: c.also });
    case "reply":
      return desk.reply(sid, { prompt: c.prompt, mode: c.mode, model: c.model, effort: c.effort, copy: c.copy });
    case "answer":
      return desk.answer(sid, c.form && typeof c.form === "object" ? (c.form as Record<string, unknown>) : {});
    case "allow":
      return desk.allow(sid, { specs: c.specs, mode: c.mode, model: c.model, effort: c.effort });
    case "dequeue":
      return desk.dequeue(sid, id);
    case "stop":
      return desk.stop(sid);
    case "stopRun":
      return desk.stopRun(id);
    case "discard":
      return desk.discard(sid);
    case "discardRun":
      return desk.discardRun(id);
    case "clear":
      return desk.clear();
    case "pushSandbox":
      return desk.pushSandbox(id, typeof c.to === "string" ? c.to : undefined);
    case "landed":
      return desk.landed(id, c.pr && typeof c.pr === "object" ? (c.pr as { number?: unknown; url?: unknown }) : {});
  }
  throw new Error(`The Mac doesn't do "${c.op.slice(0, 40)}".`);
}
