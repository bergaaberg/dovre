/**
 * Short model calls (summaries), through the local `claude` CLI: headless, no tools, no
 * settings, skills, MCP servers or session file, so it's cheap and can't act. The text goes in
 * on stdin.
 */
import { type Ran, runOff } from "../spawn.ts";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpAsker } from "./omp.ts";
import { codexCost } from "../agents/harnesses/codex/harness.ts";

/** `onText`, where the route streams: the reply so far, as it grows. */
export type Complete = (p: { system: string; user: string; model?: string; signal?: AbortSignal; onText?: (soFar: string) => void }) => Promise<{ text: string; cost: number }>;

export function cliArgs(system: string, model: string): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--tools", "",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt", system,
  ];
}

/**
 * The same through a Copilot model in omp, for people without Claude Code: the crawler's asker
 * (src/ai/omp.ts: its own profile with no MCP servers, no tools, no session). The model it
 * was made with answers, whatever `model` asks for; Copilot calls cost nothing per call here.
 */
export function copilotComplete(c: Pick<OmpAsker, "ask">): Complete {
  return async ({ system, user }) => ({ text: (await c.ask(user, { system })).trim(), cost: 0 });
}

/** `pre`: arguments before claude's own (node running an npm shim's script, src/tools.ts). */
export function claudeCli(opts: { bin?: string; pre?: string[]; timeoutMs?: number } = {}): Complete {
  const bin = opts.bin ?? "claude";
  // An empty folder of its own: no CLAUDE.md or project settings to pick up.
  const cwd = join(tmpdir(), "dovre-llm");
  mkdirSync(cwd, { recursive: true });
  // Off the main thread: starting claude.exe stalls whoever starts it for about a second (src/spawn.ts).
  return async ({ system, user, model = "haiku" }) => {
    let r: Ran;
    try {
      r = await runOff(bin, [...(opts.pre ?? []), ...cliArgs(system, model)], { cwd, input: user, timeoutMs: opts.timeoutMs ?? 90_000 });
    } catch (e) {
      throw new Error(/timed out|ETIMEDOUT|killed/i.test(String((e as Error).message)) ? "summary timed out" : String((e as Error).message).slice(0, 300));
    }
    let j: { is_error?: boolean; result?: unknown; total_cost_usd?: unknown };
    try {
      j = JSON.parse(r.stdout);
    } catch {
      throw new Error((r.stderr || r.stdout || `exit ${r.code}`).slice(0, 300));
    }
    if (j.is_error || r.code !== 0) throw new Error(String(j.result ?? r.stderr ?? `exit ${r.code}`).slice(0, 300));
    return { text: String(j.result ?? "").trim(), cost: Number(j.total_cost_usd ?? 0) };
  };
}

export type RunFn = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; signal?: AbortSignal }) => Promise<Ran>;

/**
 * agy, only when chosen (BINO_VIA / SUMMARIES=agy): unlike the other routes it can't be run without
 * its tools and MCP servers, so it runs sandboxed (`--sandbox`), with slash commands off, in an
 * empty folder of its own; what it's asked stays in agy's own history. `pre`: arguments before agy's own.
 */
export const AGY_LLM_DIR = join(tmpdir(), "dovre-llm-agy");
export function agyCli(opts: { bin?: string; pre?: string[]; timeoutMs?: number; run?: RunFn } = {}): Complete {
  const bin = opts.bin ?? "agy";
  const cwd = AGY_LLM_DIR;
  mkdirSync(cwd, { recursive: true });
  const runner = opts.run ?? runOff;
  return async ({ system, user, model, signal }) => {
    let r: Ran;
    const args = [
      ...(opts.pre ?? []),
      "--output-format",
      "json",
      "--disable-slash-commands",
      "--sandbox",
      ...(model ? ["--model", model] : []),
    ];
    const input = system ? `${system}\n\n${user}` : user;
    try {
      r = await runner(bin, args, { cwd, input, timeoutMs: opts.timeoutMs ?? 90_000, signal });
    } catch (e) {
      throw new Error(/timed out|ETIMEDOUT|killed/i.test(String((e as Error).message)) ? "summary timed out" : String((e as Error).message).slice(0, 300));
    }
    let j: { status?: string; response?: unknown; error?: unknown };
    try {
      j = JSON.parse(r.stdout);
    } catch {
      throw new Error((r.stderr || r.stdout || `exit ${r.code}`).slice(0, 300));
    }
    if (r.code !== 0 || (j.status && j.status !== "SUCCESS")) {
      throw new Error(String(j.error ?? j.response ?? r.stderr ?? `exit ${r.code}`).slice(0, 300));
    }
    return { text: String(j.response ?? "").trim(), cost: 0 };
  };
}

/**
 * Codex, only when chosen (BINO_VIA / SUMMARIES=codex; PLAN WP-M1): `codex exec --json` read-only
 * (`--sandbox read-only`), in an empty folder of its own (`--skip-git-repo-check`: it isn't a
 * checkout), the text on stdin. Like agy it keeps its tools, so it's never picked by itself. The
 * reply is the turn's last agent message; the cost an estimate from its tokens (src/agents/harnesses/codex/).
 */
export const CODEX_LLM_DIR = join(tmpdir(), "dovre-llm-codex");
export function codexCli(opts: { bin?: string; pre?: string[]; timeoutMs?: number; run?: RunFn } = {}): Complete {
  const bin = opts.bin ?? "codex";
  const cwd = CODEX_LLM_DIR;
  mkdirSync(cwd, { recursive: true });
  const runner = opts.run ?? runOff;
  return async ({ system, user, model, signal }) => {
    let r: Ran;
    const args = [...(opts.pre ?? []), "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", ...(model ? ["--model", model] : []), "-"];
    try {
      r = await runner(bin, args, { cwd, input: system ? `${system}\n\n${user}` : user, timeoutMs: opts.timeoutMs ?? 90_000, signal });
    } catch (e) {
      throw new Error(/timed out|ETIMEDOUT|killed/i.test(String((e as Error).message)) ? "summary timed out" : String((e as Error).message).slice(0, 300));
    }
    let text = "";
    let failed: string | undefined;
    let usage: Parameters<typeof codexCost>[0];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === "item.completed" && (j.item?.type ?? j.item?.item_type) === "agent_message" && typeof j.item.text === "string") text = j.item.text;
        if (j.type === "turn.completed") usage = j.usage;
        if (j.type === "turn.failed") failed = String(j.error?.message ?? "Codex's turn failed");
        if (j.type === "error" && typeof j.message === "string") failed ??= j.message;
      } catch {}
    }
    if (failed || r.code !== 0) throw new Error((failed ?? (r.stderr || `exit ${r.code}`)).slice(0, 300));
    return { text: text.trim(), cost: codexCost(usage) };
  };
}
