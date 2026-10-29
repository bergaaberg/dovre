/**
 * agy (Antigravity CLI) as an agent harness: `agy --output-format stream-json` in a repo,
 * with prompt on stdin (PLAN D12, WP-G4).
 */
import type { Harness, Run, StartOpts } from "../../runner.ts";
import { effortIn, effortList, type HarnessDef, type HarnessOptions, toolDetail, toolSpec } from "../shared.ts";

export type AgyHarnessOpts = {
  bin?: string;
  defaultModel?: string;
};

/** agy's `--mode` names and `--effort` levels. It can't fork. */
export const AGY_OPTIONS: HarnessOptions = {
  modes: {
    default: { label: "Ask before acting (agy's default)", short: "asks first" },
    acceptEdits: { label: "Accept edits, ask before commands", short: "accept edits" },
    plan: { label: "Plan: read, don't change anything", short: "plan" },
  },
  efforts: effortList(["low", "medium", "high", "xhigh", "max"]),
  fork: false,
};

export function agyArgs(o: StartOpts, opts: AgyHarnessOpts = {}): string[] {
  const args = ["--output-format", "stream-json"];

  if (o.mode === "plan") {
    args.push("--mode", "plan");
  } else if (o.mode === "acceptEdits") {
    args.push("--mode", "accept-edits");
  }

  const model = o.model || opts.defaultModel;
  if (model) {
    args.push("--model", model);
  }

  const effort = effortIn(AGY_OPTIONS.efforts, o.effort);
  if (effort) args.push("--effort", effort);

  if (o.resume) {
    args.push("--conversation", o.resume);
  }

  return args;
}

export function agyApply(run: Run, line: string): void {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }

  // Conversation identification
  if (j.conversation_id && !run.sessionId) {
    run.sessionId = j.conversation_id;
  }
  if (j.event === "init" && j.conversation_id) {
    run.sessionId = j.conversation_id;
  }

  // Step updates and streaming text deltas
  if (j.event === "step_update" && j.step_update) {
    const su = j.step_update;
    if (typeof su.text_delta === "string") {
      run.partial += su.text_delta;
    }
    if (su.state === "DONE" && run.partial.trim()) {
      run.events.push({ t: "text", text: run.partial });
      run.partial = "";
    }
    if (Array.isArray(su.tool_calls)) {
      for (const call of su.tool_calls) {
        run.events.push({
          t: "tool",
          name: call.name,
          detail: toolDetail(call.name, call.args),
        });
      }
    }
  }

  // agy refuses an MCP call it can't ask about (headless) unless its own settings allow it. It has no
  // per-turn allow, so say which rule would (#172) instead of offering "Allow and continue".
  if (j.event === "step_update" && j.step_update?.state === "ERROR") {
    const m = /permission check failed for mcp "([\w.-]{1,80}\/[\w.-]{1,80})"/.exec(String(j.step_update.tool_info?.error?.message ?? ""));
    if (m) run.events.push({ t: "error", text: `agy refused ${m[1]}: it can't ask in a turn Dovre runs. To allow it, add mcp(${m[1]}) to permissions.allow in agy's settings.` });
  }

  // Final result
  if (j.event === "result" && j.result) {
    const r = j.result;
    if (r.usage) {
      // Estimate approximate cost based on tokens (e.g. Gemini 2.5 ~$1/M tokens)
      const totalTokens = r.usage.total_tokens ?? (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0);
      run.cost = Number(((totalTokens * 1.5) / 1_000_000).toFixed(4));
    }
    const response = typeof r.response === "string" ? r.response : "";
    if (response.trim() && !run.events.some((e) => e.t === "text" && e.text === response)) {
      run.events.push({ t: "text", text: response });
    }
    run.events.push({
      t: "result",
      text: response,
      cost: run.cost,
      error: r.status !== "SUCCESS",
    });
    run.partial = "";
  }
}

export const AGY_MODELS: { value: string; label: string }[] = [
  { value: "", label: "agy's default model" },
  { value: "flash", label: "Gemini Flash" },
  { value: "flash_lite", label: "Gemini Flash Lite" },
  { value: "pro", label: "Gemini Pro" },
];

export const agyHarness = (bin = "agy", opts: AgyHarnessOpts = {}): Harness => ({
  id: "agy",
  bin,
  args: (o) => agyArgs(o, opts),
  apply: agyApply,
  stdinPrompt: true,
  canFork: false,
  mcpEnv: true,
});

export const agy: HarnessDef = { id: "agy", bin: "agy", binVar: "AGY_BIN", models: AGY_MODELS, options: AGY_OPTIONS, keep: "launcher/keep_agy.go", make: (t) => ({ ...agyHarness(t.bin), pre: t.pre }) };
