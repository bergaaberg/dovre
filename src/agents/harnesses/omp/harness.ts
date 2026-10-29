/**
 * omp ("oh-my-pi") as a second agent harness: `omp -p --mode json` headless in a repo, a new
 * session or a resumed/forked one, prompt on stdin. Checked against omp 18.12.2.
 *
 * Why json print mode, not rpc: the runner spawns one process per turn and reads stdout lines
 * until it exits. `--mode json` is exactly that (pi's agent events as JSON lines, then exit).
 * `--mode rpc` is a long-lived stdin/stdout protocol (prompt, abort, fork, branch commands) that
 * would need a different runner; nothing a turn needs is missing from json mode.
 *
 * The stream (one JSON object per line):
 * - `session` {id, cwd, parentSession?}: first line. Resume re-emits the same id; fork a new one.
 * - `agent_start`, `turn_start`, `turn_end`, `advisor_cost_changed`: bookkeeping, ignored.
 * - `message_start` / `message_end` {message}: role user | assistant | toolResult. Only
 *   assistant `message_end` is read: content blocks `text`, `thinking`, `toolCall`
 *   {id, name, arguments}, plus `usage.cost.total`, `stopReason`, `errorMessage`. (An assistant
 *   `message_start` can already carry the final content, so it isn't read, or text would double.)
 * - `message_update` {assistantMessageEvent}: `text_delta` {delta} streams text; the rest
 *   (thinking/toolcall deltas) is ignored.
 * - `tool_execution_start` {toolCallId, toolName, args} / `tool_execution_end` {…, result,
 *   isError}: results are never kept. The one thing read from an end is omp's own denial text.
 * - `agent_end` {messages, isTerminal}: the end of the prompt.
 *
 * Permissions. `tools.approvalMode` defaults to yolo (and the user's config is yolo), so every
 * turn passes `--approval-mode` explicitly and never yolo. omp sorts tools into tiers
 * (read < write < exec): `always-ask` runs reads only, `write` also runs edits/writes, yolo runs
 * everything. In `-p` there is no UI, so a call that needs approval is denied at once (no hang):
 * tool_execution_end isError with "Tool "write" requires approval but no interactive UI
 * available." That becomes a `denied` event. Allowing is per tool (omp's `tools.approval.<tool>:
 * allow` policy), not per command: "Allow and continue" resumes with `allowed: ["bash"]`, which
 * goes in as a `--config` overlay file (the flag only takes a path). That allows every call of
 * that tool for that one turn, which is broader than Claude's exact-command rules.
 *
 * Dovre's MCP tools (#172) reach omp through the stdio bridge (src/mcp-stdio.ts), registered once
 * from Settings; the turn's address and token come in the environment (`mcpEnv`). omp runs MCP
 * tools without asking even at always-ask (checked against omp 18.12.6), so a pack's tool must hold
 * its own limits, as every pack tool already must.
 *
 * Plan mode: omp's plan mode is TUI-only (`plan.defaultOnStartup` is ignored in print mode;
 * `--plan-yolo` approves the plan itself and implements it, so it's out). Here plan is
 * always-ask (nothing but reads can run) plus an appended instruction to stop at a plan.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, Run, StartOpts } from "../../runner.ts";
import { effortIn, effortList, type HarnessDef, type HarnessOptions } from "../shared.ts";

/**
 * Models for the "Model" select. "" is omp's configured default (modelRoles.default, for this
 * user github-copilot/gpt-6-luna at high thinking). The rest are Copilot models the config and
 * recent sessions use, plus Claude through Copilot. Values are what `--model` takes.
 */
export const OMP_MODELS: { value: string; label: string }[] = [
  { value: "", label: "omp's default model" },
  { value: "github-copilot/gpt-6-luna", label: "GPT-6 Luna" },
  { value: "github-copilot/gpt-6-sol", label: "GPT-6 Sol" },
  { value: "github-copilot/gpt-5.6-luna", label: "GPT-5.6 Luna (fast)" },
  { value: "github-copilot/claude-opus-5.5", label: "Claude Opus 5.5 (Copilot)" },
];

/** omp's approval modes for Dovre's three, its `--thinking` levels, and `--fork` on a reply. */
export const OMP_OPTIONS: HarnessOptions = {
  modes: {
    default: { label: "Always ask: only reads run, the rest asks", short: "always ask" },
    acceptEdits: { label: "Write: edits run, commands ask", short: "write" },
    plan: { label: "Plan only: reads, then a plan", short: "plan only" },
  },
  efforts: effortList(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).map((c) => (c.value === "" ? { value: "", label: "Default thinking" } : c)),
  fork: true,
};

export const OMP_PLAN_PROMPT =
  "Plan mode: read and search as much as you need, but do not edit or write files and do not run commands. " +
  "End with a short numbered plan and wait for the user to approve it.";

/** The text omp puts in a tool result when it denies a call for want of an approval UI. */
const DENIED = /requires approval but no interactive UI/;

/** A value omp's parser won't take for a flag, or that isn't the kind of thing it claims to be. */
const safeArg = (v: string | undefined, re: RegExp) => (v && !v.startsWith("-") && re.test(v) ? v : undefined);
const ID = /^[\w-]+$/;
const MODEL = /^[\w./:@-]+$/;
const TOOL = /^[A-Za-z0-9_.-]+$/;

/** One line of what an omp tool call does: the command, the pattern, the file. Never file contents. */
export function ompToolDetail(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const pattern = str(args.pattern);
  const path = str(args.path) ?? str(args.file_path);
  const v =
    str(args.command) ??
    (pattern ? (path ? `${pattern} in ${path}` : pattern) : undefined) ??
    path ??
    str(args.url) ??
    str(args.query) ??
    str(args.task) ??
    str(args.description) ??
    str(args.i) ?? // omp's short "intent" the model writes for each call
    "";
  return v.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * The overlay that allows these tools for one run: `{"tools":{"approval":{"bash":"allow"}}}`
 * (JSON is YAML, and omp reads `--config` as config.yml). Written once per tool set, under
 * `dir`. Names that aren't plain tool names are dropped, so nothing else gets into the file.
 */
export function allowOverlay(allowed: string[], dir = join(tmpdir(), "dovre")): string | undefined {
  const names = [...new Set(allowed.filter((a) => TOOL.test(a)))].sort();
  if (!names.length) return undefined;
  const body = JSON.stringify({ tools: { approval: Object.fromEntries(names.map((n) => [n, "allow"])) } });
  const file = join(dir, `omp-allow-${createHash("sha256").update(body).digest("hex").slice(0, 16)}.yml`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body + "\n");
  }
  return file;
}

export type OmpHarnessOpts = {
  /** Where allow overlays go (default: the temp folder). */
  overlayDir?: string;
  /** The omp profile a session lives in (`~/.omp/profiles/<name>`), so a resume runs in it. */
  profileOf?: (sessionId: string) => string | undefined;
};

export function ompArgs(o: StartOpts, opts: OmpHarnessOpts = {}): string[] {
  const args = ["-p", "--mode", "json", "--approval-mode", o.mode === "acceptEdits" ? "write" : "always-ask"];
  if (o.mode === "plan") args.push("--append-system-prompt", OMP_PLAN_PROMPT);
  const model = safeArg(o.model, MODEL);
  if (model) args.push("--model", model);
  const effort = effortIn(OMP_OPTIONS.efforts, o.effort);
  if (effort) args.push(`--thinking=${effort}`);
  const resume = safeArg(o.resume, ID);
  if (resume) {
    const profile = safeArg(opts.profileOf?.(resume), ID);
    if (profile) args.push("--profile", profile);
    // --fork isn't in `omp --help`, but it's the flag omp's own /fork spawns: a new session file
    // with the history copied, the original left alone.
    args.push(o.fork ? "--fork" : "--resume", resume);
  }
  if (o.allowed?.length) {
    const overlay = allowOverlay(o.allowed, opts.overlayDir);
    if (overlay) args.push("--config", overlay);
  }
  return args;
}

type State = { calls: Map<string, { name: string; args: unknown }>; lastText: string; error?: string };
const states = new WeakMap<Run, State>();
const stateOf = (run: Run) => {
  let s = states.get(run);
  if (!s) states.set(run, (s = { calls: new Map(), lastText: "" }));
  return s;
};

/** Folds one `--mode json` line into the run. Unknown lines are ignored. */
export function ompApply(run: Run, line: string) {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  if (!j || typeof j !== "object") return;
  const s = stateOf(run);
  switch (j.type) {
    case "session":
      if (typeof j.id === "string") run.sessionId = j.id;
      break;
    case "message_update": {
      const e = j.assistantMessageEvent;
      if (e?.type === "text_delta" && typeof e.delta === "string") run.partial += e.delta;
      break;
    }
    case "message_end": {
      const m = j.message;
      if (m?.role !== "assistant") break;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          run.events.push({ t: "text", text: b.text });
          s.lastText = b.text;
        }
        if (b?.type === "toolCall" && typeof b.name === "string") {
          run.events.push({ t: "tool", name: b.name, detail: ompToolDetail(b.name, b.arguments) });
          if (typeof b.id === "string") s.calls.set(b.id, { name: b.name, args: b.arguments });
        }
      }
      const cost = Number(m.usage?.cost?.total);
      if (Number.isFinite(cost)) run.cost += cost;
      // Only the newest assistant message decides: an auto-retried error that recovered isn't one.
      s.error = m.stopReason === "error" || m.stopReason === "aborted" ? String(m.errorMessage || m.stopReason) : undefined;
      run.partial = "";
      break;
    }
    case "tool_execution_start":
      if (typeof j.toolCallId === "string" && typeof j.toolName === "string") s.calls.set(j.toolCallId, { name: j.toolName, args: j.args });
      break;
    case "tool_execution_end": {
      if (!j.isError) break;
      // Read only to recognise omp's own denial message; tool output is never kept.
      const text = Array.isArray(j.result?.content) ? j.result.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
      if (!DENIED.test(text)) break;
      const call = s.calls.get(j.toolCallId);
      const tool = String(j.toolName ?? call?.name ?? "");
      if (tool) run.events.push({ t: "denied", tool, spec: tool, detail: ompToolDetail(tool, call?.args) });
      break;
    }
    case "agent_end":
      if (j.isTerminal === false) break;
      run.events.push({ t: "result", text: s.error ?? s.lastText, cost: run.cost, error: !!s.error });
      run.partial = "";
      break;
    case "error":
      run.events.push({ t: "error", text: String(j.message ?? j.error ?? "omp error").slice(0, 600) });
      break;
  }
}

export const ompHarness = (bin = "omp", opts: OmpHarnessOpts = {}): Harness => ({
  id: "omp",
  bin,
  args: (o) => ompArgs(o, opts),
  apply: ompApply,
  // The prompt on stdin: `-p` reads it there, so a prompt starting with "-" isn't taken for a
  // flag and long prompts don't hit Windows' command-line limit.
  stdinPrompt: true,
  canFork: true,
  mcpEnv: true,
});

// Every turn says how to ask before acting: the user's own omp config approves everything.
export const omp: HarnessDef = { id: "omp", bin: "omp", binVar: "OMP_BIN", models: OMP_MODELS, options: OMP_OPTIONS, keep: "launcher/keep_omp.go", make: (t, ctx) => ({ ...ompHarness(t.bin, { profileOf: (id) => ctx.ompProfileOf?.(id) }), pre: t.pre }) };
