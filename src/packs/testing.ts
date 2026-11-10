/**
 * For a pack's tests: a PackContext with harmless defaults (nothing gathered, an empty page, no
 * slots filled), so a test names only what it needs and keeps compiling when the context grows.
 * A pack's tests import it as `dovre/pack-testing.ts`. Below it, what a test of a pack's pages needs.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Context } from "hono";
import { createApp, packsOf } from "../app.ts";
import type { McpRun } from "../ai/mcpcalls.ts";
import type { AgentHost, AiRoute } from "./ai.ts";
import { type D1, openDb } from "../db.ts";
import type { AppEnv, Env } from "../env.ts";
import { pickForge } from "../forge/pick.ts";
import type { Forge } from "../forge/types.ts";
import { shell } from "../html.ts";
import type { Snapshot } from "../gather.ts";
import type { Session } from "../sources/claude.ts";
import type { Deploy, Ghe, Pr } from "../sources/ghe.ts";
import { noMemory } from "./core/assistant/bino/memory.ts";
import { routeOf } from "./core/assistant/bino/route.ts";
import { checkoutIn, checkoutsIn } from "./checkouts.ts";
import { loggedFor } from "./logged.ts";
import { kvInMemory } from "./store.ts";
import { CORE_PACKS } from "./own.ts";
import { activePacks, initAll, lookupsFrom } from "./registry.ts";
import { foreignTables, migrationsGap, tablePrefix } from "./migrations.ts";
import { checkHtml, classesOf, scopeCss } from "./guard.ts";
import { STYLE } from "../ui/style.ts";
import { type AgentShare, type ListItem, type ListShare, type Pack, PACK_API, type PackContext, type PageOpts } from "./types.ts";

const soons = new WeakMap<PackContext["soon"], (number | undefined)[]>();
/**
 * What a `testContext` was asked through `ctx.soon`, in order (each call's `ms`, undefined when
 * left out): `assert.deepEqual(soonOf(ctx), [undefined])` says "asked to be called again, once".
 * Nothing calls `refresh` again in a test: call it yourself, with `{ soon: true }`.
 */
export const soonOf = (ctx: PackContext): (number | undefined)[] => soons.get(ctx.soon) ?? [];

export function testContext(over: Partial<PackContext> = {}, as: { /** The pack's id, for what `logged` writes when you pass a `db` (`<id>.<kind>`). */ id?: string } = {}): PackContext {
  const asked: (number | undefined)[] = [];
  const soon = (ms?: number) => void asked.push(ms);
  soons.set(soon, asked);
  // As core does it: a code folder comes with its checkouts (the git repos directly under it).
  const dir = over.codeDir;
  return {
    checkouts: () => (dir ? checkoutsIn(dir) : []),
    checkout: (name: unknown) => (dir ? checkoutIn(dir, name) : null),
    // Everything works in a test unless you say otherwise: `can: (what) => ({ ok: false, why: "…" })`.
    can: () => ({ ok: true }),
    env: {},
    bindings: {},
    hosted: false,
    db: undefined as unknown as D1,
    // In memory, with core's checks; with a `db` of yours, pass `store: { kv: … }` only to watch it.
    store: { kv: kvInMemory() },
    // Checks the kind as core does; kept in the actions table of a `db` you pass, as `<id>.<kind>`, else nowhere.
    logged: loggedFor(as.id ?? "test", over.db, () => {}),
    // No one, as locally: `{ ...ctx, viewer: () => "ann@example.dev" }` for a person's request.
    viewer: () => undefined,
    publish: () => {},
    snapshot: () => undefined,
    gathered: async () => undefined,
    fill: () => [],
    fillOwn: () => [],
    soon,
    page: async () => new Response(),
    dockPage: () => new Response(),
    log: () => {},
    ring: () => {},
    ask: async () => ({ action: "cancel" }),
    asking: () => false,
    pulse: () => ({ working: 0, asking: 0, trouble: [], busy: false }),
    forge: () => undefined,
    startPicture: () => {},
    wasm: () => undefined,
    file: () => undefined,
    required: () => undefined,
    refs: () => [],
    pageOn: () => true,
    setupDone: () => true,
    ai: () => ({ text: false, why: "not in tests" }),
    complete: async () => {
      throw new Error("AI: not in tests");
    },
    agent: {
      can: () => ({ ok: false, why: "not in tests" }),
      start: async () => ({ error: "AI: not in tests" }),
      result: async () => undefined,
      land: async () => ({ error: "AI: not in tests" }),
    },
    mcp: {
      can: () => ({ ok: false, why: "not in tests" }),
      call: async () => {
        throw new Error("MCP: not in tests");
      },
      write: async () => {
        throw new Error("MCP: not in tests");
      },
    },
    ...over,
  };
}

// ── For tests of a pack's pages: made-up data, hostile text, and an app around the pack ──

/** Markup if anything renders it unescaped: put it in every string field of a view's input. */
/** The agents pack's share (`agent`) as a test fills it in: links shaped like its own. */
export const testAgentLinks: AgentShare = {
  start: (o = {}) => {
    const q = new URLSearchParams({ ...(o.repo ? { repo: o.repo } : {}), ...(o.prompt !== undefined ? { prompt: o.prompt } : {}) }).toString();
    return q ? `/agents/new?${q}` : "/agents/new";
  },
  session: (sid) => `/agents/s/${encodeURIComponent(sid)}`,
  run: (id) => `/agents/r/${encodeURIComponent(id)}`,
};

/** A stand-in for the agents pack that only shares where its pages are, for packs that link there (`uses: ["agents"]`). */
export const testAgentsPack = (): Pack => ({
  manifest: { api: PACK_API, id: "agents", name: "Agents", description: "Stand-in: where agents' pages are", domain: "general" },
  shares: () => ({ agent: testAgentLinks }),
});

/**
 * `ctx.page` for a pack's routes tested on their own: the page in core's shell (menu, styles), as
 * `operator` sees it. Nothing is boxed or guarded here: `packApp` is the whole app.
 */
export const testPage = (o: { operator?: string } = {}) => async (c: Context<AppEnv>, p: PageOpts): Promise<Response> =>
  c.html(shell({ title: p.title, frame: { operator: o.operator ?? "ola-nordmann", nav: [], host: "acme.ghe.com" }, current: p.current ?? c.req.path, body: p.body, head: p.head }));

/** The forge a pack brings, as core makes it when FORGE names it: its `create` with these settings, or one whose every call fails saying why. */
export function testForge(pack: Pack, env: Record<string, string | undefined> = {}): Forge {
  if (!pack.forge) throw new Error(`${pack.manifest.id} brings no forge`);
  return pickForge(pack.forge.id, [pack], () => assert.fail("not GitHub"), env);
}

/** A stand-in for My list (the todo pack's `list` share), kept in memory: hand it out from `required("todo", "list")` and read `items()` after. */
export function testList(): ListShare {
  const kept: ListItem[] = [];
  return {
    items: async () => [...kept],
    get: async (id) => kept.find((t) => t.id === id),
    add: async (t) => {
      const item: ListItem = { id: kept.length + 1, parent: t.parent ?? null, title: t.title, notes: t.notes ?? "", state: t.state ?? "next", due: t.due ?? null, doneAt: null };
      kept.push(item);
      return item;
    },
    href: (id) => `/todo#t-${id}`,
  };
}

/**
 * What core keeps of a pack's lookups, as Bino gets them: `kinds` by their full names
 * (`<id>.<kind>`), and `left`, a line for each one left out (a bad field, one past the caps).
 */
export function keptLookups(pack: Pack, ctx: PackContext = testContext()): { kinds: string[]; left: string[] } {
  const left: string[] = [];
  const kinds = lookupsFrom([pack], () => ctx, (_id, line) => left.push(line)).map((l) => l.kind);
  return { kinds, left };
}

/** Fails when a class in this source's `class="…"` is styled by neither core's stylesheet nor the pack's own (`css`). A name built in place (`x-${kind}`) isn't checked. */
export function assertStyled(name: string, source: string, css = "") {
  const styled = classesOf(STYLE + css);
  const missing = new Set<string>();
  for (const m of source.matchAll(/class="([^"]*)"/g))
    // `class="${on ? "a" : "b"}"` ends at the quote inside the `${`: what's left of that expression is code, not class names.
    for (const cls of m[1]!.replace(/\$\{[^}]*\}/g, " ").replace(/\$\{.*$/s, " ").split(/\s+/).filter(Boolean)) if (/^[a-z][a-z0-9-]*$/.test(cls) && !cls.endsWith("-") && !styled.has(cls)) missing.add(cls);
  assert.deepEqual([...missing], [], `${name}: classes no stylesheet styles`);
}

export const HOSTILE = `<script>x</script>"'><img src=x onerror=1>`;

/** Fails when hostile text (HOSTILE) reached the page as markup. */
export function assertInert(name: string, out: string) {
  for (const live of ["<script>x", "<img src=x", "onerror=1>"]) assert.ok(!out.includes(live), `${name}: ${live} reached the page as markup`);
}

/**
 * Fails when the core would refuse a view's fragment (src/packs/guard.ts): a tag closed that wasn't
 * opened, one left open, a <style> or <base>. On a page from `packApp`, when it already did.
 */
export function assertFragment(name: string, out: string) {
  assert.ok(!out.includes("pack-broke"), `${name}: the core refused part of the pack's markup (the pack's log says why)`);
  if (/<html[\s>]/i.test(out)) return;
  const why = checkHtml(out);
  assert.equal(why, undefined, `${name}: ${why}`);
}

/** Fails when the pack's styles would restyle core: each such selector is left out when it's served. */
export function assertScoped(pack: Pack) {
  if (!pack.styles) return;
  const { dropped } = scopeCss(pack.styles, classesOf(STYLE));
  assert.deepEqual(dropped, [], `${pack.manifest.id}: these selectors style core's markup, not the pack's own (give each a class of the pack's)`);
}

/**
 * Fails when the pack's migrations aren't its own: a list core would refuse (not one statement
 * each), or a table or index not named after the pack (`<id>` with dashes as underscores, alone
 * or followed by `_`). `also`: tables it had before this rule, by their full names.
 */
export function assertTables(pack: Pack, o: { also?: string[] } = {}) {
  const id = pack.manifest.id;
  assert.equal(migrationsGap(pack), undefined, `${id}: ${migrationsGap(pack)}`);
  const also = new Set((o.also ?? []).map((n) => n.toLowerCase()));
  const foreign = foreignTables(pack).filter((line) => !also.has(line.slice(line.indexOf(": ") + 2).toLowerCase()));
  assert.deepEqual(foreign, [], `${id}: these tables or indexes aren't named after the pack (start each "${tablePrefix(id)}_")`);
}

export const testPr = (o: Partial<Pr> = {}): Pr => ({
  repo: "ACME/shop-api", number: 1, title: "A PR", url: "https://acme.ghe.com/ACME/shop-api/pull/1", draft: false,
  updatedAt: "2026-10-22T07:00:00Z", branch: "feat/x", author: "ola-nordmann", review: "REVIEW_REQUIRED", checks: "SUCCESS", openThreads: 0,
  body: "", additions: 1, deletions: 0, headSha: "abc1234def", labels: [], files: [], reviews: [], requested: [], runs: [], ...o,
});

export const testSession = (o: Partial<Session> = {}): Session => ({ sessionId: "s-1", live: true, status: "busy", prs: [], subagentsRunning: 0, ...o });

export const testDeploy = (o: Partial<Deploy> = {}): Deploy => ({
  id: 10, name: "Deploy to PROD", title: "Deploy to PROD", actor: "per-hansen", createdAt: "2026-10-22T06:45:00Z", url: "https://acme.ghe.com/ACME/people/actions/runs/10",
  sha: "3f59045", headSha: "3f59045aaaa", branch: "main", repo: "ACME/people", envs: [{ id: 5, name: "prod" }], superseded: [], more: false, ...o,
});

/** A gathered snapshot: 2026-10-22 07:00 UTC, ola-nordmann in ACME, nothing open. */
export function testSnapshot(o: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.parse("2026-10-22T07:00:00Z"),
    login: "ola-nordmann",
    org: "ACME",
    prs: { ok: true, value: { mine: [], review: [] } },
    notes: { ok: true, value: [] },
    moves: { ok: true, value: [] },
    deploys: { ok: true, value: [] },
    refs: new Map(),
    changelogs: new Map(),
    red: [],
    name: "Andreas",
    ...o,
  };
}

/**
 * Dovre around these packs, signed in, on a fresh database: `get` and `post` (a form, from this
 * app's own origin unless `headers` say otherwise) answer as the app would. GitHub answers nothing;
 * Bino is off.
 */
export function packApp(packs: Pack[], o: { snapshot?: Snapshot; /** The instance's settings the packs read. */ env?: Record<string, string>; forge?: Pick<Forge, "id" | "name" | "can"> & Partial<Pick<Forge, "host" | "work" | "merged" | "repos" | "file" | "pr" | "dir" | "propose">>; hosted?: boolean; /** Local: the code folder packs see as `ctx.codeDir`. */ codeDir?: string; /** Local: the folder the packs' own folders (`ctx.dir()`) are made in; without it, `data/` where the tests run. */ dataDir?: string; /** A pack session (#353): no cockpit, and only `checkout` under codeDir. */ session?: { pack: string; checkout?: string }; /** A token's turn for /mcp (a session's own, #371). */ mcpTurns?: (token: string) => { id: string; repo: string; cwd: string } | undefined; /** A made-up model for `ctx.complete` (#466); a pack still needs my OK on its Settings page. */ ai?: AiRoute; /** A made-up runner for `ctx.agent` (#467); the same OK needed. */ agents?: AgentHost; /** A made-up Claude Code for `ctx.mcp` (#488); the same OK needed. */ mcp?: McpRun } = {}) {
  const db = openDb();
  const s = o.snapshot ?? testSnapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const ghe: Ghe = { host: "acme.ghe.com", rest: () => Promise.reject(new Error("no GitHub in tests")), graphql: () => Promise.reject(new Error("no GitHub in tests")) };
  const env = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: o.codeDir ?? "x", CLAUDE_DIR: "x", DB: db.DB, ...(o.dataDir ? { U_DB: join(o.dataDir, "dovre.sqlite") } : {}) } as Env;
  const app = createApp(env, { gatherer, ghe, forge: o.forge, bino: { route: routeOf({ via: "off" }), memory: noMemory("off in tests") }, packs: { ...activePacks(packs, { env: o.env ?? {}, hosted: !!o.hosted, which: () => "/bin/x" }), env: o.env ?? {}, core: [...CORE_PACKS] }, session: o.session, mcpTurns: o.mcpTurns, ai: o.ai, agents: o.agents, mcp: o.mcp });
  // The packs' own tables (Pack.migrations) are made before the first request through get or post.
  const mounted = packsOf(app)!;
  const ready = initAll(mounted, mounted.ctxOf, () => {}, { init: false });
  const get = async (path: string, headers: Record<string, string> = {}) => (await ready, app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token", ...headers } }));
  const post = async (path: string, body: Record<string, string> | string, headers: Record<string, string> = {}) =>
    (await ready,
    app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", ...headers },
      body: new URLSearchParams(body).toString(),
    }));
  return { app, get, post, db, /** Settled once the packs' migrations ran; `get` and `post` wait for it themselves. */ ready };
}
