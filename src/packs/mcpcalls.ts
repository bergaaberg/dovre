/**
 * A pack's MCP calls (#488, `ctx.mcp`): exact calls to the one MCP server its manifest names, made
 * through Claude Code's sign-in to it (src/ai/mcpcalls.ts), for where an app's API tokens are
 * locked down. The pack never writes a prompt: it lists calls, core asks for exactly those, and
 * each call gets its tool's own result back, matched by tool and arguments, so the model can't
 * change what's read.
 *
 * Behind the pack's AI grant (src/packs/ai.ts): off until I tick it on Settings → Packs → the
 * pack, within the day's dollars, logged by cost only. Reads and writes are apart: `call` may use
 * only the manifest's `reads`, with every write tool refused outright; `write` makes one call to
 * one write tool, under the write kind the manifest maps it to. Results are handed to the pack in
 * memory; core stores none of them. Local only.
 */
import { type McpMade, type McpRun, McpSetupError } from "../ai/mcpcalls.ts";
import type { AiGrant, PackAiStore } from "./ai.ts";
import type { PackMcp, PackMcpAsk, PackMcpCall, PackMcpCan, PackMcpResult } from "./types.ts";

const SERVER = /^[a-z][a-z0-9_-]{0,40}$/;
const TOOL = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const KIND = /^[a-z][a-z0-9-]{0,40}$/;
/** The most calls in one job, the most their arguments may be, and the most of a result that's handed on. */
export const MAX_CALLS = 20;
export const MAX_ASK_CHARS = 50_000;
export const MAX_RESULT_CHARS = 200_000;

const oneLine = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 200) : undefined);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What a manifest asks for (`ai.mcp`), read safely: a why, an https server, and its tools by plain name; else nothing. */
export function mcpAskOf(m: unknown): PackMcpAsk | undefined {
  if (!plain(m)) return undefined;
  const why = oneLine(m.why);
  const server = plain(m.server) ? m.server : {};
  const name = typeof server.name === "string" && SERVER.test(server.name) ? server.name : undefined;
  let url: string | undefined;
  try {
    const u = new URL(String(server.url));
    if (u.protocol === "https:" && !u.username && !u.password) url = u.href;
  } catch {}
  if (!why || !name || !url) return undefined;
  const writes: Record<string, string> = {};
  if (plain(m.writes)) for (const [tool, kind] of Object.entries(m.writes).slice(0, MAX_CALLS)) if (TOOL.test(tool) && typeof kind === "string" && KIND.test(kind)) writes[tool] = kind;
  // A tool is a read or a write, never both: a write wins.
  const reads = Array.isArray(m.reads) ? [...new Set(m.reads.filter((t): t is string => typeof t === "string" && TOOL.test(t) && !(t in writes)))].slice(0, MAX_CALLS) : [];
  if (!reads.length && !Object.keys(writes).length) return undefined;
  return { why, server: { name, url }, reads, writes };
}

/** A value with its keys in order at every depth, so two sets of arguments compare as text. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (plain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const same = (a: unknown) => JSON.stringify(canon(a));

/** The result of the call made with exactly these arguments, or why there's none. */
function resultOf(made: McpMade[], call: PackMcpCall): PackMcpResult {
  const want = same(call.input);
  const of = made.filter((c) => c.tool === call.tool);
  const hit = of.find((c) => same(c.input) === want);
  if (!hit) return { ok: false, why: of.length ? `${call.tool} was called with other arguments than asked` : `the ${call.tool} call wasn't made` };
  if (hit.result === undefined) return { ok: false, why: `${call.tool} gave no result` };
  if (hit.error) return { ok: false, why: `${call.tool}: ${hit.result.split("\n")[0]!.slice(0, 200)}` };
  if (hit.result.length > MAX_RESULT_CHARS) return { ok: false, why: `${call.tool}'s result is too long to hand on` };
  return { ok: true, text: hit.result };
}

const callLine = (n: number, c: PackMcpCall) => `${n}) ${c.tool} ${JSON.stringify(c.input)}`;

export function packMcpFor(o: { id: string; ask: PackMcpAsk | undefined; store: PackAiStore | undefined; run: McpRun | undefined; hosted: boolean; log: (line: string) => void }): PackMcp {
  const a = o.ask;
  const whyNot = (): string | undefined => {
    if (o.hosted) return "not hosted yet";
    if (!a) return "it didn't ask for MCP calls in its manifest";
    if (!o.store) return "no database here";
    if (!o.store.grant(o.id).mcp) return "not allowed: Settings → Packs → this pack";
    if (!o.run) return "Claude Code isn't on this machine";
    return undefined;
  };
  const can = (): PackMcpCan => {
    const no = whyNot();
    return no ? { ok: false, why: no } : { ok: true, reads: [...(a!.reads ?? [])], writes: Object.keys(a!.writes ?? {}) };
  };
  const gate = async () => {
    await o.store?.load().catch(() => {});
    const no = whyNot();
    if (no) throw new Error(`MCP: ${no}`);
  };
  /** One job: only `allowed` may be called, every other write tool is refused outright. */
  const job = async (calls: PackMcpCall[], allowed: string[], how: string, signal?: AbortSignal): Promise<{ made: McpMade[]; cost: number }> => {
    const store = o.store!;
    const g: AiGrant = store.grant(o.id);
    if (JSON.stringify(calls).length > MAX_ASK_CHARS) throw new Error(`MCP: the calls' arguments are over ${MAX_ASK_CHARS} characters`);
    if ((await store.spent(o.id)) >= g.dayUsd) throw new Error(`MCP: today's cap ($${g.dayUsd.toFixed(2)}) is spent; it opens again tomorrow`);
    const denied = Object.keys(a!.writes ?? {}).filter((t) => !allowed.includes(t));
    try {
      const s = await o.run!({ server: a!.server, allowed, denied, prompt: `${how}\n${calls.map((c, i) => callLine(i + 1, c)).join("\n")}`, ...(signal ? { signal } : {}) });
      await store.record(o.id, s.cost, true, "mcp").catch((e) => o.log(`mcp: can't log a job: ${(e as Error).message}`));
      return { made: s.calls, cost: s.cost };
    } catch (e) {
      await store.record(o.id, 0, false, "mcp").catch(() => {});
      throw e instanceof McpSetupError ? Object.assign(new Error(e.message), { setup: e.setup }) : e;
    }
  };
  const checked = (c: unknown, tools: string[], what: string): PackMcpCall => {
    if (!plain(c) || typeof c.tool !== "string" || !plain(c.input)) throw new Error("MCP: a call is { tool, input }");
    if (!tools.includes(c.tool)) throw new Error(`MCP: ${c.tool.slice(0, 80)} isn't one of the ${what} in its manifest`);
    return { tool: c.tool, input: c.input };
  };

  return {
    can,
    async call(calls, opts) {
      await gate();
      if (!Array.isArray(calls) || !calls.length || calls.length > MAX_CALLS) throw new Error(`MCP: 1 to ${MAX_CALLS} calls a job`);
      const asked = calls.map((c) => checked(c, a?.reads ?? [], "read tools"));
      const { made, cost } = await job(asked, [...new Set(asked.map((c) => c.tool))], "Make these calls now, in parallel:", opts?.signal);
      return { results: asked.map((c) => resultOf(made, c)), cost };
    },
    async write(kind, call, opts) {
      await gate();
      const writes = a?.writes ?? {};
      const c = checked(call, Object.keys(writes), "write tools");
      if (writes[c.tool] !== kind) throw new Error(`MCP: ${c.tool} isn't a write of kind ${String(kind).slice(0, 40)} in its manifest`);
      const { made, cost } = await job([c], [c.tool], "Make this one call now, once:", opts?.signal);
      return { result: resultOf(made, c), cost, times: made.filter((m) => m.tool === c.tool).length };
    },
  };
}
