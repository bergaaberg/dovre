/**
 * The coding agents' sessions on this machine, from every harness Dovre reads: Claude Code's,
 * omp's (every profile), Copilot CLI's, Antigravity's and Codex's, each only when it's switched on (`on`). Metadata only, as src/sources/claude.ts
 * keeps it. The agents pack reads them again on its own schedule (src/packs/core/agents/here.ts);
 * the bridge reads them for the Mac's state.
 */
import { type AgentEntry, type Session, loadSessions } from "./claude.ts";
import { loadOmpSessions, ompAgentDirs, ompProcessesOf } from "./omp.ts";
import { COPILOT_DIR, copilotProcessesOf, loadCopilotSessions } from "./copilot.ts";
import { loadAgySessions } from "./agy.ts";
import { loadCodexSessions } from "./codex.ts";
import type { AgentCli } from "../tools.ts";
import { commandLines } from "./procs.ts";

export type Sessions = { live: Session[]; recent: Session[] };

/** Every harness's sessions, together, newest first. `omp: false` skips omp's (it isn't here); `on` leaves out a harness switched off (src/tools.ts). */
export async function localSessions(claudeDir: string, agents: AgentEntry[] | undefined, opts: { omp?: boolean; on?: (h: AgentCli) => boolean } = {}): Promise<{ live: Session[]; recent: Session[] }> {
  const on = opts.on ?? (() => true);
  const none = { live: [] as Session[], recent: [] as Session[] };
  const claude = on("claude") ? await loadSessions(claudeDir, { agents }) : none;
  // One process list for both; unread, omp counts none live and Copilot falls back to recent open files.
  const rows = await commandLines(["omp", "copilot"]).catch(() => undefined);
  const processes = ompProcessesOf(rows ?? []);
  const omp = (on("omp") && opts.omp !== false ? ompAgentDirs() : []).map(({ dir, profile }) => {
    try {
      return loadOmpSessions(dir, { processes, profile });
    } catch {
      return { live: [], recent: [] };
    }
  });
  let copilot: { live: Session[]; recent: Session[] } = { live: [], recent: [] };
  if (on("copilot")) try {
    copilot = loadCopilotSessions(COPILOT_DIR, { processes: rows && copilotProcessesOf(rows) });
  } catch {}
  let agy: { live: Session[]; recent: Session[] } = { live: [], recent: [] };
  if (on("agy")) try {
    agy = loadAgySessions();
  } catch {}
  let codex: { live: Session[]; recent: Session[] } = { live: [], recent: [] };
  if (on("codex")) try {
    codex = loadCodexSessions();
  } catch {}
  const at = (x: Session) => Date.parse(x.lastAt ?? "") || 0;
  // Sessions run in a temp folder are probes and throwaways, not work.
  const real = (x: Session) => !/[\\/](Temp|tmp)[\\/]/i.test(x.cwd ?? "");
  return {
    live: [...claude.live, ...omp.flatMap((o) => o.live), ...copilot.live, ...agy.live, ...codex.live].filter(real),
    recent: [...claude.recent, ...omp.flatMap((o) => o.recent), ...copilot.recent, ...agy.recent, ...codex.recent].filter(real).sort((a, b) => at(b) - at(a)).slice(0, 24),
  };
}

