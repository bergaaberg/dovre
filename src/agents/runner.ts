/**
 * Agent turns run from Dovre: `claude -p` headless in a repo, either a new session or a
 * resumed one (forked when the original is still open in a terminal, so two writers never
 * share a transcript). Output is stream-json; each run keeps its events in memory, and the
 * transcript Claude writes is the lasting record.
 *
 * Permissions: in headless mode a tool that needs approval is denied, and the result lists
 * the denials. The page offers "Allow and continue", which resumes with exactly that tool
 * spec allowed. Modes are limited to default, acceptEdits and plan: never bypass.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { askOf, COPY_NOTE, type Question } from "./conversation.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const MODES = ["default", "acceptEdits", "plan"] as const;
export type Mode = (typeof MODES)[number];
export const MODELS = ["", "opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export type AgentEvent =
  | { t: "text"; text: string }
  | { t: "tool"; name: string; detail: string }
  | { t: "denied"; tool: string; spec: string; detail: string }
  | { t: "result"; text: string; cost: number; error: boolean }
  | { t: "error"; text: string }
  | { t: "ask"; questions: Question[] };

/** Which agent CLI runs a session. */
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
  args(o: StartOpts): string[];
  apply(run: Run, line: string): void;
  stdinPrompt: boolean;
  /** Whether it can continue a copy of a session (fork) instead of the session itself. */
  canFork: boolean;
  /** It reaches Dovre's MCP server through the environment (mcpEnv), not only its arguments: Codex, omp, agy. */
  mcpEnv?: boolean;
};

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
};

export type StartOpts = {
  harness?: HarnessId; cwd: string; prompt: string; resume?: string; fork?: boolean; mode?: Mode; model?: string; allowed?: string[];
  /** Dovre's MCP server for this turn (src/mcp.ts): its address and the turn's own token. Set by the runner, not the caller. */
  mcp?: { url: string; token: string };
};

/** The --mcp-config that names Dovre's MCP server for one turn (added to the user's own servers, not replacing them). */
export const mcpConfig = (m: { url: string; token: string }) => JSON.stringify({ mcpServers: { dovre: { type: "http", url: m.url, headers: { Authorization: `Bearer ${m.token}` } } } });

/**
 * The environment that carries a turn's MCP address and token (#172): Codex reads the token from it
 * (`bearer_token_env_var`), and omp and agy's stdio bridge (src/mcp-stdio.ts) reads both. It's the
 * agent's own environment, so a command it runs sees it too: such a command reaches the same tools
 * with the same limits, only past the agent's own ask. Claude Code needs none of it (its --mcp-config).
 */
export const mcpEnv = (m: { url: string; token: string } | undefined): Record<string, string> => (m ? { DOVRE_MCP_URL: m.url, DOVRE_MCP_TOKEN: m.token } : {});

/**
 * Added to every Claude Code turn. Headless, Claude Code refuses a command that touches a folder
 * outside the project (`/tmp`, another checkout) whatever `--allowedTools` says, so the agent
 * keeps its work inside the repo (#163).
 */
export const HEADLESS_NOTE =
  "You are running headless from Dovre. Keep every command and file inside this repo's folder: a call that touches a folder outside it (such as /tmp or another checkout) is refused, and allowing it doesn't help. If you need a separate checkout, make a git worktree inside this folder (for example .worktrees/<name>).";

export function argsFor(o: StartOpts): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", o.mode ?? "default", "--append-system-prompt", HEADLESS_NOTE];
  if (o.model) args.push("--model", o.model);
  if (o.resume) args.push("--resume", o.resume);
  if (o.resume && o.fork) args.push("--fork-session");
  if (o.mcp) args.push("--mcp-config", mcpConfig(o.mcp));
  // Last: --allowedTools takes every argument after it.
  if (o.allowed?.length) args.push("--allowedTools", ...o.allowed);
  return args;
}

/** One line of what a tool call does: the command, the file, the pattern. */
export function toolDetail(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 160);
}

/** The narrowest allow rule for a denied call: this exact command or file, not the whole tool. */
export function toolSpec(name: string, input: any): string {
  if (name === "Bash" && typeof input?.command === "string") return `Bash(${input.command})`;
  if (name === "PowerShell" && typeof input?.command === "string") return `PowerShell(${input.command})`;
  if ((name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") && typeof (input?.file_path ?? input?.notebook_path) === "string") return `${name}(${input.file_path ?? input.notebook_path})`;
  if (name === "WebFetch" && typeof input?.url === "string") {
    try {
      return `WebFetch(domain:${new URL(input.url).hostname})`;
    } catch {}
  }
  return name;
}

/** Folds one stream-json line into the run. Unknown lines are ignored. */
export function apply(run: Run, line: string) {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  if (j.session_id && !run.sessionId) run.sessionId = j.session_id;
  if (j.type === "system" && j.subtype === "init" && j.session_id) run.sessionId = j.session_id;
  if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") run.partial += j.event.delta.text ?? "";
  if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    for (const b of j.message.content) {
      if (b.type === "text" && b.text?.trim()) run.events.push({ t: "text", text: b.text });
      const questions = b.type === "tool_use" && b.name === "AskUserQuestion" ? askOf(b.input) : null;
      if (questions) run.events.push({ t: "ask", questions });
      else if (b.type === "tool_use") run.events.push({ t: "tool", name: b.name, detail: toolDetail(b.name, b.input) });
    }
    run.partial = "";
  }
  if (j.type === "result") {
    run.cost = Number(j.total_cost_usd ?? 0);
    // A question can't be shown in a headless turn, so it ends denied: it's answered on the page instead (the "ask" event).
    for (const d of (j.permission_denials ?? []).filter((d: { tool_name?: string }) => d.tool_name !== "AskUserQuestion")) run.events.push({ t: "denied", tool: d.tool_name, spec: toolSpec(d.tool_name, d.tool_input), detail: toolDetail(d.tool_name, d.tool_input) });
    run.events.push({ t: "result", text: String(j.result ?? ""), cost: run.cost, error: !!j.is_error });
    run.partial = "";
  }
}

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
};

type Spawn = (bin: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) => ChildProcess;

export const claudeHarness = (bin = "claude"): Harness => ({ id: "claude", bin, args: argsFor, apply, stdinPrompt: true, canFork: true });

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
          if (run.status === "running") follow(run, h);
          else {
            // Done: its events, once, from its stream.
            for (const line of readFileSync(file(run.id, "out.jsonl"), "utf8").split("\n")) if (line.trim()) h.apply(run, line.trim());
          }
        } catch {}
      }
    } catch {}
  }

  return {
    start(o) {
      const h = harnesses[o.harness ?? ((Object.keys(harnesses) as HarnessId[])[0] ?? "claude")];
      if (!h) throw new Error(`No ${o.harness} harness here.`);
      const fork = !!(o.resume && o.fork && h.canFork);
      const prompt = o.prompt;
      // A copy is told it's one, so it leaves the terminal's unfinished work alone (the page shows the note as a line).
      o = { ...o, fork, prompt: fork ? `${COPY_NOTE}\n\n${o.prompt}` : o.prompt };
      const run: Run = {
        id: randomUUID(), harness: h.id, resumed: o.resume, forked: fork, sessionId: o.resume && !fork ? o.resume : undefined,
        cwd: o.cwd, repo: o.cwd.split(/[\\/]/).pop() ?? o.cwd, prompt, mode: o.mode ?? "default", model: o.model ?? "", allowed: o.allowed ?? [],
        status: "running", startedAt: now(), events: [], partial: "", cost: 0,
      };
      runs.set(run.id, run);
      // A token per turn, good while the turn runs: Claude Code and Codex get it in their arguments
      // and environment, omp and agy in the environment for the stdio bridge (#172).
      if (opts.mcp && (opts.mcp.on?.() ?? true)) {
        const token = randomBytes(32).toString("base64url");
        mcpTokens.set(run.id, token);
        o = { ...o, mcp: { url: opts.mcp.url, token } };
      }
      const argv = [...(h.pre ?? []), ...(h.stdinPrompt ? h.args(o) : [...h.args(o), o.prompt])];
      if (host) {
        const child = spawn(host.exe, ["agent-host", "--out", file(run.id, "out.jsonl"), "--err", file(run.id, "err.txt"), "--exit", file(run.id, "exit.json"), "--", h.bin, ...argv], {
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
      const child = spawnFn(h.bin, argv, o.mcp && h.mcpEnv ? { cwd: o.cwd, env: mcpEnv(o.mcp) } : { cwd: o.cwd });
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
        changed(run);
      });
      child.on("close", (code) => {
        if (buf.trim()) h.apply(run, buf.trim());
        children.delete(run.id);
        if (run.status === "running") run.status = code === 0 ? "done" : "failed";
        if (code !== 0 && run.status === "failed" && err.trim()) run.events.push({ t: "error", text: err.trim().slice(-600) });
        run.endedAt = Date.now();
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
}
