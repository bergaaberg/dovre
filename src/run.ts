/**
 * `node src/run.ts <pack> [checkout]`: one pack from dovre-packs in a throw-away session (#353,
 * prototype). No home page, needs, gatherer or Bino: the pack's own pages, on a random port on
 * 127.0.0.1, behind a launch token made for this session. Nothing is kept: the database is in
 * memory, and it's all gone when the process ends.
 *
 * The same doors as local mode: the launch-token cookie on a localhost Host header, and the exact
 * Origin on every write (createApp's own checks). createApp's `session` keeps the cockpit out: only
 * the pack's paths, sign-in, assets and the event stream answer, and the menu holds the pack's entries. A checkout given is the one repo the pack sees,
 * as a checkout directly under CODE_DIR. Its settings: see settingsOf; its Settings page keeps what's
 * saved there in memory only (#369).
 *
 * Its tools (Pack.tools) answer an agent on /mcp (#371), with a token of their own, made for this
 * session and never the launch token: src/mcp.ts's checks, the session's token in place of a turn's.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { type Env, parseVars } from "./env.ts";
import type { Snapshot } from "./gather.ts";
import { createHub } from "./live.ts";
import { systemOpener } from "./open-link.ts";
import { noMemory } from "./packs/core/assistant/bino/memory.ts";
import { routeOf } from "./packs/core/assistant/bino/route.ts";
import { apiCompare } from "./packs/api.ts";
import { resolvePacksRepo } from "./packs/cli.ts";
import { createKeys } from "./secrets.ts";
import { activePacks } from "./packs/registry.ts";
import type { Pack } from "./packs/types.ts";
import type { Ghe } from "./sources/ghe.ts";
import { which } from "./tools.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The pack with this id among a module's exports (its `<id>Pack`, or any export whose manifest says so). */
export function packIn(mod: Record<string, unknown>, id: string): Pack | undefined {
  const isPack = (v: unknown): v is Pack => !!v && typeof v === "object" && (v as Pack).manifest?.id === id;
  return Object.values(mod).find(isPack);
}

/** Where to go first: the pack's first nav entry, else /<id>. Only this app's own paths. */
export function firstPage(pack: Pack): string {
  let href: string | undefined;
  try {
    href = (pack.nav as ((ctx: unknown) => { href: string }[]) | undefined)?.({})?.[0]?.href;
  } catch {}
  return href && /^\/(?![/\\])[\w\-/?=&.%]*$/.test(href) ? href : `/${pack.manifest.id}`;
}

/** The session's turn for /mcp: only its own token, compared in constant time (#371). */
export function sessionTurn(token: string, turn: { id: string; repo: string; cwd: string }): (given: string) => typeof turn | undefined {
  const want = Buffer.from(token);
  return (given) => {
    const g = Buffer.from(String(given));
    return g.length === want.length && timingSafeEqual(g, want) ? turn : undefined;
  };
}

/** The line that gives a Claude Code session this pack's tools; the port is new each session, so is the line. */
export function mcpAddLine(id: string, port: number, token: string): string {
  return `claude mcp add --transport http dovre-${id} http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

/** Where a session's setting came from (#369). */
export type SettingSource = "--set" | "environment" | "local instance";

/**
 * The pack's own settings (only the keys its manifest names), first found wins: `--set` flags, this
 * shell's environment, then the local instance's `.dev.vars` (read, never written). What's still
 * missing can be set on the session's Settings page, in memory only.
 */
export function settingsOf(pack: Pack, o: { flags?: Record<string, string>; env: Record<string, string | undefined>; instance?: Record<string, string> }): { values: Record<string, string>; from: Record<string, SettingSource> } {
  const values: Record<string, string> = {};
  const from: Record<string, SettingSource> = {};
  for (const { key } of pack.manifest.settings ?? []) {
    for (const [src, vars] of [["--set", o.flags], ["environment", o.env], ["local instance", o.instance]] as const) {
      const v = vars?.[key]?.trim();
      if (v) {
        values[key] = v;
        from[key] = src;
        break;
      }
    }
  }
  return { values, from };
}

/**
 * The command line: `<pack> [checkout] [--set KEY=value]…`. A `--set` must name one of the pack's
 * settings, and never a secret one: the command line lands in shell history.
 */
export function argsOf(args: string[]): { id?: string; checkout?: string; sets: [string, string][] } {
  const rest: string[] = [];
  const sets: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const kv = a === "--set" ? (args[++i] ?? "") : a.startsWith("--set=") ? a.slice(6) : undefined;
    if (kv === undefined) {
      if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
      rest.push(a);
      continue;
    }
    const eq = kv.indexOf("=");
    if (eq < 1) throw new Error("--set takes KEY=value");
    sets.push([kv.slice(0, eq), kv.slice(eq + 1)]);
  }
  return { id: rest[0], checkout: rest[1], sets };
}

/** The `--set` pairs as settings, checked against the pack's manifest. */
export function flagsOf(pack: Pack, sets: [string, string][]): Record<string, string> {
  const settings = pack.manifest.settings ?? [];
  for (const [k] of sets) {
    const s = settings.find((x) => x.key === k);
    if (!s) throw new Error(`${pack.manifest.id} has no setting ${k}${settings.length ? ` (it has ${settings.map((x) => x.key).join(", ")})` : ""}`);
    if (s.secret) throw new Error(`${k} is a secret: not on the command line (shell history). Set it in the environment, or on the session's Settings page`);
  }
  return Object.fromEntries(sets);
}

/** The local instance's `.dev.vars` beside this core, if there is one. */
function instanceVars(): Record<string, string> {
  try {
    return parseVars(readFileSync(join(dirname(import.meta.dirname), ".dev.vars"), "utf8"));
  } catch {
    return {};
  }
}

const EMPTY: Snapshot = {
  at: Date.now(),
  login: "",
  org: "",
  prs: { ok: true, value: { mine: [], review: [] } },
  notes: { ok: true, value: [] },
  moves: { ok: true, value: [] },
  deploys: { ok: true, value: [] },
  refs: new Map(),
  changelogs: new Map(),
  red: [],
  name: "",
};

async function main(args: string[]) {
  const { id, checkout, sets } = argsOf(args);
  if (!id || !ID.test(id)) {
    console.log("dovre run <pack> [checkout] [--set KEY=value]…: one pack from dovre-packs, in a throw-away session");
    process.exit(id ? 1 : 0);
  }
  const repo = resolvePacksRepo();
  const entry = join(repo, "packs", id, "index.ts");
  if (!existsSync(entry)) throw new Error(`no pack ${id} in ${repo}`);
  const pack = packIn((await import(pathToFileURL(entry).href)) as Record<string, unknown>, id);
  if (!pack) throw new Error(`packs/${id}/index.ts exports no pack with id ${id}`);

  // A checkout given: its parent is CODE_DIR, so the pack's "directly under CODE_DIR" check holds for it.
  const dir = checkout ? resolve(checkout) : undefined;
  if (dir && !(existsSync(dir) && statSync(dir).isDirectory())) throw new Error(`${checkout} isn't a folder`);

  // Before API 1.7 a pack lists the code folder itself, so it sees the checkout's neighbours too.
  if (dir && apiCompare(pack.manifest.api, "1.7") < 0) console.warn(`${id} is on pack API ${String(pack.manifest.api)}: it may see every checkout beside ${basename(dir)}, not only it`);
  const token = randomBytes(24).toString("base64url");
  const mcpToken = randomBytes(24).toString("base64url");
  const db = openDb();
  const env = { LAUNCH_TOKEN: token, CODE_DIR: dir ? dirname(dir) : "", CLAUDE_DIR: "", GHE_HOST: "github.com", GHE_ORG: "", DB: db.DB } as Env;
  const { values: settings, from } = settingsOf(pack, { flags: flagsOf(pack, sets), env: process.env, instance: instanceVars() });
  // A key given as a store's reference (#416) is read now; one saved on its Settings stays in memory.
  const keys = createKeys(settings, { log: (l) => console.log(l) });
  await keys.read();
  const packs = activePacks([pack], { env: settings, unread: keys.unread(), hosted: false, which });
  // Off only for a setting it lacks: it starts on its Settings page, and turns on once that's given there.
  const waiting = !packs.on.length && packs.off.length === 1 && !!packs.off[0]!.pack && (pack.manifest.settings ?? []).some((s) => s.required && !settings[s.key]);
  if (!packs.on.length && !waiting) throw new Error(`${id} is off here: ${packs.off.map((o) => o.why).join("; ")}`);
  for (const [k, src] of Object.entries(from)) console.log(`${k}: from ${src === "local instance" ? "the local instance's .dev.vars" : src === "--set" ? "--set" : "the environment"}`);

  const ghe: Ghe = { host: "github.com", rest: () => Promise.reject(new Error("no GitHub in a pack session")), graphql: () => Promise.reject(new Error("no GitHub in a pack session")) };
  const gatherer = { get: async () => EMPTY, stale: () => {}, gathering: () => false, peek: () => EMPTY };
  const app = createApp(env, {
    gatherer,
    ghe,
    hub: createHub(),
    bino: { route: routeOf({ via: "off" }), memory: noMemory("off in a pack session") },
    packs: { ...packs, env: settings, keys },
    session: { pack: id, checkout: dir ? basename(dir) : "" },
    mcpTurns: sessionTurn(mcpToken, { id: `session-${id}`, repo: dir ? basename(dir) : id, cwd: dir ?? process.cwd() }),
  });
  const start = waiting ? `/settings/packs/${encodeURIComponent(id)}` : firstPage(pack);
  // / goes to the pack (createApp's session gate answers 404 for every other core page).
  const fetch = (req: Request) => (new URL(req.url).pathname === "/" ? Response.redirect(new URL(start, req.url), 302) : app.fetch(req));

  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
    const url = `http://127.0.0.1:${info.port}/login?tk=${token}&next=${encodeURIComponent(start)}`;
    console.log(`${pack.manifest.name}${dir ? ` on ${basename(dir)}` : ""}: ${url}${waiting ? `\n${packs.off[0]!.why}: set it on the page that opens.` : ""}`);
    if (pack.tools) console.log(`Its tools for Claude Code, while this session runs:\n  ${mcpAddLine(id, info.port, mcpToken)}\n  (claude mcp remove dovre-${id} once it's over)`);
    console.log("Ctrl+C ends the session; nothing is kept.");
    if (process.env.DOVRE_NO_OPEN !== "1") systemOpener()(url);
  });
  const end = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
}

if (import.meta.main) await main(process.argv.slice(2)).catch((e) => {
  console.error(`dovre run: ${(e as Error).message}`);
  process.exit(1);
});
