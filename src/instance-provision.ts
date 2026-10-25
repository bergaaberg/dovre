/**
 * `pnpm instance provision <folder> [--domain <host>] [--owners <list>] [--email <email>] [--access-team <team>] [--access-aud <aud>] [--deploy]`
 *
 * Plug-and-play Cloudflare Worker + D1 + Bridge provisioner (WP-M5) for users new to Cloudflare:
 * 1. Verifies `wrangler whoami` (or launches interactive browser `wrangler login`).
 * 2. Auto-creates the D1 database (`wrangler d1 create <db>`) if `database_id` is empty in `wrangler.jsonc`,
 *    extracts the UUID, and writes it directly into `wrangler.jsonc`.
 * 3. Applies D1 migrations (`wrangler d1 migrations apply <db> --remote`).
 * 4. Generates a cryptographic 32-byte `BRIDGE_KEY`, saves it to `.dev.vars` for `pnpm bridge`,
 *    and uploads `BRIDGE_KEY` + `GITHUB_TOKEN` (from `gh auth token` if signed in) to the Worker.
 * 5. Prints a 3-step Zero Trust Access checklist (and deploys when `--deploy` is passed).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { upsertDevVar } from "./setup.ts";

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export type WranglerInfo = {
  worker: string;
  dbName: string;
  dbId: string;
  domain: string;
};

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
  return {
    worker: parsed.name,
    dbName: d1.database_name,
    dbId: d1.database_id ?? "",
    domain: parsed.routes?.[0]?.pattern ?? "",
  };
}

/** Extracts a D1 database UUID from `wrangler d1 create` or `wrangler d1 info` output. */
export function extractD1Uuid(output: string): string | undefined {
  return output.match(UUID_RE)?.[1]?.toLowerCase();
}

export type WranglerPatch = {
  databaseId?: string;
  domain?: string;
  repoOwners?: string;
  githubUser?: string;
  allowedEmails?: string;
  cfAccessTeam?: string;
  cfAccessAud?: string;
};

/** Patches `database_id`, route `pattern`, and `vars` in `wrangler.jsonc` while preserving comments. */
export function patchWranglerConfig(jsoncText: string, patch: WranglerPatch): string {
  let out = jsoncText;
  if (patch.databaseId !== undefined) {
    out = out.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(patch.databaseId)}`);
  }
  if (patch.domain) {
    out = out.replace(/("pattern"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(patch.domain)}`);
  }
  const vars: [string, string | undefined][] = [
    ["REPO_OWNERS", patch.repoOwners],
    ["GITHUB_USER", patch.githubUser],
    ["ALLOWED_EMAILS", patch.allowedEmails],
    ["CF_ACCESS_TEAM", patch.cfAccessTeam],
    ["CF_ACCESS_AUD", patch.cfAccessAud],
  ];
  for (const [k, v] of vars) {
    if (v === undefined) continue;
    const re = new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`);
    out = out.replace(re, `$1${JSON.stringify(v)}`);
  }
  return out;
}

export type CmdRunner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => { status: number; stdout: string; stderr: string };

const defaultRun: CmdRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts?.cwd, input: opts?.input, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type ProvisionOpts = {
  dir: string;
  coreVarsFile?: string;
  domain?: string;
  repoOwners?: string;
  githubUser?: string;
  allowedEmails?: string;
  cfAccessTeam?: string;
  cfAccessAud?: string;
  deploy?: boolean;
  run?: CmdRunner;
  log?: (line: string) => void;
};

export function provisionInstance(o: ProvisionOpts): { dbId: string; bridgeKey: string; steps: string[] } {
  const run = o.run ?? defaultRun;
  const log = o.log ?? ((l: string) => console.log(l));
  const steps: string[] = [];
  const wranglerPath = join(o.dir, "wrangler.jsonc");
  if (!existsSync(wranglerPath)) throw new Error(`No wrangler.jsonc found in ${o.dir}. Run \`pnpm instance new ${o.dir}\` first.`);

  // 1. Check Cloudflare login
  const who = run("npx", ["wrangler", "whoami"], { cwd: o.dir });
  if (who.status !== 0 || /not authenticated|run `wrangler login`/i.test(who.stdout + who.stderr)) {
    log("→ Not signed in to Cloudflare yet. Opening browser for `wrangler login`…");
    const login = run("npx", ["wrangler", "login"], { cwd: o.dir });
    if (login.status !== 0) throw new Error(`Cloudflare login failed: ${login.stderr || login.stdout}`);
    steps.push("wrangler login");
  } else {
    steps.push("wrangler whoami");
  }

  // 2. Read & auto-create D1 if needed
  let raw = readFileSync(wranglerPath, "utf8");
  const info = readWranglerInfo(raw);
  let dbId = info.dbId;
  if (!UUID_RE.test(dbId)) {
    log(`→ Creating Cloudflare D1 database "${info.dbName}"…`);
    const created = run("npx", ["wrangler", "d1", "create", info.dbName], { cwd: o.dir });
    const foundId = extractD1Uuid(created.stdout + "\n" + created.stderr);
    if (foundId) {
      dbId = foundId;
      steps.push(`d1 create ${info.dbName}`);
    } else {
      // Fallback: if D1 already exists on the account, look it up via `wrangler d1 info`
      const existing = run("npx", ["wrangler", "d1", "info", info.dbName], { cwd: o.dir });
      const infoId = extractD1Uuid(existing.stdout + "\n" + existing.stderr);
      if (!infoId) throw new Error(`Could not create or find D1 database "${info.dbName}": ${created.stderr || created.stdout}`);
      dbId = infoId;
      steps.push(`d1 info ${info.dbName}`);
    }
  }

  // 3. Auto-discover GitHub login if unset
  let ghUser = o.githubUser;
  let ghToken: string | undefined;
  if (!ghUser) {
    const u = run("gh", ["api", "user", "--jq", ".login"], { cwd: o.dir });
    if (u.status === 0 && u.stdout.trim()) ghUser = u.stdout.trim();
  }
  const tk = run("gh", ["auth", "token"], { cwd: o.dir });
  if (tk.status === 0 && tk.stdout.trim()) ghToken = tk.stdout.trim();

  raw = patchWranglerConfig(raw, {
    databaseId: dbId,
    domain: o.domain,
    repoOwners: o.repoOwners ?? ghUser,
    githubUser: ghUser,
    allowedEmails: o.allowedEmails,
    cfAccessTeam: o.cfAccessTeam,
    cfAccessAud: o.cfAccessAud,
  });
  writeFileSync(wranglerPath, raw);
  log(`✓ Updated ${wranglerPath} (database_id=${dbId})`);

  // 4. Apply D1 migrations
  log(`→ Applying D1 migrations to ${info.dbName}…`);
  const mig = run("npx", ["wrangler", "d1", "migrations", "apply", info.dbName, "--remote"], { cwd: o.dir });
  if (mig.status !== 0) throw new Error(`D1 migrations failed: ${mig.stderr || mig.stdout}`);
  steps.push(`d1 migrations apply ${info.dbName}`);

  // 5. Generate BRIDGE_KEY and sync secrets
  const varsFile = o.coreVarsFile ?? join(resolve(o.dir, "..", "dovre"), ".dev.vars");
  const bridgeKey = randomBytes(24).toString("base64url");
  const targetDomain = o.domain ?? info.domain;
  try {
    upsertDevVar(varsFile, "BRIDGE_KEY", bridgeKey);
    if (targetDomain && !targetDomain.endsWith(".example")) {
      upsertDevVar(varsFile, "BRIDGE_URL", `wss://${targetDomain}/bridge`);
    }
  } catch {}

  log("→ Uploading BRIDGE_KEY secret to Cloudflare Worker…");
  run("npx", ["wrangler", "secret", "put", "BRIDGE_KEY"], { cwd: o.dir, input: bridgeKey });
  steps.push("secret put BRIDGE_KEY");

  if (ghToken) {
    log("→ Uploading GITHUB_TOKEN from `gh auth token` to Cloudflare Worker…");
    run("npx", ["wrangler", "secret", "put", "GITHUB_TOKEN"], { cwd: o.dir, input: ghToken });
    steps.push("secret put GITHUB_TOKEN");
  }

  if (o.deploy) {
    log("→ Deploying Worker…");
    const dep = run("npx", ["wrangler", "deploy"], { cwd: o.dir });
    if (dep.status !== 0) throw new Error(`Worker deploy failed: ${dep.stderr || dep.stdout}`);
    steps.push("wrangler deploy");
  }

  log(`\n✓ Provisioned ${info.worker} (D1: ${info.dbName} / ${dbId})`);
  log(`  Next — 3 quick steps in Cloudflare Zero Trust (one.dash.cloudflare.com → Access → Applications):`);
  log(`  1. Add a Self-hosted application for "${targetDomain}" allowing your email.`);
  log(`  2. Copy your team name into CF_ACCESS_TEAM and the Application Audience (AUD) Tag into CF_ACCESS_AUD in ${wranglerPath}.`);
  log(`  3. Run \`pnpm --dir ${o.dir} deploy\` (and \`pnpm bridge\` here on your laptop to stream local agents).`);
  return { dbId, bridgeKey, steps };
}
