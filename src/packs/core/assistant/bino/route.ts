/**
 * How Bino reaches a model, chosen by BINO_VIA: `claude` (Claude Code's CLI, headless, the default
 * when it's here), `omp` (a Copilot model, no tools), `copilot` (Copilot CLI, no tools, src/ai/copilotcli.ts)
 * or `off`. Every route has the same shape, so
 * the page never knows which one answered.
 *
 * The CLI route runs `claude -p` with nothing to act with: no tools, no MCP servers, no settings,
 * skills or session file, in an empty folder of its own. Bino only talks; what it knows comes in
 * the prompt (src/packs/core/assistant/bino/context.ts). It starts on the worker thread (src/spawn.ts), since starting
 * claude.exe stalls whoever starts it for about a second here.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ran, runOff } from "../../../../spawn.ts";
import type { Tool } from "../../../../tools.ts";
import type { OmpAsker } from "../../../../ai/omp.ts";
import { agyCli, codexCli } from "../../../../ai/llm.ts";
import { type ApiKeyOpts, apiKeyRouteOf, type CfGatewayOpts, gatewayRouteOf, type OpenRouterOpts, openRouterRouteOf } from "./gateway.ts";

export const VIAS = ["claude", "omp", "copilot", "agy", "codex", "api-key", "cf-gateway", "openrouter", "off"] as const;
export type BinoVia = (typeof VIAS)[number];

/** One call: a system prompt and the conversation so far as one message in, the reply out. */
export type Ask = (p: { system: string; user: string; model?: string }) => Promise<{ text: string; cost: number }>;

export type Route = {
  via: BinoVia;
  /** Whether Bino can answer; when not, `why` says what to do about it. */
  ready: boolean;
  why?: string;
  ask?: Ask;
  /** The model for talking, and the cheap one memory is kept with. */
  model: string;
  reflectModel: string;
};

/** BINO_VIA as set, or what fits: Claude Code when it's here, else agy, else omp (a Copilot model), else Copilot CLI, else off. */
export function viaOf(setting: string | undefined, claudeFound: boolean, ompFound = false, copilotFound = false, agyFound = false): BinoVia {
  const s = (setting ?? "").trim().toLowerCase();
  if ((VIAS as readonly string[]).includes(s)) return s as BinoVia;
  // agy and Codex are never picked by themselves: they can't be run without their tools (src/ai/llm.ts).
  void agyFound;
  return claudeFound ? "claude" : ompFound ? "omp" : copilotFound ? "copilot" : "off";
}

export {
  type ApiKeyOpts,
  apiKeyRouteOf,
  type CfGatewayOpts,
  createApiKeyAsk,
  createCfGatewayAsk,
  createOpenRouterAsk,
  directModelOf,
  gatewayModelOf,
  type OpenRouterOpts,
  openRouterModelOf,
  openRouterRouteOf,
} from "./gateway.ts";

/** The CLI's arguments: talk only (no tools, no MCP, no settings, no session kept). */
export function binoArgs(system: string, model: string): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--system-prompt", system,
  ];
}

/** What the CLI answered: the reply and its cost, or why it didn't. */
export function parseReply(r: Ran): { text: string; cost: number } {
  let j: { is_error?: boolean; result?: unknown; total_cost_usd?: unknown };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error((r.stderr || r.stdout || `exit ${r.code}`).slice(0, 300));
  }
  if (j.is_error || r.code !== 0) throw new Error(String(j.result ?? r.stderr ?? `exit ${r.code}`).slice(0, 300));
  return { text: String(j.result ?? "").trim(), cost: Number(j.total_cost_usd ?? 0) };
}

type Run = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string }) => Promise<Ran>;

/**
 * `copilot`: the omp route, a Copilot model with no tools, no MCP and no session (src/teams/crawl.ts);
 * it talks and keeps memory with the model it was made with.
 */
export function routeOf(o: { via: BinoVia; claude?: Tool; copilot?: OmpAsker; copilotCli?: Ask; copilotCliModel?: string; agy?: Tool; codex?: Tool; apiKey?: ApiKeyOpts; cfGateway?: CfGatewayOpts; openRouter?: OpenRouterOpts; model?: string; reflectModel?: string; run?: Run; log?: (line: string) => void }): Route {
  const model = o.model || "sonnet";
  const reflectModel = o.reflectModel || "haiku";
  const base = { via: o.via, model, reflectModel };
  if (o.via === "off") return { ...base, ready: false, why: "Bino is off: turn it on in Settings → Panes." };
  if (o.via === "api-key") return apiKeyRouteOf({ apiKey: o.apiKey, model: o.model, reflectModel: o.reflectModel, log: o.log });
  if (o.via === "openrouter") return openRouterRouteOf({ openRouter: o.openRouter, model: o.model, reflectModel: o.reflectModel, log: o.log });
  if (o.via === "copilot") {
    const m = o.copilotCliModel || "auto";
    const at = { via: o.via, model: m, reflectModel: m };
    if (!o.copilotCli) return { ...at, ready: false, why: "Bino through Copilot CLI needs it installed (`copilot` on the PATH, or COPILOT_BIN)." };
    return { ...at, ready: true, ask: o.copilotCli };
  }
  if (o.via === "omp") {
    const c = o.copilot;
    const why = c ? c.why() : "Bino through Copilot needs omp (`omp` on the PATH).";
    const at = { via: o.via, model: c?.model ?? "", reflectModel: c?.model ?? "" };
    if (why || !c) return { ...at, ready: false, why };
    return {
      ...at,
      ready: true,
      ask: async ({ system, user }) => {
        const text = (await c.ask(user, { system })).trim();
        o.log?.(`bino: ${c.model} (Copilot)`);
        return { text, cost: 0 };
      },
    };
  }
  if (o.via === "cf-gateway") return gatewayRouteOf({ cfGateway: o.cfGateway, model: o.model, reflectModel: o.reflectModel, log: o.log });
  if (o.via === "agy") {
    const m = o.model || "flash";
    const at = { via: o.via, model: m, reflectModel: o.reflectModel || "flash_lite" };
    const agy = o.agy;
    if (!agy) {
      return { ...at, ready: false, why: "Bino talks through agy, which isn't here: install it (`agy` on the PATH) or set AGY_BIN." };
    }
    const ask = agyCli({ bin: agy.bin, pre: agy.pre, timeoutMs: 180_000, run: o.run });
    return {
      ...at,
      ready: true,
      ask: async (p) => {
        const got = await ask({ ...p, model: p.model || m });
        o.log?.(`bino: ${p.model || m} (agy)`);
        return got;
      },
    };
  }
  if (o.via === "codex") {
    // Empty: Codex's own default model (its config.toml).
    const at = { via: o.via, model: o.model || "", reflectModel: o.reflectModel || o.model || "" };
    const codex = o.codex;
    if (!codex) return { ...at, ready: false, why: "Bino talks through Codex, which isn't here: install it (`codex` on the PATH) or set CODEX_BIN." };
    const ask = codexCli({ bin: codex.bin, pre: codex.pre, timeoutMs: 180_000, run: o.run });
    return {
      ...at,
      ready: true,
      ask: async (p) => {
        const got = await ask({ ...p, model: p.model || undefined });
        o.log?.(`bino: ${p.model || "default model"} (Codex)`);
        return got;
      },
    };
  }
  const claude = o.claude;
  if (!claude) return { ...base, ready: false, why: "Bino talks through Claude Code, which isn't here: install it (`claude` on the PATH) or set CLAUDE_BIN." };
  const run = o.run ?? runOff;
  // An empty folder of its own: no CLAUDE.md or project settings to pick up.
  const cwd = join(tmpdir(), "dovre-bino");
  mkdirSync(cwd, { recursive: true });
  const ask: Ask = async ({ system, user, model: m }) => {
    const r = await run(claude.bin, [...claude.pre, ...binoArgs(system, m || model)], { cwd, input: user, timeoutMs: 180_000 });
    const got = parseReply(r);
    o.log?.(`bino: ${m || model}, $${got.cost.toFixed(4)}`);
    return got;
  };
  return { ...base, ready: true, ask };
}
