/**
 * A small MCP client for `db mcp` (db-cli's own MCP server, newline-delimited JSON-RPC on stdio),
 * for the Data tab's production databases. Dovre is the host here: when db asks before it opens
 * a production database (`elicitation/create`), the question goes to `ask`, which puts it in the
 * bar on every page (src/relay/asks.ts) for me to answer. Nothing else answers it.
 *
 * db holds a yes for one database until its process ends, so the process ends after `idleMs`
 * without a call (and on close()): then db asks again. What comes back is handed to the caller
 * and nowhere else; db's stderr is dropped unread (it can carry anything).
 */
import { type ChildProcess, spawn } from "node:child_process";

export type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type Ask = (message: string, schema: unknown) => Promise<Answer>;
export type SpawnFn = (bin: string, args: string[]) => ChildProcess;
/** db's tabular answer: column names and rows of strings (or null). */
export type Table = { columns: string[]; rows: (string | null)[][]; rowCount: number; truncated: boolean };

export type DbMcp = {
  call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Ends db (and with it every yes it holds). */
  close(): void;
  running(): boolean;
};

const PROTOCOL = "2025-11-25";

export function createDbMcp(o: { bin: string; pre?: string[]; ask: Ask; idleMs?: number; spawnFn?: SpawnFn; onClose?: () => void }): DbMcp {
  const spawnFn: SpawnFn = o.spawnFn ?? ((bin, args) => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
  let child: ChildProcess | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let idle: NodeJS.Timeout | undefined;

  const send = (m: unknown) => child?.stdin?.write(`${JSON.stringify(m)}\n`);
  const request = (method: string, params: unknown, timeoutMs: number) =>
    new Promise<any>((ok, fail) => {
      const id = nextId++;
      const t = setTimeout(() => (pending.delete(id), fail(new Error("db took too long to answer."))), timeoutMs);
      pending.set(id, { ok: (v) => (clearTimeout(t), ok(v)), fail: (e) => (clearTimeout(t), fail(e)) });
      send({ jsonrpc: "2.0", id, method, params });
    });

  /** A request from db: its question to me, a ping; anything else it can't have. */
  async function serve(m: any) {
    if (m.method === "elicitation/create") {
      let a: Answer;
      try {
        a = await o.ask(String(m.params?.message ?? ""), m.params?.requestedSchema);
      } catch {
        // Nobody could be asked: unanswered, which db reads as no.
        a = { action: "cancel" };
      }
      send({ jsonrpc: "2.0", id: m.id, result: a });
    } else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not offered by this client." } });
  }

  function end() {
    clearTimeout(idle);
    const c = child;
    child = undefined;
    ready = undefined;
    for (const p of pending.values()) p.fail(new Error("db's connection closed."));
    pending.clear();
    if (c) {
      try {
        c.stdin?.end();
        c.kill();
      } catch {}
      o.onClose?.();
    }
  }

  function start(): Promise<void> {
    if (ready) return ready;
    const c = spawnFn(o.bin, [...(o.pre ?? []), "mcp"]);
    child = c;
    let buf = "";
    c.stdout?.setEncoding?.("utf8");
    c.stdout?.on("data", (d: string | Buffer) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.method && m.id !== undefined) void serve(m);
        else if (m.id !== undefined && pending.has(m.id)) {
          const p = pending.get(m.id)!;
          pending.delete(m.id);
          if (m.error) p.fail(new Error(String(m.error.message ?? "db refused.").slice(0, 400)));
          else p.ok(m.result);
        }
      }
    });
    c.stderr?.resume();
    c.on("error", () => child === c && end());
    c.on("close", () => child === c && end());
    ready = request("initialize", { protocolVersion: PROTOCOL, capabilities: { elicitation: { form: {} } }, clientInfo: { name: "dovre", version: "1" } }, 30_000).then(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    });
    ready.catch(() => end());
    return ready;
  }

  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(end, o.idleMs ?? 30 * 60_000);
    idle.unref?.();
  };

  return {
    async call(tool, args, timeoutMs = 10 * 60_000) {
      touch();
      await start();
      try {
        const r = await request("tools/call", { name: tool, arguments: args }, timeoutMs);
        if (r?.isError) {
          const text = Array.isArray(r.content) ? r.content.map((c: any) => (c?.type === "text" ? String(c.text) : "")).join(" ") : "";
          throw new Error(text.trim().slice(0, 400) || "db refused.");
        }
        if (r?.structuredContent !== undefined) return r.structuredContent;
        const text = Array.isArray(r?.content) ? r.content.find((c: any) => c?.type === "text")?.text : undefined;
        if (typeof text !== "string") return undefined;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      } finally {
        touch();
      }
    },
    close: end,
    running: () => !!child,
  };
}

/** db's tabular answer as rows keyed by column, the shape the Data tab draws. */
export function tableOf(v: unknown): { rows: Record<string, string | null>[]; columns: string[]; truncated: boolean } {
  const t = v && typeof v === "object" ? (v as Partial<Table>) : {};
  const columns = Array.isArray(t.columns) ? t.columns.map(String) : [];
  const rows = (Array.isArray(t.rows) ? t.rows : []).filter(Array.isArray).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] == null ? null : String(r[i])])));
  return { rows, columns, truncated: !!t.truncated };
}
