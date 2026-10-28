/**
 * Agent turns run from Dovre: `claude -p` headless in a repo, either a new session or a
 * resumed one (forked when the original is still open in a terminal, so two writers never
 * share a transcript). Output is stream-json; each run keeps its events in memory, and the
 * transcript Claude writes is the lasting record.
 *
 * Permissions: in headless mode a tool that needs approval is denied, and the result lists
 * the denials. The page offers "Allow and continue", which resumes with exactly that tool
 * spec allowed. Modes are limited to default, acceptEdits and plan: never bypass outside a
 * sandbox. A sandbox run (src/agents/sandbox.ts) is the one place yolo is turned on: the runner
 * sets `HarnessOpts.yolo` itself, for a fresh clone inside a container, and nothing a caller
 * passes can.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { COPY_NOTE, type Question } from "./conversation.ts";
import { claudeHarness } from "./harnesses/claude/harness.ts";
import { mcpConfig, mcpEnv } from "./harnesses/shared.ts";
import type { SandboxBox, SandboxEngine, SandboxState } from "./sandbox.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const MODES = ["default", "acceptEdits", "plan"] as const;
export type Mode = (typeof MODES)[number];

export type AgentEvent =
  | { t: "text"; text: string }
  | { t: "tool"; name: string; detail: string }
  | { t: "denied"; tool: string; spec: string; detail: string }
  | { t: "result"; text: string; cost: number; error: boolean }
  | { t: "error"; text: string }
  | { t: "ask"; questions: Question[] };

/** Which agent CLI runs a session: each has its folder in src/agents/harnesses/<id>/ (src/agents/harnesses/index.ts). */
export const HARNESSES = ["claude", "omp", "agy", "codex"] as const;
export type HarnessId = (typeof HARNESSES)[number];

/**
 * What the runner needs to know about one agent CLI: how to start a turn, and how to read its
 * streamed output into the run. The prompt goes in on stdin when `stdinPrompt`, else as the last arg.
 */
export type Harness = {
  id: HarnessId;
  bin: string;
  /** Arguments before the harness's own: the script, when `bin` is node running an npm shim's target (src/tools.ts). */
  pre?: string[];
  args(o: HarnessOpts): string[];
  apply(run: Run, line: string): void;
  stdinPrompt: boolean;
  /** Whether it can continue a copy of a session (fork) instead of the session itself. */
  canFork: boolean;
  /** It reaches Dovre's MCP server through the environment (mcpEnv), not only its arguments: Codex, omp, agy. */
  mcpEnv?: boolean;
  /** It can run in a sandbox (src/agents/sandbox.ts): its program's name inside the image. */
  sandbox?: { bin: string };
};

/** What a harness builds its arguments from: what the caller asked, plus `yolo`, which only the runner sets, and only for a sandbox run. */
export type HarnessOpts = StartOpts & { yolo?: boolean };

export type Run = {
  id: string;
  harness: HarnessId;
  sessionId?: string;
  resumed?: string;
  forked: boolean;
  cwd: string;
  repo: string;
  prompt: string;
  mode: Mode;
  model: string;
  allowed: string[];
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  events: AgentEvent[];
  /** Text streaming in for the message being written now. */
  partial: string;
  cost: number;
  /** Hosted, with several machines: the one it ran on (H7). */
  machine?: string;
  /** A sandbox run (yolo inside a container): its clone, container and base commit. `cwd` stays the checkout it was cloned from. */
  sandbox?: SandboxBox;
};

export type StartOpts = {
  harness?: HarnessId; cwd: string; prompt: string; resume?: string; fork?: boolean; mode?: Mode; model?: string; allowed?: string[];
  /** Run in a sandbox: a fresh clone of `cwd` inside a container, in yolo mode. A new session only. */
  sandbox?: boolean;
  /** Dovre's MCP server for this turn (src/mcp.ts): its address and the turn's own token. Set by the runner, not the caller. */
  mcp?: { url: string; token: string };
};

/** Repos the user may start agents in: folders right under the code folder that are git checkouts. */
export function repoDir(codeDir: string, name: unknown): string | null {
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || name === "." || name === "..") return null;
  const dir = resolve(codeDir, name);
  if (!dir.startsWith(resolve(codeDir) + sep)) return null;
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, ".git")) ? dir : null;
  } catch {
    return null;
  }
}

export type Runner = {
  /** Which harnesses can run here. */
  harnesses(): HarnessId[];
  start(o: StartOpts): Run;
  get(id: string): Run | undefined;
  /** The newest run that belongs to a session (started it, or resumed it in place). A copy's run is the copy's, not the original's. */
  ofSession(sessionId: string): Run | undefined;
  /** The runs that made copies of a session (forked it), newest first. */
  copiesOf(sessionId: string): Run[];
  list(): Run[];
  stop(id: string): boolean;
  /** Forgets an ended run: off the lists, its files in the runs folder gone. The session's own transcript stays. */
  discard(id: string): boolean;
  /** Resolves when the run knows its session id (or ends), at most `ms` later. */
  sessionOf(id: string, ms?: number): Promise<string | undefined>;
  /** The running turn an MCP token was made for (src/mcp.ts); undefined once it has ended. */
  byMcpToken(token: string): Run | undefined;
  /** Whether sandbox runs can start here, and why not; undefined when they aren't set up at all. */
  sandbox(): SandboxState | undefined;
};

type Spawn = (bin: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) => ChildProcess;

/**
 * `host`: run each turn through `dovre agent-host` (launcher/agenthost.go), apart from this
 * process: the turn goes on when Dovre restarts, and is picked up again from `dir`. The host
 * writes the agent's stream filtered down to what's shown here (never tool results), so that
 * file is safe to keep. Without it (tests), turns are this process's children, as before.
 */
export type RunHost = { exe: string; dir: string };

/** A run as kept on disk: everything but what's rebuilt from its stream. */
type Kept = Omit<Run, "events" | "partial"> & { pid?: number; mcp?: string };

export function createRunner(opts: {
  harnesses?: Partial<Record<HarnessId, Harness>>; spawnFn?: Spawn; onChange?: (run: Run) => void; host?: RunHost; now?: () => number;
  /** Dovre's MCP server (src/mcp.ts): each turn gets its address and a token of its own, while `on()` says packs offer tools. */
  mcp?: { url: string; on?: () => boolean };
  /** Where sandbox runs go (src/agents/sandbox.ts). Without it, none start. */
  sandbox?: SandboxEngine;
} = {}): Runner {
  // Given harnesses are all there is (only what this machine has); without any, Claude Code's.
  const harnesses: Partial<Record<HarnessId, Harness>> = opts.harnesses ?? { claude: claudeHarness() };
  const spawnFn: Spawn = opts.spawnFn ?? ((b, a, o) => spawn(b, a, { cwd: o.cwd, env: o.env ? { ...process.env, ...o.env } : undefined, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
  const host = opts.spawnFn ? undefined : opts.host;
  const now = opts.now ?? Date.now;
  const runs = new Map<string, Run>();
  const children = new Map<string, ChildProcess>();
  const pids = new Map<string, number>();
  /** Each turn's MCP token (run id → token): kept apart from the run, so it's never drawn or sent to the Worker. */
  const mcpTokens = new Map<string, string>();
  const changed = (r: Run) => opts.onChange?.(r);
  /** A sandbox run that ended: its token's env file goes (the clone stays, for its commits). */
  const boxEnded = (r: Run) => {
    if (r.sandbox) opts.sandbox?.ended(r.sandbox);
  };
  /** A sandbox run is stopped when it runs past the cap, also when picked up after a restart. */
  const capped = (r: Run, stop: (id: string) => boolean) => {
    if (!r.sandbox || !opts.sandbox) return;
    const t = setTimeout(() => {
      if (r.status !== "running") return;
      stop(r.id);
      r.events.push({ t: "error", text: `Stopped: the sandbox run went past ${Math.round(opts.sandbox!.maxMs / 60_000)} minutes.` });
      changed(r);
    }, Math.max(0, r.startedAt + opts.sandbox.maxMs - now()));
    t.unref?.();
  };

  // ── Turns apart from this process (host) ──
  // Absolute, since the host runs in the agent's working directory.
  const file = (id: string, ext: string) => resolve(host!.dir, `${id}.${ext}`);
  const keep = (run: Run) => {
    const { events: _e, partial: _p, ...rest } = run;
    const kept: Kept = { ...rest, pid: pids.get(run.id), mcp: mcpTokens.get(run.id) };
    try {
      writeFileSync(file(run.id, "json"), JSON.stringify(kept));
    } catch {}
  };
  const alive = (pid: number | undefined) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  /** Reads what the host has written since last time; ends the run when the host says it's done. */
  function follow(run: Run, h: Harness) {
    let at = 0;
    let buf = "";
    let quiet = 0;
    const read = () => {
      let grew = false;
      try {
        const fd = openSync(file(run.id, "out.jsonl"), "r");
        try {
          const chunk = Buffer.alloc(64 * 1024);
          let n: number;
          while ((n = readSync(fd, chunk, 0, chunk.length, at)) > 0) {
            at += n;
            buf += chunk.subarray(0, n).toString("utf8");
            grew = true;
          }
        } finally {
          closeSync(fd);
        }
      } catch {}
      let nl: number;
      const knew = run.sessionId;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) h.apply(run, line);
      }
      if (run.sessionId !== knew) keep(run);
      return grew;
    };
    const finish = (status: Run["status"], error?: string) => {
      clearInterval(timer);
      read();
      if (run.status === "running") run.status = status;
      if (error && run.status === "failed") run.events.push({ t: "error", text: error.slice(-600) });
      run.endedAt ??= now();
      pids.delete(run.id);
      boxEnded(run);
      keep(run);
      changed(run);
    };
    const tick = () => {
      const grew = read();
      if (grew) changed(run);
      let code: number | undefined;
      try {
        code = JSON.parse(readFileSync(file(run.id, "exit.json"), "utf8")).code;
      } catch {}
      if (code !== undefined) {
        let err = "";
        try {
          err = readFileSync(file(run.id, "err.txt"), "utf8").trim();
        } catch {}
        return finish(code === 0 ? "done" : "failed", code === 0 ? undefined : err || `exit ${code}`);
      }
      // The host was ended from outside (Stop, a reboot): nothing more is coming.
      quiet = grew || alive(pids.get(run.id)) ? 0 : quiet + 1;
      // Stop sets "stopped" itself; a host gone on its own without an exit note failed.
      if (quiet >= 3) {
        let err = "";
        try {
          err = readFileSync(file(run.id, "err.txt"), "utf8").trim();
        } catch {}
        finish("failed", err || "The agent ended before it finished, without saying why.");
      }
    };
    const timer = setInterval(tick, 250);
    timer.unref?.();
    tick();
  }
  // Runs from before a restart: shown again, and followed if they're still going.
  if (host) {
    try {
      mkdirSync(host.dir, { recursive: true });
      for (const f of readdirSync(host.dir)) {
        if (!f.endsWith(".json") || f.endsWith(".exit.json")) continue;
        const path = join(host.dir, f);
        // A week of history; older runs go.
        if (now() - statSync(path).mtimeMs > 7 * 86_400_000) {
          for (const ext of ["json", "out.jsonl", "err.txt", "exit.json"]) rmSync(path.replace(/\.json$/, `.${ext}`), { force: true });
          continue;
        }
        try {
          const k = JSON.parse(readFileSync(path, "utf8")) as Kept;
          const h = harnesses[k.harness];
          if (!h || typeof k.id !== "string") continue;
          const { pid, mcp, ...rest } = k;
          const run: Run = { ...rest, events: [], partial: "" };
          runs.set(run.id, run);
          if (pid) pids.set(run.id, pid);
          if (typeof mcp === "string" && run.status === "running") mcpTokens.set(run.id, mcp);
          if (run.status === "running") {
            follow(run, h);
            capped(run, (id) => api.stop(id));
          } else {
            boxEnded(run);
            // Done: its events, once, from its stream.
            for (const line of readFileSync(file(run.id, "out.jsonl"), "utf8").split("\n")) if (line.trim()) h.apply(run, line.trim());
          }
        } catch {}
      }
    } catch {}
  }

  const api: Runner = {
    start(given) {
      const h = harnesses[given.harness ?? ((Object.keys(harnesses) as HarnessId[])[0] ?? "claude")];
      if (!h) throw new Error(`No ${given.harness} harness here.`);
      const box = !!given.sandbox;
      if (box) {
        if (!opts.sandbox) throw new Error("Sandbox runs aren't set up on this machine.");
        if (!h.sandbox) throw new Error(`${h.id} can't run in a sandbox yet.`);
        if (given.resume) throw new Error("A sandbox run starts a new session; it can't carry on an old one.");
        const st = opts.sandbox.state();
        if (!st.ok) throw new Error(st.why);
      }
      const fork = !!(given.resume && given.fork && h.canFork);
      const prompt = given.prompt;
      // A copy is told it's one, so it leaves the terminal's unfinished work alone (the page shows the note as a line).
      // Yolo is set here and nowhere else: whatever the caller passed, only a sandbox run has it.
      let o: HarnessOpts = { ...given, fork, prompt: fork ? `${COPY_NOTE}\n\n${given.prompt}` : given.prompt, yolo: box, ...(box ? { allowed: undefined } : {}) };
      const id = randomUUID();
      const sandbox = box ? opts.sandbox!.prepare({ id, repo: o.cwd }) : undefined;
      const run: Run = {
        id, harness: h.id, resumed: o.resume, forked: fork, sessionId: o.resume && !fork ? o.resume : undefined,
        cwd: o.cwd, repo: o.cwd.split(/[\\/]/).pop() ?? o.cwd, prompt, mode: o.mode ?? "default", model: o.model ?? "", allowed: o.allowed ?? [],
        status: "running", startedAt: now(), events: [], partial: "", cost: 0, ...(sandbox ? { sandbox } : {}),
      };
      runs.set(run.id, run);
      // A token per turn, good while the turn runs: Claude Code and Codex get it in their arguments
      // and environment, omp and agy in the environment for the stdio bridge (#172). Not into a sandbox.
      if (!box && opts.mcp && (opts.mcp.on?.() ?? true)) {
        const token = randomBytes(32).toString("base64url");
        mcpTokens.set(run.id, token);
        o = { ...o, mcp: { url: opts.mcp.url, token } };
      }
      const own = h.stdinPrompt ? h.args(o) : [...h.args(o), o.prompt];
      // In a sandbox the harness is the image's own program, run by the engine; never the host's.
      const cmd = sandbox ? opts.sandbox!.command(sandbox, [h.sandbox!.bin, ...own]) : { bin: h.bin, args: [...(h.pre ?? []), ...own] };
      capped(run, (rid) => api.stop(rid));
      if (host) {
        const child = spawn(host.exe, ["agent-host", "--out", file(run.id, "out.jsonl"), "--err", file(run.id, "err.txt"), "--exit", file(run.id, "exit.json"), "--", cmd.bin, ...cmd.args], {
          cwd: o.cwd,
          env: o.mcp && h.mcpEnv ? { ...process.env, ...mcpEnv(o.mcp) } : undefined,
          detached: true,
          windowsHide: true,
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", (e) => {
          run.events.push({ t: "error", text: String(e.message) });
          run.status = "failed";
          run.endedAt = now();
          boxEnded(run);
          keep(run);
          changed(run);
        });
        if (child.pid) pids.set(run.id, child.pid);
        child.stdin?.end(h.stdinPrompt ? o.prompt : "");
        child.unref();
        keep(run);
        follow(run, h);
        return run;
      }
      const child = spawnFn(cmd.bin, cmd.args, o.mcp && h.mcpEnv ? { cwd: o.cwd, env: mcpEnv(o.mcp) } : { cwd: o.cwd });
      children.set(run.id, child);
      let buf = "";
      let err = "";
      child.stdout?.on("data", (d) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) h.apply(run, line);
        }
        changed(run);
      });
      child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
      child.on("error", (e) => {
        run.events.push({ t: "error", text: String(e.message) });
        run.status = "failed";
        run.endedAt = Date.now();
        boxEnded(run);
        changed(run);
      });
      child.on("close", (code) => {
        if (buf.trim()) h.apply(run, buf.trim());
        children.delete(run.id);
        if (run.status === "running") run.status = code === 0 ? "done" : "failed";
        if (code !== 0 && run.status === "failed" && err.trim()) run.events.push({ t: "error", text: err.trim().slice(-600) });
        run.endedAt = Date.now();
        boxEnded(run);
        changed(run);
      });
      child.stdin?.end(h.stdinPrompt ? o.prompt : "");
      return run;
    },
    harnesses: () => (Object.keys(harnesses) as HarnessId[]).filter((k) => harnesses[k]),
    get: (id) => runs.get(id),
    ofSession(sessionId) {
      let hit: Run | undefined;
      for (const r of runs.values()) if ((r.sessionId === sessionId || (r.resumed === sessionId && !r.forked)) && (!hit || r.startedAt > hit.startedAt)) hit = r;
      return hit;
    },
    copiesOf: (sessionId) => [...runs.values()].filter((r) => r.forked && r.resumed === sessionId).sort((a, b) => b.startedAt - a.startedAt),
    list: () => [...runs.values()].sort((a, b) => b.startedAt - a.startedAt),
    stop(id) {
      const run = runs.get(id);
      const child = children.get(id);
      const pid = child?.pid ?? pids.get(id);
      if (!run || run.status !== "running" || (!child && !pid)) return false;
      run.status = "stopped";
      if (host) keep(run);
      // The container is a VM of its own: ending its client may leave it running.
      if (run.sandbox) opts.sandbox?.kill(run.sandbox);
      // The agent's own children (builds, tests) go too.
      if (process.platform === "win32" && pid) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else if (child) child.kill();
      else if (pid) {
        try {
          process.kill(pid);
        } catch {}
      }
      changed(run);
      return true;
    },
    discard(id) {
      const run = runs.get(id);
      if (!run || run.status === "running") return false;
      runs.delete(id);
      if (run.sandbox) opts.sandbox?.remove(run.sandbox);
      if (host) for (const ext of ["json", "out.jsonl", "err.txt", "exit.json"]) rmSync(file(id, ext), { force: true });
      changed(run);
      return true;
    },
    async sessionOf(id, ms = 20_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = runs.get(id);
        if (!r || r.sessionId || r.status !== "running") return r?.sessionId;
        await new Promise((res) => setTimeout(res, 150));
      }
      return runs.get(id)?.sessionId;
    },
    sandbox: () => opts.sandbox?.state(),
    byMcpToken(token) {
      if (typeof token !== "string" || token.length < 32) return undefined;
      const given = Buffer.from(token);
      for (const [id, t] of mcpTokens) {
        const run = runs.get(id);
        // A turn that ended (or was forgotten) takes its token with it.
        if (!run || run.status !== "running") {
          mcpTokens.delete(id);
          continue;
        }
        const want = Buffer.from(t);
        if (want.length === given.length && timingSafeEqual(want, given)) return run;
      }
      return undefined;
    },
  };
  return api;
}
