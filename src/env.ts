/**
 * Settings: what Settings keeps (src/config.ts), overlaid by process.env, then by `.dev.vars`
 * (KEY=value lines, never committed). Secrets
 * that already live elsewhere stay there: the GHE token comes from `gh auth token` when unset.
 */
import { owns, ownersOf, primaryOf } from "./owners.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Hono } from "hono";
import type { D1 } from "./db.ts";
import type { Frame } from "./html.ts";

/** `who`: hosted, the email Cloudflare Access verified for this request (what a write is done as). */
export type AppEnv = { Bindings: Env; Variables: { frame: Frame; who?: string; /** Which writes take one click (src/writes.ts), for the page being drawn. */ clicks?: Map<string, import("./writes.ts").Clicks>; /** Local, PUBLIC_ORIGIN when set (src/access.ts). */ publicOrigin?: string; /** How long this page waited on the gather (ms), for Server-Timing (src/speed.ts). */ speedWaited?: number } };
export type App = Hono<AppEnv>;

export type Env = {
  DB: D1;
  /** The token /login exchanges for a cookie. Unset: made once and kept in data/launch-token (src/boot.ts). */
  LAUNCH_TOKEN?: string;
  /**
   * Local only (#74): the one public address an authenticating proxy serves this Dovre at, exactly
   * `https://host[:port]`. Read from the environment or .dev.vars only, never from Settings.
   */
  PUBLIC_ORIGIN?: string;
  /** Where the SQLite file lives. */
  U_DB?: string;
  /** Which forge the code lives on: "github" (the default) or a pack's (src/forge/types.ts). */
  FORGE?: string;
  /** Timezone name for dates and greetings (e.g. UTC, America/New_York). */
  TZ_NAME?: string;
  /** Greeting language: "en" (default) or "no". */
  GREETING?: string;
  /** The one host (github.com or a GHE): REPO_HOST, or GHE_HOST. */
  GHE_HOST: string;
  /** The first owner (src/owners.ts): short names belong here, and org-only things are asked of it. */
  GHE_ORG: string;
  /** Every owner tracked, comma-separated (REPO_OWNERS, else GHE_ORG or GITHUB_USER). Unset: GHE_ORG alone. */
  OWNERS?: string;
  /** Personal GitHub user or org fallback */
  GITHUB_USER?: string;
  /** Secret. From `gh auth token [--hostname <GHE_HOST>]` when unset. */
  GHE_TOKEN?: string;
  GITHUB_TOKEN?: string;
  /** Who "me" is on GHE; looked up from the token when unset. */
  GHE_LOGIN?: string;
  /** Comma-separated repos (in GHE_ORG) where the work is planned: their issues are parents for dev tasks, and take none by hand. */
  SORTING_REPOS?: string;
  /** Comma-separated repos that take issues through their own forms. */
  FORM_REPOS?: string;
  /** Where the repos are checked out. */
  CODE_DIR: string;
  /** Where agents started here run when no repo is picked (default ~/.dovre/agents; src/agents/workdir.ts). */
  AGENT_DIR?: string;
  /** Claude Code's state directory. */
  CLAUDE_DIR: string;
  /** Where `claude` / `omp` / `copilot` / `agy` / `codex` are, when not on the PATH (src/tools.ts). Unfound, that harness is off. */
  CLAUDE_BIN?: string;
  OMP_BIN?: string;
  COPILOT_BIN?: string;
  AGY_BIN?: string;
  CODEX_BIN?: string;
  /** The agent CLIs the agents pack uses, comma-separated (src/tools.ts harnessesOn). Unset: every one found. */
  AGENT_HARNESSES?: string;
  /** The model Bino and summaries ask through Copilot CLI (BINO_VIA / SUMMARIES = copilot). Unset: Copilot picks (auto). */
  COPILOT_CLI_MODEL?: string;
  /** AI summaries of PRs and deploys through `claude -p`: `on` or `off`. Unset: on when Claude Code is here. */
  SUMMARIES?: string;
  /** Bino / Assistant (src/packs/core/assistant/): `claude` | `omp` | `copilot` | `agy` | `codex` | `api-key` | `cf-gateway` | `openrouter` | `off`. */
  BINO_VIA?: string;
  ASSISTANT_VIA?: string;
  /** The model Bino talks with (default sonnet, or cheap model for api-key/openrouter); its memory is kept with BINO_REFLECT_MODEL (default haiku). */
  BINO_MODEL?: string;
  ASSISTANT_MODEL?: string;
  BINO_REFLECT_MODEL?: string;
  /** Direct API key or OpenRouter key for Assistant (`BINO_VIA=api-key` or `openrouter`). */
  ASSISTANT_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Pack folders this machine loads (comma-separated; PLAN D23). */
  PACKS?: string;
  CRATES?: string;
  /** Docker (src/packs/core/docker/): `on` (default) or `off`. DOCKER_PIPE: another engine's pipe (\\.\pipe\docker_engine for Docker Desktop's) instead of the launcher's. */
  DOCKER?: string;
  DOCKER_PIPE?: string;
  /** Copilot through omp, for Bino and summaries without Claude Code (src/ai/omp.ts): its omp profile (default dovre-copilot: no MCP servers) and Copilot model (default github-copilot/gpt-6-luna:medium). */
  COPILOT_PROFILE?: string;
  COPILOT_MODEL?: string;
  /** Panes switched on Settings (src/config.ts): `off` turns one off; unset is on. */
  TERMINAL?: string;
  STATS?: string;
  REVIEWS?: string;
  LAB?: string;
  /** My team on GHE (its slug), for grouping work by the people in it. */
  TEAM?: string;
  /** Who Bino is told I am, e.g. "a tech lead at an insurance company". Unset: a developer. */
  ABOUT_ME?: string;
  /** The skills agent reviews use: reviewing someone else's PR, and assessing a review on mine. */
  REVIEW_SKILL?: string;
  TRIAGE_SKILL?: string;
  /** The skill that drafts an issue through a repo's own forms (FORM_REPOS). Unset: plain instructions. */
  FORM_SKILL?: string;
  /** Cloudflare Workers / Hosted Mode settings */
  IS_HOSTED?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM?: string;
  AUTH_ISSUER?: string;
  AUTH_AUD?: string;
  AUTH_JWKS_URL?: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_AIG_TOKEN?: string;
  ALLOWED_EMAILS?: string;
  /** Set when the first-run page was answered (src/pages/welcome.ts). */
  SETUP_DONE?: string;
};

/** Whether a program is on the PATH, by looking (no process started). */
export function onPath(name: string, path = process.env.PATH ?? "", exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""]): boolean {
  return path.split(delimiter).some((dir) => dir && exts.some((x) => existsSync(join(dir, name + x))));
}

export function parseVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function ghToken(host: string): string | undefined {
  try {
    const args = host === "github.com" ? ["auth", "token"] : ["auth", "token", "--hostname", host];
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function fileVars(): Record<string, string> {
  try {
    return parseVars(readFileSync(".dev.vars", "utf8"));
  } catch {
    return {};
  }
}

/** Keys set in `.dev.vars` or the environment: those win over Settings, which shows them as fixed. */
export function fixedKeys(): Set<string> {
  return new Set([...Object.keys(fileVars()), ...Object.keys(process.env).filter((k) => /^[A-Z0-9_]+$/.test(k) && process.env[k] !== undefined)]);
}

/** Every setting as a string, the same order loadEnv reads them: what a pack's own keys come from (PLAN D23). */
export function rawVars(stored: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...stored, ...(process.env as Record<string, string | undefined>), ...fileVars() };
}

/** Settings: what was set on the Settings page (`stored`, src/config.ts), then the environment, then `.dev.vars`. */
export function loadEnv(stored: Record<string, string> = {}): Omit<Env, "DB"> {
  const v = { ...stored, ...(process.env as Record<string, string | undefined>), ...fileVars() };
  const host = v.REPO_HOST || v.GHE_HOST || "github.com";
  const owners = ownersOf(v.REPO_OWNERS || v.GHE_ORG || v.GITHUB_USER || v.GH_ORG);
  return {
    LAUNCH_TOKEN: v.LAUNCH_TOKEN,
    // Not from Settings: widening who gets in is the machine owner's to set, not a page's.
    PUBLIC_ORIGIN: fileVars().PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN,
    U_DB: v.U_DB,
    FORGE: v.FORGE,
    GHE_HOST: host,
    GHE_ORG: owners[0] ?? "",
    OWNERS: owners.join(","),
    GITHUB_USER: v.GITHUB_USER,
    TZ_NAME: v.TZ_NAME,
    GREETING: v.GREETING,
    // GHE_TOKEN first; a GITHUB_TOKEN (often in the shell already) is a github.com token, never sent to another host.
    GHE_TOKEN: v.GHE_TOKEN || (/^(api\.)?github\.com$/i.test(host.trim()) ? v.GITHUB_TOKEN : undefined) || ghToken(host),
    GITHUB_TOKEN: v.GITHUB_TOKEN,
    GHE_LOGIN: v.GHE_LOGIN,
    // The lists below: unset or empty is off.
    SORTING_REPOS: v.SORTING_REPOS ?? "",
    FORM_REPOS: v.FORM_REPOS ?? "",
    CODE_DIR: v.CODE_DIR || join(homedir(), "Code"),
    AGENT_DIR: v.AGENT_DIR || undefined,
    CLAUDE_DIR: v.CLAUDE_DIR || join(homedir(), ".claude"),
    CLAUDE_BIN: v.CLAUDE_BIN || undefined,
    OMP_BIN: v.OMP_BIN || undefined,
    COPILOT_BIN: v.COPILOT_BIN || undefined,
    COPILOT_CLI_MODEL: v.COPILOT_CLI_MODEL || undefined,
    AGY_BIN: v.AGY_BIN || undefined,
    CODEX_BIN: v.CODEX_BIN || undefined,
    AGENT_HARNESSES: v.AGENT_HARNESSES || undefined,
    SUMMARIES: v.SUMMARIES || undefined,
    BINO_VIA: v.ASSISTANT_VIA || v.BINO_VIA || undefined,
    ASSISTANT_VIA: v.ASSISTANT_VIA || v.BINO_VIA || undefined,
    BINO_MODEL: v.ASSISTANT_MODEL || v.BINO_MODEL || undefined,
    ASSISTANT_MODEL: v.ASSISTANT_MODEL || v.BINO_MODEL || undefined,
    BINO_REFLECT_MODEL: v.BINO_REFLECT_MODEL || undefined,
    ASSISTANT_API_KEY: v.ASSISTANT_API_KEY || undefined,
    ANTHROPIC_API_KEY: v.ANTHROPIC_API_KEY || undefined,
    OPENAI_API_KEY: v.OPENAI_API_KEY || undefined,
    GEMINI_API_KEY: v.GEMINI_API_KEY || undefined,
    OPENROUTER_API_KEY: v.OPENROUTER_API_KEY || undefined,
    // CRATES: its name before WP-M4, still read so a machine's settings keep working.
    PACKS: v.PACKS || v.CRATES || undefined,
    CRATES: v.PACKS || v.CRATES || undefined,
    CF_ACCOUNT_ID: v.CF_ACCOUNT_ID || undefined,
    ALLOWED_EMAILS: v.ALLOWED_EMAILS || undefined,
    CF_GATEWAY_NAME: v.CF_GATEWAY_NAME || undefined,
    CF_AIG_TOKEN: v.CF_AIG_TOKEN || undefined,
    DOCKER: v.DOCKER || undefined,
    DOCKER_PIPE: v.DOCKER_PIPE || undefined,
    COPILOT_PROFILE: v.COPILOT_PROFILE || undefined,
    COPILOT_MODEL: v.COPILOT_MODEL || undefined,
    TERMINAL: v.TERMINAL || undefined,
    STATS: v.STATS || undefined,
    REVIEWS: v.REVIEWS || undefined,
    LAB: v.LAB || undefined,
    TEAM: v.TEAM || undefined,
    ABOUT_ME: v.ABOUT_ME || undefined,
    REVIEW_SKILL: v.REVIEW_SKILL || undefined,
    TRIAGE_SKILL: v.TRIAGE_SKILL || undefined,
    FORM_SKILL: v.FORM_SKILL || undefined,
    SETUP_DONE: v.SETUP_DONE || undefined,
  };
}

/** A comma-separated list of repo names as "<org>/<name>": names only (letters, digits, . _ -), so a setting can't point outside the org. */
export const reposOf = (owners: string, list: string | undefined, fallback: string): string[] => {
  const first = primaryOf(owners);
  const out = new Set<string>();
  for (const raw of (list ?? fallback).split(",")) {
    const [a, b, more] = raw.trim().split("/");
    const [owner, name] = b === undefined ? [first, a] : [a, b];
    if (more !== undefined || !owner || !name || !/^[\w.-]+$/.test(name) || name === "." || name === ".." || !owns(owners, owner)) continue;
    out.add(`${ownersOf(owners).find((o) => o.toLowerCase() === owner.toLowerCase())}/${name}`);
  }
  return [...out];
};
