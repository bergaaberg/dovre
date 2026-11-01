/**
 * The agents desk (PLAN WP-N10): everything the agent pages do on the machine the agents run on,
 * behind one interface. Locally it's this file's `localDesk`, over the runner, the transcripts
 * and the code folder. Hosted it's the Mac's own `localDesk`, reached over the bridge
 * (src/bridge/), so every call here is also a call a hosted page may make of the Mac. Each one
 * checks what it's given as a route would: a harness found here, a checkout right under
 * CODE_DIR (or Dovre's own folder), modes default/acceptEdits/plan, an allow is a denied call's
 * spec, prompts bounded. The app keeps what's about the page: flashes, sessions cleared away
 * (the instance's database), redirects back.
 */
import { statSync } from "node:fs";
import type { Env } from "../env.ts";
import { type Session, listRepos, sessionById, tail, transcriptOf } from "../sources/claude.ts";
import { ompAgentDirs, ompSessionById, ompTranscriptOf, ompTurnsOf } from "../sources/omp.ts";
import { COPILOT_DIR, copilotEventsOf, copilotSessionById, copilotTurnsOf } from "../sources/copilot.ts";
import { allowedPrompt, answersPrompt, type Turn, turnsOf as claudeTurns } from "./conversation.ts";
import { joined, type Queue, type Queued } from "./queue.ts";
import { type TurnStat, turnCost as turnCostOf, turnStats } from "./latest.ts";
import { modelsOf, optionsOf } from "./harnesses/index.ts";
import { effortIn } from "./harnesses/shared.ts";
import { EFFORTS, type Effort, HARNESSES, type HarnessId, MODES, type Mode, type Run, type Runner, type StartOpts, repoDir } from "./runner.ts";
import { WORK, ensureWorkDir, inWorkDir, workDirOf } from "./workdir.ts";
import { isRepoError, type SandboxState } from "./sandbox.ts";
import { pairId, pairWorktree } from "./pair.ts";

export const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID = /^[\w-]{1,64}$/;

/** What's there now, drawn without waiting: locally the runner's; hosted the Mac's last word. */
export type DeskView = {
  /** Agents can run (a runner here, or the Mac online). */
  here: boolean;
  /** Hosted: whether the Mac is connected, and when it last was. Locally always online. */
  online: boolean;
  seen?: number;
  harnesses: HarnessId[];
  runs: Run[];
  /** Where Dovre's own folder is, to say so on the new-agent form. */
  workDir: string;
  /** Hosted: the desk is the Mac's, reached over the bridge (pages say when it's offline). */
  remote?: boolean;
  /** Hosted: the machines' sessions, as they last said (locally they're in the snapshot). */
  sessions?: { live: Session[]; recent: Session[] };
  /** Hosted: every paired machine (H7), online first. */
  machines?: MachineStatus[];
  /** Sandbox runs (src/agents/sandbox.ts): whether one can start, and why not. Absent where they aren't set up. */
  sandbox?: SandboxState;
};

/** Hosted: a paired machine, as pages name it. */
export type MachineStatus = { id: string; name: string; online: boolean; seen?: number };

/** A copy made of a session from here (a fork): its own session once the agent says which. */
export type Copy = { sid?: string; run: string; startedAt: number; status: Run["status"] };

/**
 * A session's page: the session, what was said, the run going on it, and what waits.
 * `replyCopies`: what I send goes to a copy (a terminal has the session open). `copies`: the
 * copies made of it from here; `copyOf`: the session this one is a copy of.
 */
export type SessionView = { session?: Session; turns: Turn[]; run?: Run; queued: Queued[]; discardable: boolean; turnCost?: number; /** Its turns started here: cost, time, diff (#241). */ stats?: TurnStat[]; replyCopies?: boolean; copies?: Copy[]; copyOf?: string };

/** A reply forks when the session is open elsewhere (a terminal; not a background agent, not this desk's own turn on it). */
export const replyCopies = (session: Session | undefined, run: Run | undefined) => !!session?.live && session.kind !== "background" && run?.status !== "running";

/** Where to go after an action, and what to say there. `started`: a turn began on the session. */
export type Done = { to: string; flash?: string; started?: boolean };

export type Desk = {
  view(): DeskView;
  /** Hosted: reads what the Mac last said again, before a page is drawn (the app calls it after its guard). */
  refresh?(): Promise<void>;
  /** The checkouts agents may start in: on `machine` (hosted; throws when it doesn't answer), else all of them. */
  repos(machine?: string): Promise<string[]>;
  /** Hosted: the machine a session or run is on. */
  machineOf?(id: string): MachineStatus | undefined;
  run(id: string): Promise<Run | undefined>;
  session(sid: string): Promise<SessionView | undefined>;
  /** `machine`: hosted, the machine to start on (the one online when there's one). */
  /** `sandbox`: run it in a sandbox (a fresh clone in a container, yolo inside), when the form ticked it. */
  /** `caps`: a sandbox run's base, wall clock, budget and effort (#207, auto runs); checked here. `run`: the run's id. */
  /** `effort`: a level from the harness's own list (#236). */
  /** `also`: a second harness to give the same prompt (#242); each side then runs in a worktree of its own, and `to` is the pair's page. */
  start(o: { repo?: unknown; prompt?: unknown; harness?: unknown; mode?: unknown; model?: unknown; effort?: unknown; machine?: unknown; sandbox?: unknown; caps?: unknown; also?: unknown }): Promise<{ to: string; run?: string } | { error: string; repo?: true }>;
  /** `copy`: ticked, the reply goes to a copy of the session (a harness that can fork), as it does on its own when a terminal has it open. */
  reply(sid: string, o: { prompt?: unknown; mode?: unknown; model?: unknown; effort?: unknown; copy?: unknown }): Promise<Done>;
  /** Answers to the agent's newest question (AskUserQuestion): the form as posted. */
  answer(sid: string, form: Record<string, unknown>): Promise<Done>;
  /** Allows the exact calls that were refused, and the agent goes on. */
  allow(sid: string, o: { specs?: unknown; mode?: unknown; model?: unknown; effort?: unknown }): Promise<Done>;
  dequeue(sid: string, id: string): Promise<void>;
  stop(sid: string): Promise<void>;
  stopRun(id: string): Promise<void>;
  /** Clears an ended session started here away: the sessions to drop from Dovre's lists, or why not. */
  discard(sid: string): Promise<{ cleared: string[] } | { flash: string }>;
  discardRun(id: string): Promise<{ cleared: string[] }>;
  /** A sandbox run's branch goes to origin (#206): checked, then pushed with the machine's own git credentials. */
  pushSandbox(id: string, to?: string): Promise<{ repo: string; branch: string; head: string } | { error: string }>;
  /** Its draft PR is open: the run keeps the link, and its clone goes. */
  landed(id: string, pr: { number?: unknown; url?: unknown }): Promise<void>;
  /** Everything started here that has ended. */
  clear(): Promise<{ cleared: string[] }>;
};

export const modeOf = (v: unknown): Mode => ((MODES as readonly string[]).includes(String(v)) ? (v as Mode) : "default");
/** A model the harness knows, else its default. */
export const modelOf = (v: unknown, h: HarnessId = "claude"): string => {
  const known = modelsOf(h).map((m) => m.value);
  return known.includes(String(v)) ? String(v) : "";
};
/** An effort the harness takes, else none (its own default). */
export const effortOf = (v: unknown, h: HarnessId = "claude"): string | undefined => effortIn(optionsOf(h).efforts, v);
/** A ticked checkbox, as a form or the bridge sends it. */
export const tickedOf = (v: unknown) => v === "on" || v === true;
/** A sandbox run's caps, as anyone may send them: a plain ref for the base, minutes 1–600 (as ms), dollars 0.01–1000, turns 1–500, a known effort. Anything else is left out. */
export function capsOf(v: unknown): Pick<StartOpts, "base" | "maxMs" | "budget" | "turns" | "effort"> {
  if (!v || typeof v !== "object") return {};
  const c = v as Record<string, unknown>;
  const out: Pick<StartOpts, "base" | "maxMs" | "budget" | "turns" | "effort"> = {};
  if (typeof c.base === "string" && REF.test(c.base) && !c.base.includes("..") && !c.base.endsWith(".lock") && !c.base.endsWith("/")) out.base = c.base;
  if (typeof c.maxMs === "number" && Number.isFinite(c.maxMs) && c.maxMs >= 60_000 && c.maxMs <= 600 * 60_000) out.maxMs = Math.round(c.maxMs);
  if (typeof c.budget === "number" && Number.isFinite(c.budget) && c.budget >= 0.01 && c.budget <= 1000) out.budget = Math.round(c.budget * 100) / 100;
  if (typeof c.turns === "number" && Number.isInteger(c.turns) && c.turns >= 1 && c.turns <= 500) out.turns = c.turns;
  if ((EFFORTS as readonly string[]).includes(String(c.effort))) out.effort = c.effort as Effort;
  return out;
}
/** A branch or remote-tracking ref: never an option (no leading dash), no revision syntax. */
const REF = /^[\w][\w./-]{0,120}$/;
export const promptOf = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= 20_000 ? v.trim() : null);
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
/** The specs of calls to allow: each one line, bounded, at most ten. */
export const specsOf = (v: unknown): string[] =>
  [v]
    .flat()
    .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 2000 && !/[\r\n]/.test(s))
    .slice(0, 10);

/** The last few transcripts parsed, kept until the file changes: a streaming session redraws up to 4×/s (#267). */
const parsed = new Map<string, { size: number; mtimeMs: number; parse: (text: string) => Turn[]; turns: Turn[] }>();
const PARSED_MAX = 8;
/** A transcript's turns (its last 3 MB), parsed again only when the file's size or mtime moved. Don't mutate the result. */
export function cachedTurns(file: string, parse: (text: string) => Turn[]): Turn[] {
  let st;
  try {
    st = statSync(file);
  } catch {
    parsed.delete(file);
    return [];
  }
  const hit = parsed.get(file);
  if (hit && hit.parse === parse && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    parsed.delete(file);
    parsed.set(file, hit); // newest last
    return hit.turns;
  }
  const turns = parse(tail(file, 3 * 1024 * 1024));
  parsed.delete(file);
  parsed.set(file, { size: st.size, mtimeMs: st.mtimeMs, parse, turns });
  if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value!);
  return turns;
}

/** A session by id, Claude Code's, omp's or Copilot CLI's, with its conversation. */
export function findSession(claudeDir: string, sid: string, live: Session[]): { session?: Session; turns: Turn[] } {
  const claude = sessionById(claudeDir, sid, live);
  if (claude && claude.harness !== "omp" && claude.harness !== "copilot") {
    const file = transcriptOf(claudeDir, sid);
    return { session: claude, turns: file ? cachedTurns(file, claudeTurns) : [] };
  }
  for (const { dir } of ompAgentDirs()) {
    const session = ompSessionById(dir, sid, live);
    if (!session) continue;
    const file = ompTranscriptOf(dir, sid);
    return { session, turns: file ? cachedTurns(file, ompTurnsOf) : [] };
  }
  const copilot = copilotSessionById(COPILOT_DIR, sid, live);
  if (copilot) {
    const file = copilotEventsOf(COPILOT_DIR, sid);
    return { session: copilot, turns: file ? cachedTurns(file, copilotTurnsOf) : [] };
  }
  return { session: claude, turns: [] };
}

/**
 * The desk on this machine. `sessions`: the agents' sessions as gathered here (the server's
 * snapshot, or the bridge's own read). `onStarted`: a turn began on a session (it comes back if
 * it was cleared away), including one the queue started by itself.
 */
export function localDesk(o: {
  env: Pick<Env, "CODE_DIR" | "CLAUDE_DIR" | "AGENT_DIR">;
  runner?: Runner;
  queue: Queue;
  sessions: () => Promise<{ live: Session[]; recent: Session[] }>;
  onStarted?: (sid: string) => void | Promise<void>;
  /** Makes one side's worktree of a pair (#242); src/agents/pair.ts, swapped in tests. */
  worktree?: (checkout: string, harness: HarnessId, id: string) => Promise<string>;
}): Desk {
  const { env, runner, queue } = o;
  const workDir = workDirOf(env);
  /** Where a new session runs: Dovre's folder (made on first use), or a checkout right under the code folder. */
  const cwdOf = (v: unknown): string | null => {
    if (v !== WORK) return repoDir(env.CODE_DIR, v);
    try {
      return ensureWorkDir(workDir);
    } catch {
      return null;
    }
  };
  // One this machine has, else the first it has.
  const harnessOf = (v: unknown): HarnessId => ((HARNESSES as readonly string[]).includes(String(v)) && runner?.harnesses().includes(v as HarnessId) ? (v as HarnessId) : (runner?.harnesses()[0] ?? "claude"));
  const page = (sid: string) => `/agents/s/${sid}`;
  const live = async () => (await o.sessions()).live;

  /** Starts the next turn of a session: resumed in place, or forked when a terminal still has it open. Where to go next. */
  async function next(sid: string, prompt: string, t: { mode: Mode; model: unknown; effort?: unknown; copy?: boolean }, allowed: string[] = [], q: { queuedFirst?: boolean } = {}): Promise<string> {
    if (!runner) throw new Error("Agents can't run here.");
    const current = runner.ofSession(sid);
    if (current?.status === "running") throw new Error("The agent is still working on the last turn.");
    // Its session lived in the container, which is gone: a sandbox run takes one prompt.
    if (current?.sandbox) throw new Error("A sandbox run takes one prompt: start a new one to carry on.");
    const session = findSession(env.CLAUDE_DIR, sid, await live()).session;
    const cwd = session?.cwd ?? current?.cwd;
    if (!cwd) throw new Error("Couldn't tell which folder this session ran in.");
    if (session?.harness === "copilot") throw new Error("Copilot CLI sessions are read here; reply to them in a terminal.");
    const harness: HarnessId = session?.harness ?? current?.harness ?? "claude";
    if (!runner.harnesses().includes(harness)) throw new Error(`${harness} can't run here.`);
    const fork = replyCopies(session, current) || (!!t.copy && optionsOf(harness).fork);
    if (fork && runner.copiesOf(sid).some((r) => r.status === "running")) throw new Error("A copy made from here is still working: reply in it, or wait for it to end.");
    // What I wrote while it worked goes along: before a reply of mine, after an answer to a permission or question.
    const waiting = queue.take(sid);
    const text = !waiting.length ? prompt : joined(q.queuedFirst ? [...waiting, { text: prompt }] : [{ text: prompt }, ...waiting]);
    let run;
    try {
      run = runner.start({ harness, cwd, prompt: text, resume: sid, fork, mode: t.mode, model: modelOf(t.model, harness), effort: effortOf(t.effort, harness), allowed });
    } catch (e) {
      for (const w of waiting) queue.add(sid, w);
      throw e;
    }
    // Talking to a session I'd cleared away brings it back.
    await o.onStarted?.(sid);
    if (!fork) return page(sid);
    const forked = await runner.sessionOf(run.id, 300);
    return forked ? page(forked) : `/agents/r/${run.id}`;
  }
  const started = async (sid: string, go: () => Promise<string>): Promise<Done> => {
    try {
      return { to: await go(), started: true };
    } catch (e) {
      return { to: page(sid), flash: String((e as Error).message) };
    }
  };
  // A turn that ended well takes what waits as the next turn (src/agents/queue.ts calls this).
  queue.onDrain(async (sid, items) => {
    const last = items[items.length - 1]!;
    await next(sid, joined(items), { mode: modeOf(last.mode), model: last.model, effort: last.effort });
  });
  const startedHere = (sid: string, cwd?: string) => !!runner?.ofSession(sid) || inWorkDir(workDir, cwd);
  const drop = (runs: Run[], sessions: string[]) => {
    for (const r of runs) runner?.discard(r.id);
    return { cleared: [...new Set([...runs.map((r) => r.sessionId).filter((x): x is string => !!x), ...sessions])] };
  };

  /**
   * The same prompt on two harnesses (#242): a worktree each, beside the checkout, then a turn each.
   * The first takes the form's model and effort; the second its own defaults. Both share the mode.
   */
  async function startPair(cwd: string, prompt: string, harness: HarnessId, f: Parameters<Desk["start"]>[0]): Promise<{ to: string; run?: string } | { error: string }> {
    const also = String(f.also);
    if (!runner) return { error: "Agents can't run here." };
    if (f.repo === WORK) return { error: "Two agents side by side work in worktrees of a checkout: pick one." };
    if (tickedOf(f.sandbox)) return { error: "Two agents side by side don't run in a sandbox (yet): untick one." };
    if (!(HARNESSES as readonly string[]).includes(also) || !runner.harnesses().includes(also as HarnessId)) return { error: `No ${also} here to compare with.` };
    if (also === harness) return { error: "Pick a different agent to compare with." };
    const id = pairId();
    const make = o.worktree ?? pairWorktree;
    const sides: [HarnessId, { model: unknown; effort: unknown }][] = [[harness, { model: f.model, effort: f.effort }], [also as HarnessId, { model: "", effort: "" }]];
    const dirs: string[] = [];
    try {
      for (const [h] of sides) dirs.push(await make(cwd, h, id));
    } catch (e) {
      return { error: String((e as Error).message) };
    }
    const runs = sides.map(([h, t], i) => runner.start({ harness: h, cwd: dirs[i]!, prompt, mode: modeOf(f.mode), model: modelOf(t.model, h), effort: effortOf(t.effort, h), pair: id }));
    return { to: `/agents/pair/${id}`, run: runs[0]!.id };
  }

  return {
    view: () => {
      const sandbox = runner?.sandbox();
      return { here: !!runner, online: true, harnesses: runner?.harnesses() ?? [], runs: runner?.list() ?? [], workDir, ...(sandbox ? { sandbox } : {}) };
    },
    repos: async () => listRepos(env.CODE_DIR),
    run: async (id) => (RUN_ID.test(id) ? runner?.get(id) : undefined),
    async session(sid) {
      if (!SID.test(sid)) return undefined;
      const found = findSession(env.CLAUDE_DIR, sid, await live());
      const session = found.session;
      const run = runner?.ofSession(sid);
      if (!session && !run) return undefined;
      const turns = found.turns.length ? found.turns : run ? [{ role: "user" as const, text: run.prompt }] : [];
      const discardable = run?.status !== "running" && !session?.live && (!!run || inWorkDir(workDir, session?.cwd));
      const turnCost = run ? turnCostOf(run, runner?.list() ?? []) : undefined;
      const copies = (runner?.copiesOf(sid) ?? []).map((r) => ({ sid: r.sessionId, run: r.id, startedAt: r.startedAt, status: r.status }));
      const copyOf = (runner?.list() ?? []).find((r) => r.forked && r.sessionId === sid)?.resumed;
      const stats = turnStats(sid, runner?.list() ?? []);
      return { session, turns, run, queued: queue.list(sid), discardable, turnCost, stats, replyCopies: replyCopies(session, run), copies, copyOf };
    },
    async start(f) {
      const cwd = cwdOf(f.repo);
      const prompt = promptOf(f.prompt);
      if (!runner) return { error: "Agents can't run here." };
      if (!cwd) return { error: f.repo === WORK ? `Couldn't make Dovre's folder at ${workDir}.` : "Pick a checkout in your code folder, or Dovre's own folder." };
      if (!prompt) return { error: "Say what the agent should do." };
      const harness = harnessOf(f.harness);
      const sandbox = tickedOf(f.sandbox);
      if (f.also !== undefined && f.also !== "") return startPair(cwd, prompt, harness, f);
      if (sandbox && f.repo === WORK) return { error: "A sandbox run works in a clone of a checkout: pick one." };
      let run;
      try {
        run = runner.start({ harness, cwd, prompt, mode: modeOf(f.mode), model: modelOf(f.model, harness), effort: effortOf(f.effort, harness), sandbox, ...(sandbox ? capsOf(f.caps) : {}) });
      } catch (e) {
        if (!sandbox) throw e;
        return { error: String((e as Error).message), ...(isRepoError(e) ? { repo: true as const } : {}) };
      }
      // Straight to the run: its page turns into the session's once the agent says which (a second or two).
      const sid = await runner.sessionOf(run.id, 300);
      return { to: sid ? page(sid) : `/agents/r/${run.id}`, run: run.id };
    },
    async reply(sid, f) {
      if (!SID.test(sid)) return { to: "/agents" };
      const prompt = promptOf(f.prompt);
      if (!prompt) return { to: page(sid) };
      // Still working: it waits for the turn to end, as in the terminal.
      if (runner?.ofSession(sid)?.status === "running") {
        const added = queue.add(sid, { text: prompt, mode: typeof f.mode === "string" ? f.mode : undefined, model: typeof f.model === "string" ? f.model : undefined, effort: typeof f.effort === "string" && f.effort.length <= 20 ? f.effort : undefined });
        return { to: page(sid), flash: added ? undefined : "Ten messages wait already: remove one, or wait for the turn to end." };
      }
      return started(sid, () => next(sid, prompt, { mode: modeOf(f.mode), model: f.model, effort: f.effort, copy: tickedOf(f.copy) }, [], { queuedFirst: true }));
    },
    async answer(sid, form) {
      if (!SID.test(sid)) return { to: "/agents" };
      const fromTranscript = [...findSession(env.CLAUDE_DIR, sid, await live()).turns].reverse().find((t) => t.role === "ask");
      const run = runner?.ofSession(sid);
      const fromRun = run ? [...run.events].reverse().find((e) => e.t === "ask") : undefined;
      const questions = fromTranscript?.role === "ask" ? fromTranscript.questions : fromRun?.t === "ask" ? fromRun.questions : null;
      if (!questions) return { to: page(sid) };
      const prompt = answersPrompt(questions, form as Parameters<typeof answersPrompt>[1]);
      if (!prompt) return { to: page(sid), flash: "Pick an answer first." };
      return started(sid, () => next(sid, prompt, { mode: modeOf(form.mode), model: one(form.model), effort: one(form.effort) }));
    },
    async allow(sid, f) {
      if (!SID.test(sid)) return { to: "/agents" };
      const specs = specsOf(f.specs);
      if (!specs.length) return { to: page(sid) };
      return started(sid, () => next(sid, allowedPrompt(specs), { mode: modeOf(one(f.mode)), model: one(f.model), effort: one(f.effort) }, specs));
    },
    async dequeue(sid, id) {
      if (SID.test(sid) && typeof id === "string") queue.remove(sid, id);
    },
    async stop(sid) {
      const run = SID.test(sid) ? runner?.ofSession(sid) : undefined;
      if (run) runner!.stop(run.id);
    },
    async stopRun(id) {
      const run = RUN_ID.test(id) ? runner?.get(id) : undefined;
      if (run) runner!.stop(run.id);
    },
    async discard(sid) {
      if (!SID.test(sid)) return { flash: "That isn't a session." };
      const session = findSession(env.CLAUDE_DIR, sid, await live()).session;
      // Its own runs; the copies made of it stay (they're sessions of their own).
      const runs = (runner?.list() ?? []).filter((r) => r.sessionId === sid || (r.resumed === sid && !r.forked));
      if (runs.some((r) => r.status === "running") || session?.live) return { flash: "It's still going: stop it first." };
      if (!runs.length && !startedHere(sid, session?.cwd)) return { flash: "Only sessions started in Dovre can be cleared away here." };
      return drop(runs, [sid]);
    },
    async discardRun(id) {
      const run = RUN_ID.test(id) ? runner?.get(id) : undefined;
      return run && run.status !== "running" ? drop([run], []) : { cleared: [] };
    },
    async pushSandbox(id, to) {
      if (!runner || !RUN_ID.test(id)) return { error: "That isn't a run here." };
      try {
        return await runner.pushSandbox(id, typeof to === "string" ? to : undefined);
      } catch (e) {
        return { error: String((e as Error).message).slice(0, 300) };
      }
    },
    async landed(id, pr) {
      const url = typeof pr?.url === "string" && /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr.url) ? pr.url : undefined;
      if (RUN_ID.test(id) && Number.isInteger(pr?.number) && url) runner?.landed(id, { number: pr.number as number, url });
    },
    async clear() {
      const runs = (runner?.list() ?? []).filter((r) => r.status !== "running");
      const sessions = (await o.sessions()).recent.filter((x) => inWorkDir(workDir, x.cwd)).map((x) => x.sessionId);
      return drop(runs, sessions);
    },
  };
}
