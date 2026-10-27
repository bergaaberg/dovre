/**
 * Terminals in Dovre: each one a program from the fixed list (programs.ts) in a checkout right
 * under CODE_DIR, run in a pseudo console by `dovre pty-host` (launcher/pty.go) and talked to
 * over its stdio in frames. The server never starts the program itself: starting claude.exe
 * stalls the starter ~1 s here, and a terminal that stalled every page would be worse than none.
 *
 * Output is never written anywhere: the last 256 KB stay in memory so a page that comes back (a
 * reload, a second window) sees where things are, and go when the terminal does. A terminal with
 * nobody watching for 20 minutes is closed; one that ended is listed for 10 more, then dropped.
 * They end with the server: its end of the host's stdin closes, and the host takes the program
 * and everything it started with it (a job object).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpConfig, mcpEnv } from "../../../agents/harnesses/shared.ts";
import { repoDir } from "../../../agents/runner.ts";
import { listRepos } from "../../../sources/claude.ts";
import { argvFor, type Program } from "./programs.ts";

export type ExternalApp = "warp" | "wt";

export type Chunk = { t: "out"; data: string } | { t: "exit"; code: number; reason?: string };

export type Term = {
  id: string;
  program: string;
  label: string;
  repo: string;
  cwd: string;
  resume?: string;
  startedAt: number;
  endedAt?: number;
  code?: number;
  reason?: string;
};

/** `mcp`: the terminal's own token for Dovre's MCP server (#172), kept off `Term` so it's never drawn. */
type Live = Term & { child: ChildProcess; tail: string; subs: Set<(c: Chunk) => void>; idleSince: number; mcp?: string };

const TAIL = 256 * 1024;
const IDLE_MS = 20 * 60_000;
const KEEP_ENDED_MS = 10 * 60_000;

export type Terminals = {
  programs(): Program[];
  /** The checkouts a terminal may start in (right under CODE_DIR), by folder name. */
  repos(): string[];
  start(o: { program: string; repo: string; cols?: number; rows?: number; resume?: string }): Term | { problem: string };
  /** Launches a validated program + checkout in an external terminal app (Warp or Windows Terminal). */
  openExternal(o: { app: ExternalApp; program: string; repo: string; resume?: string }): { ok: true } | { problem: string };
  get(id: string): Term | undefined;
  list(): Term[];
  /** Replays what's in memory, then follows; returns the way to stop following. */
  attach(id: string, fn: (c: Chunk) => void): (() => void) | undefined;
  input(id: string, data: string): boolean;
  resize(id: string, cols: number, rows: number): boolean;
  close(id: string): boolean;
  /** The open terminal an MCP token was made for (src/mcp.ts); undefined once it has ended. */
  byMcpToken(token: string): { id: string; repo: string; cwd: string } | undefined;
};

/**
 * What a terminal's program gets to reach Dovre's MCP server while it's open (#172): Claude Code and
 * Codex in their arguments, and everything in the environment, so omp and agy (through the stdio
 * bridge) and agents started from a shell get it too.
 */
export function withMcp(p: Program, argv: string[], m: { url: string; token: string }): { argv: string[]; env: Record<string, string> } {
  const extra = p.harness === "claude" ? ["--mcp-config", mcpConfig(m)] : p.harness === "codex" ? ["-c", `mcp_servers.dovre.url=${JSON.stringify(m.url)}`, "-c", 'mcp_servers.dovre.bearer_token_env_var="DOVRE_MCP_TOKEN"'] : [];
  return { argv: [...argv, ...extra], env: mcpEnv(m) };
}

const frame = (kind: string, payload: Buffer) => {
  const b = Buffer.alloc(5 + payload.length);
  b[0] = kind.charCodeAt(0);
  b.writeUInt32LE(payload.length, 1);
  payload.copy(b, 5);
  return b;
};
const size = (cols: number, rows: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(cols, 0);
  b.writeUInt16LE(rows, 2);
  return b;
};
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : d);

export function createTerminals(opts: {
  hostExe: string; codeDir: string; programs: Program[]; onChange?: () => void; now?: () => number; spawnFn?: typeof spawn; warpDir?: string;
  /** Dovre's MCP server: each terminal gets its address and a token of its own while it's open, when `on()` says packs offer tools. */
  mcp?: { url: string; on?: () => boolean };
}): Terminals {
  const now = opts.now ?? Date.now;
  const spawnFn = opts.spawnFn ?? spawn;
  const terms = new Map<string, Live>();
  const changed = () => opts.onChange?.();
  const view = (l: Live): Term => {
    const { child: _c, tail: _t, subs: _s, idleSince: _i, mcp: _m, ...t } = l;
    return t;
  };
  const ended = (l: Live, code: number, reason?: string) => {
    if (l.endedAt) return;
    l.endedAt = now();
    l.code = code;
    l.reason = reason;
    for (const fn of l.subs) fn({ t: "exit", code, reason });
    changed();
  };
  const sweep = setInterval(() => {
    for (const [id, l] of terms) {
      if (!l.endedAt && !l.subs.size && now() - l.idleSince > IDLE_MS) {
        l.child.stdin?.write(frame("k", Buffer.alloc(0)));
        setTimeout(() => l.child.kill(), 3000).unref?.();
      }
      if (l.endedAt && now() - l.endedAt > KEEP_ENDED_MS) {
        terms.delete(id);
        changed();
      }
    }
  }, 30_000);
  sweep.unref?.();

  return {
    programs: () => opts.programs,
    repos: () => listRepos(opts.codeDir),
    start(o) {
      const p = opts.programs.find((x) => x.id === o.program);
      if (!p) return { problem: "That isn't one of the programs a terminal here can run." };
      const cwd = repoDir(opts.codeDir, o.repo);
      if (!cwd) return { problem: "Pick a checkout in your code folder." };
      let argv = argvFor(p, o.resume);
      if (!argv) return { problem: "Only an agent CLI resumes a session, and only by its id." };
      const cols = clamp(o.cols, 20, 400, 120);
      const rows = clamp(o.rows, 5, 200, 32);
      const token = opts.mcp && (opts.mcp.on?.() ?? true) ? randomBytes(32).toString("base64url") : undefined;
      let env: NodeJS.ProcessEnv | undefined;
      if (token && opts.mcp) {
        const w = withMcp(p, argv, { url: opts.mcp.url, token });
        argv = w.argv;
        env = { ...process.env, ...w.env };
      }
      const child = spawnFn(opts.hostExe, ["pty-host", "--cols", String(cols), "--rows", String(rows), "--cwd", cwd, "--", ...argv], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], ...(env ? { env } : {}) });
      const l: Live = { id: randomUUID(), program: p.id, label: p.label, repo: o.repo, cwd, resume: o.resume, startedAt: now(), child, tail: "", subs: new Set(), idleSince: now(), mcp: token };
      terms.set(l.id, l);
      const decoder = new TextDecoder("utf-8");
      let buf = Buffer.alloc(0);
      child.stdout?.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
          const n = buf.readUInt32LE(1);
          if (buf.length < 5 + n) break;
          const kind = String.fromCharCode(buf[0]!);
          const payload = buf.subarray(5, 5 + n);
          buf = buf.subarray(5 + n);
          if (kind === "o") {
            const data = decoder.decode(payload, { stream: true });
            if (!data) continue;
            l.tail = (l.tail + data).slice(-TAIL);
            for (const fn of l.subs) fn({ t: "out", data });
          } else if (kind === "e") l.reason = payload.toString("utf8").slice(0, 300);
          else if (kind === "x") {
            let code = -1;
            try {
              code = Number(JSON.parse(payload.toString("utf8")).code);
            } catch {}
            ended(l, code, l.reason);
          }
        }
      });
      child.on("error", (e) => ended(l, -1, e.message));
      child.on("close", () => ended(l, l.code ?? -1, l.reason ?? "The terminal's host ended."));
      changed();
      return view(l);
    },
    openExternal(o) {
      if (o.app !== "warp" && o.app !== "wt") return { problem: "Pick Warp or Windows Terminal." };
      const p = opts.programs.find((x) => x.id === o.program);
      if (!p) return { problem: "That isn't one of the programs a terminal here can run." };
      const cwd = repoDir(opts.codeDir, o.repo);
      if (!cwd) return { problem: "Pick a checkout in your code folder." };
      const argv = argvFor(p, o.resume);
      if (!argv) return { problem: "Only an agent CLI resumes a session, and only by its id." };
      if (o.app === "wt") {
        const child = spawnFn("wt.exe", ["-d", cwd, "--", ...argv], { cwd, detached: true, windowsHide: false, stdio: ["ignore", "ignore", "ignore"] });
        child.on("error", () => {});
        child.unref?.();
        return { ok: true };
      }
      const dir = opts.warpDir ?? join(homedir(), ".warp", "launch_configurations");
      mkdirSync(dir, { recursive: true });
      const quote = (a: string) => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
      const cmdLine = argv.map(quote).join(" ");
      const yaml = `---\nname: dovre-session\nwindows:\n  - tabs:\n      - title: ${JSON.stringify(`${p.label} (${o.repo})`)}\n        layout:\n          cwd: ${JSON.stringify(cwd)}\n          commands:\n            - exec: ${JSON.stringify(cmdLine)}\n`;
      writeFileSync(join(dir, "dovre-session.yaml"), yaml, { mode: 0o600 });
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
      const openArgs = process.platform === "win32" ? ["/c", "start", "", "warp://launch/dovre-session"] : ["warp://launch/dovre-session"];
      const child = spawnFn(opener, openArgs, { cwd, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", () => {});
      child.unref?.();
      return { ok: true };
    },
    get: (id) => {
      const l = terms.get(id);
      return l ? view(l) : undefined;
    },
    list: () => [...terms.values()].sort((a, b) => b.startedAt - a.startedAt).map(view),
    byMcpToken(token) {
      if (typeof token !== "string" || token.length < 32) return undefined;
      const given = Buffer.from(token);
      for (const l of terms.values()) {
        if (!l.mcp || l.endedAt) continue;
        const want = Buffer.from(l.mcp);
        if (want.length === given.length && timingSafeEqual(want, given)) return { id: `terminal:${l.id}`, repo: l.repo, cwd: l.cwd };
      }
      return undefined;
    },
    attach(id, fn) {
      const l = terms.get(id);
      if (!l) return undefined;
      if (l.tail) fn({ t: "out", data: l.tail });
      if (l.endedAt) {
        fn({ t: "exit", code: l.code ?? -1, reason: l.reason });
        return () => {};
      }
      l.subs.add(fn);
      return () => {
        l.subs.delete(fn);
        if (!l.subs.size) l.idleSince = now();
      };
    },
    input(id, data) {
      const l = terms.get(id);
      if (!l || l.endedAt || !data) return false;
      l.child.stdin?.write(frame("i", Buffer.from(data.slice(0, 64 * 1024), "utf8")));
      return true;
    },
    resize(id, cols, rows) {
      const l = terms.get(id);
      if (!l || l.endedAt) return false;
      l.child.stdin?.write(frame("r", size(clamp(cols, 20, 400, 120), clamp(rows, 5, 200, 32))));
      return true;
    },
    close(id) {
      const l = terms.get(id);
      if (!l || l.endedAt) return false;
      l.child.stdin?.write(frame("k", Buffer.alloc(0)));
      setTimeout(() => !l.endedAt && l.child.kill(), 3000).unref?.();
      return true;
    },
  };
}
