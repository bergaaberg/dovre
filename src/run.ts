/**
 * `node src/run.ts <pack> [checkout]`: one pack from dovre-packs in a throw-away session (#353,
 * prototype). No home page, needs, gatherer or Bino: the pack's own pages, on a random port on
 * 127.0.0.1, behind a launch token made for this session. Nothing is kept: the database is in
 * memory, and it's all gone when the process ends.
 *
 * The same doors as local mode: the launch-token cookie on a localhost Host header, and the exact
 * Origin on every write (createApp's own checks). createApp's `session` keeps the cockpit out: only
 * the pack's paths, sign-in, assets and the event stream answer, and the menu holds the pack's entries. A checkout given is the one repo the pack sees,
 * as a checkout directly under CODE_DIR.
 */
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import type { Env } from "./env.ts";
import type { Snapshot } from "./gather.ts";
import { createHub } from "./live.ts";
import { systemOpener } from "./open-link.ts";
import { noMemory } from "./packs/core/assistant/bino/memory.ts";
import { routeOf } from "./packs/core/assistant/bino/route.ts";
import { apiCompare } from "./packs/api.ts";
import { resolvePacksRepo } from "./packs/cli.ts";
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

/** The pack's own settings from this shell's environment: only the keys its manifest names. */
export function settingsOf(pack: Pack, from: Record<string, string | undefined>): Record<string, string> {
  const keys = (pack.manifest.settings ?? []).map((s) => s.key);
  return Object.fromEntries(keys.flatMap((k) => (from[k] ? [[k, from[k]!]] : [])));
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
  const [id, checkout] = args;
  if (!id || !ID.test(id)) {
    console.log("dovre run <pack> [checkout]: one pack from dovre-packs, in a throw-away session");
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
  const db = openDb();
  const env = { LAUNCH_TOKEN: token, CODE_DIR: dir ? dirname(dir) : "", CLAUDE_DIR: "", GHE_HOST: "github.com", GHE_ORG: "", DB: db.DB } as Env;
  const settings = settingsOf(pack, process.env);
  const packs = activePacks([pack], { env: settings, hosted: false, which });
  if (!packs.on.length) throw new Error(`${id} is off here: ${packs.off.map((o) => o.why).join("; ")}`);

  const ghe: Ghe = { host: "github.com", rest: () => Promise.reject(new Error("no GitHub in a pack session")), graphql: () => Promise.reject(new Error("no GitHub in a pack session")) };
  const gatherer = { get: async () => EMPTY, stale: () => {}, gathering: () => false, peek: () => EMPTY };
  const app = createApp(env, {
    gatherer,
    ghe,
    hub: createHub(),
    bino: { route: routeOf({ via: "off" }), memory: noMemory("off in a pack session") },
    packs: { ...packs, env: settings },
    session: { pack: id, checkout: dir ? basename(dir) : "" },
  });
  const start = firstPage(pack);
  // / goes to the pack (createApp's session gate answers 404 for every other core page).
  const fetch = (req: Request) => (new URL(req.url).pathname === "/" ? Response.redirect(new URL(start, req.url), 302) : app.fetch(req));

  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
    const url = `http://127.0.0.1:${info.port}/login?tk=${token}&next=${encodeURIComponent(start)}`;
    console.log(`${pack.manifest.name}${dir ? ` on ${basename(dir)}` : ""}: ${url}\nCtrl+C ends the session; nothing is kept.`);
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
