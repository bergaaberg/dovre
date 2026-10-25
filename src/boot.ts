/**
 * What a start needs before the app can run, for whoever runs it: the login token (made once and
 * kept, so the launcher and the cookie keep working), and GHE reachable, else the setup page.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { type SetupProblem, type SetupState, setupApp } from "./setup.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The token /login exchanges for the cookie: LAUNCH_TOKEN when set, else the one kept in
 * data/launch-token, else a new one, kept there (readable by me only, where the OS allows).
 * The launcher reads the same file (launcher/paths.go). Never logged.
 */
export function launchToken(dataDir: string, pinned?: string): string {
  if (pinned) return pinned;
  const file = join(dataDir, "launch-token");
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (TOKEN_RE.test(kept)) return kept;
  } catch {}
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
  return token;
}

/** The login URL with the token hidden, for the log. */
export const maskedLogin = (base: string) => `${base}/login?tk=… (run \`dovre\`, or the token in data/launch-token)`;

/**
 * Serves the setup page until GHE works, looking again every `everyMs`. When it does: exit 75
 * under the supervisor (it starts the real server at once), else say so on the page.
 * Never resolves: the start stops here.
 */
export async function serveSetup(o: {
  problem: SetupProblem;
  token: string;
  port: number;
  dataDir: string;
  version: string;
  /** Whether GHE works now. */
  check: () => Promise<boolean>;
  discoveredOwners?: string[];
  onSaveOwners?: (owners: string) => Promise<void> | void;
  everyMs?: number;
  supervised?: boolean;
  exit?: (code: number) => void;
  /** Stops it (tests). */
  signal?: AbortSignal;
}): Promise<never> {
  const state: SetupState = { discoveredOwners: o.discoveredOwners };
  const look = async () => {
    state.lookedAt = Date.now();
    if (!(await o.check().catch(() => false))) return;
    if (o.supervised) (o.exit ?? process.exit)(75);
    else state.ready = true;
  };
  const app = setupApp({
    problem: o.problem,
    token: o.token,
    info: { version: o.version, startedAt: Date.now() },
    state: () => state,
    onSaveOwners: o.onSaveOwners,
    onWake: look,
  });
  const up = join(o.dataDir, `up-${o.port}.js`);
  const server = serve({ fetch: app.fetch, port: o.port, hostname: "127.0.0.1" }, () => {
    try {
      mkdirSync(dirname(up), { recursive: true });
      writeFileSync(up, `window.dovreUp = ${Date.now()};\n`);
    } catch {}
    console.error(o.problem.kind === "org" ? "No GHE_ORG set: name it in .dev.vars or on http://127.0.0.1:" + o.port + ". Showing the setup page." : o.problem.kind === "login" ? `No GHE login: run \`gh auth login --hostname ${o.problem.host}\` or sign in on http://127.0.0.1:${o.port}. Showing the setup page.` : `GHE didn't answer (${o.problem.error ?? "?"}). Showing the setup page.`);
  });
  const timer = setInterval(() => void look(), o.everyMs ?? 10_000);
  o.signal?.addEventListener("abort", () => {
    clearInterval(timer);
    server.close();
  });
  return new Promise<never>(() => {});
}
