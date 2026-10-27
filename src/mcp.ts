/**
 * Dovre's MCP server for the agent turns it starts (dovre#153): the packs' tools (`Pack.tools`),
 * over MCP's Streamable HTTP transport, answered as plain JSON (no stream: every call is one answer).
 *
 * Who can call: a turn or terminal Dovre started, while it runs. Each gets its own random token
 * (src/agents/runner.ts, src/packs/core/terminal/terms.ts; omp and agy through src/mcp-stdio.ts);
 * it isn't the launch token and opens nothing but POST /mcp. Answered before the sign-in check, so it's held tighter than a page:
 *  - local mode only, on a localhost Host (not PUBLIC_ORIGIN): a 404 otherwise, as if nothing were here;
 *  - no Origin header: a browser always sends one on a POST, an agent's MCP client doesn't;
 *  - the token of a running turn, compared in constant time; a turn that ended takes its token with it.
 * Permissions don't widen: the agent asks for each MCP tool as for any other, and a pack's tool
 * enforces its own limits. Every call is logged (`mcp.call`: the tool and the repo, never the
 * arguments or what came back).
 */
import type { Hono } from "hono";
import { logAction } from "./actions/deploys.ts";
import type { D1 } from "./db.ts";
import type { Pack, PackContext, PackTool, ToolCall } from "./packs/types.ts";

import { MCP_VERSIONS } from "./mcp-stdio.ts";

export { MCP_VERSIONS };
export const MAX_REQUEST = 256_000;
export const MAX_RESULT = 60_000;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

type Turn = { id: string; repo: string; cwd: string };
export type McpOpts = {
  /** The packs shown now (on, available, not hidden). */
  shown: () => Pack[];
  ctxOf: (p: Pack) => PackContext;
  /** The running turn a token belongs to. */
  turnOf: (token: string) => Turn | undefined;
  hosted: boolean;
  /** A localhost Host (never PUBLIC_ORIGIN). */
  isLocal: (req: Request) => boolean;
  db: () => D1 | undefined;
  log: (line: string) => void;
  version?: string;
};

type Offered = { name: string; pack: Pack; tool: PackTool };

/** Every tool the shown packs offer, by its MCP name; a pack whose `tools` throws offers none. */
export function offered(packs: Pack[], ctxOf: (p: Pack) => PackContext, log: (line: string) => void): Map<string, Offered> {
  const out = new Map<string, Offered>();
  for (const p of packs) {
    if (!p.tools) continue;
    let list: PackTool[];
    try {
      list = p.tools(ctxOf(p));
    } catch (e) {
      log(`mcp: ${p.manifest.id}'s tools: ${(e as Error)?.message ?? e}`);
      continue;
    }
    for (const t of list) {
      if (!TOOL_NAME.test(t.name)) continue;
      const name = `${p.manifest.id.replace(/-/g, "_")}_${t.name}`;
      if (!out.has(name)) out.set(name, { name, pack: p, tool: t });
    }
  }
  return out;
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function mountMcp(app: Hono<any>, o: McpOpts) {
  const notHere = () => new Response("Not found", { status: 404 });
  const guard = (req: Request): Turn | Response => {
    if (o.hosted || !o.isLocal(req)) return notHere();
    // A browser page (any site, this one too) sends an Origin on a POST; an agent's client doesn't.
    if (req.headers.get("origin") !== null) return new Response("Forbidden", { status: 403 });
    const m = /^Bearer\s+(\S{32,200})$/i.exec(req.headers.get("authorization") ?? "");
    const turn = m ? o.turnOf(m[1]!) : undefined;
    if (!turn) return new Response("This turn's token, as Authorization: Bearer <token>.", { status: 401, headers: { "www-authenticate": "Bearer" } });
    return turn;
  };

  app.get("/mcp", (c) => (o.hosted || !o.isLocal(c.req.raw) ? notHere() : c.body(null, 405, { allow: "POST" })));
  app.delete("/mcp", (c) => (o.hosted || !o.isLocal(c.req.raw) ? notHere() : c.body(null, 405, { allow: "POST" })));

  app.post("/mcp", async (c) => {
    const turn = guard(c.req.raw);
    if (turn instanceof Response) return turn;
    const text = await c.req.text();
    if (text.length > MAX_REQUEST) return json(rpcError(null, -32600, "Too large."), 413);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return json(rpcError(null, -32700, "Not JSON."), 400);
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return json(rpcError(msg?.id, -32600, "One JSON-RPC 2.0 message."), 400);
    // A notification (initialized, cancelled…) or a response: taken, nothing to say.
    if (msg.id === undefined || msg.id === null) return c.body(null, 202);
    const id = msg.id;
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};

    switch (msg.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "dovre", version: o.version ?? "0" },
            instructions: "Tools from the packs of the Dovre that started this session. Each says its own limits; a refusal is final, so don't retry it another way.",
          },
        });
      }
      case "ping":
        return json({ jsonrpc: "2.0", id, result: {} });
      case "tools/list": {
        const tools = [...offered(o.shown(), o.ctxOf, o.log).values()].map((t) => ({ name: t.name, description: t.tool.description, inputSchema: t.tool.input }));
        return json({ jsonrpc: "2.0", id, result: { tools } });
      }
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const t = offered(o.shown(), o.ctxOf, o.log).get(name);
        if (!t) return json(rpcError(id, -32602, `No tool ${name.slice(0, 80)} here.`));
        const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        const call: ToolCall = { run: turn.id, repo: turn.repo, cwd: turn.cwd };
        let out: { text: string; error?: boolean };
        try {
          out = await t.tool.run(args, o.ctxOf(t.pack), call);
        } catch (e) {
          o.log(`mcp: ${name}: ${(e as Error)?.message ?? e}`);
          out = { text: "The tool failed.", error: true };
        }
        const said = String(out.text ?? "");
        const db = o.db();
        if (db) await logAction(db, { kind: "mcp.call", target: name, detail: `from an agent in ${turn.repo}`.slice(0, 200), ok: !out.error }).catch(() => {});
        return json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: said.length > MAX_RESULT ? `${said.slice(0, MAX_RESULT)}\n…(cut)` : said }], isError: !!out.error } });
      }
      default:
        return json(rpcError(id, -32601, `No method ${msg.method.slice(0, 80)} here.`));
    }
  });
}
