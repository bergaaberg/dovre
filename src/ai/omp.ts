/**
 * One question to a Copilot model through omp, with nothing else: its own omp profile with no MCP
 * servers, no tools, no extensions, skills or rules, and no session saved. A run whose stream shows
 * a tool call, or an answer from anything but Copilot, is thrown away. Bino and summaries use it for
 * people without Claude Code; packs that must keep what they read away from Claude use it too.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../spawn.ts";

export type OmpAsker = {
  /** Why it can't run (undefined: it can). */
  why(): string | undefined;
  /** The model's text answer to one prompt (with `system` in place of omp's own). Throws on a tool call, a non-Copilot model, or a failed run. */
  ask(prompt: string, o?: { system?: string }): Promise<string>;
  model: string;
  profile: string;
};

/** Who is asking and which settings name its profile and model, for what it says when it can't run. */
export type AskerWho = { name: string; profileVar: string; modelVar: string };

export type OmpRun = (bin: string, args: string[], opts: { cwd: string; input: string; timeoutMs: number; maxBuffer: number }) => Promise<Ran>;

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export function ompAsker(o: { omp?: { bin: string; pre: string[] }; profile: string; model: string; cwd: string; run: OmpRun; home?: string; who: AskerWho }): OmpAsker {
  const dir = join(o.home ?? homedir(), ".omp", "profiles", o.profile, "agent");
  const who = o.who;
  const why = () => {
    if (!o.omp) return `${who.name} needs omp (OMP_BIN, or omp on the PATH).`;
    if (!PROFILE_NAME.test(o.profile)) return `${who.profileVar} isn't a profile name.`;
    if (!/^github-copilot\/[\w.:-]{1,80}$/.test(o.model)) return `${who.name} runs only on a Copilot model (github-copilot/…); ${who.modelVar} is ${o.model || "empty"}.`;
    if (!existsSync(dir)) return `Set up the omp profile ${o.profile} once: run \`omp --profile ${o.profile}\` and sign in to GitHub Copilot (/login), then quit.`;
    if (existsSync(join(dir, "mcp.json"))) return `The omp profile ${o.profile} has MCP servers (${join(dir, "mcp.json")}): it must have none, so nothing it reads can reach a tool. Remove that file.`;
    return undefined;
  };
  return {
    model: o.model,
    profile: o.profile,
    why,
    async ask(prompt, opts = {}) {
      const no = why();
      if (no) throw new Error(no);
      const args = ["-p", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "always-ask", "--profile", o.profile, "--model", o.model, ...(opts.system ? ["--system-prompt", opts.system] : [])];
      const r = await o.run(o.omp!.bin, [...o.omp!.pre, ...args], { cwd: o.cwd, input: prompt, timeoutMs: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      return answerOf(r);
    },
  };
}

/** The assistant's text from omp's JSON stream; refused if a tool was called or the model isn't Copilot's. */
export function answerOf(r: Ran): string {
  let text = "";
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === "tool_execution_start") throw new Error(`The model tried a tool (${String(j.toolName ?? "?").slice(0, 60)}): run thrown away.`);
    if (j.type !== "message_end" || j.message?.role !== "assistant") continue;
    const provider = j.message.provider ?? j.message.api;
    if (typeof provider === "string" && !/copilot/i.test(provider)) throw new Error(`The answer came through ${provider.slice(0, 40)}, not Copilot: run thrown away.`);
    for (const b of Array.isArray(j.message.content) ? j.message.content : []) {
      if (b?.type === "toolCall") throw new Error("The model tried a tool: run thrown away.");
      if (b?.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  if (r.code !== 0 && !text) throw new Error(`omp ended with ${r.code}: ${r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
  return text;
}
