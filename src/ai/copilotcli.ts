/**
 * Short model calls through GitHub's Copilot CLI (`copilot -p`), for Bino and summaries on a machine
 * with Copilot CLI and no Claude Code. Nothing to act with: every tool off (`--available-tools=__none__`;
 * an empty value doesn't turn them off), no built-in MCP servers, no custom instructions, no questions,
 * no updates, in an empty folder.
 *
 * Each call gets a Copilot home of its own (COPILOT_HOME, a fresh temp folder) that's deleted when
 * it ends: the user's ~/.copilot has plugins, hooks and MCP servers that would see the prompt, and
 * Copilot keeps every prompt in its home's session files and session-store.db, with no flag to stop
 * it. The sign-in isn't in the home (an empty one signs in), so nothing is copied over.
 * COPILOT_ALLOW_ALL never reaches it. There's no system-prompt flag: the system text leads the prompt.
 * The prompt goes in on stdin, never on the command line.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ran, runOff } from "../spawn.ts";
import type { Tool } from "../tools.ts";
import type { Complete } from "./llm.ts";

/** A model name Copilot CLI takes (`--model`), or nothing: then Copilot picks (auto). */
const MODEL = /^\w[\w.:-]{0,59}$/;

export function copilotCliArgs(cwd: string, model?: string): string[] {
  return [
    "--available-tools=__none__",
    "--disable-builtin-mcps",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-auto-update",
    "--log-level", "none",
    "--output-format", "json",
    "-C", cwd,
    ...(model && MODEL.test(model) ? ["--model", model] : []),
  ];
}

/** The system text and the message as one prompt. */
export const copilotPrompt = (system: string, user: string) => `<instructions>\n${system.trim()}\n</instructions>\n\n${user}`;

/** What `--output-format json` printed: the last assistant message, and the session and its premium requests. */
export function parseCopilotJsonl(stdout: string): { text: string; sessionId?: string; premiumRequests?: number; model?: string; error?: string } {
  let text = "";
  let sessionId: string | undefined;
  let premiumRequests: number | undefined;
  let model: string | undefined;
  let error: string | undefined;
  let exitCode: number | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === "assistant.message" && typeof j.data?.content === "string") {
      if (j.data.content.trim()) text = j.data.content;
      if (typeof j.data.model === "string") model = j.data.model;
    } else if (j.type === "session.error" || j.type === "error") error = String(j.data?.message ?? j.message ?? "Copilot CLI failed").slice(0, 300);
    else if (j.type === "result") {
      if (typeof j.sessionId === "string") sessionId = j.sessionId;
      if (typeof j.exitCode === "number") exitCode = j.exitCode;
      const p = Number(j.usage?.premiumRequests);
      if (Number.isFinite(p)) premiumRequests = p;
    }
  }
  if (!error && exitCode && !text) error = `Copilot CLI exited ${exitCode}`;
  return { text: text.trim(), sessionId, premiumRequests, model, error };
}

type Run = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string | null> }) => Promise<Ran>;

/**
 * A Complete through Copilot CLI. `model` is Copilot's (COPILOT_CLI_MODEL), whatever a caller asks
 * for: Claude's names (haiku, sonnet) mean nothing to it. Calls cost premium requests, not dollars: 0.
 */
export function copilotCli(tool: Pick<Tool, "bin" | "pre">, opts: { model?: string; run?: Run; timeoutMs?: number; log?: (line: string) => void; root?: string } = {}): Complete {
  const run = opts.run ?? runOff;
  const root = opts.root ?? join(tmpdir(), "dovre-copilot-cli");
  const active = new Set<string>();
  // Homes a crash or a locked file left behind go before the next call starts.
  const sweep = () => {
    try {
      for (const d of readdirSync(root)) if (d.startsWith("h-") && !active.has(join(root, d))) rmSync(join(root, d), { recursive: true, force: true });
    } catch {}
  };
  return async ({ system, user }) => {
    mkdirSync(root, { recursive: true });
    sweep();
    const home = mkdtempSync(join(root, "h-"));
    active.add(home);
    const cwd = join(home, "work");
    mkdirSync(cwd);
    try {
      let r: Ran;
      try {
        r = await run(tool.bin, [...tool.pre, ...copilotCliArgs(cwd, opts.model)], { cwd, input: copilotPrompt(system, user), timeoutMs: opts.timeoutMs ?? 120_000, env: { COPILOT_HOME: home, COPILOT_ALLOW_ALL: null, COPILOT_AUTO_UPDATE: "false" } });
      } catch (e) {
        throw new Error(/timed out|ETIMEDOUT|killed/i.test(String((e as Error).message)) ? "Copilot CLI timed out" : String((e as Error).message).slice(0, 300));
      }
      const got = parseCopilotJsonl(r.stdout);
      if (got.error || (r.code !== 0 && !got.text)) throw new Error(got.error ?? (r.stderr || `Copilot CLI exited ${r.code}`).slice(0, 300));
      if (!got.text) throw new Error("Copilot CLI gave no answer.");
      opts.log?.(`copilot cli: ${got.model ?? opts.model ?? "auto"}, ${got.premiumRequests ?? "?"} premium request(s)`);
      return { text: got.text, cost: 0 };
    } finally {
      // Its home held the prompt (session files, session-store.db, logs): gone with it.
      active.delete(home);
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {}
    }
  };
}
