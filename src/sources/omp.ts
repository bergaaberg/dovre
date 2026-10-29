/**
 * Local omp ("oh-my-pi") sessions, read from ~/.omp without touching it (omp 18.12.2):
 * - `agent/sessions/<encoded cwd>/<ISO time>_<id>.jsonl`: one transcript per session. Line 1 is
 *   a fixed-width `title` header omp rewrites in place, line 2 `session` {id, cwd}; then
 *   `model_change`, `thinking_level_change`, `title_change`, `message` (role user | assistant |
 *   toolResult | developer), `custom` (tool_execution_start, session_exit, …), `custom_message`
 *   (omp's own injected notes and background-job output). Only metadata is kept: title, cwd,
 *   model, last prompt, PR links, cost. Tool results, custom_message and developer text never.
 *   The folder next to each file holds tool output logs and is never read.
 * - `agent/history.db` (SQLite): `session_recaps`, omp's short recap per session, used as the
 *   summary. Opened read-only.
 * - Profiles (`omp --profile work`) keep the same layout under `~/.omp/profiles/<name>/agent`.
 *
 * Live: omp keeps no registry of running sessions. What it has, best first:
 * 1. `omp collab list --json`: documented, with pid, sessionId, busy and inputRequired, but it
 *    only lists sessions shared through Collab (/collab), so usually it's empty.
 * 2. A session file that doesn't end in `session_exit` is open (or its process died: omp writes
 *    that entry on every normal exit and on signals, after each `-p` turn too). Its last
 *    message says what it's doing: an assistant message that stopped means it waits for the
 *    next prompt; anything else (a prompt, a tool call, a tool result) means it's working.
 * 3. The running omp processes (command lines; `--profile`, `--resume`): an open file only
 *    counts when a process of that profile could own it, which rules out crashed sessions.
 * With 1, the status is omp's own. With 2 and 3 it's "busy"/"idle" read from the file. With
 * only 2 (no process list) the session is live if it's open and was written in the last
 * `openHours`, and its status says "probably-busy"/"probably-idle".
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { repoOf } from "../format.ts";
import { DatabaseSync } from "node:sqlite";
import { ompToolDetail } from "../agents/harnesses/omp/harness.ts";
import { cleanUserText, type Turn } from "../agents/conversation.ts";
import { alive, tail, type Session } from "./claude.ts";
import { argvOf, commandLines, type ProcRow } from "./procs.ts";

export const OMP_AGENT_DIR = join(homedir(), ".omp", "agent");

/** The default agent folder and every profile's, with the profile's name. */
export function ompAgentDirs(home = homedir()): { profile?: string; dir: string }[] {
  const out: { profile?: string; dir: string }[] = [{ dir: join(home, ".omp", "agent") }];
  const profiles = join(home, ".omp", "profiles");
  if (existsSync(profiles))
    for (const d of readdirSync(profiles, { withFileTypes: true }))
      if (d.isDirectory() && /^[\w.-]+$/.test(d.name) && existsSync(join(profiles, d.name, "agent", "sessions"))) out.push({ profile: d.name, dir: join(profiles, d.name, "agent") });
  return out;
}

/** Which profile holds a session: undefined for the default one, or when nobody has it. */
export function ompProfileOf(sessionId: string, home = homedir()): string | undefined {
  return ompAgentDirs(home).find((d) => d.profile && ompTranscriptOf(d.dir, sessionId))?.profile;
}

const FILE = /^.+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function transcripts(agentDir: string): { id: string; file: string }[] {
  const root = join(agentDir, "sessions");
  if (!existsSync(root)) return [];
  const out: { id: string; file: string }[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(root, d.name))) {
      const m = FILE.exec(f);
      if (m) out.push({ id: m[1].toLowerCase(), file: join(root, d.name, f) });
    }
  }
  return out;
}

export function ompTranscriptOf(agentDir: string, id: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return transcripts(agentDir).find((t) => t.id === id.toLowerCase())?.file;
}

/** What a session file says about itself. `state` comes from its last entries. */
export type OmpMeta = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  lastPrompt?: string;
  lastAt?: string;
  cost?: number;
  prs: Map<string, Session["prs"][number]>;
  userMessages: number;
  /** exited: ended with session_exit. busy/idle: open, working or waiting for a prompt. */
  state: "exited" | "busy" | "idle";
};

const PR = /https:\/\/((?:[\w-]+\.)*(?:ghe\.com|github\.com))\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** Text the user typed: user-attributed text blocks, minus anything the harness wrapped in. */
function userText(m: any): string {
  if (m?.attribution && m.attribution !== "user") return "";
  const parts = typeof m?.content === "string" ? [m.content] : Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text) : [];
  return cleanUserText(parts.join("\n"));
}

/**
 * The metadata in a transcript's text (its head and tail are enough). Tool results, injected
 * messages and thinking are skipped before they're parsed.
 */
export function summarizeOmpTranscript(text: string): OmpMeta {
  const out: OmpMeta = { prs: new Map(), userMessages: 0, state: "idle" };
  let header: string | undefined;
  let changed: string | undefined;
  let first: string | undefined;
  let cost = 0;
  let costed = false;
  let model: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"')) continue;
    const head = line.slice(0, 400);
    // Big and never needed: tool output, and injected notes / background-job output.
    if (/"role":"(toolResult|developer)"/.test(head) || head.includes('"type":"custom_message"')) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof j.timestamp === "string") out.lastAt = j.timestamp;
    switch (j.type) {
      case "title":
        if (typeof j.title === "string" && j.title.trim()) header = j.title.trim();
        break;
      case "session":
        if (typeof j.id === "string") out.sessionId = j.id;
        if (typeof j.cwd === "string") out.cwd = j.cwd;
        if (typeof j.title === "string" && j.title.trim()) first = j.title.trim();
        break;
      case "title_change":
        if (typeof j.title === "string" && j.title.trim()) changed = j.title.trim();
        break;
      case "model_change":
        if (typeof j.model === "string") model = j.model;
        break;
      case "custom":
        if (j.customType === "session_exit") out.state = "exited";
        else if (j.customType === "tool_execution_start") out.state = "busy";
        break;
      case "message": {
        const m = j.message;
        if (m?.role === "user") {
          const t = userText(m);
          if (t) {
            out.userMessages++;
            if (!t.startsWith("/")) out.lastPrompt = t;
          }
          out.state = "busy";
        } else if (m?.role === "assistant") {
          if (typeof m.provider === "string" && typeof m.model === "string") model = `${m.provider}/${m.model}`;
          const c = Number(m.usage?.cost?.total);
          if (Number.isFinite(c)) {
            cost += c;
            costed = true;
          }
          for (const b of Array.isArray(m.content) ? m.content : [])
            if (b?.type === "text" && typeof b.text === "string")
              for (const p of b.text.matchAll(PR)) {
                const url = `https://${p[1]}/${p[2]}/pull/${p[3]}`;
                out.prs.set(url, { url, repo: p[2], number: Number(p[3]) });
              }
          out.state = m.stopReason === "stop" || m.stopReason === "error" || m.stopReason === "aborted" ? "idle" : "busy";
        }
        break;
      }
    }
  }
  out.title = header ?? changed ?? first;
  out.model = model;
  if (costed) out.cost = cost;
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

/** A transcript's metadata: its header lines and its last 8 MB (cost counts what that holds). */
function metaOf(file: string): OmpMeta {
  const size = statSync(file).size;
  return summarizeOmpTranscript(size <= TAIL ? tail(file, TAIL) : head(file, 16 * 1024) + tail(file, TAIL));
}

/** omp's newest recap and title per session, from history.db. Empty when it can't be read. */
export function ompRecaps(agentDir: string): { recaps: Map<string, { text: string; at: string }>; titles: Map<string, string> } {
  const recaps = new Map<string, { text: string; at: string }>();
  const titles = new Map<string, string>();
  const f = join(agentDir, "history.db");
  if (!existsSync(f)) return { recaps, titles };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(f, { readOnly: true });
    for (const r of db.prepare("SELECT session_id, recap, created_at FROM session_recaps ORDER BY created_at, id").all() as any[])
      if (typeof r.session_id === "string" && typeof r.recap === "string") recaps.set(r.session_id, { text: r.recap.trim(), at: new Date(Number(r.created_at) * 1000).toISOString() });
    for (const r of db.prepare("SELECT session_id, title FROM session_titles").all() as any[]) if (typeof r.session_id === "string" && typeof r.title === "string" && r.title.trim()) titles.set(r.session_id, r.title.trim());
  } catch {
    // Locked, older schema, or no node:sqlite: the sessions still list, just without recaps.
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return { recaps, titles };
}

/** A running omp: its profile, and the session it was started with when it says (`--resume`). */
export type OmpProcess = { pid: number; profile?: string; resume?: string };

/** omp commands that aren't a session (`omp collab list`, `omp models`, …). */
const COMMANDS = new Set("acp agents anonymize auth auth-broker auth-gateway bench browser-relay cleanse clip collab commit completions compress config dry-balance find gallery gc git grep grievances if-bench images install join login models play plugin predict ps read render say search session setup share shell skill ssh stats stream tiny-models token toks ttsr update usage worktree".split(" "));

/** One process's command line, or null when it isn't a session (workers, subcommands, --no-session). */
export function parseOmpCommandLine(pid: number, commandLine: string): OmpProcess | null {
  const argv = argvOf(commandLine);
  const args = argv.slice(1);
  if (!args.length) return { pid };
  if (args[0].startsWith("__omp_worker") || COMMANDS.has(args[0])) return null;
  const p: OmpProcess = { pid };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith("--") && args[i].includes("=") ? [args[i].slice(0, args[i].indexOf("=")), args[i].slice(args[i].indexOf("=") + 1)] : [args[i], undefined];
    const value = () => inline ?? args[++i];
    if (flag === "--no-session" || flag === "--help" || flag === "-h" || flag === "--version" || flag === "-v" || flag === "--export") return null;
    if (flag === "--profile") p.profile = value();
    else if (flag === "--resume" || flag === "-r" || flag === "--restore") p.resume = value();
  }
  return p;
}

/** Running omp processes (src/sources/procs.ts). */
export function ompProcesses(timeoutMs = 15_000): Promise<OmpProcess[]> {
  return commandLines(["omp"], timeoutMs).then(ompProcessesOf);
}

/** The omp sessions among a process list's rows. */
export function ompProcessesOf(rows: ProcRow[]): OmpProcess[] {
  return rows.filter((r) => r.name === "omp").map((r) => parseOmpCommandLine(r.pid, r.cmd)).filter((p): p is OmpProcess => !!p);
}

/** What `omp collab list --json` says about one shared session. */
export type CollabHost = { pid: number; sessionId: string; cwd?: string; model?: string; busy?: boolean; inputRequired?: boolean; startedAt?: number };

export function parseCollabHosts(json: string): CollabHost[] {
  const j = JSON.parse(json);
  return (Array.isArray(j?.hosts) ? j.hosts : [])
    .filter((h: any) => typeof h?.sessionId === "string" && Number.isInteger(h?.pid))
    .map((h: any) => ({
      pid: h.pid, sessionId: h.sessionId, cwd: typeof h.cwd === "string" ? h.cwd : undefined,
      model: h.model?.provider && h.model?.id ? `${h.model.provider}/${h.model.id}` : undefined,
      busy: typeof h.busy === "boolean" ? h.busy : undefined, inputRequired: !!h.inputRequired, startedAt: typeof h.startedAt === "number" ? h.startedAt : undefined,
    }));
}

export function ompCollabHosts(bin = "omp", profile?: string, timeoutMs = 20_000): Promise<CollabHost[]> {
  const args = [...(profile && /^[\w.-]+$/.test(profile) ? ["--profile", profile] : []), "collab", "list", "--json"];
  return new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try {
        resolve(parseCollabHosts(out));
      } catch (e) {
        reject(e);
      }
    }),
  );
}

/** How sure we are a session runs, and what it's doing. */
type Liveness = { live: boolean; status?: string; pid?: number };

/**
 * Which open sessions are live. Pure, for the test: `files` are this profile's transcripts
 * (newest first) with their state; `processes` the omp processes of this profile, when known.
 */
export function liveness(
  files: { id: string; mtime: number; state: string }[],
  opts: { hosts?: CollabHost[]; processes?: { pid: number; resume?: string }[]; now: number; openHours: number; isAlive: (pid: number) => boolean },
): Map<string, Liveness> {
  const out = new Map<string, Liveness>();
  for (const h of opts.hosts ?? []) if (opts.isAlive(h.pid)) out.set(h.sessionId, { live: true, pid: h.pid, status: h.inputRequired ? "waiting" : h.busy === true ? "busy" : h.busy === false ? "idle" : undefined });
  const open = files.filter((f) => f.state !== "exited" && !out.has(f.id)).sort((a, b) => b.mtime - a.mtime);
  if (opts.processes) {
    const free: { pid: number; resume?: string }[] = [];
    for (const p of opts.processes) {
      const hit = p.resume && open.find((f) => !out.has(f.id) && f.id.startsWith(p.resume!.toLowerCase()));
      if (hit) out.set(hit.id, { live: true, pid: p.pid, status: hit.state });
      else free.push(p);
    }
    // A process started without --resume owns one of the most recently written open files.
    for (const f of open) {
      if (out.has(f.id)) continue;
      // Which of them is a guess when there are several, so no pid.
      if (!free.shift()) break;
      out.set(f.id, { live: true, status: f.state });
    }
  } else {
    for (const f of open) if (opts.now - f.mtime <= opts.openHours * 3600e3) out.set(f.id, { live: true, status: `probably-${f.state}` });
  }
  return out;
}

function build(id: string, meta: OmpMeta, l: Liveness | undefined, mtime: number, history: ReturnType<typeof ompRecaps>, profile?: string): Session {
  const recap = history.recaps.get(id);
  return {
    sessionId: id,
    harness: "omp",
    ...(profile ? { profile } : {}),
    model: meta.model,
    live: !!l?.live,
    status: l?.status,
    pid: l?.pid,
    statusSince: l?.live ? mtime : undefined,
    cwd: meta.cwd,
    repo: repoOf(meta.cwd),
    title: meta.title ?? history.titles.get(id),
    lastPrompt: meta.lastPrompt,
    summary: recap?.text,
    summaryAt: recap?.at,
    lastAt: meta.lastAt,
    cost: meta.cost,
    prs: [...meta.prs.values()],
    // Task subagents run inside the omp process and leave no files to count.
    subagentsRunning: 0,
  };
}

/**
 * Live sessions, and the ones written in the last `days` (newest first, at most `limit`).
 * Sessions nobody typed into are left out. `processes`: from `ompProcesses()`, all of them;
 * only those of `profile` (undefined: the default one) count here. `hosts`: from
 * `ompCollabHosts()` for the same profile.
 */
export function loadOmpSessions(
  ompAgentDir: string = OMP_AGENT_DIR,
  opts: { days?: number; limit?: number; now?: number; isAlive?: (pid: number) => boolean; hosts?: CollabHost[]; processes?: OmpProcess[]; profile?: string; openHours?: number } = {},
): { live: Session[]; recent: Session[] } {
  const { days = 4, limit = 20, now = Date.now(), isAlive = alive, openHours = 12 } = opts;
  const processes = opts.processes?.filter((p) => p.profile === opts.profile);
  const since = now - days * 86400e3;
  const files: { id: string; file: string; mtime: number; meta: OmpMeta; state: OmpMeta["state"] }[] = [];
  const hosted = new Set((opts.hosts ?? []).map((h) => h.sessionId));
  for (const t of transcripts(ompAgentDir)) {
    let st;
    try {
      st = statSync(t.file);
    } catch {
      continue;
    }
    if (st.mtimeMs < since && !hosted.has(t.id)) continue;
    let meta: OmpMeta;
    try {
      meta = metaOf(t.file);
    } catch {
      continue;
    }
    if (!meta.userMessages && !hosted.has(t.id)) continue;
    files.push({ id: t.id, file: t.file, mtime: st.mtimeMs, meta, state: meta.state });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const lv = liveness(files, { hosts: opts.hosts, processes, now, openHours, isAlive });
  const history = ompRecaps(ompAgentDir);
  const live: Session[] = [];
  const recent: Session[] = [];
  for (const f of files) {
    const l = lv.get(f.id);
    if (l?.live) live.push(build(f.id, f.meta, l, f.mtime, history, opts.profile));
    else if (recent.length < limit) recent.push(build(f.id, f.meta, undefined, f.mtime, history, opts.profile));
  }
  const order = (st?: string) => (st === "waiting" ? 0 : st === "idle" || st === "probably-idle" ? 1 : 2);
  live.sort((a, b) => order(a.status) - order(b.status) || (b.statusSince ?? 0) - (a.statusSince ?? 0));
  return { live, recent };
}

/** One session by id, live or not (from the live list when it's there). */
export function ompSessionById(ompAgentDir: string, id: string, live: Session[] = []): Session | undefined {
  const hit = live.find((s) => s.sessionId === id);
  if (hit) return hit;
  const f = ompTranscriptOf(ompAgentDir, id);
  if (!f) return undefined;
  return build(id.toLowerCase(), metaOf(f), undefined, statSync(f).mtimeMs, ompRecaps(ompAgentDir));
}

/**
 * A session's conversation, in the same shape as Claude's: what the user typed, what the agent
 * said, one line per tool call. Never tool results (they can hold prod data and secrets), never
 * omp's injected messages (developer role, custom_message). Thinking is kept, cut short (#240): it's the model's own words.
 */
export function ompTurnsOf(text: string, limit = 60): Turn[] {
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"')) continue;
    const head = line.slice(0, 400);
    if (!head.includes('"type":"message"') || !/"role":"(user|assistant)"/.test(head)) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "message") continue;
    const m = j.message;
    const at = typeof j.timestamp === "string" ? j.timestamp : undefined;
    if (m?.role === "user") {
      const t = userText(m);
      if (t) turns.push({ role: "user", text: t, at });
      continue;
    }
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const last = turns[turns.length - 1];
        if (last?.role === "assistant" && last.text === b.text) continue;
        turns.push({ role: "assistant", text: b.text, at });
      }
      if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) turns.push({ role: "thinking", text: b.thinking.trim().slice(0, 4000), at });
      if (b?.type === "toolCall" && typeof b.name === "string") {
        const last = turns[turns.length - 1];
        const call = { name: b.name, detail: ompToolDetail(b.name, b.arguments) };
        if (last?.role === "tools") last.calls.push(call);
        else turns.push({ role: "tools", calls: [call], at });
      }
    }
  }
  return turns.slice(-limit);
}
