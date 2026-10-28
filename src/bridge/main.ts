/**
 * `pnpm bridge` / `dovre bridge run`: this machine's agents, reached from hosted Dovre (PLAN D24,
 * WP-N10, dovre-site#9). Builds this machine's agents desk as the server does (the harnesses found
 * here, the agent host when it's there, its own data folder for runs and the reply queue) and holds
 * the bridge's socket to the hub. Nothing listens here.
 *
 * Two ways to sign in:
 * - **Paired** (H6): `dovre bridge login <handle>` wrote a credentials file; the launcher passes it
 *   as DOVRE_BRIDGE_CREDENTIALS, with DOVRE_BRIDGE_DATA (runs, the reply queue), DOVRE_HOST_EXE
 *   (the agent host: the launcher itself) and DOVRE_VERSION. Each dial trades the refresh token
 *   for a fresh JWT (src/bridge/creds.ts). Unpaired, it exits with code 3: the launcher stops.
 * - **Self-hosted** (Access service token), from the environment or .dev.vars: BRIDGE_URL
 *   (wss://<hosted>/bridge), BRIDGE_KEY (the Worker's secret of the same name),
 *   BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET. scripts/install-bridge.sh starts it at login on a Mac.
 *
 * CODE_DIR (the checkouts) and CLAUDE_DIR as for the server.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDesk } from "../agents/desk.ts";
import { createQueue } from "../agents/queue.ts";
import { createRunner, type Run } from "../agents/runner.ts";
import { appleContainer } from "../agents/sandbox.ts";
import { findHarnessTools, harnessesFor } from "../agents/harnesses/index.ts";
import { loadEnv, rawVars } from "../env.ts";
import { localSessions } from "../sources/sessions.ts";
import { liveAgents, type Session } from "../sources/claude.ts";
import { ompProfileOf } from "../sources/omp.ts";
import { findTool, harnessesOn, withToolDirs } from "../tools.ts";
import { jwtHeaders, loadCreds, saveCreds, Unpaired } from "./creds.ts";
import { fileLedger, SENT_FILE } from "./sentfile.ts";
import { type Bridge, startBridge } from "./mac.ts";
import { keyOk } from "./wire.ts";

/** Unpaired or revoked: the launcher doesn't start it again. */
const EXIT_UNPAIRED = 3;

/** The commit an installed copy runs (REVISION, written by scripts/install-bridge.sh), or the launcher's version; a checkout says so. */
const revision = (() => {
  if (process.env.DOVRE_VERSION) return process.env.DOVRE_VERSION;
  try {
    return readFileSync(new URL("../../REVISION", import.meta.url), "utf8").trim().slice(0, 12) || "checkout";
  } catch {
    return "checkout";
  }
})();
const VERSION = `0.2.1+${revision}`;
// Started at login, the PATH is the system's: the places agent CLIs install to are added (H8).
process.env.PATH = withToolDirs(process.env.PATH, { platform: process.platform, home: homedir(), env: process.env });
const env = loadEnv();
const v = rawVars();

const dataDir = process.env.DOVRE_BRIDGE_DATA?.trim() || fileURLToPath(new URL("../../data/bridge/", import.meta.url));
mkdirSync(dataDir, { recursive: true });
// What it sends home, recorded here first (src/sent.ts); `dovre bridge sent` prints it.
const ledger = fileLedger(join(dataDir, SENT_FILE));

const credsFile = process.env.DOVRE_BRIDGE_CREDENTIALS?.trim();
let url: string;
let key: string;
let headers: Parameters<typeof startBridge>[0]["headers"];
let name = hostname().replace(/\.local$/, "");
if (credsFile) {
  const creds = loadCreds(credsFile);
  if (!creds) {
    console.error(`dovre bridge: ${credsFile} is missing or unreadable: run \`dovre bridge login <handle>\``);
    process.exit(EXIT_UNPAIRED);
  }
  url = creds.hub;
  key = creds.frame_key;
  name = creds.name || name;
  const next = jwtHeaders({ creds, save: (c) => saveCreds(credsFile, c), ledger });
  headers = async () => {
    try {
      return await next();
    } catch (e) {
      if (e instanceof Unpaired) quit(e.message);
      throw e;
    }
  };
} else {
  const u = v.BRIDGE_URL?.trim();
  const k = v.BRIDGE_KEY?.trim();
  const id = v.BRIDGE_CLIENT_ID?.trim();
  const secret = v.BRIDGE_CLIENT_SECRET?.trim();
  const missing = [!u?.startsWith("wss://") && "BRIDGE_URL (wss://…/bridge)", !keyOk(k) && "BRIDGE_KEY (32 characters or more)", !id && "BRIDGE_CLIENT_ID", !secret && "BRIDGE_CLIENT_SECRET"].filter(Boolean);
  if (missing.length) {
    console.error(`dovre bridge: pair this machine with \`dovre bridge login <handle>\`, or set ${missing.join(", ")} in .dev.vars or the environment.`);
    process.exit(2);
  }
  url = u!;
  key = k!;
  headers = { "CF-Access-Client-Id": id!, "CF-Access-Client-Secret": secret! };
}

const hostExe = process.env.DOVRE_HOST_EXE?.trim() || fileURLToPath(new URL(`../../bin/dovre${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));

// The agent CLIs this machine has: only those are offered (src/tools.ts).
const tools = findHarnessTools(env);
const { claude, omp, agy, codex } = tools;
// Only the CLIs switched on (AGENT_HARNESSES in .dev.vars); unset, every one found.
const harnessOn = harnessesOn(env.AGENT_HARNESSES);

let bridge: Bridge | undefined;
const queue = createQueue({ file: join(dataDir, "queue.json"), onChange: (sid) => bridge?.topics([`run:${sid}`]) });
const statusOf = new Map<string, Run["status"]>();
const runner = createRunner({
  host: existsSync(hostExe) ? { exe: hostExe, dir: join(dataDir, "runs") } : undefined,
  // Sandbox runs (#205): Apple container, so macOS only for now.
  sandbox: process.platform === "darwin" ? appleContainer({ root: join(dataDir, "sandboxes") }) : undefined,
  harnesses: harnessesFor(tools, harnessOn, { ompProfileOf }),
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
bridge = startBridge({ url, key, headers, ledger, desk, sessions, version: VERSION, name, log: (l) => console.log(l), onRevoked: () => quit("this machine was unpaired: run `dovre bridge login` again to pair it") });
console.log(`dovre bridge: ${revision}; ${runner.harnesses().join(", ") || "no agent CLIs found"}; dialling ${new URL(url).host}`);

/** Stop: the bridge, and turns that would otherwise go on unseen. */
function stopAll() {
  bridge?.stop();
  ledger.stop();
  // Without the agent host, turns are this process's children: they stop with it, so nothing edits a repo unseen.
  if (!existsSync(hostExe)) for (const r of runner.list()) if (r.status === "running") runner.stop(r.id);
}

function quit(why: string): never {
  console.error(`dovre bridge: ${why}`);
  stopAll();
  process.exit(EXIT_UNPAIRED);
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopAll();
    process.exit(0);
  });
