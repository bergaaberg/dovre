/**
 * Dovre's MCP server over stdio, for agents that can't be handed an HTTP server per run (#172):
 * omp reads its servers only from mcp.json files, and agy only from its own config, without
 * filling in environment variables. Settings registers this once in each (src/agents/mcpsetup.ts);
 * the entry holds no secret.
 *
 * It forwards each JSON-RPC line to POST /mcp (src/mcp.ts) with the turn's address and token from
 * the environment the agent passes down (DOVRE_MCP_URL, DOVRE_MCP_TOKEN: src/agents/runner.ts
 * `mcpEnv`, or an open terminal's). Without them, as in a session Dovre didn't start, it answers by
 * itself with no tools, so the agent starts as usual. The address must be this machine's own
 * (loopback), so the token never leaves it.
 *
 * Run as `node --experimental-strip-types --no-warnings src/mcp-stdio.ts`.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Protocol versions Dovre's MCP server speaks, newest first (here, so this starts without loading the server). */
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type Target = { url: string; token: string };

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/mcp$/;
const TOKEN = /^[A-Za-z0-9_-]{32,200}$/;

/** Where to forward, from the environment; undefined when it isn't a Dovre turn's (or not a loopback address). */
export function targetOf(env: Record<string, string | undefined>): Target | undefined {
  const url = env.DOVRE_MCP_URL ?? "", token = env.DOVRE_MCP_TOKEN ?? "";
  return LOOPBACK.test(url) && TOKEN.test(token) ? { url, token } : undefined;
}

const reply = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The answer to one line when there's no turn to forward to: no tools. */
export function alone(msg: any): string | undefined {
  if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return undefined;
  if (msg.method === "initialize") {
    const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
    return reply(msg.id, {
      protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "dovre", version: "0" },
      instructions: "Dovre's tools are there only in a session Dovre started.",
    });
  }
  if (msg.method === "ping") return reply(msg.id, {});
  if (msg.method === "tools/list") return reply(msg.id, { tools: [] });
  return fail(msg.id, -32601, "Dovre's tools are there only in a session Dovre started.");
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Forwards one line; resolves to the line to write back, or undefined for nothing (a notification). */
export async function forward(line: string, t: Target | undefined, fetchFn: Fetch = fetch): Promise<string | undefined> {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "Not JSON.");
  }
  if (!t) return alone(msg);
  const id = msg && typeof msg === "object" ? msg.id : undefined;
  try {
    const res = await fetchFn(t.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${t.token}` }, body: line, signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    if (res.status === 202 || id === undefined || id === null) return undefined;
    if (res.headers.get("content-type")?.includes("application/json")) {
      try {
        return JSON.stringify(JSON.parse(text));
      } catch {}
    }
    return fail(id, -32000, res.status === 401 ? "This Dovre turn has ended." : `Dovre answered ${res.status}.`);
  } catch {
    return id === undefined || id === null ? undefined : fail(id, -32000, "Dovre isn't answering.");
  }
}

/** Reads lines on stdin until it closes; answers go out one a line, in the order they're ready. */
export function serve(input: NodeJS.ReadableStream, write: (line: string) => void, t: Target | undefined, fetchFn?: Fetch) {
  createInterface({ input }).on("line", (line) => {
    if (!line.trim()) return;
    void forward(line, t, fetchFn).then((out) => out && write(out));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve(process.stdin, (line) => process.stdout.write(`${line}\n`), targetOf(process.env));
}
