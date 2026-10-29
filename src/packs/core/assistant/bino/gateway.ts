/**
 * Bino through Cloudflare AI Gateway (PLAN D17): the Anthropic Messages API behind the account's
 * gateway, with the gateway's own token (CF_AIG_TOKEN) and the provider key kept in the gateway
 * (BYOK), or an ANTHROPIC_API_KEY passed along. Portable on purpose: the hosted Worker and its
 * Durable Object (src/hosted/hub.ts) load this, never route.ts, whose CLIs are Node only.
 */
import type { Ask, Route } from "./route.ts";

export type CfGatewayOpts = {
  accountId?: string;
  gateway?: string;
  apiToken?: string;
  /** Sent as x-api-key when the gateway doesn't hold the provider key itself. */
  apiKey?: string;
  /** The name of the key stored in the gateway (BYOK), when it isn't `default`: sent as cf-aig-byok-alias. */
  keyAlias?: string;
  model?: string;
  fetchFn?: typeof fetch;
};

/** The CLI's short names (BINO_MODEL=sonnet) as API model ids, and their prices ($ per 1M tokens in, out). */
const GATEWAY_MODELS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const PRICES: Record<string, [number, number]> = { "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };
export const gatewayModelOf = (m: string | undefined) => GATEWAY_MODELS[(m ?? "").trim().toLowerCase()] ?? (m?.trim() || "claude-sonnet-5-5");

/** A setting from the process, where there is one (locally; a Worker passes its bindings instead). */
/** A hung provider must never stall a Bino turn (the CLI routes time out at 180 s); Stop ends it sooner. */
const within = (stop?: AbortSignal) => (stop ? AbortSignal.any([AbortSignal.timeout(180_000), stop]) : AbortSignal.timeout(180_000));

/** Each `data:` of a Server-Sent Events body, parsed; `[DONE]` and what isn't JSON are skipped. */
export async function eachEvent(res: Response, fn: (e: unknown) => void): Promise<void> {
  if (!res.body) return;
  const read = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const line = (l: string) => {
    if (!l.startsWith("data:")) return;
    const d = l.slice(5).trim();
    if (!d || d === "[DONE]") return;
    let e: unknown;
    try {
      e = JSON.parse(d);
    } catch {
      return;
    }
    fn(e);
  };
  for (;;) {
    const { value, done } = await read.read();
    if (done) break;
    buf += value;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const l of lines) line(l);
  }
  line(buf);
}

type Reply = { model?: string; stop_reason?: string; text: string; usage?: { input_tokens?: number; output_tokens?: number } };

/** A Messages API reply: read whole, or streamed (`onText` given, the request sent with `stream: true`). */
async function messagesReply(res: Response, onText?: (soFar: string) => void): Promise<Reply> {
  if (!onText) {
    const j = (await res.json()) as { model?: string; stop_reason?: string; content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    // The reply is the text block; thinking blocks come first and carry no text by default.
    const text = (j.content ?? []).filter((b) => b.type === "text" || (b.type === undefined && typeof b.text === "string")).map((b) => b.text ?? "").join("");
    return { model: j.model, stop_reason: j.stop_reason, text, usage: j.usage };
  }
  const r: Reply = { text: "", usage: {} };
  let failed: string | undefined;
  await eachEvent(res, (raw) => {
    const e = raw as { type?: string; message?: { model?: string; usage?: { input_tokens?: number } }; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: { output_tokens?: number }; error?: { message?: string } };
    if (e.type === "message_start") {
      r.model = e.message?.model;
      r.usage!.input_tokens = e.message?.usage?.input_tokens;
    } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
      r.text += e.delta.text;
      onText(r.text);
    } else if (e.type === "message_delta") {
      r.stop_reason = e.delta?.stop_reason ?? r.stop_reason;
      r.usage!.output_tokens = e.usage?.output_tokens ?? r.usage!.output_tokens;
    } else if (e.type === "error") failed = e.error?.message ?? "the stream failed";
  });
  if (failed) throw new Error(failed.slice(0, 200));
  return r;
}

type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };

/** A chat-completions reply (OpenAI, Gemini, OpenRouter): read whole, or streamed with `onText`. */
async function chatReply(res: Response, onText?: (soFar: string) => void): Promise<{ text: string; usage?: ChatUsage }> {
  if (!onText) {
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: ChatUsage };
    return { text: (j.choices?.[0]?.message?.content ?? "").trim(), usage: j.usage };
  }
  let text = "";
  let usage: ChatUsage | undefined;
  let failed: string | undefined;
  await eachEvent(res, (raw) => {
    const e = raw as { choices?: { delta?: { content?: string | null } }[]; usage?: ChatUsage | null; error?: { message?: string } };
    if (e.error) failed = e.error.message ?? "the stream failed";
    const d = e.choices?.[0]?.delta?.content;
    if (d) {
      text += d;
      onText(text);
    }
    if (e.usage) usage = e.usage;
  });
  if (failed) throw new Error(failed.slice(0, 200));
  return { text: text.trim(), usage };
}

const fromEnv = (k: string): string | undefined => (typeof process !== "undefined" ? process.env?.[k] : undefined) || undefined;

/** Ask implementation using Cloudflare AI Gateway. */
export function createCfGatewayAsk(opts: CfGatewayOpts = {}): Ask {
  const f = opts.fetchFn ?? fetch;
  const accountId = opts.accountId ?? fromEnv("CF_ACCOUNT_ID") ?? "";
  const gateway = opts.gateway ?? fromEnv("AI_GATEWAY") ?? "default";
  const token = opts.apiToken ?? fromEnv("CF_AIG_TOKEN");
  const apiKey = opts.apiKey ?? fromEnv("ANTHROPIC_API_KEY");
  const keyAlias = (opts.keyAlias ?? fromEnv("AI_GATEWAY_KEY_ALIAS"))?.trim();
  const defaultModel = gatewayModelOf(opts.model);
  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/anthropic/v1/messages`;

  return async ({ system, user, model: callModel, signal, onText }) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (token) headers["cf-aig-authorization"] = `Bearer ${token}`;
    if (apiKey) headers["x-api-key"] = apiKey;
    else if (keyAlias) headers["cf-aig-byok-alias"] = keyAlias;
    const res = await f(url, {
      method: "POST",
      headers,
      signal: within(signal),
      // Current models think by default, and thinking counts against max_tokens: leave room for the reply.
      body: JSON.stringify({
        model: callModel ? gatewayModelOf(callModel) : defaultModel,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
        ...(onText ? { stream: true } : {}),
      }),
    });
    if (!res.ok) throw new Error(`AI Gateway HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await messagesReply(res, onText);
    if (j.stop_reason === "refusal") throw new Error("The model declined to answer that.");
    const text = j.text;
    const [pin, pout] = PRICES[j.model ?? callModel ?? defaultModel] ?? PRICES[gatewayModelOf(callModel ?? defaultModel)] ?? [2, 10];
    const cost = Number((((j.usage?.input_tokens ?? 0) * pin + (j.usage?.output_tokens ?? 0) * pout) / 1_000_000).toFixed(4));
    return { text, cost };
  };
}

/** Theroute: ready with an account and the gateway's token; memory is kept on Haiku unless told otherwise. */
export function gatewayRouteOf(o: { cfGateway?: CfGatewayOpts; model?: string; reflectModel?: string; log?: (line: string) => void }): Route {
  const g = o.cfGateway ?? {};
  const accountId = g.accountId ?? fromEnv("CF_ACCOUNT_ID");
  const apiToken = g.apiToken ?? fromEnv("CF_AIG_TOKEN");
  const gateway = g.gateway ?? fromEnv("AI_GATEWAY") ?? fromEnv("CF_GATEWAY_NAME");
  const model = gatewayModelOf(o.model);
  const at = { via: "cf-gateway" as const, model, reflectModel: gatewayModelOf(o.reflectModel || "haiku") };
  if (!accountId || !apiToken) return { ...at, ready: false, why: "Bino through Cloudflare AI Gateway needs CF_ACCOUNT_ID and CF_AIG_TOKEN." };
  const ask = createCfGatewayAsk({ ...g, accountId, apiToken, gateway, model });
  return {
    ...at,
    ready: true,
    ask: async (p) => {
      const got = await ask({ ...p, model: p.model || model });
      o.log?.(`bino: ${p.model || model} (AI Gateway), $${got.cost.toFixed(4)}`);
      return got;
    },
  };
}

export type ApiKeyOpts = {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
};

/** Direct provider model aliases: defaults to a cheap, fast model (`claude-haiku-5-5`, `gpt-4o-mini`, or `gemini-2.5-flash`). */
export function directModelOf(m: string | undefined, key?: string): string {
  const raw = (m ?? "").trim();
  const low = raw.toLowerCase();
  if (low in GATEWAY_MODELS) return GATEWAY_MODELS[low]!;
  if (raw) return raw;
  if (key?.startsWith("AIza")) return "gemini-2.5-flash";
  if (key && /^sk-(?!ant-)/.test(key)) return "gpt-4o-mini";
  return "claude-haiku-5-5";
}

const DIRECT_PRICES: Record<string, [number, number]> = {
  ...PRICES,
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gemini-2.5-flash": [0.15, 0.6],
  "gemini-2.5-pro": [1.25, 10],
  "anthropic/claude-3.5-haiku": [0.8, 4],
  "anthropic/claude-sonnet-4": [3, 15],
  "google/gemini-2.5-flash": [0.15, 0.6],
};

/**
 * Direct Provider API Key route (`BINO_VIA=api-key` / `ASSISTANT_VIA=api-key`).
 * Supports Anthropic (`claude-haiku-5-5` recommended), OpenAI (`gpt-4o-mini`), or Google Gemini (`gemini-2.5-flash`)
 * directly via fetch, with no proxy or gateway required.
 */
export function createApiKeyAsk(opts: ApiKeyOpts = {}): Ask {
  const f = opts.fetchFn ?? fetch;
  const apiKey =
    opts.apiKey ??
    fromEnv("ASSISTANT_API_KEY") ??
    fromEnv("ANTHROPIC_API_KEY") ??
    fromEnv("OPENAI_API_KEY") ??
    fromEnv("GEMINI_API_KEY") ??
    "";
  const defaultModel = directModelOf(opts.model, apiKey);

  return async ({ system, user, model: callModel, signal, onText }) => {
    const model = callModel ? directModelOf(callModel, apiKey) : defaultModel;
    const isGemini = /^gemini-/i.test(model) || apiKey.startsWith("AIza");
    const isOpenAi = !isGemini && (/^(gpt-|o1|o3|o4)/i.test(model) || /^sk-(?!ant-)/.test(apiKey));

    if (isGemini || isOpenAi) {
      const url = isGemini
        ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        : "https://api.openai.com/v1/chat/completions";
      const res = await f(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal: within(signal),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(onText ? { stream: true, ...(isOpenAi ? { stream_options: { include_usage: true } } : {}) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Provider API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await chatReply(res, onText);
      const text = j.text;
      const [pin, pout] = DIRECT_PRICES[model] ?? [0.15, 0.6];
      const cost = Number((((j.usage?.prompt_tokens ?? 0) * pin + (j.usage?.completion_tokens ?? 0) * pout) / 1_000_000).toFixed(4));
      return { text, cost };
    }

    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      signal: within(signal),
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: user }],
        ...(onText ? { stream: true } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await messagesReply(res, onText);
    if (j.stop_reason === "refusal") throw new Error("The model declined to answer that.");
    const text = j.text;
    const [pin, pout] = DIRECT_PRICES[j.model ?? model] ?? DIRECT_PRICES[model] ?? [0.1, 0.5];
    const cost = Number((((j.usage?.input_tokens ?? 0) * pin + (j.usage?.output_tokens ?? 0) * pout) / 1_000_000).toFixed(4));
    return { text, cost };
  };
}

export function apiKeyRouteOf(o: { apiKey?: ApiKeyOpts; model?: string; reflectModel?: string; log?: (line: string) => void }): Route {
  const k = o.apiKey ?? {};
  const key =
    k.apiKey ??
    fromEnv("ASSISTANT_API_KEY") ??
    fromEnv("ANTHROPIC_API_KEY") ??
    fromEnv("OPENAI_API_KEY") ??
    fromEnv("GEMINI_API_KEY");
  const model = directModelOf(o.model, key);
  const reflectModel = directModelOf(o.reflectModel || (model.startsWith("gpt-") ? "gpt-4o-mini" : model.startsWith("gemini-") ? "gemini-2.5-flash" : "haiku"), key);
  const at = { via: "api-key" as const, model, reflectModel };
  if (!key) return { ...at, ready: false, why: "Direct API Key route needs ASSISTANT_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)." };
  const ask = createApiKeyAsk({ ...k, apiKey: key, model });
  return {
    ...at,
    ready: true,
    ask: async (p) => {
      const got = await ask({ ...p, model: p.model || model });
      o.log?.(`bino: ${p.model || model} (Direct API Key), $${got.cost.toFixed(4)}`);
      return got;
    },
  };
}

export type OpenRouterOpts = {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
};

const OPENROUTER_MODELS: Record<string, string> = {
  haiku: "anthropic/claude-3.5-haiku",
  sonnet: "anthropic/claude-sonnet-4",
  flash: "google/gemini-2.5-flash",
};

export const openRouterModelOf = (m: string | undefined) =>
  OPENROUTER_MODELS[(m ?? "").trim().toLowerCase()] ?? (m?.trim() || "anthropic/claude-3.5-haiku");

/** OpenRouter route (`BINO_VIA=openrouter` / `ASSISTANT_VIA=openrouter`). */
export function createOpenRouterAsk(opts: OpenRouterOpts = {}): Ask {
  const f = opts.fetchFn ?? fetch;
  const apiKey = opts.apiKey ?? fromEnv("OPENROUTER_API_KEY") ?? fromEnv("ASSISTANT_API_KEY") ?? "";
  const defaultModel = openRouterModelOf(opts.model);

  return async ({ system, user, model: callModel, signal, onText }) => {
    const model = callModel ? openRouterModelOf(callModel) : defaultModel;
    const res = await f("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "http-referer": "https://dovre.dev",
        "x-title": "Dovre",
      },
      signal: within(signal),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(onText ? { stream: true } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await chatReply(res, onText);
    const text = j.text;
    const [pin, pout] = DIRECT_PRICES[model] ?? [0.8, 4];
    const cost =
      typeof j.usage?.cost === "number"
        ? Number(j.usage.cost.toFixed(4))
        : Number((((j.usage?.prompt_tokens ?? 0) * pin + (j.usage?.completion_tokens ?? 0) * pout) / 1_000_000).toFixed(4));
    return { text, cost };
  };
}

export function openRouterRouteOf(o: { openRouter?: OpenRouterOpts; model?: string; reflectModel?: string; log?: (line: string) => void }): Route {
  const r = o.openRouter ?? {};
  const key = r.apiKey ?? fromEnv("OPENROUTER_API_KEY") ?? fromEnv("ASSISTANT_API_KEY");
  const model = openRouterModelOf(o.model);
  const reflectModel = openRouterModelOf(o.reflectModel || "haiku");
  const at = { via: "openrouter" as const, model, reflectModel };
  if (!key) return { ...at, ready: false, why: "OpenRouter route needs OPENROUTER_API_KEY (or ASSISTANT_API_KEY)." };
  const ask = createOpenRouterAsk({ ...r, apiKey: key, model });
  return {
    ...at,
    ready: true,
    ask: async (p) => {
      const got = await ask({ ...p, model: p.model || model });
      o.log?.(`bino: ${p.model || model} (OpenRouter), $${got.cost.toFixed(4)}`);
      return got;
    },
  };
}
