/**
 * Codex (OpenAI's `codex` CLI) as an agent harness (PLAN WP-M1): `codex exec --json` in a repo,
 * the prompt on stdin (`-`), a resumed session through `codex exec … resume <id> -`.
 *
 * Permissions never widen (CLAUDE.md): Codex has no per-call allow in exec mode, only its sandbox,
 * so plan and default run read-only and acceptEdits may write in the checkout (`workspace-write`).
 * Never `danger-full-access`, never `--dangerously-bypass-approvals-and-sandbox`. A command the
 * sandbox refuses shows as a failed tool call; there's no "Allow and continue" for Codex.
 *
 * The stream (one JSON object a line, `type` dotted): thread.started { thread_id }, item.started /
 * item.updated / item.completed { item: { id, type, … } }, turn.completed { usage }, turn.failed
 * { error }, error { message }. Item types read: agent_message (text), command_execution (command,
 * status), file_change (changes: path, kind), mcp_tool_call (server, tool), web_search (query),
 * error (message). Reasoning and command output are never read (the agent host drops them too).
 */
import type { Harness, Run, StartOpts } from "./runner.ts";

export function codexArgs(o: StartOpts): string[] {
  const args = ["exec", "--json", "--sandbox", o.mode === "acceptEdits" ? "workspace-write" : "read-only"];
  if (o.model) args.push("--model", o.model);
  // Dovre's MCP server for this turn (#172): the address here, the token from the environment (mcpEnv), so it isn't in the arguments.
  if (o.mcp) args.push("-c", `mcp_servers.dovre.url=${JSON.stringify(o.mcp.url)}`, "-c", 'mcp_servers.dovre.bearer_token_env_var="DOVRE_MCP_TOKEN"');
  // The prompt comes on stdin: `-` says so.
  return o.resume ? [...args, "resume", o.resume, "-"] : [...args, "-"];
}

/** An item's kind: `type` now, `item_type` in Codex's first JSON stream. */
const kindOf = (item: any): string => String(item?.type ?? item?.item_type ?? "");

/** Rough dollars for a turn's tokens (Codex doesn't say): GPT-5-class rates, cached input at a tenth. An estimate. */
export function codexCost(u: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined): number {
  if (!u) return 0;
  const input = Number(u.input_tokens ?? 0), cached = Number(u.cached_input_tokens ?? 0), output = Number(u.output_tokens ?? 0);
  return Number((((input - cached) * 1.25 + cached * 0.125 + output * 10) / 1_000_000).toFixed(4));
}

export function codexApply(run: Run, line: string): void {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  if (j.type === "thread.started" && typeof j.thread_id === "string") run.sessionId = j.thread_id;
  if (j.type === "item.completed" && j.item) {
    const item = j.item;
    const kind = kindOf(item);
    if (kind === "agent_message" && typeof item.text === "string" && item.text.trim()) run.events.push({ t: "text", text: item.text });
    else if (kind === "command_execution") run.events.push({ t: "tool", name: item.status === "failed" || item.status === "declined" ? "shell (refused or failed)" : "shell", detail: String(item.command ?? "").replace(/\s+/g, " ").slice(0, 160) });
    else if (kind === "file_change") {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      run.events.push({ t: "tool", name: "edit", detail: changes.map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`.trim()).join(", ").slice(0, 160) });
    } else if (kind === "mcp_tool_call") run.events.push({ t: "tool", name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, detail: "" });
    else if (kind === "web_search") run.events.push({ t: "tool", name: "web search", detail: String(item.query ?? "").slice(0, 160) });
    else if (kind === "error" && typeof item.message === "string") run.events.push({ t: "error", text: item.message.slice(0, 600) });
  }
  if (j.type === "turn.completed") {
    run.cost += codexCost(j.usage);
    const last = [...run.events].reverse().find((e) => e.t === "text");
    run.events.push({ t: "result", text: last && last.t === "text" ? last.text : "", cost: run.cost, error: false });
    run.partial = "";
  }
  if (j.type === "turn.failed") {
    const text = String(j.error?.message ?? "Codex's turn failed").slice(0, 600);
    run.events.push({ t: "result", text, cost: run.cost, error: true });
    run.partial = "";
  }
  if (j.type === "error" && typeof j.message === "string") run.events.push({ t: "error", text: j.message.slice(0, 600) });
}

/** The models offered for a Codex turn; empty is Codex's own default (its config.toml). */
export const CODEX_MODELS: { value: string; label: string }[] = [
  { value: "", label: "Codex's default model" },
  { value: "gpt-5-codex", label: "GPT-5 Codex" },
  { value: "gpt-5", label: "GPT-5" },
];

export const codexHarness = (bin = "codex"): Harness => ({
  id: "codex",
  bin,
  args: codexArgs,
  apply: codexApply,
  stdinPrompt: true,
  canFork: false,
  mcpEnv: true,
});
