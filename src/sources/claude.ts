/**
 * Local Claude Code sessions, read from ~/.claude without touching it:
 * - `sessions/<pid>.json`: one per running CLI, with busy/idle. Live when the pid still runs.
 * - `projects/<encoded cwd>/<sessionId>.jsonl`: the transcript. Only its small metadata lines
 *   are read (title, last prompt, recap, PR links, cost); tool results are never kept, they can
 *   hold anything (prod rows, secrets).
 * - `history.jsonl`: every prompt typed, the fallback for "what was asked last".
 */
import { runOff } from "../spawn.ts";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { repoOf } from "../format.ts";

export type Session = {
  sessionId: string;
  /** Which agent CLI the session belongs to; Claude Code unless set. */
  harness?: "claude" | "omp" | "copilot" | "agy" | "codex";
  /** omp: the profile the session ran under (`omp --profile <name>`); unset for the default one. */
  profile?: string;
  /** The model, when the session says (omp: "github-copilot/gpt-6-luna"). */
  model?: string;
  pid?: number;
  live: boolean;
  /** busy: working; waiting: needs a permission answer; idle: waiting for the next prompt. */
  status?: "busy" | "waiting" | "idle" | string;
  waitingFor?: string;
  /** "interactive" (a terminal), "background" (claude --bg) or "headless" (claude -p, Dovre's own turns included). */
  kind?: string;
  statusSince?: number;
  name?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  title?: string;
  lastPrompt?: string;
  summary?: string;
  summaryAt?: string;
  lastAt?: string;
  cost?: number;
  prs: { url: string; repo: string; number: number }[];
  subagentsRunning: number;
};

type Meta = Omit<Session, "sessionId" | "live" | "subagentsRunning" | "prs"> & { prs: Map<string, Session["prs"][number]> };

const META = /"type":"(ai-title|last-prompt|pr-link|cost-state|agent-name|system|user|assistant)"/;

/** The newest of each metadata line in a transcript's text. Anything unparseable is skipped. */
export function summarizeTranscript(text: string): Meta {
  const out: Meta = { prs: new Map() };
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || !META.test(line.slice(0, 600))) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    switch (j.type) {
      case "ai-title":
        if (j.aiTitle) out.title = j.aiTitle;
        break;
      case "agent-name":
        if (!out.title && j.agentName) out.title = j.agentName;
        break;
      case "last-prompt":
        if (typeof j.lastPrompt === "string" && !j.lastPrompt.startsWith("/")) out.lastPrompt = j.lastPrompt;
        break;
      case "pr-link":
        if (j.prUrl) out.prs.set(j.prUrl, { url: j.prUrl, repo: j.prRepository, number: j.prNumber });
        break;
      case "cost-state":
        if (typeof j.totalCostUSD === "number") out.cost = j.totalCostUSD;
        break;
      case "system":
        if (j.subtype === "away_summary" && typeof j.content === "string") {
          out.summary = j.content.replace(/\s*\(disable recaps in \/config\)\s*$/, "");
          out.summaryAt = j.timestamp;
        }
        break;
    }
    if (typeof j.cwd === "string") out.cwd = j.cwd;
    if (typeof j.gitBranch === "string" && j.gitBranch !== "HEAD") out.branch = j.gitBranch;
    if (typeof j.timestamp === "string") out.lastAt = j.timestamp;
  }
  return out;
}

/** The last `bytes` of a file, from the start of a line. */
export function tail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const projectDirs = (claude: string) => {
  const root = join(claude, "projects");
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)) : [];
};

export function transcriptOf(claude: string, sessionId: string): string | undefined {
  for (const d of projectDirs(claude)) {
    const f = join(d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

function subagentsRunning(transcript: string): number {
  const dir = transcript.replace(/\.jsonl$/, "") + "/subagents";
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      if (JSON.parse(readFileSync(join(dir, f), "utf8")).finished === false) n++;
    } catch {}
  }
  return n;
}

/** Last typed prompt per session, from the tail of history.jsonl. Slash commands don't count. */
export function lastPrompts(claude: string): Map<string, string> {
  const f = join(claude, "history.jsonl");
  const m = new Map<string, string>();
  if (!existsSync(f)) return m;
  for (const line of tail(f, 2 * 1024 * 1024).split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.sessionId && typeof j.display === "string" && !j.display.startsWith("/")) m.set(j.sessionId, j.display);
    } catch {}
  }
  return m;
}

function build(base: { sessionId: string; live: boolean; pid?: number; status?: string; statusSince?: number; name?: string; cwd?: string; waitingFor?: string; kind?: string }, transcript: string | undefined, history: Map<string, string>, tailBytes: number): Session {
  const meta: Meta = transcript ? summarizeTranscript(tail(transcript, tailBytes)) : { prs: new Map() };
  const cwd = base.cwd ?? meta.cwd;
  return {
    ...meta,
    ...base,
    cwd,
    repo: repoOf(cwd),
    lastPrompt: meta.lastPrompt ?? history.get(base.sessionId),
    prs: [...meta.prs.values()],
    subagentsRunning: transcript ? subagentsRunning(transcript) : 0,
  };
}

/** What `claude agents --json` says about one running session: the supported way to read it. */
export type AgentEntry = { pid?: number; sessionId: string; cwd?: string; kind?: string; name?: string; status?: string; waitingFor?: string; startedAt?: number; updatedAt?: number };

/** `pre`: arguments before claude's own (node running an npm shim's script, src/tools.ts). */
export async function liveAgents(bin = "claude", timeoutMs = 20_000, pre: string[] = []): Promise<AgentEntry[]> {
  // Off the main thread: starting claude.exe stalls whoever starts it for about a second (src/spawn.ts).
  const r = await runOff(bin, [...pre, "agents", "--json"], { timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (r.code !== 0) throw new Error(`claude agents: exit ${r.code} ${r.stderr.slice(0, 200)}`);
  const list = JSON.parse(r.stdout);
  return Array.isArray(list) ? list.filter((a) => typeof a?.sessionId === "string") : [];
}

/**
 * Running sessions, and the ones that ran in the last `days` (newest first, at most `limit`).
 * `agents`: from liveAgents(); without it, the per-process files in sessions/ stand in.
 */
export function loadSessions(claude: string, opts: { days?: number; limit?: number; isAlive?: (pid: number) => boolean; now?: number; agents?: AgentEntry[] } = {}): { live: Session[]; recent: Session[] } {
  const { days = 4, limit = 20, isAlive = alive, now = Date.now() } = opts;
  const history = lastPrompts(claude);
  const dir = join(claude, "sessions");
  const live: Session[] = [];
  if (opts.agents) {
    // The registry file has when the status last changed; agents --json doesn't.
    // It also says how the session was started: agents --json calls `claude -p` "interactive" too.
    const since = new Map<string, number>();
    const headless = new Set<string>();
    if (existsSync(dir))
      for (const f of readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))) {
        try {
          const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
          if (!j.sessionId) continue;
          since.set(j.sessionId, j.statusUpdatedAt ?? j.updatedAt);
          if (typeof j.entrypoint === "string" && j.entrypoint.startsWith("sdk")) headless.add(j.sessionId);
        } catch {}
      }
    for (const a of opts.agents)
      live.push(build({ sessionId: a.sessionId, live: true, pid: a.pid, status: a.status, statusSince: since.get(a.sessionId) ?? a.updatedAt ?? a.startedAt, name: a.name, cwd: a.cwd, waitingFor: a.waitingFor, kind: headless.has(a.sessionId) ? "headless" : a.kind }, transcriptOf(claude, a.sessionId), history, 4 * 1024 * 1024));
  } else if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      let s: any;
      try {
        s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        continue;
      }
      if (!s?.sessionId || !isAlive(Number(s.pid))) continue;
      live.push(build({ sessionId: s.sessionId, live: true, pid: s.pid, status: s.status, statusSince: s.statusUpdatedAt ?? s.updatedAt, name: s.name, cwd: s.cwd }, transcriptOf(claude, s.sessionId), history, 4 * 1024 * 1024));
    }
  }
  const liveIds = new Set(live.map((s) => s.sessionId));
  const since = now - days * 86400e3;
  const files: { id: string; file: string; mtime: number }[] = [];
  for (const d of projectDirs(claude)) {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      if (liveIds.has(id)) continue;
      const file = join(d, f);
      const st = statSync(file);
      if (st.mtimeMs >= since && st.size > 4000) files.push({ id, file, mtime: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const recent = files.slice(0, limit).map((r) => build({ sessionId: r.id, live: false }, r.file, history, 2 * 1024 * 1024));
  const order = (st?: string) => (st === "waiting" ? 0 : st === "idle" ? 1 : 2);
  live.sort((a, b) => order(a.status) - order(b.status) || (b.statusSince ?? 0) - (a.statusSince ?? 0));
  return { live, recent };
}

/** One session by id, live or not, from its transcript (and the live list when it's running). */
export function sessionById(claude: string, sessionId: string, live: Session[] = []): Session | undefined {
  const hit = live.find((s) => s.sessionId === sessionId);
  if (hit && hit.harness !== "copilot") return hit;
  const t = transcriptOf(claude, sessionId);
  return t ? build({ sessionId, live: false }, t, lastPrompts(claude), 4 * 1024 * 1024) : undefined;
}

/** Folders under the code folder that are git checkouts (a .git folder, or a worktree's .git file). */
export function listRepos(codeDir: string): string[] {
  if (!existsSync(codeDir)) return [];
  return readdirSync(codeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(codeDir, d.name, ".git")))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}
