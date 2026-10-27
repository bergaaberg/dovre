/**
 * Giving omp and agy Dovre's pack tools (#172). Neither takes an MCP server per run, so Settings
 * registers the stdio bridge (src/mcp-stdio.ts) once in each one's own config: omp's mcp.json (the
 * default profile's, and each profile's), agy's through `agy mcp add`. The entry is the same for
 * every turn and holds no secret: the turn's address and token come in its environment.
 *
 * Only on a click (a Confirm, logged as agents.tools). An entry is "stale" when Dovre's node or
 * folder moved (an update, a new install), and registering again fixes it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ToolsHarness = "omp" | "agy";
export const TOOLS_HARNESSES: ToolsHarness[] = ["omp", "agy"];
/** Each config's name for the bridge. */
export const SERVER = "dovre";

export type Entry = { command: string; args: string[] };
export type Reg = "yes" | "stale" | "no" | "unreadable";

/** How omp or agy starts the bridge: this node, on this checkout's script. */
export const bridgeEntry = (execPath = process.execPath, script = fileURLToPath(new URL("../mcp-stdio.ts", import.meta.url))): Entry => ({ command: execPath, args: ["--experimental-strip-types", "--no-warnings", script] });

/** JSON with // and /* *\/ comments and trailing commas (agy's config takes them); undefined when it still isn't JSON. */
export function jsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

const same = (s: any, want: Entry) => s && typeof s === "object" && s.command === want.command && Array.isArray(s.args) && s.args.length === want.args.length && s.args.every((a: unknown, i: number) => a === want.args[i]) && s.disabled !== true && s.enabled !== false;

/** One config file's state: the bridge as it should be, there but different, missing, or a file that can't be read. */
export function fileState(file: string, want: Entry): Reg {
  if (!existsSync(file)) return "no";
  let j: any;
  try {
    j = jsonc(readFileSync(file, "utf8"));
  } catch {
    return "unreadable";
  }
  if (!j || typeof j !== "object") return "unreadable";
  const s = j.mcpServers?.[SERVER];
  return !s ? "no" : same(s, want) ? "yes" : "stale";
}

/** The worst of several: one file that lacks it means it's not everywhere. */
const worst = (states: Reg[]): Reg => (["unreadable", "no", "stale", "yes"] as Reg[]).find((r) => states.includes(r)) ?? "no";

/** omp's mcp.json for the default profile, and for each profile there is (~/.omp/profiles/<name>/agent). */
export function ompFiles(home: string): string[] {
  const root = join(home, ".omp");
  const out = [join(root, "agent", "mcp.json")];
  try {
    for (const p of readdirSync(join(root, "profiles"), { withFileTypes: true })) if (p.isDirectory() && /^[\w.-]+$/.test(p.name)) out.push(join(root, "profiles", p.name, "agent", "mcp.json"));
  } catch {}
  return out;
}

export const agyFile = (home: string) => join(home, ".gemini", "config", "mcp_config.json");

export function toolsState(h: ToolsHarness, home: string, want: Entry): Reg {
  return h === "omp" ? worst(ompFiles(home).map((f) => fileState(f, want))) : fileState(agyFile(home), want);
}

type Run = (bin: string, args: string[]) => void;
const runQuiet: Run = (bin, args) => void execFileSync(bin, args, { stdio: "ignore", timeout: 20_000, windowsHide: true });

/**
 * Puts the bridge in. omp: each mcp.json, keeping every other server (a file that isn't JSON is left
 * alone and said). agy: `agy mcp add`, which keeps its own format. Nothing else is changed.
 */
export function registerTools(h: ToolsHarness, o: { home: string; want: Entry; /** How to start agy: its binary, and any script before its own arguments. */ agy?: string[]; run?: Run }): { ok: true } | { ok: false; why: string } {
  if (h === "agy") {
    if (!o.agy?.[0]) return { ok: false, why: "agy isn't on this machine." };
    try {
      (o.run ?? runQuiet)(o.agy[0], [...o.agy.slice(1), "mcp", "add", SERVER, "--", o.want.command, ...o.want.args]);
    } catch (e) {
      return { ok: false, why: `agy mcp add failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    return toolsState("agy", o.home, o.want) === "yes" ? { ok: true } : { ok: false, why: "agy took it, but its config doesn't show it." };
  }
  const files = ompFiles(o.home);
  const read: { file: string; j: any }[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      read.push({ file, j: {} });
      continue;
    }
    // Plain JSON only: rewriting a file with comments would drop them.
    let j: any;
    try {
      j = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, why: `${file} isn't plain JSON (comments?), so Dovre left it alone; nothing was changed. Add the "${SERVER}" server to it by hand.` };
    read.push({ file, j });
  }
  for (const { file, j } of read) {
    const servers = j.mcpServers && typeof j.mcpServers === "object" && !Array.isArray(j.mcpServers) ? j.mcpServers : {};
    const next = { ...j, mcpServers: { ...servers, [SERVER]: { type: "stdio", command: o.want.command, args: o.want.args } } };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.dovre-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  return { ok: true };
}
