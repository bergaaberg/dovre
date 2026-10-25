/**
 * What a terminal may run: a fixed list found once at start, never a command line from the page.
 * Shells (pwsh, cmd, Git Bash) and the agent CLIs (Claude Code, omp and each omp profile, Copilot CLI). A page
 * names one by id; the folder is checked separately (a checkout right under CODE_DIR).
 *
 * omp always gets an explicit --approval-mode (CLAUDE.md: the user's own omp config approves
 * everything): "always-ask", since a person is at the keyboard. A profile with a policy overlay
 * (~/.omp/policies/<profile>.yml, as the company-db launcher uses) gets it with --config, and
 * the flags its launcher script passes (~/.omp/bin/Invoke-Omp<Profile>.ps1), so starting
 * company-db here is the same as from its own shortcut.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findTool, which } from "../../../tools.ts";

export type Program = { id: string; label: string; argv: string[]; harness?: "claude" | "omp" | "copilot" | "agy" | "codex"; profile?: string };

const pascal = (name: string) => name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

/** The `$ompArguments = @( … )` flags a launcher script passes; only plain flags and the policy path. */
export function launcherFlags(script: string, policy: string): string[] {
  const m = script.match(/\$ompArguments\s*=\s*@\(([\s\S]*?)\)/);
  if (!m) return [];
  const out: string[] = [];
  for (const t of m[1]!.matchAll(/'([^']*)'|(\$policyPath)/g)) {
    if (t[2]) out.push(policy);
    else if (/^[\w\-.:=]+$/.test(t[1]!)) out.push(t[1]!);
  }
  return out;
}

/** The shells and agent CLIs here; an agent CLI switched off (`on`, src/tools.ts harnessesOn) isn't one. */
export function findPrograms(opts: { home?: string; env?: NodeJS.ProcessEnv; claudeBin?: string; ompBin?: string; copilotBin?: string; agyBin?: string; codexBin?: string; on?: (h: NonNullable<Program["harness"]>) => boolean } = {}): Program[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const out: Program[] = [];
  const pwsh = which("pwsh", env) ?? which("powershell", env);
  if (pwsh) out.push({ id: "pwsh", label: /pwsh/i.test(pwsh) ? "PowerShell" : "Windows PowerShell", argv: [pwsh, "-NoLogo"] });
  if (process.platform === "win32") {
    const cmd = env.ComSpec && existsSync(env.ComSpec) ? env.ComSpec : "C:\\Windows\\System32\\cmd.exe";
    if (existsSync(cmd)) out.push({ id: "cmd", label: "Command Prompt", argv: [cmd] });
    const bash = join(env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
    if (existsSync(bash)) out.push({ id: "bash", label: "Git Bash", argv: [bash, "--login", "-i"] });
  } else {
    const zsh = which("zsh", env);
    if (zsh) out.push({ id: "zsh", label: "Zsh", argv: [zsh, "-l"] });
    const bash = which("bash", env);
    if (bash) out.push({ id: "bash", label: "Bash", argv: [bash, "-l"] });
  }
  const agy = findTool("agy", opts.agyBin ?? env.AGY_BIN);
  if (agy) out.push({ id: "agy", label: "Antigravity CLI (agy)", argv: [agy.bin, ...agy.pre], harness: "agy" });
  const claude = findTool("claude", opts.claudeBin ?? env.CLAUDE_BIN);
  if (claude) out.push({ id: "claude", label: "Claude Code", argv: [claude.bin, ...claude.pre], harness: "claude" });
  const omp = findTool("omp", opts.ompBin ?? env.OMP_BIN);
  if (omp) {
    const base = [omp.bin, ...omp.pre];
    out.push({ id: "omp", label: "omp", argv: [...base, "--approval-mode", "always-ask"], harness: "omp" });
    const dir = join(home, ".omp", "profiles");
    let profiles: string[] = [];
    try {
      profiles = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[\w-]{1,40}$/.test(d.name)).map((d) => d.name).sort();
    } catch {}
    for (const p of profiles) {
      const policy = join(home, ".omp", "policies", `${p}.yml`);
      const script = join(home, ".omp", "bin", `Invoke-Omp${pascal(p)}.ps1`);
      let flags = ["--profile", p, ...(existsSync(policy) ? ["--config", policy] : [])];
      try {
        const fromScript = launcherFlags(readFileSync(script, "utf8"), policy);
        if (fromScript.includes("--profile")) flags = fromScript;
      } catch {}
      out.push({ id: `omp:${p}`, label: `omp (${p})`, argv: [...base, ...flags.filter((f) => f !== "--approval-mode"), "--approval-mode", "always-ask"], harness: "omp", profile: p });
    }
  }
  // Copilot CLI asks before it acts unless told otherwise; --no-auto-update keeps the version I installed.
  const copilot = findTool("copilot", opts.copilotBin ?? env.COPILOT_BIN);
  if (copilot) out.push({ id: "copilot", label: "Copilot CLI", argv: [copilot.bin, ...copilot.pre, "--no-auto-update"], harness: "copilot" });
  // Codex asks before it acts outside its sandbox in a terminal: its own defaults, nothing widened.
  const codex = findTool("codex", opts.codexBin ?? env.CODEX_BIN);
  if (codex) out.push({ id: "codex", label: "Codex", argv: [codex.bin, ...codex.pre], harness: "codex" });
  const on = opts.on ?? (() => true);
  return out.filter((p) => !p.harness || on(p.harness));
}

const SID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

/** The program to start: as listed, or an agent CLI resuming a session by its id. */
export function argvFor(p: Program, resume?: string): string[] | null {
  if (!resume) return p.argv;
  if (!p.harness || !SID.test(resume)) return null;
  if (p.harness === "agy") return [...p.argv, "--conversation", resume];
  if (p.harness === "codex") return [...p.argv, "resume", resume];
  return [...p.argv, "--resume", resume];
}
