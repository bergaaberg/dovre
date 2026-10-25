/**
 * Local Copilot CLI sessions (GitHub's `copilot`, 1.0.95), read from ~/.copilot without touching it:
 * - `session-state/<id>/workspace.yaml`: id, cwd, git_root, branch, repository, name (often a
 *   `|-` block), created_at, updated_at.
 * - `session-state/<id>/events.jsonl`: one event per line, `{"type":…,"data":{…},"id","timestamp",
 *   "parentId"}`, so a line's type is at its very start. Only these are parsed: session.start,
 *   session.model_change, session.context_changed, user.message, assistant.message (its text,
 *   model and tool calls, never reasoning), assistant.turn_end, tool.execution_start (state only),
 *   permission.requested (its kind only) / permission.completed, abort, session.task_complete
 *   (the agent's own summary) and session.shutdown. Never tool.execution_complete (tool output),
 *   hook.* (they carry tool results), model.* (whole requests and responses), system.* (the system
 *   prompt, notifications), skill.* or compaction summaries: they're skipped before parsing.
 *   The session's other files (session.db, checkpoints, files, research, snapshots) are never read.
 *
 * Live: no registry (`copilot sessions` only imports, and open-sessions-state.json isn't reliable).
 * A session whose file doesn't end in session.shutdown is open (or its process died); it counts
 * as live when a running copilot.exe could own it (`--resume`/`--session-id`, else one of the
 * newest open files), as for omp (`liveness` in omp.ts).
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { repoOf } from "../format.ts";
import { cleanUserText, type Turn } from "../agents/conversation.ts";
import { ompToolDetail } from "../agents/omp.ts";
import { alive, tail, type Session } from "./claude.ts";
import { liveness } from "./omp.ts";
import { argvOf, type ProcRow } from "./procs.ts";

export const COPILOT_DIR = join(homedir(), ".copilot");

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** workspace.yaml's top-level scalars: plain, quoted, or a `|`/`>` block. Nothing nested. */
export function parseWorkspace(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if (/^[|>][-+]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (lines[i + 1] === "" && /^\s/.test(lines[i + 2] ?? "")))) block.push(lines[++i]);
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
      const body = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      v = (v.startsWith(">") ? body.join(" ") : body.join("\n")).trim();
    } else if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.startsWith("'")) v = v.slice(1, v.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
    out[m[1]] = v;
  }
  return out;
}

/** What a session's events say about it. `state` comes from its last events. */
export type CopilotMeta = {
  sessionId?: string;
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  model?: string;
  lastPrompt?: string;
  lastAt?: string;
  summary?: string;
  prs: Map<string, Session["prs"][number]>;
  userMessages: number;
  /** exited: ended with session.shutdown; waiting: a permission asked and not answered. */
  state: "exited" | "busy" | "idle" | "waiting";
  /** What the open permission is for (its kind: shell, write, read, url, mcp). */
  waitingFor?: string;
};

/** Event types read; any other line is skipped by its first bytes, before it's parsed. */
const READ = /^\{"type":"(session\.start|session\.model_change|session\.context_changed|session\.shutdown|session\.task_complete|user\.message|assistant\.message|assistant\.turn_end|tool\.execution_start|permission\.requested|permission\.completed|abort)"/;
/** Read for their order only, never parsed. */
const STATE_ONLY = new Set(["tool.execution_start", "permission.completed", "assistant.turn_end"]);

const PR = /https:\/\/((?:[\w-]+\.)*(?:ghe\.com|github\.com))\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

const WAITING_FOR: Record<string, string> = { shell: "a command", write: "a file edit", read: "reading a file", url: "a web fetch", mcp: "an MCP tool" };

export function summarizeCopilotEvents(text: string): CopilotMeta {
  const out: CopilotMeta = { prs: new Map(), userMessages: 0, state: "idle" };
  // Whether the newest assistant message asked for tools (then turn_end isn't the turn's end).
  let calling = false;
  for (const line of text.split("\n")) {
    const t = READ.exec(line)?.[1];
    const at = /"timestamp":"([^"]{10,40})"/.exec(line.slice(-200))?.[1];
    if (at) out.lastAt = at;
    if (!t) continue;
    if (STATE_ONLY.has(t)) {
      if (t === "assistant.turn_end") out.state = calling ? "busy" : "idle";
      else if (t === "permission.completed") (out.state = "busy"), (out.waitingFor = undefined);
      else out.state = "busy";
      continue;
    }
    if (t === "permission.requested") {
      // Its diff, file contents and command text are never kept: only which kind of thing it asks.
      out.state = "waiting";
      const kind = /"permissionRequest":\{[^{}]*?"kind":"(\w{1,20})"/.exec(line)?.[1] ?? /"kind":"(\w{1,20})"/.exec(line)?.[1];
      out.waitingFor = kind ? (WAITING_FOR[kind] ?? kind) : undefined;
      continue;
    }
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const d = j.data ?? {};
    switch (t) {
      case "session.start":
        if (typeof d.sessionId === "string") out.sessionId = d.sessionId;
        if (typeof d.context?.cwd === "string") out.cwd = d.context.cwd;
        if (typeof d.context?.gitRoot === "string") out.gitRoot = d.context.gitRoot;
        if (typeof d.context?.branch === "string") out.branch = d.context.branch;
        if (typeof d.selectedModel === "string") out.model = d.selectedModel;
        break;
      case "session.context_changed":
        if (typeof d.cwd === "string") out.cwd = d.cwd;
        if (typeof d.gitRoot === "string") out.gitRoot = d.gitRoot;
        if (typeof d.branch === "string") out.branch = d.branch;
        break;
      case "session.model_change":
        if (typeof d.newModel === "string") out.model = d.newModel;
        break;
      case "user.message": {
        const u = typeof d.content === "string" ? cleanUserText(d.content) : "";
        if (u) {
          out.userMessages++;
          if (!u.startsWith("/")) out.lastPrompt = u;
        }
        out.state = "busy";
        break;
      }
      case "assistant.message":
        if (typeof d.model === "string" && d.model) out.model = d.model;
        calling = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
        if (typeof d.content === "string")
          for (const p of d.content.matchAll(PR)) {
            const url = `https://${p[1]}/${p[2]}/pull/${p[3]}`;
            out.prs.set(url, { url, repo: p[2], number: Number(p[3]) });
          }
        out.state = "busy";
        break;
      case "session.task_complete":
        if (typeof d.summary === "string" && d.summary.trim()) out.summary = d.summary.trim().slice(0, 1000);
        break;
      case "abort":
        out.state = "idle";
        out.waitingFor = undefined;
        break;
      case "session.shutdown":
        out.state = "exited";
        out.waitingFor = undefined;
        break;
    }
  }
  return out;
}

/** The first `bytes` of a file, cut at the last whole line. */
function head(file: string, bytes: number): string {
  const buf = Buffer.alloc(bytes);
  const fd = openSync(file, "r");
  let n: number;
  try {
    n = readSync(fd, buf, 0, bytes, 0);
  } finally {
    closeSync(fd);
  }
  const text = buf.subarray(0, n).toString("utf8");
  return n < bytes ? text : text.slice(0, text.lastIndexOf("\n") + 1);
}

const TAIL = 8 * 1024 * 1024;

/** A session's events: the start and the last 8 MB. */
function eventsText(file: string): string {
  const size = statSync(file).size;
  return size <= TAIL ? tail(file, TAIL) : head(file, 64 * 1024) + tail(file, TAIL);
}

function sessions(root: string): { id: string; dir: string; events: string }[] {
  const base = join(root, "session-state");
  if (!existsSync(base)) return [];
  const out: { id: string; dir: string; events: string }[] = [];
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory() || !ID.test(d.name)) continue;
    const events = join(base, d.name, "events.jsonl");
    if (existsSync(events)) out.push({ id: d.name.toLowerCase(), dir: join(base, d.name), events });
  }
  return out;
}

export function copilotEventsOf(root: string, id: string): string | undefined {
  if (!ID.test(id)) return undefined;
  const f = join(root, "session-state", id.toLowerCase(), "events.jsonl");
  return existsSync(f) ? f : undefined;
}

function workspaceOf(dir: string): Record<string, string> {
  try {
    return parseWorkspace(readFileSync(join(dir, "workspace.yaml"), "utf8"));
  } catch {
    return {};
  }
}

/** A running copilot: the session it was started with, when it says. */
export type CopilotProcess = { pid: number; resume?: string };

const COMMANDS = new Set("app login help init config update version workflow sessions memories plugin mcp skill instruction lsp sandbox completion".split(" "));

/** One process's command line, or null when it isn't a session (a subcommand, --help, --version). */
export function parseCopilotCommandLine(pid: number, commandLine: string): CopilotProcess | null {
  const args = argvOf(commandLine).slice(1);
  if (args[0] && COMMANDS.has(args[0])) return null;
  const p: CopilotProcess = { pid };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith("--") && args[i].includes("=") ? [args[i].slice(0, args[i].indexOf("=")), args[i].slice(args[i].indexOf("=") + 1)] : [args[i], undefined];
    if (flag === "--help" || flag === "-h" || flag === "--version" || flag === "-v" || flag === "--acp") return null;
    if (flag === "--resume" || flag === "-r" || flag === "--session-id") {
      const v = inline ?? (args[i + 1] && !args[i + 1].startsWith("-") ? args[++i] : undefined);
      if (v && /^[0-9a-f-]{4,36}$/i.test(v)) p.resume = v;
    }
  }
  return p;
}

/** The Copilot sessions among a process list's rows (src/sources/procs.ts). */
export function copilotProcessesOf(rows: ProcRow[]): CopilotProcess[] {
  return rows.filter((r) => r.name === "copilot").map((r) => parseCopilotCommandLine(r.pid, r.cmd)).filter((p): p is CopilotProcess => !!p);
}

function build(id: string, meta: CopilotMeta, ws: Record<string, string>, l: { live: boolean; status?: string; pid?: number } | undefined, mtime: number): Session {
  const cwd = ws.cwd || meta.cwd;
  const root = ws.git_root || meta.gitRoot || cwd;
  const name = (ws.name ?? "").replace(/\s+/g, " ").trim();
  const status = l?.status?.replace(/^probably-/, "");
  return {
    sessionId: id,
    harness: "copilot",
    model: meta.model,
    live: !!l?.live,
    status: l?.status,
    waitingFor: status === "waiting" ? meta.waitingFor : undefined,
    pid: l?.pid,
    statusSince: l?.live ? mtime : undefined,
    cwd,
    repo: repoOf(root),
    branch: ws.branch || meta.branch,
    title: name ? name.slice(0, 200) : undefined,
    lastPrompt: meta.lastPrompt,
    summary: meta.summary,
    lastAt: meta.lastAt ?? ws.updated_at,
    prs: [...meta.prs.values()],
    subagentsRunning: 0,
  };
}

/**
 * Live sessions, and the ones written in the last `days` (newest first, at most `limit`).
 * Sessions nobody typed into are left out. `processes`: from `copilotProcessesOf`; undefined when
 * the process list couldn't be read (then an open file written in the last `openHours` counts).
 */
export function loadCopilotSessions(
  root: string = COPILOT_DIR,
  opts: { days?: number; limit?: number; now?: number; isAlive?: (pid: number) => boolean; processes?: CopilotProcess[]; openHours?: number } = {},
): { live: Session[]; recent: Session[] } {
  const { days = 4, limit = 20, now = Date.now(), isAlive = alive, openHours = 12 } = opts;
  const since = now - days * 86400e3;
  const files: { id: string; dir: string; mtime: number; meta: CopilotMeta; state: string }[] = [];
  for (const s of sessions(root)) {
    let mtime: number;
    try {
      mtime = statSync(s.events).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < since) continue;
    let meta: CopilotMeta;
    try {
      meta = summarizeCopilotEvents(eventsText(s.events));
    } catch {
      continue;
    }
    if (!meta.userMessages) continue;
    files.push({ id: s.id, dir: s.dir, mtime, meta, state: meta.state });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const lv = liveness(files, { processes: opts.processes, now, openHours, isAlive });
  const live: Session[] = [];
  const recent: Session[] = [];
  for (const f of files) {
    const l = lv.get(f.id);
    if (l?.live) live.push(build(f.id, f.meta, workspaceOf(f.dir), l, f.mtime));
    else if (recent.length < limit) recent.push(build(f.id, f.meta, workspaceOf(f.dir), undefined, f.mtime));
  }
  const order = (st?: string) => (st === "waiting" || st === "probably-waiting" ? 0 : st === "idle" || st === "probably-idle" ? 1 : 2);
  live.sort((a, b) => order(a.status) - order(b.status) || (b.statusSince ?? 0) - (a.statusSince ?? 0));
  return { live, recent };
}

/** One session by id, live or not (from the live list when it's there). */
export function copilotSessionById(root: string, id: string, live: Session[] = []): Session | undefined {
  const hit = live.find((s) => s.sessionId === id && s.harness === "copilot");
  if (hit) return hit;
  const f = copilotEventsOf(root, id);
  if (!f) return undefined;
  return build(id.toLowerCase(), summarizeCopilotEvents(eventsText(f)), workspaceOf(join(f, "..")), undefined, statSync(f).mtimeMs);
}

/** Tool calls that are the agent talking to the CLI, not doing anything. */
const QUIET = new Set(["report_intent", "task_complete"]);

/**
 * A session's conversation, in the same shape as Claude's: what the user typed, what the agent
 * said, one line per tool call. Never tool results, reasoning, or the CLI's own messages.
 */
export function copilotTurnsOf(text: string, limit = 60): Turn[] {
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    const t = /^\{"type":"(user\.message|assistant\.message)"/.exec(line)?.[1];
    if (!t) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const d = j.data ?? {};
    const at = typeof j.timestamp === "string" ? j.timestamp : undefined;
    if (t === "user.message") {
      const u = typeof d.content === "string" ? cleanUserText(d.content) : "";
      if (u) turns.push({ role: "user", text: u, at });
      continue;
    }
    if (typeof d.content === "string" && d.content.trim()) {
      const last = turns[turns.length - 1];
      if (!(last?.role === "assistant" && last.text === d.content)) turns.push({ role: "assistant", text: d.content, at });
    }
    for (const r of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
      if (typeof r?.name !== "string" || QUIET.has(r.name)) continue;
      const args = typeof r.arguments === "string" ? undefined : r.arguments;
      const intent = typeof r.intentionSummary === "string" ? r.intentionSummary.replace(/\s+/g, " ").slice(0, 160) : "";
      const call = { name: r.name, detail: ompToolDetail(r.name, args) || intent };
      const last = turns[turns.length - 1];
      if (last?.role === "tools") last.calls.push(call);
      else turns.push({ role: "tools", calls: [call], at });
    }
  }
  return turns.slice(-limit);
}
