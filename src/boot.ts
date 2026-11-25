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

type ShowCockpit = (fetch: (request: Request) => Response | Promise<Response>) => number;

/**
 * Serves the setup page until GHE works, looking again every `everyMs`. When it does: exit 75
 * under the supervisor (it starts the real server at once), else say so on the page.
 * If the user chooses to continue without a code host, startup resumes with the listener
 * already open. Swap in the cockpit once it's ready, so the browser can keep polling.
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
  onNoCodeHost?: () => Promise<void>;
  everyMs?: number;
  supervised?: boolean;
  /** PUBLIC_ORIGIN, checked (src/access.ts). */
  publicOrigin?: string;
  /** The address to listen on (LISTEN_HOST; default 127.0.0.1). */
  listenHost?: string;
  exit?: (code: number) => void;
  /** Stops it (tests). */
  signal?: AbortSignal;
}): Promise<ShowCockpit> {
  const state: SetupState = { discoveredOwners: o.discoveredOwners };
  const look = async () => {
    if (state.withoutCodeHost) return;
    state.lookedAt = Date.now();
    if (!(await o.check().catch(() => false)) || state.withoutCodeHost) return;
    if (o.supervised) (o.exit ?? process.exit)(75);
    else state.ready = true;
  };
  const next = Promise.withResolvers<ShowCockpit>();
  const app = setupApp({
    problem: o.problem,
    token: o.token,
    info: { version: o.version, startedAt: Date.now() },
    state: () => state,
    onSaveOwners: o.onSaveOwners,
    onNoCodeHost: o.onNoCodeHost && (async () => {
      if (state.withoutCodeHost) return;
      state.withoutCodeHost = true;
      try {
        await o.onNoCodeHost!();
      } catch (e) {
        state.withoutCodeHost = false;
        throw e;
      }
      clearInterval(timer);
      next.resolve((cockpit) => {
        fetch = cockpit;
        return boundPort;
      });
    }),
    onWake: look,
    publicOrigin: o.publicOrigin,
  });
  let fetch: (request: Request) => Response | Promise<Response> = app.fetch;
  let boundPort = o.port;
  const up = join(o.dataDir, `up-${o.port}.js`);
  const server = serve({ fetch: (request) => fetch(request), port: o.port, hostname: o.listenHost ?? "127.0.0.1" }, ({ port }) => {
    boundPort = port;
    try {
      mkdirSync(dirname(up), { recursive: true });
      writeFileSync(up, `window.dovreUp = ${Date.now()};\n`);
    } catch {}
    console.error(o.problem.kind === "org" ? "No GHE_ORG set: name it in .dev.vars or on http://127.0.0.1:" + port + ". Showing the setup page." : o.problem.kind === "login" ? `No GHE login: run \`gh auth login --hostname ${o.problem.host}\` or sign in on http://127.0.0.1:${port}. Showing the setup page.` : `GHE didn't answer (${o.problem.error ?? "?"}). Showing the setup page.`);
  });
  const timer = setInterval(() => void look(), o.everyMs ?? 10_000);
  o.signal?.addEventListener("abort", () => {
    clearInterval(timer);
    server.close();
  });
  return next.promise;
}
