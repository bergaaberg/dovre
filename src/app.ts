/**
 * Dovre: the view from the top (PLAN.md). Local only: every route needs the launch-token
 * cookie on a localhost Host; anything else is a 404, as if nothing were here.
 * Settings and Packs, the first run and pack setup, and the relay are route modules in src/routes/,
 * given the part of the app's state they use (src/routes/scope.ts).
 */
import { type AgentHost, type AiRoute, aiAskOf, packAiFor, packAiStore } from "./packs/ai.ts";
import { agentHostOf } from "./packs/agenthost.ts";
import type { PackAiAsk } from "./packs/types.ts";
import { checkoutIn, checkoutsIn } from "./packs/checkouts.ts";
import { loggedFor } from "./packs/logged.ts";
import { packDirOf, programsFor } from "./packs/programs.ts";
import { ownersIn } from "./owners.ts";
import { d1Reads, packReads } from "./sources/files.ts";
import { packProposals } from "./actions/propose.ts";
import { resolve } from "node:path";
import { slowLog } from "./slow.ts";
import { createSpeed, type Speed, speedLog, WAITED } from "./speed.ts";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { contextStorage, tryGetContext } from "hono/context-storage";
import { secureHeaders } from "hono/secure-headers";
import { type AccessVerifier, COOKIE, allowed, isLocal, isOwnOrigin, publicOriginOf, sameSecret, secureCookie } from "./access.ts";
import { logAction, recentActions, repoIn } from "./actions/deploys.ts";
import type { App, AppEnv, Env } from "./env.ts";
import type { Gatherer, Snapshot } from "./gather.ts";
import { type Need } from "./home/needs.ts";
import { dockShell, type Frame, html, type NavItem, SIDE_JS, SIDE_PATH, shell } from "./html.ts";
import { homePage } from "./pages/home.ts";
import { browserZone, currentTz, greetingLang, setWhen, validZone } from "./when.ts";
import type { Ghe } from "./sources/ghe.ts";
import { githubForge } from "./forge/github.ts";
import { type Forge, type ForgeCan, forgeCan } from "./forge/types.ts";
import { streamSSE } from "hono/streaming";
import type { Hub } from "./live.ts";
import type { Runner } from "./agents/runner.ts";
import { statsPage, WEEKS } from "./pages/stats.ts";
import { actionsCard, actionsPage } from "./pages/actions.ts";
import { pagesOf, parseQuery, type Row as SearchRow, search } from "./search/search.ts";
import { createGheSearch } from "./search/ghe.ts";
import { searchList, searchPage } from "./pages/search.ts";
import { createBugRoutes } from "./pages/bug.ts";
import { HOME_SOURCE as PACKS_HOME } from "./packs/releases.ts";
import { type Asks, askInBar, createAsks } from "./relay/asks.ts";
import { type Bino, createBino } from "./packs/core/assistant/bino/bino.ts";
import type { Lookups } from "./packs/core/assistant/bino/lookups.ts";
import { appsOf, contextOf, defaultBinoOf } from "./packs/core/assistant/bino/context.ts";
import { investigateOf, investigatePage } from "./pages/investigate.ts";
import type { BinoMemory } from "./packs/core/assistant/bino/memory.ts";
import type { Route } from "./packs/core/assistant/bino/route.ts";
import { hostAssistant } from "./packs/core/assistant/bino/host.ts";
import type { Kept } from "./kept.ts";
import { AREAS, type AgentToolsView, type SetupLine } from "./pages/settings.ts";
import { type SentView } from "./pages/sent.ts";
import { type ToolsHarness } from "./agents/mcpsetup.ts";
import { type SetupRow, setupStrip } from "./pages/setup.ts";
import { type OnboardingStore, onboardingStore } from "./onboarding.ts";
import { onboardOf } from "./packs/suggest.ts";
import { type Config, type PaneId, type PanesOn, type PaneState } from "./config.ts";
import { found } from "./tools.ts";
import { mountPwa } from "./pwa.ts";
import { type Html, Notice, PageHeader } from "./ui/kit.ts";
import { writeClicksStore, writeKinds } from "./writes.ts";
import { mountMcp } from "./mcp.ts";
import { mountIngest } from "./packs/ingest.ts";
import { actsFrom, lookupsFrom, beforePages, bannersFrom, briefingFrom, docksFrom, fillOf, whatFrom, whereFrom, linkedFrom, needsFrom, noteFrom, type Off, statsFrom, pulseFrom, type Refreshes, refresher, refreshLog, ringsOf, safely, settleRequires, heldOff, requiresOf, todayCards, usesOf } from "./packs/registry.ts";
import type { Keys } from "./secretrefs.ts";
import { createReleases, type GetJson } from "./packs/releases.ts";
import { manifestSettings } from "./pages/packs.ts";
import type { Copies } from "./packs/copies.ts";
import { strictOrigin } from "./strict.ts";
import { webUrl } from "./open-link.ts";
import { type Layout, type LayoutStore, layoutStore, withTabs } from "./layout.ts";
import { packFeedOf } from "./home/feed.ts";
import { safeUrl } from "./pages/parts.ts";
import type { AiSummary, ListShare, Pack, PackContext, PackShares, PrSlotArg, Pulse, TodayCard, WasmFile } from "./packs/types.ts";
import { fileWhy, isWasm, isWasmFile, packFileAt, packFileNameOk, packFileType, packFileWhy, shaOk, WASM_INLINE_MAX, wasmFileAt, wasmNameOk } from "./packs/wasm.ts";
import { hashOf } from "./ui/style.ts";
import { type Note, type Policy, RING_KINDS, type Rung, rings } from "./notify.ts";
import { listRepos } from "./sources/claude.ts";
import { GO_KEYS, SCRIPT, SCRIPT_PATH } from "./ui/app.js.ts";
import { SETUP_JS, SETUP_JS_PATH } from "./ui/setup.js.ts";
import { RAW_CHANGE } from "./ui/on.js.ts";
import { STYLE, STYLE_PATH } from "./ui/style.ts";
import { boxed, classesOf, guardHtml, scopeCss, scriptOf } from "./packs/guard.ts";
import { createCodeRoutes } from "./pages/code.ts";
import { currentViewer, viewingAs } from "./viewer.ts";
import { keyPrefsStore } from "./keys.ts";
import { welcomeRoutes } from "./routes/welcome.ts";
import { relayRoutes } from "./routes/relay.ts";
import { settingsRoutes } from "./routes/settings.ts";

/** Each pane's pages: 404 while it's switched off. */
const PANE_PATHS: [PaneId, RegExp][] = [
  ["bino", /^\/bino(\/|$)/],
];

/** Core pages only some forges serve (src/forge/types.ts): not here at all when this one can't. */
const FORGE_PATHS: [ForgeCan, RegExp][] = [
  ["deployApproval", /^\/deploys\/(approve|reject|reject-superseded)$/],
];

/** Thrown by a page when nothing has been gathered yet; it answers with a page that fills itself in. */
class Pending extends Error {}
/** How long a pack's page may take before it shows as broken (a long job redirects to a page that fills itself in). */
export const PACK_ROUTE_MS = 30_000;

/** The first start's page: the same frame as every page (menu, tab bar, styles), and a note that swaps out for the real page when the gather lands. */
function pendingPage(path: string, frame: Frame): string {
  return String(shell({ title: "Dovre", frame, current: path, body: html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><h1>Gathering</h1><p class="t2">The page fills in by itself in a few seconds.</p></section>` }));
}

/** Nothing gathered yet: what the frame is drawn from on the "Gathering" page. */
const EMPTY = { deploys: { ok: false }, prs: { ok: false } } as unknown as Snapshot;

function navOf(s: Snapshot, opts: { hosted?: boolean; bino?: boolean; /** Some pack here draws on /stats. */ stats?: boolean; /** This instance lists packs (on or off). */ packs?: boolean } = {}): NavItem[] {
  // The rail (src/html.ts): groups in order; "You" sits at the foot.
  const items: (NavItem | false)[] = [
    { href: "/", title: "Today", icon: "home" },
    !!opts.stats && { href: "/stats", title: "Stats", icon: "chart" },
    !opts.hosted && { href: "/code", title: "Code", icon: "code", group: "Code", order: 40 },
    !!opts.bino && { href: "/bino", title: "Bino", icon: "chat", group: "Agents", order: 20 },
    !!opts.packs && { href: "/packs", title: "Packs", icon: "layers", group: "You" },
    { href: "/settings", title: "Settings", icon: "gear", group: "You" },
    { href: "/bug", title: "Report a bug", icon: "alert", group: "You" },
  ];
  return items.filter((x): x is NavItem => !!x);
}

/** A built app's packs, for the composition roots (their refresh schedule, cron, email). */
const appPacks = new WeakMap<App, { on: Pack[]; off: Off[]; ctxOf: (c: Pack) => PackContext; /** Where the composition root's refresher and cron say how each run went. */ refreshes: Refreshes; /** Hidden in Settings → Layout: its refresh doesn't run. */ hidden: (id: string) => boolean; /** What the shown packs say needs me now (src/packs/registry.ts needsFrom). */ needs: () => Need[]; /** Their ring kinds that start off (RingDecl.off). */ startsOff: ReadonlySet<string>; /** The PR links their pages show, for the gather (linkedFrom). */ linked: () => string[]; /** What Bino may look up (hosted: the DO asks through src/hosted/lookups.ts). */ lookups: Lookups; /** Whether a page answers here (its pack is on and shown). */ pageOn: (href: string) => boolean; /** Hosted (#428): once the start read the keys, their packs on or off as they came back. */ keysRead: () => Promise<void>; /** After a pack's refresh failed: its keys read again, at most every 10 minutes. */ keysAgain: (p: Pack) => void }>();
export const packsOf = (app: App) => appPacks.get(app);

/** In a pack session, the paths that answer: the pack's own (its id and manifest paths), sign-in, assets and the event stream. */
export function sessionPath(path: string, owned: string[]): boolean {
  if (path === "/login" || path === "/events" || path.startsWith("/assets/")) return true;
  return owned.some((p) => path === `/${p}` || path.startsWith(`/${p}/`));
}

/** hashOf (FNV-1a) over bytes: a module's URL changes when it does. */
function hashBytes(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
  return (h >>> 0).toString(36);
}

export function createApp(env: Env, deps: { gatherer: Gatherer; /** Local: where slow requests and page loads are written (data/perf.log). */ perfLog?: (line: string) => void; /** Page speed's counts (src/speed.ts); default: this app's own. */ speed?: Speed; ghe: Ghe; /** Settings → Layout's store (default: kept in D1); the demo's is fixed. */ layout?: LayoutStore; /** The forge (src/forge/): what it can't do is hidden. Default: GitHub through `ghe`. */ forge?: Pick<Forge, "id" | "name" | "can"> & Partial<Pick<Forge, "host" | "work" | "merged" | "repos" | "untriaged" | "file" | "everyRepo" | "pr" | "dir" | "propose">>; /** Local: keeps a pack's picture for the starting page (PackContext.startPicture). */ startPicture?: (svg: string) => void; /** Local: the model packs may ask once I allow them (#466: AI_VIA); none, and `ctx.complete` says so. */ ai?: AiRoute; /** What packs' agent turns run on (#467); default: the runner's. Tests give a made-up one. */ agents?: AgentHost; runner?: Runner; /** Local: the open terminals' MCP tokens (#172), beside the runner's turns; in a pack session, its own (#371). */ mcpTurns?: (token: string) => { id: string; repo: string; cwd: string } | undefined; /** Local: Settings → Pack tools for agents (#172). */ agentTools?: { view(): Omit<AgentToolsView, "said">; register(h: ToolsHarness): { ok: true } | { ok: false; why: string } }; /** Local mode: opens a checked web address in the system's default browser (src/open-link.ts). */ openUrl?: (href: string) => void; hub?: Hub; notify?: { policy(): Policy; setPolicy(p: Policy): Promise<void>; log(): Rung[]; test(): void; /** Rings these now (a pack's `ctx.ring`, checked). */ ring?(notes: Note[]): void }; info?: { version: string; startedAt: number }; restart?: () => void; /** Kept GHE answers (data/catalog.json). */ kept?: Kept; /** Load what pages need shortly after starting. */ prewarm?: boolean; /** Where the agents' skills are installed (default: the home folder); for tests. */ skillsHome?: string; /** Questions MCP servers put to me through the relay (launcher/relay.go). */ asks?: Asks; /** Bino, the assistant: its model route and memory (src/packs/core/assistant/bino/); hosted, the Durable Object's (src/hosted/client.ts). */ bino?: { route: Route; memory: BinoMemory; file?: string; log?: (line: string) => void } | { remote: Bino }; /** Hosted: a page's event stream comes from the Durable Object (src/hosted/hub.ts). */ events?: () => Promise<Response>; /** Hosted with a hub: pages listen on its /live socket (H5), /events only if that never opens. */ live?: boolean; /** Hosted mode (IS_HOSTED=1): checks Cloudflare Access on every request. Hosted without it, nobody gets in. */ access?: AccessVerifier; /** Which panes run (src/config.ts): `false` is off, gone from the menu, search, Today and its routes. */ panes?: PanesOn; /** What the climb was told (src/onboarding.ts); default: kept in D1. */ onboarding?: OnboardingStore; /** Hosted: the paired machines, for the climb's "Bring your laptop?". */ machines?: () => Promise<{ name?: string; online: boolean }[]>; /** For Settings: each pane's state, and what Settings keeps. */ config?: { panes: Record<PaneId, PaneState>; stored: Config }; /** Hosted: what the instance has and lacks, for Settings' Setup panel (src/hosted/setup.ts). */ setup?: () => SetupLine[]; /** Settings → What Dovre sends (#145): the record of calls home, hosted the hub's, on a machine its bridge's file. */ sent?: () => Promise<SentView>; /** A pack session (#353, src/run.ts): only this pack's pages, sign-in, assets and the event stream; no cockpit. */ session?: { pack: string; /** The one checkout under CODE_DIR its packs see (#368). */ checkout?: string }; /** The packs that run here and those that don't, with why (src/packs/, PLAN D23). */ packs?: { on: Pack[]; off: Off[]; env: Record<string, string | undefined>; bindings?: Record<string, unknown>; /** How long Today waits for a pack's cards (default 250 ms). */ budgetMs?: number; /** How long a pack's page may take before it shows as broken (default 30 s). */ routeMs?: number; /** Dovre's own packs (src/packs/core/), labelled so on the Packs page. */ core?: string[]; /** Local `.dev.vars` path for saving pack settings from `/packs`. */ varsFile?: string; /** Secret settings read from a store (#416; hosted #428). */ keys?: Keys; /** Local: packs copied from dovre-packs, and Update (src/packs/copies.ts). */ copies?: Copies } }): App {
  setWhen({ tz: env.TZ_NAME, lang: env.GREETING });
  const app: App = new Hono<AppEnv>();
  // The request each page is drawn for, without passing it down (the packs' bars are told the path).
  app.use(contextStorage());
  // A pack session: every path but the pack's own, sign-in, assets and the event stream is a 404.
  if (deps.session) {
    const id = deps.session.pack;
    // Off until its settings are given (#369): its paths are still its own.
    const manifest = deps.packs?.on.find((x) => x.manifest.id === id)?.manifest ?? deps.packs?.off.find((x) => x.id === id)?.manifest;
    const owned = [id, ...(Array.isArray(manifest?.paths) ? manifest.paths : [])];
    const own = encodeURIComponent(id);
    app.use(async (c, next) => {
      // Its settings page and the form it posts to (kept in memory, src/run.ts).
      const settings = (c.req.method === "GET" && c.req.path === `/settings/packs/${own}`) || (c.req.method === "POST" && c.req.path === `/packs/${own}/settings`);
      // Its tools for an agent (#371): /mcp, with the session's own token (mountMcp's checks).
      if (!settings && c.req.path !== "/mcp" && !sessionPath(c.req.path, owned)) return c.notFound();
      await next();
    });
  }
  /** Local: data/perf.log, slow page loads as the page and the server measured them (timings only). */
  const perfLog = deps.perfLog ?? (() => {});
  // Local: a request the server took long to answer, and whether it was busy or waiting (src/slow.ts). A question's long poll waits on purpose.
  if (deps.perfLog) app.use(slowLog(perfLog, { skip: (path) => path.startsWith("/relay/ask/") }));
  // Every page's time, counted by route (#294), and said in Server-Timing; the counts reach D1 at most every 30 s.
  const speed = deps.speed ?? createSpeed();
  app.use(speedLog(speed));
  app.use(async (c, next) => {
    await next();
    const p = speed.flush(env.DB);
    try {
      c.executionCtx.waitUntil(p);
    } catch {}
  });
  // Local only: the one public address a proxy serves this Dovre at (#74). A bad value throws here.
  const publicOrigin = env.IS_HOSTED === "1" ? undefined : publicOriginOf(env.PUBLIC_ORIGIN);
  if (publicOrigin)
    app.use((c, next) => {
      c.set("publicOrigin", publicOrigin);
      return next();
    });
  const { gatherer, ghe } = deps;
  // GitHub's call counts (#253) reach D1 after a request, at most every 30 s; hosted, while the Worker still runs.
  if (ghe.calls)
    app.use(async (c, next) => {
      await next();
      const p = ghe.calls!.flush(env.DB);
      try {
        c.executionCtx.waitUntil(p);
      } catch {}
    });
  const asks = deps.asks ?? createAsks();
  // Bino: what it's told comes from what's gathered, my list and what each pack says it may know, never more (src/packs/core/assistant/bino/context.ts).
  // Hosted, GitHub's snapshot stays out: the apps' packs say what matters there.
  const hostedMode = env.IS_HOSTED === "1";
  const binoContext = async () =>
    contextOf({
      todos: await sharedList()?.items(),
      s: hostedMode ? undefined : gatherer.peek(),
      org: hostedMode ? undefined : env.GHE_ORG,
      about: env.ABOUT_ME,
      apps: packBino(),
    });
  // Bino comes with core's assistant pack, which mounts its pages: with that pack off (PACK_ASSISTANT=off) or absent, there's no Bino.
  const assistant = deps.packs?.core?.includes("assistant") ? deps.packs.on.find((c) => c.manifest.id === "assistant") : undefined;
  const binoDeps = assistant ? deps.bino : undefined;
  const engine =
    binoDeps && !("remote" in binoDeps)
      ? createBino({
          route: binoDeps.route,
          memory: binoDeps.memory,
          file: binoDeps.file,
          log: binoDeps.log,
          context: async (_c, given) => given ?? binoContext(),
          onChange: (c) => deps.hub?.publish([`bino:${c.id}`, "bino"]),
          onDraft: (c) => deps.hub?.publish([`bino-draft:${c.id}`]),
          kinds: () => packActs(),
          lookups: { specs: () => packLookups(), run: (l) => runLookup(l) },
        })
      : undefined;
  const bino: Bino | undefined = binoDeps && "remote" in binoDeps ? binoDeps.remote : engine;
  /** What this instance's forge can do beyond the gather (GitHub: everything). */
  const forge = deps.forge ?? githubForge(ghe);
  // What packs may read from the owners' repos (#139): checked and kept a few minutes, shared by every pack.
  const reads = packReads(forge, () => ownersIn(env), { shared: d1Reads(env.DB) });
  // A pack's PR changing one file (dovre#203): its declared kinds only, in the owners' repos, logged.
  const proposals = (c: Pack) => packProposals({ pack: { id: c.manifest.id, name: c.manifest.name }, kinds: (c.writes ?? []).map((w) => w.kind), owners: () => ownersIn(env), db: env.DB, propose: (p) => forge.propose!(p) });
  const can = (what: ForgeCan) => forgeCan(forge, what);
  /** A pane switched off on Settings (src/config.ts), or one the forge can't serve. */
  const off = (id: PaneId) => deps.panes?.[id] === false;
  /** Some pack shown here draws on /stats: without one, Stats is gone from the menu and search, and 404s. */
  const statsOn = () => shown().some((p) => p.stats);
  /** A core path the forge can't serve (FORGE_PATHS): it 404s, and menus and search leave it out. */
  const forgeHidden = (href: string) => {
    const path = href.split(/[?#]/)[0]!;
    return FORGE_PATHS.some(([what, re]) => !can(what) && re.test(path));
  };

  // Packs' WebAssembly (Pack.wasm) and big files (Pack.files): checked, hashed, served below. Bytes
  // are served from memory; a file locally from its `load` (checked on first use), hosted from the
  // static assets the build wrote (src/packs/assets.ts). Pages may compile WebAssembly only while a
  // pack ships some.
  type Served = { type: string; bytes: Uint8Array } | { type: string; pack: string; what: string; file: WasmFile; why: (b: unknown, sha: string) => Promise<string> };
  const served = new Map<string, Served>();
  const wasmPaths = new Map<string, Map<string, string>>();
  const filePaths = new Map<string, Map<string, string>>();
  const pathsOf = (m: Map<string, Map<string, string>>, id: string) => m.get(id) ?? m.set(id, new Map()).get(id)!;
  let shipsWasm = false;
  for (const p of deps.packs?.on ?? []) {
    for (const [name, mod] of Object.entries(p.wasm ?? {})) {
      const file = isWasmFile(mod);
      const why = !wasmNameOk(name)
        ? "isn't a lowercase name"
        : file
          ? shaOk(mod.sha256) ? "" : "has no 16-digit hex sha256"
          : !(mod instanceof Uint8Array) || !isWasm(mod) ? "isn't WebAssembly" : mod.length > WASM_INLINE_MAX ? "is over 8 MB" : "";
      if (why) {
        console.log(`pack ${p.manifest.id}: wasm ${name.slice(0, 40)} ${why}; not served`);
        continue;
      }
      const path = file ? `/assets/${wasmFileAt(p.manifest.id, name, mod.sha256)}` : `/assets/wasm/${p.manifest.id}.${name}.${hashBytes(mod as Uint8Array)}.wasm`;
      served.set(path, file ? { type: "application/wasm", pack: p.manifest.id, what: `wasm ${name}`, file: mod, why: fileWhy } : { type: "application/wasm", bytes: mod as Uint8Array });
      pathsOf(wasmPaths, p.manifest.id).set(name, path);
      shipsWasm = true;
    }
    for (const [name, f] of Object.entries(p.files ?? {})) {
      const why = !packFileNameOk(name) ? "isn't a lowercase name ending .js or .css" : !isWasmFile(f) || !shaOk(f.sha256) ? "has no 16-digit hex sha256 or load" : "";
      if (why) {
        console.log(`pack ${p.manifest.id}: file ${name.slice(0, 40)} ${why}; not served`);
        continue;
      }
      const path = `/assets/${packFileAt(p.manifest.id, name, f.sha256)}`;
      served.set(path, { type: packFileType(name), pack: p.manifest.id, what: `file ${name}`, file: f, why: packFileWhy });
      pathsOf(filePaths, p.manifest.id).set(name, path);
      if (f.wasm === true && name.endsWith(".js")) shipsWasm = true;
    }
  }
  const scriptSrc = shipsWasm ? ["'self'", "'wasm-unsafe-eval'"] : ["'self'"];
  const appPolicy = (frames: string[] = []) =>
    secureHeaders({
      referrerPolicy: "same-origin",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        ...(frames.length ? { frameSrc: ["'self'", ...frames] } : {}),
        scriptSrc,
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
    });
  const appHeaders = appPolicy();
  /** A pack's own pages with `frames`: the app's policy, plus those origins as frame-src (one policy per set). */
  const framedHeaders = new Map<string, ReturnType<typeof appPolicy>>();
  const packFrames = (path: string): string[] => {
    const m = /^\/([a-z][a-z0-9-]*)(\/|$)/.exec(path);
    const p = m && packs.on.find((x) => x.manifest.id === m[1] && !!x.frames);
    if (!p) return [];
    let got: unknown;
    try {
      got = p.frames!(ctxOf(p));
    } catch {
      return [];
    }
    return Array.isArray(got) ? [...new Set(got.map(frameOrigin).filter((o): o is string => !!o))].slice(0, 20) : [];
  };
  const withPackFrames: typeof appHeaders = (c, next) => {
    const frames = packFrames(c.req.path);
    if (!frames.length) return appHeaders(c, next);
    const key = frames.join(" ");
    let h = framedHeaders.get(key);
    if (!h) framedHeaders.set(key, (h = appPolicy(frames)));
    return h(c, next);
  };
  // The docks' pages (Bino's, a pack's) are framed by the app's own pages (src/html.ts), and only by them.
  const dockHeaders = secureHeaders({
    referrerPolicy: "same-origin",
    xFrameOptions: "SAMEORIGIN",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc,
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
    },
  });
  /** A dock's page: Bino's, or one under a pack's /<id>/dock when that pack has a dock. */
  const dockPath = (path: string) => {
    const m = /^\/([a-z][a-z0-9-]*)\/dock(\/|$)/.exec(path);
    return !!m && (m[1] === "bino" || packs.on.some((x) => x.manifest.id === m[1] && !!x.dock));
  };
  app.use((c, next) => (dockPath(c.req.path) ? dockHeaders(c, next) : withPackFrames(c, next)));

  /** Exchanges the launch token for a cookie, on localhost only. */
  mountPwa(app, deps.info ?? { version: "dev", startedAt: Date.now() }, { files: env.IS_HOSTED !== "1", on: (href) => pageOn(href) });

  app.get("/login", (c) => {
    if (!isLocal(c.req.raw, publicOrigin) || !sameSecret(c.req.query("tk"), env.LAUNCH_TOKEN)) return c.notFound();
    // Long-lived, so the installed app opens straight to Today; the token stays the gate.
    setCookie(c, COOKIE, env.LAUNCH_TOKEN!, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 400 * 86400, secure: secureCookie(c.req.raw, publicOrigin) });
    // Only this app's own paths: never an open redirect.
    const asked = c.req.query("next") ?? "/";
    const next = /^\/(?![/\\])[\w\-/?=&.%]*$/.test(asked) ? asked : "/";
    // Arriving from another site (the launcher's file:// starting page), a redirect would carry
    // that site along and the SameSite=Strict cookie would stay behind; a page that moves on from
    // here takes it with it.
    if (c.req.header("sec-fetch-site") === "cross-site")
      return c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${next}"><title>Dovre</title><meta name="color-scheme" content="light dark"></head><body></body></html>`);
    return c.redirect(next, 303);
  });

  const hosted = env.IS_HOSTED === "1";
  const openUrl = hosted ? undefined : deps.openUrl;
  // A pack's sign-in return (`callback`), the same way: before the guard, on this machine's own
  // address, never hosted. The pack checks its own one-time state; a hidden pack's is a 404.
  if (!hosted)
    for (const cr of deps.packs?.on ?? []) {
      if (!cr.callback) continue;
      const id = cr.manifest.id;
      app.get(`/${id}/callback`, async (c) => {
        if (!isLocal(c.req.raw, publicOrigin) || !shown().includes(cr)) return c.notFound();
        try {
          const res = await cr.callback!(c, ctxOf(cr), { signedIn: allowed(c.req.raw, env.LAUNCH_TOKEN, publicOrigin) });
          res.headers.set("Cache-Control", "no-store");
          return res;
        } catch (e) {
          packLog(id)(`callback: ${(e as Error)?.message ?? e}`);
          return c.text("That sign-in didn't finish here. Try again from Dovre.", 500);
        }
      });
    }
  // A pack's ingest (dovre#109): apps POST in with a token made on Settings, before the guard.
  mountIngest(app, { packs: deps.packs?.on ?? [], shown: () => shown(), ctxOf: (p) => ctxOf(p), db: () => env.DB, hosted, isLocal: (req) => isLocal(req, publicOrigin), log: (id, line) => packLog(id)(line) });
  // The agent turns' MCP server (dovre#153): a running turn's own token, before the guard, local only.
  // A pack session has no runner: only its own token (deps.mcpTurns, src/run.ts) gets in.
  if ((deps.runner || deps.mcpTurns) && !hosted) {
    const runner = deps.runner;
    mountMcp(app, { shown: () => shown(), ctxOf: (p) => ctxOf(p), turnOf: (t) => runner?.byMcpToken(t) ?? deps.mcpTurns?.(t), hosted, isLocal: (req) => isLocal(req), db: () => env.DB, log: (line) => console.log(line), version: deps.info?.version });
  }
  app.use(async (c, next) => {
    let viewer: string | undefined;
    // Hosted is the Worker's setting, never something a request can claim (src/access.ts).
    if (hosted) {
      const who = deps.access ? await deps.access(c.req.raw) : undefined;
      // A person only: a service token (the Mac's bridge) gets /bridge in the Worker, never a page.
      if (!who?.email) return c.notFound();
      c.set("who", who.email);
      viewer = who.email;
    } else if (!allowed(c.req.raw, env.LAUNCH_TOKEN, publicOrigin)) return c.notFound();
    // Forms only from this app's own origin (its host, or exactly PUBLIC_ORIGIN).
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      const sameHost = () => { try { return new URL(origin!).host === new URL(c.req.url).host; } catch { return false; } };
      if (origin && !sameHost() && !isOwnOrigin(c.req.raw, origin, publicOrigin)) return c.text("Cross-origin form.", 403);
    }
    // A pane that's off isn't here at all.
    const path = c.req.path;
    if (PANE_PATHS.some(([id, re]) => off(id) && re.test(path))) return c.notFound();
    if (forgeHidden(path)) return c.notFound();
    const rest = async () => {
      // What the packs bring up to date before a page is drawn (hosted agents: what the Mac last said); a moment at most, and a page's event stream needs none.
      if (path !== "/events") await beforePages(shown(), ctxOf, (id, line) => packLog(id)(line));
      await next();
    };
    // Hosted, the rest is for this person (src/viewer.ts): what's private to someone shows only to them.
    return hosted ? viewingAs(viewer, rest) : rest();
  });
  // Hosted with no TZ_NAME: the Worker's own zone is UTC, so times follow the browser's zone (its u-tz cookie, set by app.js).
  if (hosted && !env.TZ_NAME?.trim())
    app.use(async (c, next) => {
      const zone = browserZone(getCookie(c, "u-tz"));
      if (zone && zone !== currentTz()) setWhen({ tz: zone });
      await next();
    });

  // Which writes take one click (dovre#104), for the page being drawn: Confirm reads it (src/writes.ts).
  // Every method, not just GET: a POST can answer with a page (a preview, a form redrawn after a 409).
  // The packs' kinds join once they're known (below); a hidden pack's stay listed, so its choice keeps.
  const clicks = writeClicksStore(env.DB, Date.now, () => writeKinds(packs.on));
  const keyPrefs = keyPrefsStore(env.DB);
  app.use(async (c, next) => {
    c.set("clicks", await clicks.get().catch(() => new Map()));
    await next();
  });
  app.get(STYLE_PATH, (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(STYLE);
  });
  // The mark, for notifications.
  app.get("/assets/mark.svg", (c) => {
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "private, max-age=86400");
    return c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -3 34 28" fill="none" stroke="#1d5c88" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><rect x="-2" y="-3" width="34" height="28" rx="6" fill="#e3edf5" stroke="none"/><path d="M1 21 10.5 6.5 15.5 13.5 19.5 8.5 29 21"/><circle cx="23.5" cy="4" r="2.4"/></svg>`);
  });
  app.get(SIDE_PATH, (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "private, max-age=86400");
    return c.body(SIDE_JS);
  });
  app.get(SCRIPT_PATH, (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(SCRIPT);
  });
  app.get(SETUP_JS_PATH, (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(SETUP_JS);
  });

  // ── Packs (src/packs/, PLAN D23): mounted after every core route, each hook isolated ──
  const packs = { env: {}, ...deps.packs, on: [...(deps.packs?.on ?? [])], off: [...(deps.packs?.off ?? [])] };
  const packLog = (id: string) => (line: string) => console.log(`pack ${id}: ${line}`);
  const contexts = new Map<string, PackContext>();
  /** Each pack's questions in the bar, by id (`asking`). */
  const asked = new Map<string, Set<string>>();
  const askedBy = (id: string) => asked.get(id) ?? asked.set(id, new Set()).get(id)!;
  /** What the climb was told, and how far each pack's own setup is (src/onboarding.ts). */
  const onboarding = deps.onboarding ?? onboardingStore(env.DB);
  /** A pack's setup page: the steps its manifest declares, when it draws them (`Pack.setup`). */
  const setupOf = (c: Pack) => (c.setup && typeof c.setup.draw === "function" ? onboardOf(c.manifest) : undefined);
  /** The steps of its setup not done yet (none: it's set up, or has no setup page). */
  const setupLeft = (c: Pack) => {
    const done = new Set(onboarding.get().setup?.[c.manifest.id] ?? []);
    return (setupOf(c)?.steps ?? []).filter((s) => !done.has(s.id));
  };
  /** What each pack may ask the model (#466), loaded in the background; until then, nothing. */
  const aiStore = env.DB ? packAiStore(env.DB) : undefined;
  aiStore?.load().catch((e) => console.log(`packs: can't read AI grants: ${(e as Error).message}`));
  // Packs' agent turns (#467): local only, on this machine's runner, in checkouts under CODE_DIR.
  const agentHost: AgentHost | undefined = hosted ? undefined : (deps.agents ?? (deps.runner && env.CODE_DIR && env.DB ? agentHostOf({ runner: deps.runner, codeDir: env.CODE_DIR, owners: () => ownersIn(env), db: env.DB, ghe }) : undefined));
  /** What a pack asks of the model; a `lands` kind it doesn't list in its `writes` is left out. */
  const aiAsk = (c: Pack): PackAiAsk | undefined => {
    const a = aiAskOf(c.manifest);
    const lands = a?.agent?.lands;
    if (!a?.agent || !lands || (c.writes ?? []).some((w) => w.kind === lands)) return a;
    const { lands: _, ...agent } = a.agent;
    return { ...a, agent };
  };
  const ctxOf = (c: Pack): PackContext => {
    let ctx = contexts.get(c.manifest.id);
    if (!ctx)
      contexts.set(
        c.manifest.id,
        (ctx = {
          env: packs.env,
          bindings: packs.bindings ?? {},
          hosted,
          ...(hosted ? {} : { codeDir: env.CODE_DIR, checkouts: () => (env.CODE_DIR ? checkoutsIn(env.CODE_DIR, deps.session?.checkout) : []), checkout: (name: unknown) => (env.CODE_DIR ? checkoutIn(env.CODE_DIR, name, deps.session?.checkout) : null) }),
          ...(hosted ? {} : programsFor(c.manifest, { dir: packDirOf(env.U_DB, c.manifest.id), checkouts: () => (env.CODE_DIR ? checkoutsIn(env.CODE_DIR, deps.session?.checkout).flatMap((n) => checkoutIn(env.CODE_DIR!, n) ?? []) : []) })),
          db: env.DB,
          logged: loggedFor(c.manifest.id, env.DB, packLog(c.manifest.id)),
          viewer: currentViewer,
          publish: (topics) => deps.hub?.publish(topics),
          snapshot: () => gatherer.peek(),
          gathered: async () => gatherer.peek() ?? (await Promise.race([gatherer.get().catch(() => undefined), new Promise<undefined>((res) => setTimeout(res, 1200))])),
          fill: (name, arg) => fill(name, arg),
          pageOn: (href) => pageOn(href),
          setupDone: () => setupLeft(c).length === 0,
          ...packAiFor({
            id: c.manifest.id,
            ask: aiAsk(c),
            store: aiStore,
            route: hosted ? undefined : deps.ai,
            hosted,
            log: packLog(c.manifest.id),
            agents: agentHost,
            audit: (detail, ok) => void logAction(env.DB, { kind: "packs.agent", target: c.manifest.id, detail, ok }).catch(() => {}),
          }),
          pulse: () => pulseNow(),
          forge: () => {
            const login = gatherer.peek()?.login;
            if (!login) return undefined;
            const owners = ownersIn(env);
            const f = forge;
            return { id: f.id, name: f.name, host: f.host ?? env.GHE_HOST, login, owners, ...(f.work ? { work: (since: string) => f.work!(login, owners, since) } : {}), ...(f.merged ? { merged: (since: string) => f.merged!(login, owners, since) } : {}), ...reads, ...(f.propose ? { propose: proposals(c) } : {}) };
          },
          wasm: (name) => wasmPaths.get(c.manifest.id)?.get(name),
          file: (name) => filePaths.get(c.manifest.id)?.get(name),
          // Only from a pack it requires or uses, while that one is on and shown (#326).
          required: (id, name) => {
            const from = (requiresOf(c.manifest).includes(id) || usesOf(c.manifest).includes(id)) && !hidden(id) ? packs.on.find((p) => p.manifest.id === id) : undefined;
            return from?.shares ? safely(() => from.shares!(ctxOf(from))[name], undefined, (e) => packLog(id)(`shares: ${(e as Error)?.message ?? e}`)) : undefined;
          },
          refs: () => packRefs(),
          startPicture: (svg) => {
            if (typeof svg === "string" && svg.length <= 200_000 && /^\s*<svg[\s>]/.test(svg)) deps.startPicture?.(svg);
          },
          page: async (cx, o) => {
            const { frame } = await page({ path: cx.req.path });
            return cx.html(shell({ title: o.title, frame, current: o.current ?? cx.req.path, body: boxed(o.body, c.manifest.id, c.manifest.name, "page", packLog(c.manifest.id)), head: guardHtml(o.head, c.manifest.name, "page head", packLog(c.manifest.id)) }));
          },
          dockPage: (cx, o) => cx.html(dockShell({ title: o.title, full: `/${c.manifest.id}`, body: boxed(o.body, c.manifest.id, c.manifest.name, "dock", packLog(c.manifest.id)), head: guardHtml(o.head, c.manifest.name, "dock head", packLog(c.manifest.id)), styles: PACK_CSS ? [PACK_CSS.path] : undefined, scripts: packScripts })),
          log: packLog(c.manifest.id),
          ring: (n) => {
            const note = noteFrom(c.manifest.id, n, packRings);
            if (note && deps.notify && rings(deps.notify.policy(), note.kind, startsOff)) deps.notify.ring?.([note]);
          },
          // Its questions go to the bar, as the relay's do (only a person answers there); hosted, none.
          ask: async (q) => {
            if (hosted) return { action: "cancel" as const };
            const mine = askedBy(c.manifest.id);
            let id: string | undefined;
            try {
              return await askInBar(asks, q.from, undefined, undefined, (x) => mine.add((id = x)))(q.message, q.schema);
            } finally {
              if (id) mine.delete(id);
            }
          },
          asking: () => {
            const mine = askedBy(c.manifest.id);
            return mine.size > 0 && asks.list().some((x) => mine.has(x.id));
          },
        }),
      );
    return ctx;
  };
  // A pack may say it can't run here (`available`, after the manifest's checks): it's off, saying so,
  // before anything of it is mounted, styled or asked. One that throws is off too.
  for (const c of [...packs.on]) {
    if (!c.available) continue;
    if (safely(() => c.available!(ctxOf(c)) !== false, false, (e) => packLog(c.manifest.id)(`available: ${(e as Error)?.message ?? e}`))) continue;
    packs.on.splice(packs.on.indexOf(c), 1);
    packs.off.push({ id: c.manifest.id, name: c.manifest.name, why: "can't run here (the pack says so)", manifest: c.manifest });
  }
  // What requires a pack that just went off goes off with it (#326).
  settleRequires(packs);
  // Settings → Layout: packs I've hidden, and packs whose events stay out of the feed (src/layout.ts).
  const layout = deps.layout ?? layoutStore(env.DB);
  /** Switched off on the Packs page, or requires a pack that is (#326). */
  const held = () => heldOff(packs.on, layout.get().packsOff ?? []);
  const hidden = (id: string) => held().has(id);
  const shown = () => packs.on.filter((c) => !hidden(c.manifest.id));
  /**
   * Whether a page answers here (#405): a core path, or one a shown pack holds (its /<id> or a
   * manifest path). Core's links to a page whose pack is off are left out: Today, the g keys, the
   * installed app's shortcuts. Read at request time, once every route is mounted.
   */
  const pageOn = (href: string) => {
    const seg = href.split(/[/?#]/)[1] ?? "";
    return seg === "" || corePaths.has(seg) || shown().some((c) => c.manifest.id === seg || (c.manifest.paths ?? []).includes(seg));
  };
  /** What the first shown pack sharing it shares under a name: core reads packs' contracts by name, never their ids. */
  const shared = <K extends keyof PackShares>(name: K): PackShares[K] | undefined => {
    for (const c of shown()) {
      const one = c.shares ? safely(() => c.shares!(ctxOf(c))[name], undefined, (e) => packLog(c.manifest.id)(`shares: ${(e as Error)?.message ?? e}`)) : undefined;
      if (one) return one;
    }
    return undefined;
  };
  /** My list (`list`, #393): Bino and search read it, never its store. */
  const sharedList = (): ListShare | undefined => shared("list");
  /** The list as search reads it: its items, and where each is shown. */
  const listOf = async (l: ListShare | undefined) => (l ? { items: await l.items().catch(() => []), href: (id: number) => l.href(id) } : undefined);
  // Each pack's styles keep only the rules for its own markup (src/packs/guard.ts): none restyles core.
  const coreClasses = classesOf(STYLE);
  const packCss = packs.on
    .filter((c) => c.styles)
    .map((c) => {
      const { css, dropped } = scopeCss(c.styles!, coreClasses);
      if (dropped.length) packLog(c.manifest.id)(`styles: ${dropped.length} selector${dropped.length === 1 ? "" : "s"} restyle core, left out: ${dropped.slice(0, 5).join(" | ")}`);
      return `/* ${c.manifest.id} */\n${css}`;
    })
    .join("\n");
  const PACK_CSS = packCss ? { path: `/assets/packs.${hashOf(packCss)}.css`, body: packCss } : undefined;
  // Their scripts (`script`): one file after the core's, each pack's in a block of its own.
  // One that listens to every change itself rather than through dovreOn isn't served: each change
  // reaches every open tab, and a script asking the server on each one multiplied the Worker's requests.
  const quiet = (c: Pack) => {
    if (!RAW_CHANGE.test(c.script!)) return true;
    console.log(`pack ${c.manifest.id}: its script listens to dovre:change itself; not served (use dovreOn)`);
    return false;
  };
  // A file each, its body in a try: one pack's syntax error or throw stops only that pack's script.
  const PACK_JS = packs.on
    .filter((c) => c.script && quiet(c))
    .map((c) => {
      const body = scriptOf(c.manifest.id, c.script!, Object.fromEntries(filePaths.get(c.manifest.id) ?? []));
      return { path: `/assets/pack.${c.manifest.id}.${hashOf(body)}.js`, body };
    });
  const packScripts = PACK_JS.length ? PACK_JS.map((j) => j.path) : undefined;
  const packNav = () => shown().flatMap((c) => (c.nav ? safely(() => c.nav!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`nav: ${(e as Error)?.message ?? e}`)) : []));
  const packFeed = () =>
    packFeedOf(
      shown().filter((c) => !layout.get().feedOff?.includes(c.manifest.id)).flatMap((c) => (c.feed ? safely(() => c.feed!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`feed: ${(e as Error)?.message ?? e}`)).map((item) => ({ pack: c.manifest, item })) : [])),
      Date.now(),
    );
  // What each pack says Bino may know. A pack that says nothing gets what it already shows on Today
  // (defaultBinoOf), unless it's private. Packs that speak for themselves come first.
  const packBino = () => {
    const tried = <T,>(c: Pack, hook: string, f: () => T, none: T): T => safely(f, none, (e) => packLog(c.manifest.id)(`${hook}: ${(e as Error)?.message ?? e}`));
    const said: { name: string; own?: boolean; text: unknown }[] = [];
    const told: typeof said = [];
    for (const c of shown()) {
      const ctx = ctxOf(c);
      const own = packs.core?.includes(c.manifest.id);
      if (c.bino) said.push({ name: c.manifest.name, own, text: tried(c, "bino", () => c.bino!(ctx), "") });
      else if (!c.manifest.private) {
        const pulse = c.pulse;
        const text = defaultBinoOf({
          glance: c.glance ? tried(c, "glance", () => c.glance!(ctx), []) : [],
          needs: c.needs ? tried(c, "needs", () => c.needs!(ctx), []) : [],
          pulse: pulse ? tried(c, "pulse", () => pulse.call(c, ctx), undefined) : undefined,
          feed: c.feed ? tried(c, "feed", () => c.feed!(ctx), []) : [],
        });
        told.push({ name: c.manifest.name, own, text });
      }
    }
    return appsOf([...said, ...told]);
  };
  // Core pages' named places (types.ts SlotMap): what each shown pack puts there.
  const fill = fillOf(shown, ctxOf, (id, line) => packLog(id)(line));
  /** A PR's or deploy's summary, from the pack that writes them ("ai.summary"): only its own shape is drawn. */
  const summary = (key: string): AiSummary | undefined => fill("ai.summary", { key }).find((x): x is AiSummary => !!x && (x.state === "pending" || (x.state === "ready" && typeof x.text === "string") || (x.state === "failed" && typeof x.error === "string")));
  /** What the packs call an actions-log entry of theirs (a name for an id). */
  const packWhere = (a: { kind: string; target: string }) => whereFrom(fill, a);
  const packWhat = (kind: string) => whatFrom(fill, kind);
  /** What Bino may propose that the packs carry out (`acts`): local only, as Bino's own are. */
  const packActs = () => (hosted ? [] : actsFrom(shown(), ctxOf, (id, line) => packLog(id)(line)));
  /** What Bino may look up in the packs' apps (`lookups`), here and hosted. */
  const packLookups = () => lookupsFrom(shown(), ctxOf, (id, line) => packLog(id)(line));
  /** One lookup, logged as `<pack>.lookup`: its kind and the fields' names, never what came back. */
  const runLookup = async (l: { kind: string; args: Record<string, string> }): Promise<{ text: string; error?: boolean }> => {
    const k = packLookups().find((x) => x.kind === l.kind);
    if (!k) return { text: "That app isn't on here now.", error: true };
    const args = Object.fromEntries(k.fields.flatMap((f) => (typeof l.args?.[f.name] === "string" && l.args[f.name] ? [[f.name, l.args[f.name]!.slice(0, f.max)]] : [])));
    const got = await k.run(args);
    await logAction(env.DB, { kind: `${k.pack}.lookup`, target: k.kind, detail: Object.keys(args).length ? `by ${Object.keys(args).join(", ")}` : undefined, ok: !got.error }).catch(() => {});
    return got;
  };
  const packPages = () => shown().flatMap((c) => (c.pages ? safely(() => c.pages!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`pages: ${(e as Error)?.message ?? e}`)) : []));
  /** The packs' things for search, each named after its pack; an href that isn't a path here or http(s) is dropped. */
  /** The packs' rows for search: under "In your apps" named after the pack, or in one of search's own groups by `kind`. */
  const packFinds = () => {
    const out = { apps: [] as SearchRow[], agents: [] as SearchRow[], code: [] as SearchRow[], actions: [] as SearchRow[] };
    for (const c of shown()) {
      if (!c.finds) continue;
      for (const f of safely(() => c.finds!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`finds: ${(e as Error)?.message ?? e}`)).slice(0, 500)) {
        if (!f || typeof f.title !== "string" || typeof f.href !== "string" || safeUrl(f.href) === "#") continue;
        const kind = f.kind === "agents" || f.kind === "code" || f.kind === "actions" ? f.kind : undefined;
        const sub = kind ? f.sub : [c.manifest.name, f.sub].filter(Boolean).join(" · ");
        out[kind ?? "apps"].push({ title: f.title.slice(0, 200), sub: typeof sub === "string" ? sub.slice(0, 200) : undefined, href: safeUrl(f.href), icon: (kind && typeof f.icon === "string" && [...f.icon].slice(0, 2).join("")) || "◇", also: (Array.isArray(f.also) ? f.also : []).slice(0, 10).map((a) => String(a).slice(0, 100)), out: /^https?:/.test(f.href) });
      }
    }
    return out;
  };
  /** The packs' kinds of reference (a ticket key…), for links in My list and deploys. */
  const packRefs = () => shown().flatMap((c) => (c.refs ? safely(() => c.refs!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`refs: ${(e as Error)?.message ?? e}`)) : []));
  const packCards = (): Promise<{ cards: TodayCard[]; failed: Off[] }> => todayCards(shown(), ctxOf, packs.budgetMs ?? 250, (id, line) => packLog(id)(line));
  /** The packs' kinds of notification (Settings), and what they say needs me (rung once per key by the composition root). */
  const packRings = ringsOf(packs.on, RING_KINDS.map((k) => k.kind), (id, line) => packLog(id)(line));
  /** The packs' kinds that are off until I switch them on. */
  const startsOff = new Set(packRings.filter((r) => r.off).map((r) => r.kind));
  const packNeeds = () => needsFrom(shown(), ctxOf, packRings, (id, line) => packLog(id)(line));
  const refreshes = refreshLog(() => deps.hub?.publish(["packs"]));
  // Hosted (#362): newer releases of the packs bundled here, from dovre-packs' tags on GitHub.
  // github.com goes through the forge's token; a forge on another host reads anonymously (dovre-packs is public).
  /** Every pack id this instance lists, on or off, Dovre's own too. */
  const packIds = () => [...new Set([...packs.on.map((p) => p.manifest.id), ...packs.off.map((o) => o.id), ...(packs.core ?? [])])];
  const packsGet: GetJson = /^(api\.)?github\.com$/i.test(ghe.host.trim())
    ? (path) => ghe.rest(path)
    : async (path) => {
        const r = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "dovre" } });
        if (!r.ok) throw new Error(`GitHub ${r.status} for ${path.split("?")[0]}`);
        return r.json();
      };
  /** Hosted (#88): the instance repo Add opens its PR on, when it's set and one of the owners'. */
  const instanceRepo = () => (hosted ? repoIn(ownersIn(env), env.INSTANCE_REPO?.trim()) : null);
  /** Hosted Adds started in this isolate and not logged yet. */
  const opening = new Set<string>();
  const releases = hosted
    ? createReleases({
        get: packsGet,
        packs: () => [...packs.on.map((p) => ({ id: p.manifest.id, version: p.manifest.version })), ...packs.off.map((o) => ({ id: o.id, version: o.manifest?.version }))].filter((p) => !packs.core?.includes(p.id)),
        here: () => packIds(),
        onChange: () => deps.hub?.publish(["packs"]),
      })
    : undefined;
  /** When each pack's keys were last read again after a failed refresh (#416): once in 10 minutes at most. */
  const keysAgainAt = new Map<string, number>();
  const keysAgain = (p: Pack) => {
    const id = p.manifest.id;
    const ks = packs.keys && manifestSettings(p.manifest).filter((s) => s.secret && packs.keys!.state(s.key)).map((s) => s.key);
    if (!ks?.length || Date.now() - (keysAgainAt.get(id) ?? 0) < 600_000) return;
    keysAgainAt.set(id, Date.now());
    void packs.keys!.read(ks).then((changed) => (changed ? settleSettings(id).then(() => deps.hub?.publish([id, "packs"])) : undefined)).catch(() => {});
  };
  const runPackRefresh = refresher(packs.on, ctxOf, (l) => console.log(l), { record: refreshes, skip: hidden, failed: keysAgain });
  const keysRead = async () => {
    const ids = [...packs.on.map((p) => p.manifest), ...packs.off.map((o) => o.manifest)].filter((m) => m && manifestSettings(m).some((s) => s.secret && packs.keys?.state(s.key))).map((m) => m!.id);
    for (const id of ids) await settleSettings(id);
    if (ids.length) deps.hub?.publish(["packs", "snapshot", ...ids]);
  };
  /** How things are across the shown packs (`pulse`); a pack reading it from its own `pulse` gets nothing back. */
  let pulsing = false;
  const pulseNow = (): Pulse => {
    if (pulsing) return { working: 0, asking: 0, trouble: [], busy: false };
    pulsing = true;
    try {
      const a = pulseFrom(shown(), ctxOf, (id, line) => packLog(id)(line));
      return { ...a, busy: a.working > 0 || !!engine?.list().some((x) => x.thinking) };
    } finally {
      pulsing = false;
    }
  };
  appPacks.set(app, { on: packs.on, off: packs.off, ctxOf, refreshes, hidden, needs: packNeeds, startsOff, linked: () => linkedFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), lookups: { specs: () => packLookups().map(({ run: _r, pack: _p, ...spec }) => spec), run: runLookup }, pageOn: (href) => pageOn(href), keysRead, keysAgain });
  if (PACK_CSS)
    app.get(PACK_CSS.path, (c) => {
      c.header("Content-Type", "text/css; charset=utf-8");
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.body(PACK_CSS.body);
    });
  const assets = deps.packs?.bindings?.ASSETS as { fetch(req: Request): Promise<Response> } | undefined;
  for (const [path, mod] of served) {
    // A file's bytes, once: locally from its load (checked), hosted from the static assets.
    let read: Promise<Uint8Array | ReadableStream | null> | undefined;
    const bytes = (url: string): Promise<Uint8Array | ReadableStream | null> => {
      if ("bytes" in mod) return Promise.resolve(mod.bytes);
      if (env.IS_HOSTED === "1") {
        if (!assets) return Promise.resolve(null);
        return assets.fetch(new Request(new URL(path.slice("/assets".length), url))).then((r) => (r.ok ? r.body : null));
      }
      return (read ??= (async () => {
        try {
          const b = await mod.file.load();
          const why = await mod.why(b, mod.file.sha256);
          if (!why) return b as Uint8Array;
          console.log(`pack ${mod.pack}: ${mod.what} ${why}; not served`);
        } catch (e) {
          console.log(`pack ${mod.pack}: ${mod.what} didn't load: ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
        return null;
      })());
    };
    app.get(path, async (c) => {
      const b = await bytes(c.req.url);
      if (!b) return c.notFound();
      c.header("Content-Type", mod.type);
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.body(b as Uint8Array<ArrayBuffer>);
    });
  }
  for (const js of PACK_JS)
    app.get(js.path, (c) => {
      c.header("Content-Type", "text/javascript; charset=utf-8");
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.body(js.body);
    });

  /**
   * The snapshot a page draws from, and its frame. With nothing gathered yet (the very first
   * start), a page waits a little, then shows "Gathering…" and swaps itself in when it lands.
   */
  /** Every page's frame: menu, docks, styles, sync state. */
  /** Bino answers, and its pack is on (a pack switched off on Packs takes Bino with it, #271). */
  const binoOn = () => !!bino?.route.ready && !!assistant && packs.on.includes(assistant) && !hidden("assistant");
  const fullFrame = (s: Snapshot, path = ""): Frame => ({ operator: s.login, look: { theme: layout.get().theme, accent: layout.get().accent, font: layout.get().font, textSize: layout.get().textSize, lineHeight: layout.get().lineHeight, binoIcon: layout.get().binoButton === "icon", motion: layout.get().motion, links: openUrl && layout.get().links === "default" ? "default" : undefined }, styles: PACK_CSS ? [PACK_CSS.path] : undefined, scripts: packScripts, nav: withTabs([...navOf(s, { hosted: env.IS_HOSTED === "1", bino: binoOn(), stats: statsOn(), packs: packs.on.length + packs.off.length > 0 }), ...packNav()], layout.get().tabs), syncedAt: s.at, syncing: gatherer.gathering() && Date.now() - s.at > 120_000, host: env.GHE_HOST, asks: asks.list(), docks: docksFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), bino: binoOn(), face: (o) => fill("bino.face", o)[0] ?? "", banners: bannersFrom(shown(), ctxOf, path, (id, line) => packLog(id)(line)), tz: env.TZ_NAME ? validZone(env.TZ_NAME) : currentTz(), tzAuto: hosted && !env.TZ_NAME?.trim() ? true : undefined, greeting: greetingLang(env.GREETING), live: deps.live ? "ws" : undefined, goOff: Object.keys(GO_KEYS).filter((k) => !pageOn(GO_KEYS[k]!)) });
  // A pack session's frame: the pack's own menu entries, nothing of the cockpit's (no Bino, docks, questions or bars).
  // On or off: a pack waiting for its settings is still the session's (#369).
  const sessionManifest = () => (deps.session ? (packs.on.find((x) => x.manifest.id === deps.session!.pack)?.manifest ?? packs.off.find((x) => x.id === deps.session!.pack)?.manifest) : undefined);
  const frameOf = (s: Snapshot, path = ""): Frame => {
    const f = fullFrame(s, path);
    const m = sessionManifest();
    if (!m) return f;
    const own = `/settings/packs/${encodeURIComponent(m.id)}`;
    const on = packs.on.find((x) => x.manifest.id === m.id);
    const nav = [...packNav(), ...(manifestSettings(m).length || on?.settings ? [{ href: own, title: "Settings", icon: "gear" as const }] : [])];
    return { ...f, nav, bino: false, docks: [], asks: [], banners: [], session: { name: m.name, home: on ? (packNav()[0]?.href ?? `/${m.id}`) : own } };
  };

  const page = async (o: { wait?: boolean; /** The page's path: a pack's bar may leave its own page out. */ path?: string } = {}): Promise<{ s: Snapshot; frame: Frame }> => {
    const t0 = performance.now();
    await Promise.all([layout.ready, onboarding.ready]);
    const got = gatherer.peek() ? await gatherer.get({ wait: o.wait }) : await Promise.race([gatherer.get(), new Promise<undefined>((res) => setTimeout(res, 1200))]);
    const waited = performance.now() - t0;
    if (waited >= 1) tryGetContext<AppEnv>()?.set(WAITED, (tryGetContext<AppEnv>()?.get(WAITED) ?? 0) + waited);
    if (!got) throw new Pending();
    const keys = await keyPrefs.get(currentViewer()).catch(() => undefined);
    return { s: got, frame: { ...frameOf(got, o.path ?? tryGetContext()?.req.path), keys } };
  };

  app.get("/", async (c) => {
    if (c.req.query("fresh") === "1") {
      gatherer.stale();
      return c.redirect("/", 303);
    }
    if ((deps.config || hosted) && !deps.session) {
      await onboarding.ready;
      // Not read yet (a slow or stuck read): Today, rather than the climb for someone already past it.
      if (onboarding.loaded?.() !== false && !setUp()) return c.redirect("/welcome", 303);
    }
    const { s, frame } = await page();
    const actions = actionsCard(await recentActions(env.DB, 6), packWhere, packWhat);
    const packToday = packs.on.length ? await packCards() : undefined;
    // The packs whose own setup isn't finished (#418): Today keeps a row for each until it is.
    const setups = shown().flatMap((x): SetupRow[] => {
      const ob = setupOf(x);
      const left = setupLeft(x);
      return ob && left.length ? [{ id: x.manifest.id, name: x.manifest.name, what: left[0]!.title, left: left.length, steps: ob.steps.length, required: ob.required }] : [];
    });
    return c.html(homePage(frame, s, summary, { setup: setupStrip(setups), cards: layout.get().cards, packs: packToday, apps: briefingFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), own: packs.core, on: pageOn, feed: { events: packFeed(), only: env.IS_HOSTED === "1" }, topics: shown().map((c) => c.manifest.id), hero: fill("today.hero", {})[0], ghe: env.GHE_HOST, forge, rules: packRefs(), agent: agentOf, actions }));
  });
  /** Everything Dovre did for me, newest first (the card on Today shows the newest few). */
  app.get("/actions", async (c) => {
    const { frame } = await page();
    return c.html(actionsPage(frame, await recentActions(env.DB, 200), packWhere, packWhat));
  });
  // ── Live updates: one event stream per open page (src/live.ts) ──
  app.get("/events", (c) =>
    deps.events
      ? deps.events()
      : streamSSE(c, async (stream) => {
      if (!deps.hub) return;
      let open = true;
      const send = (topics: string[], at: number) => {
        void stream.writeSSE({ event: "change", data: JSON.stringify({ topics, at, synced: lastSynced, notes }) }).catch(() => (open = false));
      };
      let notes: unknown;
      let lastSynced = (await gatherer.get()).at;
      const off = deps.hub.subscribe((ch) => {
        const go = () => {
          notes = ch.notes;
          send(ch.topics, ch.at);
        };
        if (ch.topics.includes("snapshot")) void gatherer.get().then((s) => { lastSynced = s.at; go(); });
        else go();
      }, { notifies: c.req.query("notify") === "1" });
      stream.onAbort(() => {
        open = false;
        off();
      });
      while (open) {
        await stream.writeSSE({ event: "ping", data: "" }).catch(() => (open = false));
        await stream.sleep(20_000);
      }
      off();
    }),
  );
  /** Gather everything now, then back where I was. */
  app.post("/refresh", async (c) => {
    // Gathers in the background; the page swaps itself when it lands (and the next load waits a moment for it).
    gatherer.stale();
    const back = c.req.header("referer");
    const path = back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname : "/";
    return c.redirect(path, 303);
  });

  // ── Talking to agents: the desk (src/agents/desk.ts), this machine's or, hosted, the Mac's ──
  /** What the packs put on each PR card ("pr.agent": agent reviews). */
  const agentOf = (p: PrSlotArg): Html | "" => {
    const out = fill("pr.agent", p).filter((x) => x !== "");
    return out.length ? html`${out}` : "";
  };
  /** What a live response showed isn't kept by the browser either. */
  const noStore = (res: Response) => (res.headers.set("Cache-Control", "no-store"), res);

  // ── Search (src/search/search.ts): /search as a page; with frag=1, just the list the palette swaps in ──
  const gheSearch = createGheSearch(ghe, ownersIn(env), { viewer: () => can("viewer") && pageOn("/prs") });
  // ── Stats: the packs' panels (Pack.stats), from memory; each pack gathers on its own ──
  /** The packs' panels for /stats, over the weeks I picked (Settings → Layout). */
  // Days touch at most five weeks: that's what a pack drawing weekly gets.
  const packStats = () => {
    const l = layout.get();
    return statsFrom(shown(), ctxOf, l.statsDays ? Math.ceil(l.statsDays / 7) + 1 : (l.statsWeeks ?? WEEKS), (id, line) => packLog(id)(line), l.statsDays);
  };
  const statsPacks = () => shown().filter((p) => p.stats);
  app.get("/stats", async (c) => {
    if (!statsOn()) return c.notFound();
    const { frame } = await page();
    return c.html(statsPage(frame, { packs: packStats(), layout: layout.get(), gather: statsPacks().some((p) => p.refresh) }));
  });
  // Gather again: each pack on /stats reads again now, told I asked (Pack.refresh's `asked`).
  app.post("/stats/refresh", async (c) => {
    if (!statsOn()) return c.notFound();
    for (const p of statsPacks()) void runPackRefresh.one(p, { asked: true });
    return c.redirect("/stats", 303);
  });

  app.get("/search", async (c) => {
    const { s, frame } = await page();
    const raw = (c.req.query("q") ?? "").slice(0, 200);
    const pages = pagesOf({ bino: binoOn(), stats: statsOn() }).concat(packs.on.length + packs.off.length ? [{ title: "Packs", href: "/packs", icon: "▦", about: "This instance's apps: on or off here and why, refreshes, settings", also: ["apps", "plugins", "modules", "manifest"] }] : [], packPages(), settingsAreas().map((id) => { const a = AREAS.find((x) => x.id === id)!; return { title: `Settings: ${a.title}`, href: `/settings/${id}`, icon: "⚙", about: a.about, also: ["settings", ...a.also] }; }));
    // GHE's own search too: on the page, and in the palette once typing pauses (remote=1). At most 3.5 s.
    const parsed = parseQuery(raw, c.req.query("only"));
    const remote = (c.req.query("frag") !== "1" || c.req.query("remote") === "1") && can("search") && (!parsed.only || parsed.only === "issues") ? await Promise.race([gheSearch(parsed.q).catch(() => []), new Promise<[]>((res) => setTimeout(() => res([]), 3500))]) : [];
    const found = packFinds();
    const r = search({ s, deploys: pageOn("/deploys"), hidden: forgeHidden, viewer: can("viewer") && pageOn("/prs"), list: await listOf(sharedList()), repos: listRepos(env.CODE_DIR), pages, apps: found.apps, kinds: found, remote }, raw, { only: c.req.query("only"), per: c.req.query("frag") === "1" ? undefined : 10 });
    if (c.req.query("frag") === "1") return noStore(await c.html(html`${searchList(r)}`));
    return c.html(searchPage(frame, r, raw));
  });

  // ── The code explorer (src/pages/code.ts; local only). PRs and their viewer are the prs pack's (#409). ──
  app.route("/", createCodeRoutes(env, { ghe, frame: async () => (await page()).frame }));


  // The installed app's links to other sites, in the default browser (Settings → Layout): only
  // from this app's own pages, only a web address, and only while the setting is on.
  app.post("/open-link", strictOrigin, async (c) => {
    if (!openUrl || layout.get().links !== "default") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    const href = webUrl(body?.url);
    if (!href) return c.text("Only a web address (http or https) opens here.", 400);
    try {
      openUrl(href);
    } catch {
      return c.text("The default browser didn't open.", 500);
    }
    return c.body(null, 204);
  });
  /** Investigate (#214): what a pack handed on, to send to Bino or a new agent session. */
  app.get("/investigate", async (c) => {
    const { frame } = await page();
    const v = investigateOf({ prompt: c.req.query("prompt"), repo: c.req.query("repo"), from: c.req.query("from") });
    return c.html(investigatePage(frame, v, { bino: binoOn(), agent: shared("agent") }));
  });
  const { keep, settleSettings, settingsAreas, restarting } = settingsRoutes(app, { publicOrigin, refreshes, env, deps, hosted, packs, ctxOf, packLog, shown, layout, onboarding, page, noStore, setupOf, setupLeft, speed, ghe, forge, clicks, aiStore, keyPrefs, openUrl, held, hidden, packIds, packCards, packRings, packStats, runPackRefresh, instanceRepo, opening, releases, packsGet });
  const { setUp } = welcomeRoutes(app, { env, deps, hosted, packs, ctxOf, packLog, shown, layout, onboarding, page, noStore, keep, restarting, setupOf, setupLeft });

  // ── Report a bug (#384): to the repo behind the page it came from ──
  const packHomeOf = (seg: string) => {
    const p = (deps.packs?.on ?? []).find((x) => x.manifest.id === seg || (x.manifest.paths ?? []).includes(seg));
    if (!p) return undefined;
    const id = p.manifest.id;
    const source = hosted ? undefined : deps.packs?.copies?.get().get(id)?.source;
    const home = deps.packs?.core?.includes(id) ? "core" : source ? (source.toLowerCase() === PACKS_HOME ? "packs" : "instance") : hosted && p.manifest.version ? "packs" : "instance";
    return { id, name: p.manifest.name, home } as const;
  };
  app.route("/", createBugRoutes({ ghe, db: env.DB, owners: () => ownersIn(env), frame: async () => (await page()).frame, packOf: packHomeOf, instance: () => env.INSTANCE_REPO?.trim().match(/^[\w.-]+\/[\w.-]+$/)?.[0] ?? null, version: deps.info?.version ?? "dev", hosted }));
  // Bino's pages are its pack's (src/packs/core/assistant/): core hands that pack the engine and what its pages read.
  if (bino && assistant)
    hostAssistant(assistant, {
      bino,
      list: sharedList,
      frame: async () => (await page()).frame,
      org: env.GHE_ORG,
      packAct: (kind) => packActs().find((k) => k.kind === kind),
      assets: { styles: PACK_CSS ? [PACK_CSS.path] : undefined, scripts: packScripts },
      // The object hosted has no packs or list of its own: what Bino knows goes with each message.
      context: engine ? undefined : binoContext,
      apps: () =>
        packs.on.map((c) => ({
          id: c.manifest.id,
          name: c.manifest.name,
          paths: c.manifest.paths,
          own: packs.core?.includes(c.manifest.id),
          private: c.manifest.private === true,
          about: c.about
            ? async (path: string) => {
                try {
                  return await c.about!(ctxOf(c), path);
                } catch (e) {
                  packLog(c.manifest.id)(`about: ${(e as Error)?.message ?? e}`);
                  return undefined;
                }
              }
            : undefined,
          needs: c.needs ? () => safely(() => c.needs!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`needs: ${(e as Error)?.message ?? e}`)) : undefined,
        })),
    });

  relayRoutes(app, { env, deps, asks, perfLog, speed });

  // Packs' routes last, each under its own /<id> on its own sub-app: none can shadow a core route,
  // another pack's, or add middleware in front of anything but its own paths.
  // (A pack's /<id>/callback and /<id>/ingest/*, mounted before the guard above, are its own, not the core's.)
  const callbacks = new Set([
    ...(deps.packs?.on ?? []).filter((x) => x.callback).map((x) => `/${x.manifest.id}/callback`),
    ...(deps.packs?.on ?? []).filter((x) => x.ingest).map((x) => `/${x.manifest.id}/ingest/*`),
  ]);
  const corePaths = new Set(app.routes.filter((r) => !callbacks.has(r.path)).map((r) => r.path.split("/")[1]));
  /** Top-level paths a pack already holds: none may take another's. */
  const claimed = new Set<string>();
  const mountedIds = new Set<string>();
  const mountPackRoutes = (c: Pack, isOff = false): boolean => {
    const id = c.manifest.id;
    if (mountedIds.has(id) || !c.routes) return true;
    // Its own /<id>, and any other top-level paths its manifest claims (agents: /worktrees).
    const owned = [id, ...(c.manifest.paths ?? [])];
    const sub = new Hono<AppEnv>();
    try {
      c.routes(sub, ctxOf(c));
    } catch (e) {
      if (!isOff) packs.off.push({ id, name: c.manifest.name, why: `its routes threw: ${(e as Error)?.message ?? e}`, manifest: c.manifest });
      return false;
    }
    const odd = owned.find((p) => !/^[a-z][a-z0-9-]{0,31}$/.test(String(p)));
    const taken = owned.find((p) => corePaths.has(p) || claimed.has(p));
    const outside = sub.routes.find((r) => !owned.some((p) => r.path === `/${p}` || r.path.startsWith(`/${p}/`)));
    if (odd || taken || outside) {
      const why = odd !== undefined ? `path ${String(odd).slice(0, 40)} isn't a lowercase word` : taken ? `/${taken} is a core path or another pack's` : `route ${outside!.path} isn't under /${owned.join(", /")}`;
      if (!isOff) packs.off.push({ id, name: c.manifest.name, why, manifest: c.manifest });
      return false;
    }
    for (const p of owned) claimed.add(p);
    mountedIds.add(id);
    // A page of its that throws, or doesn't answer in time, is that pack's broken page in the shell, not Dovre's.
    const brokePage = async (cx: Context<AppEnv>, why: string) => {
      packLog(id)(`${cx.req.method} ${cx.req.path}: ${why}`);
      const body = html`${PageHeader({ title: c.manifest.name })}${Notice({ tone: "bad", children: html`<p><strong>${c.manifest.name} broke on this page.</strong> The rest of Dovre is fine. The pack's log on the <a href="/packs">Packs</a> page says what happened. <a href="${bugHref(cx.req.path, why, id)}">Report this</a> if it looks like a bug.</p><p class="mono t3">${why.slice(0, 300)}</p>` })}`;
      try {
        const res = await ctxOf(c).page(cx, { title: c.manifest.name, body });
        return new Response(res.body, { status: 500, headers: res.headers });
      } catch {
        return cx.text(`${c.manifest.name} broke on this page: ${why.slice(0, 300)}`, 500);
      }
    };
    sub.onError((err, cx) => (err instanceof Pending ? Promise.reject(err) : brokePage(cx, String((err as Error)?.message ?? err))));
    // Hidden in Settings → Layout or switched off: its pages answer 404 until it's on and shown again.
    const gate = async (cx: Context<AppEnv>, next: () => Promise<void>) => {
      if (hidden(id) || !packs.on.includes(c)) return cx.notFound();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ms = packs.routeMs ?? PACK_ROUTE_MS;
      const late = new Promise<"late">((res) => (timer = setTimeout(() => res("late"), ms)));
      try {
        if ((await Promise.race([next(), late])) === "late") cx.res = await brokePage(cx, `didn't answer in ${ms / 1000} s`);
      } finally {
        clearTimeout(timer);
      }
    };
    for (const p of owned) {
      app.use(`/${p}`, gate);
      app.use(`/${p}/*`, gate);
    }
    app.route("/", sub);
    return true;
  };
  for (const c of [...packs.on]) {
    if (!mountPackRoutes(c)) packs.on.splice(packs.on.indexOf(c), 1);
  }
  settleRequires(packs);
  for (const o of packs.off) {
    if (o.pack && !mountPackRoutes(o.pack, true)) delete o.pack;
  }

  app.notFound((c) => c.text("Not found", 404));
  app.onError((err, c) => {
    if (err instanceof Pending) return c.html(pendingPage(new URL(c.req.url).pathname, { ...frameOf({ ...EMPTY, login: env.GITHUB_USER ?? "" }), syncedAt: undefined, syncing: false }));
    console.error(err);
    const why = String(err?.message ?? err).slice(0, 300);
    return c.html(html`<!doctype html><meta charset="utf-8"><title>Something broke · Dovre</title><p>Something broke: ${why}</p><p><a href="${bugHref(new URL(c.req.url).pathname, why)}">Report this bug</a> · <a href="/">Today</a></p>`, 500);
  });
  return app;
}

/** The bug page, filled in from an error page (#384): the page, what broke, the pack if it's one's. */
export const bugHref = (path: string, why: string, pack?: string) => safeUrl(`/bug?${new URLSearchParams({ from: path.slice(0, 300), error: why.slice(0, 600), ...(pack ? { pack } : {}) })}`);

/** A pack's `frames` entry as a CSP source: an `https://` origin, or `http://localhost:<port>` / `http://127.0.0.1:<port>` (no path, user or wildcard); else undefined. */
export function frameOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 300) return undefined;
  try {
    const u = new URL(raw);
    if (u.username || u.password || !/^[a-z0-9.-]+(:\d+)?$/i.test(u.host)) return undefined;
    // http only for this machine on a port of its own (a build served apart from Dovre, #166).
    if (u.protocol === "http:" ? !/^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !u.port : u.protocol !== "https:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}
