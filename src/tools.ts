/**
 * Which agent CLIs this machine has. Dovre works without any of them: what's missing is
 * switched off and said so in Settings → Setup, never a failure on a page.
 *
 * A tool is found on the PATH (or at CLAUDE_BIN / OMP_BIN). Node can't start a Windows .cmd
 * shim without a shell, and a shell would have to quote every argument, so an npm-installed
 * `claude.cmd` is read for the script it runs and started as `node <script>` instead.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** How to start a tool: the program, and arguments that go before the tool's own. */
export type Tool = { bin: string; pre: string[]; path: string };

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Where `name` would run from: an absolute path (or a path with a folder), or the first hit on PATH with the system's extensions. */
export function which(name: string, env: { PATH?: string; PATHEXT?: string } = process.env, platform = process.platform): string | undefined {
  const exts = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
  const candidates = (base: string) => (platform === "win32" && !extname(base) ? exts.map((e) => base + e) : [base]);
  if (isAbsolute(name) || /[\\/]/.test(name)) return candidates(resolve(name)).find(isFile);
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const hit = candidates(join(dir, name)).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}

/** The script an npm .cmd shim runs (`"%dp0%\node_modules\…\cli.js" %*`), resolved next to the shim. */
export function shimTarget(cmdFile: string, text: string): string | undefined {
  const m = text.match(/"%(?:~)?dp0%?\\?([^"%]+\.(?:c|m)?js)"/i);
  if (!m) return undefined;
  const target = resolve(dirname(cmdFile), m[1]!.replace(/\\/g, "/"));
  return existsSync(target) ? target : undefined;
}

/** A tool by name (or an override path), ready to start without a shell; undefined when it isn't here. */
export function findTool(name: string, override?: string, opts: { env?: { PATH?: string; PATHEXT?: string }; platform?: NodeJS.Platform; node?: string } = {}): Tool | undefined {
  const path = which(override || name, opts.env, opts.platform);
  if (!path) return undefined;
  if (/\.(cmd|bat)$/i.test(path)) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {}
    const script = shimTarget(path, text);
    return script ? { bin: opts.node ?? process.execPath, pre: [script], path } : undefined;
  }
  return { bin: path, pre: [], path };
}

/**
 * What this run found, set once at start (src/index.ts) for pages that offer an agent without a
 * runner at hand (src/pages/work.ts). `harnesses` unset: not looked yet (tests), offered as before.
 */
export const found: { harnesses?: ("claude" | "omp" | "agy" | "codex")[]; paths?: { claude?: string; omp?: string; copilot?: string; agy?: string; codex?: string; pwsh?: string; db?: string }; /** Copilot through omp: "ready", or what's missing (undefined: no omp). */ copilot?: string } = {};

/** The agent CLIs the agents pack can use, each switched on or off on its own (AGENT_HARNESSES). */
export const AGENT_CLIS = ["claude", "omp", "copilot", "agy", "codex"] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

/**
 * Which agent CLIs the agents pack uses (PLAN WP-M1): AGENT_HARNESSES names them, comma-separated;
 * unset or empty, every one this machine has. One left out isn't offered for a turn, its sessions
 * aren't listed, and it isn't a terminal program. Bino and summaries pick their own route.
 */
export function harnessesOn(setting: string | undefined): (h: AgentCli) => boolean {
  const list = (setting ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? (h) => list.includes(h) : () => true;
}

/** AI summaries go to Claude: on when Claude Code is here, unless SUMMARIES says no; never without it. */
/**
 * Which model writes the summaries: `claude` (Haiku through Claude Code), `omp` (a Copilot model through
 * omp) or `copilot` (Copilot CLI). SUMMARIES may name one; `on` or unset takes Claude Code when it's here,
 * else omp, else Copilot CLI; off is off.
 */
export function summariesVia(setting: string | undefined, claudeFound: boolean, ompFound: boolean, copilotFound = false, agyFound = false): "claude" | "omp" | "copilot" | "agy" | "codex" | "off" {
  const s = (setting ?? "").trim().toLowerCase();
  if (/^(off|no|false|0)$/.test(s)) return "off";
  if (s === "claude" || s === "omp" || s === "copilot" || s === "agy" || s === "codex") return s;
  // agy and Codex only when chosen: they can't be run without their tools (src/ai/llm.ts).
  void agyFound;
  return claudeFound ? "claude" : ompFound ? "omp" : copilotFound ? "copilot" : "off";
}
export const summariesWanted = (claudeFound: boolean, setting?: string) => claudeFound && (setting ? !/^(off|no|false|0)$/i.test(setting.trim()) : true);
