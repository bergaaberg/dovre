/**
 * `pnpm bridge`: the Mac's agents, reached from hosted Dovre (PLAN D24, WP-N10). Builds this
 * machine's agents desk as the server does (the harnesses found here, the agent host when it's
 * built, its own data/bridge for runs and the reply queue) and holds the bridge's socket to the
 * hub. Nothing listens here. Started at login by a launchd agent (scripts/install-bridge.sh) from a
 * fixed copy of one commit, so it never runs whatever branch the checkout has.
 *
 * Needs, from the environment or .dev.vars:
 * - BRIDGE_URL: wss://<hosted>/bridge
 * - BRIDGE_KEY: the key frames are signed with (the Worker's secret of the same name)
 * - BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET: the Access service token
 * - CODE_DIR (the checkouts), CLAUDE_DIR as for the server
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDesk } from "../agents/desk.ts";
import { agyHarness } from "../agents/agy.ts";
import { codexHarness } from "../agents/codex.ts";
import { ompHarness } from "../agents/omp.ts";
import { createQueue } from "../agents/queue.ts";
import { claudeHarness, createRunner, type Run } from "../agents/runner.ts";
import { loadEnv, rawVars } from "../env.ts";
import { localSessions } from "../sources/sessions.ts";
import { liveAgents, type Session } from "../sources/claude.ts";
import { ompProfileOf } from "../sources/omp.ts";
import { findTool, harnessesOn } from "../tools.ts";
import { type Bridge, startBridge } from "./mac.ts";
import { keyOk } from "./wire.ts";

/** The commit an installed copy runs (REVISION, written by scripts/install-bridge.sh); a checkout says so. */
const revision = (() => {
  try {
    return readFileSync(new URL("../../REVISION", import.meta.url), "utf8").trim().slice(0, 12) || "checkout";
  } catch {
    return "checkout";
  }
})();
const VERSION = `0.2.0+${revision}`;
const env = loadEnv();
const v = rawVars();
const url = v.BRIDGE_URL?.trim();
const key = v.BRIDGE_KEY?.trim();
const id = v.BRIDGE_CLIENT_ID?.trim();
const secret = v.BRIDGE_CLIENT_SECRET?.trim();
const missing = [!url?.startsWith("wss://") && "BRIDGE_URL (wss://…/bridge)", !keyOk(key) && "BRIDGE_KEY (32 characters or more)", !id && "BRIDGE_CLIENT_ID", !secret && "BRIDGE_CLIENT_SECRET"].filter(Boolean);
if (missing.length) {
  console.error(`dovre bridge: set ${missing.join(", ")} in .dev.vars or the environment.`);
  process.exit(2);
}

const dataDir = fileURLToPath(new URL("../../data/bridge/", import.meta.url));
mkdirSync(dataDir, { recursive: true });
const hostExe = fileURLToPath(new URL(`../../bin/dovre${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

// The agent CLIs this machine has: only those are offered (src/tools.ts).
const claude = findTool("claude", env.CLAUDE_BIN);
const omp = findTool("omp", env.OMP_BIN);
const agy = findTool("agy", env.AGY_BIN);
const codex = findTool("codex", env.CODEX_BIN);
// Only the CLIs switched on (AGENT_HARNESSES in .dev.vars); unset, every one found.
const harnessOn = harnessesOn(env.AGENT_HARNESSES);

let bridge: Bridge | undefined;
const queue = createQueue({ file: join(dataDir, "queue.json"), onChange: (sid) => bridge?.topics([`run:${sid}`]) });
const statusOf = new Map<string, Run["status"]>();
const runner = createRunner({
  host: existsSync(hostExe) ? { exe: hostExe, dir: join(dataDir, "runs") } : undefined,
  // omp turns always say how to ask before acting: the user's own omp config approves everything.
  harnesses: {
    ...(claude && harnessOn("claude") ? { claude: { ...claudeHarness(claude.bin), pre: claude.pre } } : {}),
    ...(omp && harnessOn("omp") ? { omp: { ...ompHarness(omp.bin, { profileOf: (id) => ompProfileOf(id) }), pre: omp.pre } } : {}),
    ...(agy && harnessOn("agy") ? { agy: { ...agyHarness(agy.bin), pre: agy.pre } } : {}),
    ...(codex && harnessOn("codex") ? { codex: { ...codexHarness(codex.bin), pre: codex.pre } } : {}),
  },
  onChange: (r) => {
    const was = statusOf.get(r.id);
    statusOf.set(r.id, r.status);
    if (was === "running" && r.status !== "running") queue.ended(r);
    bridge?.changed(r);
  },
});

// The sessions, read at most every few seconds however often they're asked for.
let read: { at: number; p: Promise<{ live: Session[]; recent: Session[] }> } | undefined;
const sessions = () => {
  if (!read || Date.now() - read.at > 5000) read = { at: Date.now(), p: liveAgents().catch(() => undefined).then((agents) => localSessions(env.CLAUDE_DIR, agents, { on: harnessOn })) };
  return read.p;
};

const desk = localDesk({ env, runner, queue, sessions });
bridge = startBridge({ url: url!, key: key!, headers: { "CF-Access-Client-Id": id!, "CF-Access-Client-Secret": secret! }, desk, sessions, version: VERSION, log: (l) => console.log(l) });
console.log(`dovre bridge: ${revision}; ${runner.harnesses().join(", ") || "no agent CLIs found"}; dialling ${new URL(url!).host}`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    bridge?.stop();
    // Without the agent host, turns are this process's children: they stop with it, so nothing edits a repo unseen.
    if (!existsSync(hostExe)) for (const r of runner.list()) if (r.status === "running") runner.stop(r.id);
    process.exit(0);
  });
