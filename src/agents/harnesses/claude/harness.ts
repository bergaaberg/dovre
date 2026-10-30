/**
 * Claude Code: `claude -p` headless with stream-json out (launcher/keep_claude.go keeps what of it
 * may be stored). Modes are passed as --permission-mode, never bypass outside a sandbox; "Allow and
 * continue" resumes with exactly the denied call allowed (toolSpec). In a sandbox run the runner sets
 * `yolo`, and the turn skips permissions inside its container (src/agents/sandbox.ts).
 */
import type { Harness, HarnessOpts, Run } from "../../runner.ts";
import { askOf } from "../../conversation.ts";
import { subagentOf, todosOf } from "../../todos.ts";
import { effortIn, effortList, type HarnessDef, type HarnessOptions, mcpConfig, toolDetail, toolSpec } from "../shared.ts";

/** The models offered for a Claude Code turn; empty is its own default. */
export const CLAUDE_MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * Added to every Claude Code turn. Headless, Claude Code refuses a command that touches a folder
 * outside the project (`/tmp`, another checkout) whatever `--allowedTools` says, so the agent
 * keeps its work inside the repo (#163).
 */
export const HEADLESS_NOTE =
  "You are running headless from Dovre. Keep every command and file inside this repo's folder: a call that touches a folder outside it (such as /tmp or another checkout) is refused, and allowing it doesn't help. If you need a separate checkout, make a git worktree inside this folder (for example .worktrees/<name>).";

/** Added to a sandbox run instead: it runs alone, may run anything in its clone, and ends in a commit. */
export const SANDBOX_NOTE =
  "You are running unattended from Dovre, in a sandbox: a fresh clone of this repo inside a container, with nothing of the user's machine. Nobody can answer questions, so don't ask any: decide, and say what you decided. Install, build and test as you need. When you are done, commit your work with git on the current branch. You cannot push; Dovre brings your commits back.";

/** Claude Code's `--effort` levels. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Claude Code's own words for the modes, its `--effort` levels, and `--fork-session` on a reply. */
export const CLAUDE_OPTIONS: HarnessOptions = {
  modes: {
    default: { label: "Ask before edits and commands", short: "asks first" },
    acceptEdits: { label: "Edit files freely, ask before commands", short: "edits freely" },
    plan: { label: "Plan only: read, don't change anything", short: "plan only" },
  },
  efforts: effortList(CLAUDE_EFFORTS),
  fork: true,
};

export function argsFor(o: HarnessOpts): string[] {
  const perm = o.yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", o.mode ?? "default"];
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...perm, "--append-system-prompt", o.yolo ? SANDBOX_NOTE : HEADLESS_NOTE];
  if (o.model) args.push("--model", o.model);
  // A sandbox run's caps (#207): Claude Code stops itself at the budget.
  if (o.yolo && o.budget) args.push("--max-budget-usd", String(o.budget));
  if (o.yolo && o.turns) args.push("--max-turns", String(o.turns));
  const effort = effortIn(CLAUDE_OPTIONS.efforts, o.effort);
  if (effort) args.push("--effort", effort);
  if (o.resume) args.push("--resume", o.resume);
  if (o.resume && o.fork) args.push("--fork-session");
  if (o.mcp) args.push("--mcp-config", mcpConfig(o.mcp));
  // Last: --allowedTools takes every argument after it.
  if (o.allowed?.length) args.push("--allowedTools", ...o.allowed);
  return args;
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
      const todos = b.type === "tool_use" && b.name === "TodoWrite" ? todosOf(b.input) : null;
      const sub = b.type === "tool_use" ? subagentOf(b.name, b.input) : undefined;
      if (questions) run.events.push({ t: "ask", questions });
      else if (todos) run.events.push({ t: "todos", items: todos });
      else if (b.type === "tool_use") run.events.push({ t: "tool", name: b.name, detail: toolDetail(b.name, b.input), ...(sub ? { sub } : {}) });
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

export const claudeHarness = (bin = "claude"): Harness => ({ id: "claude", bin, args: argsFor, apply, stdinPrompt: true, canFork: true, sandbox: { bin: "claude" } });

export const claude: HarnessDef = { id: "claude", bin: "claude", binVar: "CLAUDE_BIN", models: CLAUDE_MODELS, options: CLAUDE_OPTIONS, keep: "launcher/keep_claude.go", make: (t) => ({ ...claudeHarness(t.bin), pre: t.pre }) };
