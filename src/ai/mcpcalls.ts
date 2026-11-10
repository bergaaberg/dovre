/**
 * Exact calls to one MCP server, made through Claude Code's own sign-in to it (#488): a headless
 * `claude -p` that may call only the tools a job names, nothing built in (no Bash, no files), no
 * settings, no other MCP servers, no session kept. The model is only the transport: what's handed
 * back is each tool's own result, read out of the stream.
 *
 * This is not an agent turn and doesn't go through the agent host: nothing of the stream is
 * written anywhere. The results live in memory, for the pack that asked (src/packs/mcpcalls.ts).
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ran, runOff } from "../spawn.ts";

export type McpServer = { name: string; url: string };
/** One job: the tools it may call and those refused outright, by their bare names on `server`. */
export type McpJob = { server: McpServer; allowed: string[]; denied: string[]; prompt: string; signal?: AbortSignal };
export type McpMade = { tool: string; input: Record<string, unknown>; result?: string; error: boolean };
export type McpStream = { calls: McpMade[]; cost: number };
export type McpSetup = "no-claude" | "sign-in";
/** Claude Code isn't there, or isn't signed in to the server: the pack's page says how. */
export class McpSetupError extends Error {
  readonly setup: McpSetup;
  constructor(setup: McpSetup, message: string) {
    super(message);
    this.setup = setup;
  }
}
export type McpRun = (job: McpJob) => Promise<McpStream>;

const SYSTEM = "You are a transport between a program and a service. Make exactly the tool calls the user lists, with exactly the arguments given, nothing else. Then answer with the single word: done.";

const full = (server: string, tool: string) => `mcp__${server}__${tool}`;

export function mcpArgs(job: Pick<McpJob, "server" | "allowed" | "denied">, model = "haiku"): string[] {
  const { name, url } = job.server;
  return [
    "-p",
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }),
    "--allowedTools", job.allowed.map((t) => full(name, t)).join(","),
    ...(job.denied.length ? ["--disallowedTools", job.denied.map((t) => full(name, t)).join(",")] : []),
    "--disable-slash-commands",
    "--system-prompt", SYSTEM,
  ];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The stream's lines, as the server's calls and their results, and how the server stood. A line that isn't JSON is skipped. */
export function readMcpStream(stdout: string, server: string): McpStream & { status?: string } {
  const out: McpStream & { status?: string } = { calls: [], cost: 0 };
  const prefix = full(server, "");
  const byId = new Map<string, McpMade>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init" && Array.isArray(m.mcp_servers)) out.status = str(obj(m.mcp_servers.find((s) => obj(s).name === server)).status);
    const content = Array.isArray(obj(m.message).content) ? (obj(m.message).content as unknown[]) : [];
    if (m.type === "assistant")
      for (const c of content.map(obj))
        if (c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string" && c.name.startsWith(prefix)) {
          const call: McpMade = { tool: c.name.slice(prefix.length), input: obj(c.input), error: false };
          byId.set(c.id, call);
          out.calls.push(call);
        }
    if (m.type === "user")
      for (const c of content.map(obj)) {
        const call = typeof c.tool_use_id === "string" ? byId.get(c.tool_use_id) : undefined;
        if (!call || c.type !== "tool_result") continue;
        call.result = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => str(obj(x).text) ?? "").join("") : "";
        call.error = c.is_error === true;
      }
    if (m.type === "result") out.cost = typeof m.total_cost_usd === "number" && m.total_cost_usd > 0 ? m.total_cost_usd : 0;
  }
  return out;
}

type RunFn = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number; signal?: AbortSignal }) => Promise<Ran>;

/** `pre`: arguments before claude's own (node running an npm shim's script, src/tools.ts). */
export function claudeMcp(opts: { bin?: string; pre?: string[]; timeoutMs?: number; run?: RunFn } = {}): McpRun {
  const run = opts.run ?? runOff;
  // An empty folder of its own: no CLAUDE.md or project settings to pick up.
  const cwd = join(tmpdir(), "dovre-mcp");
  return async (job) => {
    mkdirSync(cwd, { recursive: true });
    let r: Ran;
    try {
      r = await run(opts.bin ?? "claude", [...(opts.pre ?? []), ...mcpArgs(job)], { cwd, input: job.prompt, timeoutMs: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, ...(job.signal ? { signal: job.signal } : {}) });
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/ENOENT/.test(m)) throw new McpSetupError("no-claude", "Claude Code isn't installed here (no `claude` on the PATH).");
      throw new Error(`MCP through Claude Code: ${m.slice(0, 200)}`);
    }
    const s = readMcpStream(r.stdout, job.server.name);
    if (s.status && s.status !== "connected") throw new McpSetupError("sign-in", `Claude Code's ${job.server.name} MCP is ${s.status.slice(0, 40)}.`);
    if (!s.status) throw new Error(`MCP through Claude Code: no answer (exit ${r.code}) ${r.stderr.slice(0, 160)}`);
    return { calls: s.calls, cost: s.cost };
  };
}
