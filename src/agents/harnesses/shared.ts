/**
 * What the harnesses share (src/agents/harnesses/<id>/): how a tool call is shown, the narrowest
 * allow rule for one, and how a turn reaches Dovre's MCP server. The contract they implement is
 * `Harness` in src/agents/runner.ts; each one's filter in the agent host is launcher/keep_<id>.go.
 */
import type { Harness, HarnessId } from "../runner.ts";
import type { Tool } from "../../tools.ts";

/**
 * One harness, as core knows it: the program and its override, the models a turn may pick, its
 * filter in the agent host, and how to make its runner adapter from the program found here.
 */
export type HarnessDef = {
  id: HarnessId;
  /** The program on the PATH. */
  bin: string;
  /** The environment variable naming another path for it. */
  binVar: "CLAUDE_BIN" | "OMP_BIN" | "AGY_BIN" | "CODEX_BIN";
  /** The models offered for a turn; the first (empty) is the CLI's own default. */
  models: { value: string; label: string }[];
  /** Its part of the agent host's filter (`Keep`): what of its stream may be stored. */
  keep: string;
  make(tool: Pick<Tool, "bin" | "pre">, ctx: HarnessCtx): Harness;
};

/** What a harness may need from where it runs. */
export type HarnessCtx = { /** omp: the profile a session was made with, to resume it there. */ ompProfileOf?: (sessionId: string) => string | undefined };

/** The --mcp-config that names Dovre's MCP server for one turn (added to the user's own servers, not replacing them). */
export const mcpConfig = (m: { url: string; token: string }) => JSON.stringify({ mcpServers: { dovre: { type: "http", url: m.url, headers: { Authorization: `Bearer ${m.token}` } } } });

/**
 * The environment that carries a turn's MCP address and token (#172): Codex reads the token from it
 * (`bearer_token_env_var`), and omp and agy's stdio bridge (src/mcp-stdio.ts) reads both. It's the
 * agent's own environment, so a command it runs sees it too: such a command reaches the same tools
 * with the same limits, only past the agent's own ask. Claude Code needs none of it (its --mcp-config).
 */
export const mcpEnv = (m: { url: string; token: string } | undefined): Record<string, string> => (m ? { DOVRE_MCP_URL: m.url, DOVRE_MCP_TOKEN: m.token } : {});

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
