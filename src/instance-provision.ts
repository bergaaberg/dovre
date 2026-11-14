/**
 * `pnpm instance provision <folder> [--plan] [--deploy] [--domain <host>] [--email <list>] …`: from
 * an instance folder to a working, protected Dovre on Cloudflare with the bridge connected (#98).
 * By default it's protected by the built-in passkey login (#522): only `wrangler login` is needed,
 * and it prints a one-time link that makes the first passkey. With `--access` (or
 * DOVRE_CF_API_TOKEN) it goes behind Cloudflare Access instead, on an account that already has
 * Cloudflare set up (its team, login methods, zones and other apps are reused or left alone) or on
 * a new one (it makes the team, a one-time-PIN login and a workers.dev subdomain).
 *
 * Every step finds its thing by a stable key and then reuses, creates or fixes it, so running it
 * again changes nothing, and after a failure it carries on from what's missing. `--plan` only looks
 * and prints the steps. Nothing is deleted.
 *
 * With `--github` it also makes the instance's own GitHub App (#523, src/github-app.ts: one click in
 * the browser), so people on ALLOWED_EMAILS can sign in with GitHub as well as with a passkey.
 *
 * `wrangler login` covers D1, secrets, deploy and the workers.dev subdomain. Only `--access` needs
 * an API token as well, since wrangler's login can't reach Access (`TOKEN_SCOPES`). The token is
 * read from the environment, never saved.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CfApi, cfApi, reconcileAccess, type Step, workersSubdomain } from "./cfaccess.ts";
import { type MakeGithubApp, makeGithubApp } from "./github-app.ts";
import { claimSql } from "./hosted/login/login.ts";
import { upsertDevVar } from "./setup.ts";

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const CORE = resolve(import.meta.dirname, "..");

type WranglerInfo = { worker: string; dbName: string; dbId: string; domain: string };

/** Reads the Worker name, D1 database_name / database_id, and route pattern from `wrangler.jsonc`. */
export function readWranglerInfo(jsoncText: string): WranglerInfo {
  const clean = jsoncText.replace(/^\s*\/\/.*$/gm, "");
  const parsed = JSON.parse(clean) as {
    name?: string;
    routes?: { pattern?: string }[];
    d1_databases?: { database_name?: string; database_id?: string }[];
  };
  const d1 = parsed.d1_databases?.[0];
  if (!parsed.name || !d1?.database_name) throw new Error("wrangler.jsonc is missing `name` or `d1_databases[0].database_name`");
  return { worker: parsed.name, dbName: d1.database_name, dbId: d1.database_id ?? "", domain: parsed.routes?.[0]?.pattern ?? "" };
}

/** Extracts a D1 database UUID from `wrangler d1 create` or `wrangler d1 info` output. */
export function extractD1Uuid(output: string): string | undefined {
  return output.match(UUID_RE)?.[1]?.toLowerCase();
}

type WranglerPatch = {
  databaseId?: string;
  domain?: string;
  /** No domain of its own: served at workers.dev, the route dropped. */
  workersDev?: boolean;
  repoOwners?: string;
  githubUser?: string;
  allowedEmails?: string;
  cfAccessTeam?: string;
  cfAccessAud?: string;
  bridgeClientId?: string;
  /** The workers.dev host Access covers, which the Worker then serves (no other workers.dev host). */
  workersDevHost?: string;
  /** "passkey" for the built-in login; "" to turn it off (Access). */
  authMode?: string;
  /** The instance's GitHub App (#523). */
  githubAppId?: string;
  githubAppClientId?: string;
};

/** Patches `database_id`, the route or workers.dev, and `vars` in `wrangler.jsonc`, keeping comments. */
export function patchWranglerConfig(jsoncText: string, patch: WranglerPatch): string {
  let out = jsoncText;
  if (patch.databaseId !== undefined) out = out.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(patch.databaseId)}`);
  if (patch.workersDev) {
    out = out.replace(/("workers_dev"\s*:\s*)false/, "$1true").replace(/^[ \t]*"routes"\s*:\s*\[[^\]]*\],?[ \t]*\r?\n/m, "");
  } else if (patch.domain) {
    out = out.replace(/("pattern"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(patch.domain)}`);
  }
  const vars: [string, string | undefined][] = [
    ["REPO_OWNERS", patch.repoOwners],
    ["GITHUB_USER", patch.githubUser],
    ["ALLOWED_EMAILS", patch.allowedEmails],
    ["CF_ACCESS_TEAM", patch.cfAccessTeam],
    ["CF_ACCESS_AUD", patch.cfAccessAud],
    ["BRIDGE_CLIENT_ID", patch.bridgeClientId],
    ["WORKERS_DEV_HOST", patch.workersDevHost],
    ["AUTH_MODE", patch.authMode],
    ["GITHUB_APP_ID", patch.githubAppId],
    ["GITHUB_APP_CLIENT_ID", patch.githubAppClientId],
  ];
  for (const [k, v] of vars) {
    if (v === undefined) continue;
    const re = new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`);
    if (re.test(out)) out = out.replace(re, `$1${JSON.stringify(v)}`);
    // Not in the file yet (an instance made before it was in the template): after ALLOWED_EMAILS.
    else out = out.replace(/^([ \t]*)("ALLOWED_EMAILS"\s*:\s*"[^"]*")(,?)/m, (_m, ind: string, line: string, comma: string) => `${ind}${line},\n${ind}"${k}": ${JSON.stringify(v)}${comma}`);
  }
  return out;
}

/** The KEY=value lines of a `.dev.vars` file. */
export function readDevVars(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** `wrangler whoami`'s email and account ids. */
export function parseWhoami(out: string): { email?: string; accounts: string[] } {
  return {
    email: out.match(/associated with the email (\S+@\S+?)\.?\s*$/m)?.[1],
    accounts: [...new Set([...out.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]))],
  };
}

type CmdRunner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => { status: number; stdout: string; stderr: string };

const defaultRun: CmdRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts?.cwd, input: opts?.input, encoding: "utf8", stdio: [opts?.input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type ProvisionOpts = {
  dir: string;
  /** The `.dev.vars` the bridge reads: core's own unless said. */
  coreVarsFile?: string;
  domain?: string;
  repoOwners?: string;
  githubUser?: string;
  /** Who may come in (comma-separated); `wrangler whoami`'s email when not given. */
  allowedEmails?: string;
  account?: string;
  /** The Zero Trust team to make when the account has none; the instance's name when not given. */
  team?: string;
  /** The workers.dev subdomain to claim when the account has none. */
  subdomain?: string;
  /** Only look: print what each step would do and change nothing. */
  plan?: boolean;
  deploy?: boolean;
  /** Start the bridge as a launchd agent after deploying (macOS, core's own .dev.vars). Default on. */
  bridge?: boolean;
  /**
   * An API token's API for Cloudflare Access (`--access`): the instance goes behind Access. Without
   * one, the built-in passkey login (#522): nothing but `wrangler login` is needed.
   */
  api?: CfApi;
  /** The API with wrangler's own login (the workers.dev subdomain); tests give a made-up one. */
  wranglerApi?: CfApi;
  /** Mint a passkey link even when the instance has passkeys (another device, or every one lost). */
  loginLink?: boolean;
  /** Make the instance's GitHub App for Sign in with GitHub (#523), unless it has one; under an organisation with `githubOrg`. */
  github?: boolean;
  githubOrg?: string;
  /** The manifest flow; tests give a made-up one. */
  makeGithubApp?: MakeGithubApp;
  run?: CmdRunner;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
};

export type ProvisionResult = { steps: Step[]; host: string; dbId?: string; team?: string; aud?: string; /** The passkey link this run minted. */ link?: string };

const wr = (run: CmdRunner, dir: string, ...args: string[]) => run("npx", ["wrangler", ...args], { cwd: dir });

export async function provisionInstance(o: ProvisionOpts): Promise<ProvisionResult> {
  const run = o.run ?? defaultRun;
  const log = o.log ?? ((l: string) => console.log(l));
  const apply = !o.plan;
  const steps: Step[] = [];
  const step = (what: string, action: Step["action"], detail: string) => steps.push({ what, action, detail });
  const wranglerPath = join(o.dir, "wrangler.jsonc");
  if (!existsSync(wranglerPath)) throw new Error(`No wrangler.jsonc in ${o.dir}. Run \`pnpm instance new ${o.dir}\` first.`);

  // 1. Signed in, and to which account.
  let who = wr(run, o.dir, "whoami");
  if (who.status !== 0 || /not authenticated|wrangler login/i.test(who.stdout + who.stderr)) {
    if (!apply) throw new Error("Not signed in to Cloudflare: run `npx wrangler login` (or provision without --plan, which opens it).");
    log("→ Not signed in to Cloudflare yet: opening the browser for `wrangler login`…");
    if (wr(run, o.dir, "login").status !== 0) throw new Error("Cloudflare login failed");
    who = wr(run, o.dir, "whoami");
  }
  const me = parseWhoami(who.stdout + "\n" + who.stderr);
  const account = o.account ?? (me.accounts.length === 1 ? me.accounts[0] : undefined);
  if (!account) throw new Error(`Several Cloudflare accounts (${me.accounts.join(", ")}): pass --account <id>.`);
  const emails = (o.allowedEmails ?? me.email ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  if (!emails.length) throw new Error("No email to let in: pass --email you@example.com");

  // 2. Where it lives: its own domain, or workers.dev for an account without one.
  let raw = readFileSync(wranglerPath, "utf8");
  const info = readWranglerInfo(raw);
  const wantDomain = o.domain ?? info.domain;
  const workersDev = !wantDomain || wantDomain.endsWith(".example") || wantDomain.endsWith(".workers.dev");
  const passkey = !o.api;
  if (o.github && !passkey) throw new Error("--github signs in on the built-in login, not with --access.");
  let host = wantDomain;
  if (workersDev) {
    const api = o.api ?? o.wranglerApi ?? wranglerApiOf(run, o.dir);
    const s = await workersSubdomain(api, account, o.subdomain ?? info.worker, apply);
    steps.push(s.step);
    host = `${info.worker}.${s.sub}.workers.dev`;
  }

  // 3. D1: the id in wrangler.jsonc, else one by that name, else a new one.
  let dbId = UUID_RE.test(info.dbId) ? info.dbId : undefined;
  if (dbId) step("D1 database", "reuse", `${info.dbName} (${dbId})`);
  else {
    dbId = extractD1Uuid(wr(run, o.dir, "d1", "info", info.dbName).stdout);
    if (dbId) step("D1 database", "reuse", `${info.dbName} (${dbId}), id written to wrangler.jsonc`);
    else {
      step("D1 database", "create", info.dbName);
      if (apply) {
        const c = wr(run, o.dir, "d1", "create", info.dbName);
        dbId = extractD1Uuid(c.stdout + "\n" + c.stderr);
        if (!dbId) throw new Error(`Couldn't create D1 database "${info.dbName}": ${c.stderr || c.stdout}`);
      }
    }
  }

  // 4. The bridge's side on this machine. A .dev.vars whose bridge dials another instance is left
  //    alone (its bridge is someone's running one); --vars names a file of this instance's own.
  const varsFile = o.coreVarsFile ?? join(CORE, ".dev.vars");
  const local = readDevVars(varsFile);
  const bridgeUrl = `wss://${host}/bridge`;
  const bridgeOurs = !local.BRIDGE_URL || local.BRIDGE_URL === bridgeUrl;
  if (!bridgeOurs) log(`! ${varsFile} has a bridge for ${local.BRIDGE_URL}: left as it is, and no bridge set up for ${host}. Pass --vars <file> for one of its own.`);

  // 5. Who gets in: the built-in passkey login, or Access (the team, a login, the token, the policies, the app).
  if (passkey) step("Login", readVar(raw, "AUTH_MODE") === "passkey" ? "reuse" : "create", "built-in passkeys (AUTH_MODE=passkey); no Cloudflare Access");
  const access = passkey ? { steps: [] as Step[], team: undefined, aud: undefined, bridge: undefined } : await reconcileAccess({
    api: o.api!,
    account,
    host,
    worker: info.worker,
    emails,
    team: o.team ?? info.worker,
    localClientId: bridgeOurs && local.BRIDGE_CLIENT_SECRET ? local.BRIDGE_CLIENT_ID : undefined,
    bridge: bridgeOurs,
    apply,
  });
  steps.push(...access.steps);

  // 6. GitHub: who, and a token unless the Worker has one (a fine-grained one set by hand stays).
  let ghUser = o.githubUser;
  if (!ghUser) {
    const u = run("gh", ["api", "user", "--jq", ".login"], { cwd: o.dir });
    if (u.status === 0 && u.stdout.trim()) ghUser = u.stdout.trim();
  }
  const listed = wr(run, o.dir, "secret", "list");
  const secrets = new Set(listed.status === 0 ? [...listed.stdout.matchAll(/"name"\s*:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]) : []);

  // 7. The bridge key: kept when this machine has it and the Worker too; else a new one for both.
  const keepKey = bridgeOurs && (local.BRIDGE_KEY?.length ?? 0) >= 32 && secrets.has("BRIDGE_KEY");
  if (bridgeOurs) step("Bridge key", keepKey ? "reuse" : secrets.has("BRIDGE_KEY") ? "fix" : "create", keepKey ? "BRIDGE_KEY" : "BRIDGE_KEY, here and on the Worker");
  const ghToken = secrets.has("GITHUB_TOKEN") ? undefined : run("gh", ["auth", "token"], { cwd: o.dir }).stdout.trim() || undefined;
  step("GitHub token", secrets.has("GITHUB_TOKEN") ? "reuse" : ghToken ? "create" : "fix", secrets.has("GITHUB_TOKEN") ? "GITHUB_TOKEN" : ghToken ? "GITHUB_TOKEN from `gh auth token`" : "none: `gh auth login`, or `wrangler secret put GITHUB_TOKEN`");

  // Sign in with GitHub: the app's id in wrangler.jsonc and its secret on the Worker, else (with --github) a new app.
  const appId = readVar(raw, "GITHUB_APP_CLIENT_ID");
  const hasApp = passkey && !!appId && secrets.has("GITHUB_APP_CLIENT_SECRET");
  const makeApp = passkey && !hasApp && !!o.github;
  if (hasApp) step("GitHub sign-in", "reuse", `the GitHub App ${appId}`);
  else if (makeApp) step("GitHub sign-in", "create", `a GitHub App${o.githubOrg ? ` under ${o.githubOrg}` : ""} (one click in the browser); GITHUB_APP_* on the Worker`);

  // The passkey link: when the instance has no passkey yet (or --login-link). Counted in D1, whose
  // table may not be there yet before the first migrations: then there's none.
  const passkeys = () => Number(/"n"\s*:\s*(\d+)/.exec(wr(run, o.dir, "d1", "execute", info.dbName, "--remote", "--json", "--command", "SELECT COUNT(*) AS n FROM login_passkeys").stdout)?.[1] ?? 0);
  const mintLink = passkey && (o.loginLink || (dbId ? passkeys() === 0 : true));
  if (passkey) step("Passkey link", mintLink ? "create" : "reuse", mintLink ? `for ${emails[0]}, once, within a day` : "a passkey is there (--login-link for another)");

  const startBridge = bridgeOurs && o.deploy && o.bridge !== false && (o.platform ?? process.platform) === "darwin" && resolve(varsFile) === join(CORE, ".dev.vars");
  if (o.deploy) step("Deploy", "create", `wrangler deploy → https://${host}`);
  if (startBridge) step("Bridge", "create", "scripts/install-bridge.sh (launchd, at login)");

  if (!apply) {
    printSteps(steps, log);
    log(`\nNothing changed (--plan). Run it without --plan to do this.`);
    return { steps, host, dbId, team: access.team, aud: access.aud };
  }

  // 8. Write it down: wrangler.jsonc, this machine's bridge, the Worker's secrets. The GitHub App
  //    first, since it waits on the browser; its secrets go up as soon as it's made.
  let app: Awaited<ReturnType<MakeGithubApp>> | undefined;
  if (makeApp) {
    app = await (o.makeGithubApp ?? makeGithubApp)({ host, name: `Dovre ${info.worker}`, org: o.githubOrg, log });
    put(run, o.dir, "GITHUB_APP_CLIENT_SECRET", app.clientSecret);
    put(run, o.dir, "GITHUB_APP_PRIVATE_KEY", app.pem);
  }
  raw = patchWranglerConfig(raw, {
    databaseId: dbId,
    domain: workersDev ? undefined : host,
    workersDev,
    repoOwners: o.repoOwners ?? (readVar(raw, "REPO_OWNERS") || ghUser),
    githubUser: ghUser,
    allowedEmails: emails.join(","),
    cfAccessTeam: access.team,
    cfAccessAud: access.aud,
    bridgeClientId: access.bridge?.clientId,
    workersDevHost: workersDev && !passkey ? host : undefined,
    authMode: passkey ? "passkey" : readVar(raw, "AUTH_MODE") ? "" : undefined,
    githubAppId: app ? String(app.id) : undefined,
    githubAppClientId: app?.clientId,
  });
  writeFileSync(wranglerPath, raw);

  if (bridgeOurs) {
    const key = keepKey ? local.BRIDGE_KEY : randomBytes(24).toString("base64url");
    upsertDevVar(varsFile, "BRIDGE_URL", bridgeUrl);
    if (!keepKey) {
      upsertDevVar(varsFile, "BRIDGE_KEY", key);
      put(run, o.dir, "BRIDGE_KEY", key);
    }
    if (access.bridge) upsertDevVar(varsFile, "BRIDGE_CLIENT_ID", access.bridge.clientId);
    if (access.bridge?.secret) upsertDevVar(varsFile, "BRIDGE_CLIENT_SECRET", access.bridge.secret);
  }
  if (ghToken) put(run, o.dir, "GITHUB_TOKEN", ghToken);

  log(`→ Applying D1 migrations to ${info.dbName}…`);
  const mig = wr(run, o.dir, "d1", "migrations", "apply", info.dbName, "--remote");
  if (mig.status !== 0) throw new Error(`D1 migrations failed: ${mig.stderr || mig.stdout}`);

  if (o.deploy) {
    log("→ Deploying…");
    const dep = wr(run, o.dir, "deploy");
    if (dep.status !== 0) throw new Error(`Deploy failed: ${dep.stderr || dep.stdout}`);
  }
  let link: string | undefined;
  if (mintLink) {
    const { code, sql } = await claimSql(emails[0]!);
    const r = wr(run, o.dir, "d1", "execute", info.dbName, "--remote", "--command", sql);
    if (r.status !== 0) throw new Error(`Couldn't store the passkey link: ${r.stderr || r.stdout}`);
    link = `https://${host}/_auth/claim#${code}`;
  }
  if (startBridge) {
    const b = run("sh", [join(CORE, "scripts", "install-bridge.sh")], { cwd: CORE });
    if (b.status !== 0) log(`! The bridge didn't start: ${(b.stderr || b.stdout).trim()}`);
  }

  printSteps(steps, log);
  log(`\n✓ https://${host}${o.deploy ? "" : ` (not deployed yet: \`pnpm --dir ${o.dir} deploy:worker\`)`}`);
  if (bridgeOurs && !startBridge) {
    // `pnpm bridge` reads core's .dev.vars (or the environment), so a --vars file of its own needs its settings passed.
    if (o.coreVarsFile) log(`  The bridge: its settings are in ${varsFile}; run \`pnpm bridge\` in core with its BRIDGE_* lines in the environment.`);
    else log("  The bridge: `pnpm bridge` in core streams this machine's agents to it.");
  }
  if (app) log(`  Sign in with GitHub: the app ${app.slug}${app.htmlUrl ? ` (${app.htmlUrl})` : ""}, for the verified emails on ALLOWED_EMAILS.${o.deploy ? "" : " It works once deployed."}`);
  if (link) log(`\n  Make your passkey (works once, within a day; don't share it):\n\n  ${link}\n`);
  return { steps, host, dbId, team: access.team, aud: access.aud, link };
}

/** The Cloudflare API with wrangler's own login (`wrangler auth token`): its Workers scope covers the subdomain. */
function wranglerApiOf(run: CmdRunner, dir: string): CfApi {
  const t = wr(run, dir, "auth", "token").stdout.match(/[A-Za-z0-9._-]{30,}/g)?.at(-1);
  if (!t) throw new Error("Couldn't read wrangler's login (`wrangler auth token`): run `npx wrangler login`.");
  return cfApi(t);
}

function readVar(jsonc: string, k: string): string {
  return jsonc.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`))?.[1] ?? "";
}

function put(run: CmdRunner, dir: string, name: string, value: string) {
  const r = run("npx", ["wrangler", "secret", "put", name], { cwd: dir, input: value });
  if (r.status !== 0) throw new Error(`wrangler secret put ${name} failed: ${r.stderr || r.stdout}`);
}

export function printSteps(steps: Step[], log: (l: string) => void) {
  const w = Math.max(...steps.map((s) => s.what.length));
  for (const s of steps) log(`  ${s.action.padEnd(6)}  ${s.what.padEnd(w)}  ${s.detail}`);
}
