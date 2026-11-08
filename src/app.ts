/**
 * Dovre: the view from the top (PLAN.md). Local only: every route needs the launch-token
 * cookie on a localhost Host; anything else is a 404, as if nothing were here.
 */
import { checkoutIn, checkoutsIn } from "./packs/checkouts.ts";
import { ownersIn } from "./owners.ts";
import { d1Reads, packReads } from "./sources/files.ts";
import { packProposals } from "./actions/propose.ts";
import { resolve } from "node:path";
import { slowLog } from "./slow.ts";
import { createSpeed, routeOk, type Speed, speedLog, WAITED } from "./speed.ts";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { contextStorage, tryGetContext } from "hono/context-storage";
import { secureHeaders } from "hono/secure-headers";
import { type AccessVerifier, COOKIE, allowed, isLocal, isOwnOrigin, publicOriginOf, sameSecret, secureCookie } from "./access.ts";
import { actionsOf, logAction, recentActions, repoIn, runId } from "./actions/deploys.ts";
import { proposeAdd } from "./actions/addpack.ts";
import type { App, AppEnv, Env } from "./env.ts";
import type { Gatherer, Snapshot } from "./gather.ts";
import { type Need, needsOf } from "./home/needs.ts";
import { dockShell, type Frame, html, type NavItem, SIDE_JS, SIDE_PATH, shell, tabsOf } from "./html.ts";
import { CORE_CARDS, packOrder, homePage } from "./pages/home.ts";
import { currentGreeting, currentTz, greetingLang, setWhen, validZone } from "./when.ts";
import type { Ghe } from "./sources/ghe.ts";
import { githubForge } from "./forge/github.ts";
import { type Forge, type ForgeCan, forgeCan } from "./forge/types.ts";
import { streamSSE } from "hono/streaming";
import type { Hub } from "./live.ts";
import type { Run } from "./agents/runner.ts";
import type { Runner } from "./agents/runner.ts";
import { SID, findSession, modelOf } from "./agents/desk.ts";
import { statOffers, statsPage, WEEKS } from "./pages/stats.ts";
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
import { AREAS, type AgentToolsView, agentToolsPanel, appPanel, longTurnPanel, type AreaId, edgePath, isArea, notifyPanels, type PackSettings, packsList, type SettingsNotes, type SetupLine, sessionSettings, settingRows, settingsArea, settingsHome, setupLines, setupPanel, workPanel } from "./pages/settings.ts";
import { callsPanels } from "./pages/calls.ts";
import { speedPanels } from "./pages/speed.ts";
import { sentPanels, type SentView } from "./pages/sent.ts";
import { CATALOG } from "./sent.ts";
import { TOOLS_HARNESSES, type ToolsHarness } from "./agents/mcpsetup.ts";
import { type ClimbField, type ClimbView, climbPage, type KitTile, startingPage } from "./pages/welcome.ts";
import { type SetupRow, setupPage, setupStrip, type SetupView } from "./pages/setup.ts";
import { FORGES, answersFrom, type OnboardingStore, onboardingStore } from "./onboarding.ts";
import { type Answers, INTERVIEW, markersOf, onboardOf, QUESTIONS, ROLES, suggest } from "./packs/suggest.ts";
import { scanCheckouts } from "./packs/scan.ts";
import { STEPS, type Step } from "./ui/climb.ts";
import { type Config, configFromForm, type PaneId, type PanesOn, type PaneState, saveConfig } from "./config.ts";
import { fixedKeys } from "./env.ts";
import { found } from "./tools.ts";
import { mountPwa } from "./pwa.ts";
import { type Html, Notice, PageHeader, Panel } from "./ui/kit.ts";
import { writeClicksStore, writeKinds } from "./writes.ts";
import { writesPanel } from "./pages/writes.ts";
import { mountMcp } from "./mcp.ts";
import { mountIngest, tokensPanel, createToken, listTokens, revokeToken, sourceOk } from "./packs/ingest.ts";
import { actsFrom, lookupsFrom, beforePages, bannersFrom, briefingFrom, docksFrom, fillOf, settingsFrom, whatFrom, whereFrom, linkedFrom, needsFrom, noteFrom, type Off, statsFrom, pulseFrom, type Refreshes, refresher, refreshLog, ringsOf, safely, settleRequires, missingWhy, heldOff, requiresOf, todayCards, usesOf } from "./packs/registry.ts";
import type { Keys } from "./secretrefs.ts";
import { createReleases, type GetJson } from "./packs/releases.ts";
import { manifestPanel, manifestSettings, packsPage } from "./pages/packs.ts";
import type { Copies, ToAdd } from "./packs/copies.ts";
import type { Listed } from "./packs/releases.ts";
import { removeDevVar, upsertDevVar } from "./setup.ts";
import { strictOrigin } from "./strict.ts";
import { webUrl } from "./open-link.ts";
import { type Layout, type LayoutStore, layoutFromForm, layoutStore, withTabs } from "./layout.ts";
import { LOOK_KEYS, type LayoutView, layoutPanel, lookPanel } from "./pages/layout.ts";
import { packFeedOf } from "./home/feed.ts";
import { forgeName, safeUrl } from "./pages/parts.ts";
import type { AiSummary, ListShare, Pack, PackContext, PackManifest, PackShares, PrSlotArg, Pulse, Role, TodayCard, WasmFile } from "./packs/types.ts";
import { fileWhy, isWasm, isWasmFile, packFileAt, packFileNameOk, packFileType, packFileWhy, shaOk, WASM_INLINE_MAX, wasmFileAt, wasmNameOk } from "./packs/wasm.ts";
import { hashOf } from "./ui/style.ts";
import { type Note, type Policy, RING_KINDS, type Rung, policyOf, rings } from "./notify.ts";
import { quietOf } from "./quiet.ts";
import { listRepos } from "./sources/claude.ts";
import { GO_KEYS, SCRIPT, SCRIPT_PATH } from "./ui/app.js.ts";
import { RAW_CHANGE } from "./ui/on.js.ts";
import { STYLE, STYLE_PATH } from "./ui/style.ts";
import { boxed, classesOf, guardHtml, scopeCss, scriptOf } from "./packs/guard.ts";
import { createCodeRoutes } from "./pages/code.ts";
import { settle, within } from "./pages/later.ts";
import { currentViewer, viewingAs } from "./viewer.ts";
import { DEFAULT_KEYS, KEY_GROUPS, keyPrefsStore } from "./keys.ts";
import { keysPanel } from "./pages/keys.ts";

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
const PACK_ROUTE_MS = 30_000;

/** The first start's page: the same frame as every page (menu, tab bar, styles), and a note that swaps out for the real page when the gather lands. */
function pendingPage(path: string, frame: Frame): string {
  return String(shell({ title: "Dovre", frame, current: path, body: html`<section class="pending" data-pending aria-busy="true"><span class="spinner" aria-hidden="true"></span><h1>Gathering</h1><p class="t2">The page fills in by itself in a few seconds.</p></section>` }));
}

/** Nothing gathered yet: what the frame is drawn from on the "Gathering" page. */
const EMPTY = { deploys: { ok: false }, prs: { ok: false } } as unknown as Snapshot;

export function navOf(s: Snapshot, opts: { hosted?: boolean; bino?: boolean; /** Some pack here draws on /stats. */ stats?: boolean; /** This instance lists packs (on or off). */ packs?: boolean } = {}): NavItem[] {
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
const appPacks = new WeakMap<App, { on: Pack[]; off: Off[]; ctxOf: (c: Pack) => PackContext; /** Where the composition root's refresher and cron say how each run went. */ refreshes: Refreshes; /** Hidden in Settings → Layout: its refresh doesn't run. */ hidden: (id: string) => boolean; /** What the shown packs say needs me now (src/packs/registry.ts needsFrom). */ needs: () => Need[]; /** Their ring kinds that start off (RingDecl.off). */ startsOff: ReadonlySet<string>; /** The PR links their pages show, for the gather (linkedFrom). */ linked: () => string[]; /** What Bino may look up (hosted: the DO asks through src/hosted/lookups.ts). */ lookups: Lookups; /** Whether a page answers here (its pack is on and shown). */ pageOn: (href: string) => boolean }>();
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

export function createApp(env: Env, deps: { gatherer: Gatherer; /** Local: where slow requests and page loads are written (data/perf.log). */ perfLog?: (line: string) => void; /** Page speed's counts (src/speed.ts); default: this app's own. */ speed?: Speed; ghe: Ghe; /** Settings → Layout's store (default: kept in D1); the demo's is fixed. */ layout?: LayoutStore; /** The forge (src/forge/): what it can't do is hidden. Default: GitHub through `ghe`. */ forge?: Pick<Forge, "id" | "name" | "can"> & Partial<Pick<Forge, "host" | "work" | "merged" | "repos" | "file" | "everyRepo" | "propose">>; /** Local: keeps a pack's picture for the starting page (PackContext.startPicture). */ startPicture?: (svg: string) => void; runner?: Runner; /** Local: the open terminals' MCP tokens (#172), beside the runner's turns; in a pack session, its own (#371). */ mcpTurns?: (token: string) => { id: string; repo: string; cwd: string } | undefined; /** Local: Settings → Pack tools for agents (#172). */ agentTools?: { view(): Omit<AgentToolsView, "said">; register(h: ToolsHarness): { ok: true } | { ok: false; why: string } }; /** Local mode: opens a checked web address in the system's default browser (src/open-link.ts). */ openUrl?: (href: string) => void; hub?: Hub; notify?: { policy(): Policy; setPolicy(p: Policy): Promise<void>; log(): Rung[]; test(): void; /** Rings these now (a pack's `ctx.ring`, checked). */ ring?(notes: Note[]): void }; info?: { version: string; startedAt: number }; restart?: () => void; /** Kept GHE answers (data/catalog.json). */ kept?: Kept; /** Load what pages need shortly after starting. */ prewarm?: boolean; /** Where the agents' skills are installed (default: the home folder); for tests. */ skillsHome?: string; /** Questions MCP servers put to me through the relay (launcher/relay.go). */ asks?: Asks; /** Bino, the assistant: its model route and memory (src/packs/core/assistant/bino/); hosted, the Durable Object's (src/hosted/client.ts). */ bino?: { route: Route; memory: BinoMemory; file?: string; log?: (line: string) => void } | { remote: Bino }; /** Hosted: a page's event stream comes from the Durable Object (src/hosted/hub.ts). */ events?: () => Promise<Response>; /** Hosted with a hub: pages listen on its /live socket (H5), /events only if that never opens. */ live?: boolean; /** Hosted mode (IS_HOSTED=1): checks Cloudflare Access on every request. Hosted without it, nobody gets in. */ access?: AccessVerifier; /** Which panes run (src/config.ts): `false` is off, gone from the menu, search, Today and its routes. */ panes?: PanesOn; /** What the climb was told (src/onboarding.ts); default: kept in D1. */ onboarding?: OnboardingStore; /** Hosted: the paired machines, for the climb's "Bring your laptop?". */ machines?: () => Promise<{ name?: string; online: boolean }[]>; /** For Settings: each pane's state, and what Settings keeps. */ config?: { panes: Record<PaneId, PaneState>; stored: Config }; /** Hosted: what the instance has and lacks, for Settings' Setup panel (src/hosted/setup.ts). */ setup?: () => SetupLine[]; /** Settings → What Dovre sends (#145): the record of calls home, hosted the hub's, on a machine its bridge's file. */ sent?: () => Promise<SentView>; /** A pack session (#353, src/run.ts): only this pack's pages, sign-in, assets and the event stream; no cockpit. */ session?: { pack: string; /** The one checkout under CODE_DIR its packs see (#368). */ checkout?: string }; /** The packs that run here and those that don't, with why (src/packs/, PLAN D23). */ packs?: { on: Pack[]; off: Off[]; env: Record<string, string | undefined>; bindings?: Record<string, unknown>; /** How long Today waits for a pack's cards (default 250 ms). */ budgetMs?: number; /** How long a pack's page may take before it shows as broken (default 30 s). */ routeMs?: number; /** Dovre's own packs (src/packs/core/), labelled so on the Packs page. */ core?: string[]; /** Local `.dev.vars` path for saving pack settings from `/packs`. */ varsFile?: string; /** Local: secret settings read from a store (#416). */ keys?: Keys; /** Local: packs copied from dovre-packs, and Update (src/packs/copies.ts). */ copies?: Copies } }): App {
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
          db: env.DB,
          publish: (topics) => deps.hub?.publish(topics),
          snapshot: () => gatherer.peek(),
          gathered: async () => gatherer.peek() ?? (await Promise.race([gatherer.get().catch(() => undefined), new Promise<undefined>((res) => setTimeout(res, 1200))])),
          fill: (name, arg) => fill(name, arg),
          pageOn: (href) => pageOn(href),
          setupDone: () => setupLeft(c).length === 0,
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
          dockPage: (cx, o) => cx.html(dockShell({ title: o.title, body: boxed(o.body, c.manifest.id, c.manifest.name, "dock", packLog(c.manifest.id)), head: guardHtml(o.head, c.manifest.name, "dock head", packLog(c.manifest.id)), styles: PACK_CSS ? [PACK_CSS.path] : undefined, scripts: packScripts })),
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
        const pulse = c.pulse ?? c.avatar;
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
  appPacks.set(app, { on: packs.on, off: packs.off, ctxOf, refreshes, hidden, needs: packNeeds, startsOff, linked: () => linkedFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), lookups: { specs: () => packLookups().map(({ run: _r, pack: _p, ...spec }) => spec), run: runLookup }, pageOn: (href) => pageOn(href) });
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
  const fullFrame = (s: Snapshot, path = ""): Frame => ({ operator: s.login, look: { theme: layout.get().theme, accent: layout.get().accent, font: layout.get().font, textSize: layout.get().textSize, lineHeight: layout.get().lineHeight, binoIcon: layout.get().binoButton === "icon", motion: layout.get().motion, links: openUrl && layout.get().links === "default" ? "default" : undefined }, styles: PACK_CSS ? [PACK_CSS.path] : undefined, scripts: packScripts, nav: withTabs([...navOf(s, { hosted: env.IS_HOSTED === "1", bino: binoOn(), stats: statsOn(), packs: packs.on.length + packs.off.length > 0 }), ...packNav()], layout.get().tabs), syncedAt: s.at, syncing: gatherer.gathering() && Date.now() - s.at > 120_000, host: env.GHE_HOST, asks: asks.list(), docks: docksFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), bino: binoOn(), face: (o) => fill("bino.face", o)[0] ?? "", banners: bannersFrom(shown(), ctxOf, path, (id, line) => packLog(id)(line)), tz: env.TZ_NAME ? validZone(env.TZ_NAME) : currentTz(), greeting: greetingLang(env.GREETING), live: deps.live ? "ws" : undefined, goOff: Object.keys(GO_KEYS).filter((k) => !pageOn(GO_KEYS[k]!)) });
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
      if (!setUp()) return c.redirect("/welcome", 303);
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


  // ── Settings: what's here, the panes (src/config.ts), notifications ──
  let saved = false;
  /** Set when a save restarts Dovre: when this server started, so the page knows when the next one is up. */
  let restarting: number | undefined;
  let settingsBad: string[] | undefined;
  const startedAt = deps.info?.startedAt ?? Date.now();
  const setupNow = (login: string) =>
    setupLines({
      ghe: { host: env.GHE_HOST, org: env.GHE_ORG, login },
      claude: found.paths?.claude,
      omp: found.paths?.omp,
      copilot: found.copilot,
      copilotCli: found.paths?.copilot,
      edge: edgePath(),
      codeDir: env.CODE_DIR,
      repos: listRepos(env.CODE_DIR).length,
      publicOrigin,
    });
  /** Kept, then (under the supervisor) Dovre starts again with it. */
  const keep = async (config: Config) => {
    await saveConfig(env.DB, config);
    deps.config!.stored = config;
    if (!deps.restart) return false;
    restarting = startedAt;
    setTimeout(() => deps.restart?.(), 300);
    return true;
  };
  /** What the Work form shows: what Settings keeps, and what .dev.vars or the environment fixes. */
  const panesView = () => {
    if (!deps.config) return undefined;
    const fixed = fixedKeys();
    const e = env as unknown as Record<string, string | undefined>;
    const values: Record<string, string | undefined> = { ...deps.config.stored, CODE_DIR: deps.config.stored.CODE_DIR ?? env.CODE_DIR };
    for (const k of fixed) values[k] = e[k];
    return { values, fixed };
  };
  /** Settings → Layout: what can be arranged here, and where it is now. */
  const layoutView = async (frame: Frame): Promise<LayoutView> => {
    const l = layout.get();
    const packNow = shown().length ? (await packCards()).cards : [];
    const packLabel = (id: string) => {
      const pack = packs.on.find((c) => id.startsWith(`${c.manifest.id}-`));
      if (!pack) return id;
      const n = packNow.filter((x) => x.id.startsWith(`${pack.manifest.id}-`)).length;
      return n > 1 ? `${pack.manifest.name} · ${id.slice(pack.manifest.id.length + 1)}` : pack.manifest.name;
    };
    const placed = (id: string, col: "left" | "right", order: number) => ({ col: l.cards?.[id]?.col ?? col, order: l.cards?.[id]?.order ?? order });
    return {
      layout: l,
      pages: frame.nav.filter((p) => p.href !== "/" && p.place !== "action").map((p) => ({ href: p.href, title: p.title })),
      tabs: tabsOf(frame.nav).map((p) => p.href).filter((h) => h !== "/"),
      cards: [
        ...CORE_CARDS.map((c) => ({ id: c.id, label: c.label, ...placed(c.id, c.col, c.order) })),
        ...packNow.map((c) => ({ id: c.id, label: packLabel(c.id), ...placed(c.id, c.column === "left" ? "left" : "right", packOrder(c.order)) })),
      ],
      feeds: packs.on.filter((c) => c.feed).map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
      packs: packs.on.map((c) => ({ id: c.manifest.id, name: c.manifest.name })),
      opener: !!openUrl,
      stats: statOffers(packStats()).map((o, i) => ({ id: o.id, label: o.label, from: o.from, show: l.stats?.[o.id]?.show ?? true, order: l.stats?.[o.id]?.order ?? (i + 1) * 10 })),
    };
  };
  /** Look's keys of a Layout (`look`), or the rest. */
  const partOf = (l: Layout, look: boolean) => Object.fromEntries(Object.entries(l).filter(([k]) => (LOOK_KEYS as string[]).includes(k) === look)) as Layout;
  // Look and Layout each post their `part`; the other part stays as it was. No part: the whole of it.
  app.post("/settings/layout", async (c) => {
    const { frame } = await page();
    const v = await layoutView(frame);
    const form = await c.req.parseBody({ all: true });
    const next = layoutFromForm(form, { hrefs: v.pages.map((p) => p.href), cards: v.cards.map((x) => x.id), feeds: v.feeds.map((f) => f.id), packs: v.packs.map((x) => x.id), stats: v.stats.map((x) => x.id) });
    // Cards not drawn and stats not offered just now (a pack hidden or slow) keep where I put them.
    const whole = { ...next, cards: { ...v.layout.cards, ...next.cards }, stats: { ...v.layout.stats, ...next.stats } };
    const part = form.part;
    await layout.save(part === "look" ? { ...partOf(v.layout, false), ...partOf(next, true) } : part === "layout" ? { ...partOf(v.layout, true), ...partOf(whole, false) } : whole);
    saved = true;
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect(part === "look" ? "/settings/look" : "/settings/layout", 303);
  });
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
  app.post("/settings/layout/reset", async (c) => {
    const part = (await c.req.parseBody()).part;
    if (part === "look" || part === "layout") await layout.save(partOf(layout.get(), part === "layout"));
    else await layout.reset();
    saved = true;
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect(part === "look" ? "/settings/look" : "/settings/layout", 303);
  });

  // Its address before WP-M4.
  app.get("/crates", (c) => c.redirect("/packs", 301));
  /** Investigate (#214): what a pack handed on, to send to Bino or a new agent session. */
  app.get("/investigate", async (c) => {
    const { frame } = await page();
    const v = investigateOf({ prompt: c.req.query("prompt"), repo: c.req.query("repo"), from: c.req.query("from") });
    return c.html(investigatePage(frame, v, { bino: binoOn(), agent: shared("agent") }));
  });
  app.get("/packs", async (c) => {
    const { frame } = await page();
    const local = hosted ? undefined : deps.packs?.copies;
    const copies = local?.get();
    const reading = releases?.refresh();
    if (reading)
      try {
        c.executionCtx.waitUntil(reading);
      } catch {}
    const here = packIds();
    const toAdd = local ? { packs: local.listed().filter((p) => !here.includes(p.id)), into: local.target() } : releases?.get() ? { packs: await hostedAdds(releases.get()!.listed), into: instanceRepo() ?? undefined } : undefined;
    const setups = new Map(packs.on.flatMap((x) => (setupOf(x) ? [[x.manifest.id, setupLeft(x).length > 0] as const] : [])));
    return c.html(packsPage(frame, { setups, on: packs.on, off: packs.off, env: packs.env, keys: packs.keys?.state, hosted, refreshes, core: packs.core, copies, releases: releases?.get(), canRestart: !!deps.restart, hidden: layout.get().packsOff ?? [], held: held(), toAdd }));
  });
  /** A pack's one switch (#271): on or off here, the same as Settings → Layout's list. No restart. */
  app.post("/packs/:id/switch", strictOrigin, async (c) => {
    const id = c.req.param("id");
    if (!packs.on.some((p) => p.manifest.id === id)) return c.notFound();
    const on = (await c.req.parseBody()).on === "1";
    const was = layout.get().packsOff ?? [];
    await layout.save({ ...layout.get(), packsOff: on ? was.filter((x) => x !== id) : [...new Set([...was, id])] });
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
  });
  app.post("/packs/:id/update", strictOrigin, async (c) => {
    const copies = deps.packs?.copies;
    if (hosted || !copies) return c.notFound();
    const id = c.req.param("id");
    const r = copies.update(id, (ok, detail) => void logAction(env.DB, { kind: "packs.update", target: id, detail, ok }).catch(() => {}));
    if (!r.ok) await logAction(env.DB, { kind: "packs.update", target: id, ok: false, error: r.why }).catch(() => {});
    deps.hub?.publish(["packs"]);
    return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
  });
  /** Hosted: each pack to add, with its newest Add from the log (the PR it opened, or why not) or one opening now. */
  async function hostedAdds(listed: Listed[]): Promise<ToAdd[]> {
    const log = await actionsOf(env.DB, "packs.add").catch(() => []);
    return listed.map((l) => {
      if (opening.has(l.id)) return { ...l, job: { at: Date.now(), state: "running" as const, step: "opening a PR" } };
      const a = log.find((x) => x.target === l.id);
      if (!a) return l;
      const at = Date.parse(a.at);
      return { ...l, job: a.ok ? { at, state: "done" as const, step: "PR opened; merge it, then deploy", url: a.detail ?? undefined } : { at, state: "failed" as const, step: a.error ?? "failed" } };
    });
  }
  /** Add (#88): a pack from dovre-packs this instance doesn't list; locally a job on the copies, hosted a PR on the instance repo. */
  app.post("/packs/:id/add", strictOrigin, async (c) => {
    const id = c.req.param("id");
    if (packIds().includes(id)) return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
    if (hosted) {
      const repo = instanceRepo();
      const l = releases?.get()?.listed.find((x) => x.id === id);
      if (!repo || !l) return c.notFound();
      if (opening.has(id)) return c.redirect(`/packs#add-${encodeURIComponent(id)}`, 303);
      opening.add(id);
      const work = proposeAdd(ghe, packsGet, { repo, id })
        .then(
          (pr) => logAction(env.DB, { kind: "packs.add", target: id, detail: pr.url, ok: true }),
          (e: unknown) => logAction(env.DB, { kind: "packs.add", target: id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }),
        )
        .catch(() => {})
        .finally(() => {
          opening.delete(id);
          deps.hub?.publish(["packs"]);
        });
      try {
        c.executionCtx.waitUntil(work);
      } catch {}
      deps.hub?.publish(["packs"]);
      return c.redirect(`/packs#add-${encodeURIComponent(id)}`, 303);
    }
    const copies = deps.packs?.copies;
    if (!copies) return c.notFound();
    const r = copies.add(id, (ok, detail) => void logAction(env.DB, { kind: "packs.add", target: id, detail, ok }).catch(() => {}));
    if (!r.ok) await logAction(env.DB, { kind: "packs.add", target: id, ok: false, error: r.why }).catch(() => {});
    deps.hub?.publish(["packs"]);
    return c.redirect(`/packs#add-${encodeURIComponent(id)}`, 303);
  });
  /** After its settings changed: off for a required one missing (or unread), on (and started) once they're all there. */
  const settleSettings = async (id: string) => {
    const onPack = packs.on.find((x) => x.manifest.id === id);
    const offEntry = packs.off.find((x) => x.id === id);
    const manifest = onPack?.manifest ?? offEntry?.manifest;
    if (!manifest) return;
    const missing = manifestSettings(manifest).find((s) => s.required && !packs.env[s.key]?.trim());
    const why = missing && missingWhy(missing.key, packs.keys?.unread());
    if (onPack && why) {
      packs.on.splice(packs.on.indexOf(onPack), 1);
      packs.off.push({ id, name: manifest.name, why, manifest, pack: onPack });
      settleRequires(packs);
    } else if (offEntry?.pack && !offEntry.needs && !why) {
      const p = offEntry.pack;
      packs.off.splice(packs.off.indexOf(offEntry), 1);
      packs.on.push(p);
      // It, and what was off only for want of it (#326), start in order: each after what it requires.
      const starting = [p, ...settleRequires(packs)];
      for (const q of [...packs.on]) {
        if (!starting.includes(q) || !packs.on.includes(q)) continue;
        try {
          await q.init?.(ctxOf(q));
        } catch (e) {
          packs.on.splice(packs.on.indexOf(q), 1);
          packs.off.push({ id: q.manifest.id, name: q.manifest.name, why: `didn't start: ${(e as Error)?.message ?? e}`, manifest: q.manifest });
          settleRequires(packs);
        }
      }
      for (const q of starting) if (packs.on.includes(q)) void runPackRefresh.one(q);
    } else if (offEntry && why) {
      offEntry.why = why;
      // Off for its settings now, not only for a pack it requires: it waits for them first.
      delete offEntry.needs;
    } else if (onPack) {
      void runPackRefresh.one(onPack);
    }
  };
  app.post("/packs/:id/settings", strictOrigin, async (c) => {
    if (hosted) return c.notFound();
    const id = c.req.param("id");
    const manifest = packs.on.find((x) => x.manifest.id === id)?.manifest ?? packs.off.find((x) => x.id === id)?.manifest;
    const settings = manifestSettings(manifest);
    if (!manifest || !settings.length) return c.notFound();
    const body = await c.req.parseBody();
    const keys = packs.keys;
    for (const s of settings) {
      const val = body[s.key];
      const raw = typeof val === "string" ? val.replace(/[\r\n]+/g, " ").trim().slice(0, 2000) : "";
      // A setting with choices keeps only one of them (API 1.15); anything else leaves it as it was.
      if (s.choices && raw && !s.choices.some((x) => x.value === raw)) continue;
      if (s.secret) {
        // A reference is kept and read; a pasted key goes to the Keychain on a Mac (#416).
        if (body[`clear.${s.key}`] === "1") {
          if (keys) await keys.clear(s.key);
          else {
            delete packs.env[s.key];
            if (packs.varsFile) removeDevVar(packs.varsFile, s.key);
          }
        } else if (raw) {
          if (keys) await keys.save(s.key, raw);
          else {
            packs.env[s.key] = raw;
            if (packs.varsFile) upsertDevVar(packs.varsFile, s.key, raw);
          }
        }
      } else if (raw) {
        packs.env[s.key] = raw;
        if (packs.varsFile) upsertDevVar(packs.varsFile, s.key, raw);
      } else {
        delete packs.env[s.key];
        if (packs.varsFile) removeDevVar(packs.varsFile, s.key);
      }
    }
    await settleSettings(id);
    saved = true;
    deps.hub?.publish([id, "packs", "snapshot"]);
    return c.redirect(`/settings/packs/${encodeURIComponent(id)}`, 303);
  });
  // Read again (#416): its keys from their stores, then on or off as they came back.
  app.post("/packs/:id/keys", strictOrigin, async (c) => {
    const id = c.req.param("id");
    const manifest = packs.on.find((x) => x.manifest.id === id)?.manifest ?? packs.off.find((x) => x.id === id)?.manifest;
    const secret = manifestSettings(manifest).filter((s) => s.secret && packs.keys?.state(s.key));
    if (hosted || !packs.keys || !secret.length) return c.notFound();
    await packs.keys.read(secret.map((s) => s.key));
    await settleSettings(id);
    deps.hub?.publish([id, "packs", "snapshot"]);
    return c.redirect(`/settings/packs/${encodeURIComponent(id)}`, 303);
  });

  /** A pack's own Settings panel, with core's ingest tokens when it takes ingest (dovre#109). */
  const ownPanel = async (p: Pack, made?: { pack: string; source: string; token: string }): Promise<Html | undefined> => {
    const id = p.manifest.id;
    const mine = settingsFrom([p], ctxOf, (pid, line) => packLog(pid)(line))[0]?.body;
    if (!p.ingest) return mine;
    const tokens = tokensPanel(p, await listTokens(env.DB, id).catch(() => []), { hosted, made: made?.pack === id ? made : undefined });
    return html`${mine ?? ""}${tokens}`;
  };
  /** The packs with settings: their manifest's, their own panel, or ingest tokens. Off ones too: one may be off for want of a setting. */
  const packSettings = (): PackSettings[] => {
    const set = (m: PackManifest | undefined) => manifestSettings(m).map((x) => ({ key: x.key, label: x.label, set: !!packs.env[x.key]?.trim() }));
    // A pack's own panel counts when it draws something (an empty answer or a throw: none).
    const own = new Set(settingsFrom(shown(), ctxOf, (id, line) => packLog(id)(line)).map((x) => x.id));
    return [
      ...shown().map((p) => ({ id: p.manifest.id, name: p.manifest.name, on: true, settings: set(p.manifest), panel: own.has(p.manifest.id) || !!p.ingest })),
      ...packs.on.filter((p) => hidden(p.manifest.id)).map((p) => ({ id: p.manifest.id, name: p.manifest.name, on: false, settings: set(p.manifest), panel: false })),
      ...packs.off.map((o) => ({ id: o.id, name: o.name, on: false, settings: set(o.manifest), panel: false })),
    ].filter((k) => k.settings.length || k.panel);
  };
  /** The areas this instance has: Work only where Settings keeps config, Agents only on a machine. */
  const settingsAreas = (): AreaId[] =>
    AREAS.map((a) => a.id).filter((id) => (id === "work" ? !!deps.config : id === "agents" ? (!hosted && !!deps.agentTools) || !!deps.notify || settingsFrom(shown().filter((p) => p.manifest.id === "agents"), ctxOf, () => {}).length > 0 : id === "packs" ? packSettings().length > 0 : true));
  /** Every setting as it is now, to find and to mark what was changed. */
  const rowsNow = async (frame: Frame) => {
    const v = panesView();
    return settingRows({
      layout: layout.get(),
      policy: deps.notify?.policy() ?? policyOf(undefined),
      rings: packRings,
      writes: { chosen: await clicks.get().catch(() => new Map()), kinds: writeKinds(packs.on) },
      keys: frame.keys ?? DEFAULT_KEYS,
      panes: v && deps.config ? { ...v, stored: deps.config.stored as Record<string, string | undefined> } : undefined,
      packs: packSettings(),
      agents: !hosted && deps.agentTools ? deps.agentTools.view().rows : undefined,
      setup: deps.setup?.() ?? setupNow(frame.operator),
      canRestart: !!deps.restart,
    });
  };
  /** Saved, starting again, or refused: shown once, on the next Settings page. */
  const takeNotes = (then: string): SettingsNotes => {
    const n = { saved, restarting, bad: settingsBad, then };
    saved = false;
    settingsBad = undefined;
    return n;
  };
  const sentNow = async (): Promise<SentView> => (await deps.sent?.().catch(() => undefined)) ?? { hosted };
  const areaBody = async (area: AreaId, frame: Frame): Promise<Html> => {
    switch (area) {
      case "look":
        return lookPanel(layout.get());
      case "layout":
        return layoutPanel(await layoutView(frame));
      case "notifications":
        return notifyPanels(deps.notify?.policy() ?? policyOf(undefined), deps.notify?.log() ?? [], packRings);
      case "writes":
        return writesPanel(await clicks.get().catch(() => new Map()), writeKinds(packs.on));
      case "keys":
        return keysPanel(frame.keys ?? DEFAULT_KEYS, !!currentViewer());
      case "work":
        return workPanel(panesView()!, !!deps.restart);
      case "agents": {
        // One area for agents (#272): their tools here, the long-turn ring, and the auto runs' limits.
        const agents = shown().find((p) => p.manifest.id === "agents");
        const auto = agents ? await ownPanel(agents) : undefined;
        return html`${!hosted && deps.agentTools ? agentToolsPanel({ ...deps.agentTools.view(), said: takeToolsSaid() }) : ""}${deps.notify ? longTurnPanel(deps.notify.policy()) : ""}${auto ? Panel({ title: "Auto runs", id: "auto", children: auto }) : ""}`;
      }
      case "packs":
        return packsList(packSettings());
      case "calls":
        return callsPanels((await ghe.calls?.view(env.DB)) ?? { quota: [], counts: [], now: Date.now() }, forge.name);
      case "speed":
        return speedPanels(await speed.view(env.DB));
      case "sent":
        return sentPanels(await sentNow());
      case "about":
        return html`${appPanel(deps.info, !!deps.restart, frame.tz)}${setupPanel(deps.setup?.() ?? setupNow(frame.operator))}`;
    }
  };
  /** Settings → Packs → one pack: its own panel (and ingest tokens), its manifest's settings, and where else it has some. */
  const showPack = async (c: Context<AppEnv>, id: string, made?: { pack: string; source: string; token: string }) => {
    // The agents pack's settings (auto runs) live in Settings → Agents (#272).
    if (id === "agents" && settingsAreas().includes("agents")) return c.redirect("/settings/agents#auto", 303);
    const k = packSettings().find((x) => x.id === id);
    if (!k) return c.notFound();
    const { frame } = await page();
    const on = shown().find((p) => p.manifest.id === id);
    const offEntry = packs.off.find((o) => o.id === id);
    const settings = manifestSettings(on?.manifest ?? offEntry?.manifest);
    const own = on ? await ownPanel(on, made) : undefined;
    const writes = on ? writeKinds([on]).filter((w) => w.kind.startsWith(`${id}.`)).length : 0;
    const where = html`<p class="t2">${writes ? html`Its writes: <a href="/settings/writes">Settings → Writes</a>. ` : ""}On or off, its refreshes and why: <a href="/packs#pack-${encodeURIComponent(id)}">Packs</a>.</p>`;
    if (made) c.header("Cache-Control", "no-store");
    if (deps.session) {
      const body = html`${offEntry ? Notice({ tone: "warn", children: html`Off: ${offEntry.why}` }) : ""}${own ? Panel({ title: "Its own settings", id: `pack-${id}`, children: own }) : ""}${settings.length ? manifestPanel(id, settings, packs.env, hosted, true, packs.keys?.state) : ""}`;
      return c.html(sessionSettings(frame, { name: k.name, notes: takeNotes(`/settings/packs/${encodeURIComponent(id)}`), body }));
    }
    const body = html`${offEntry ? Notice({ tone: "warn", children: html`Off: ${offEntry.why}` }) : ""}${own ? Panel({ title: "Its own settings", id: `pack-${id}`, children: own }) : ""}${settings.length ? manifestPanel(id, settings, packs.env, hosted, false, packs.keys?.state) : ""}${where}`;
    return c.html(settingsArea(frame, "packs", { areas: settingsAreas(), rows: await rowsNow(frame), notes: takeNotes(`/settings/packs/${encodeURIComponent(id)}`), body, title: k.name, crumbs: [{ href: "/settings/packs", label: "Packs" }] }));
  };
  // What the last "Set up omp/agy" said, shown once on the next Settings.
  let toolsSaid: AgentToolsView["said"];
  const takeToolsSaid = () => {
    const s = toolsSaid;
    toolsSaid = undefined;
    return s;
  };
  app.post("/settings/agent-tools/:h", strictOrigin, async (c) => {
    const h = c.req.param("h");
    if (hosted || !deps.agentTools || !TOOLS_HARNESSES.includes(h as ToolsHarness)) return c.notFound();
    const r = deps.agentTools.register(h as ToolsHarness);
    await logAction(env.DB, { kind: "agents.tools", target: h, detail: "added the dovre MCP server", ok: r.ok, ...(r.ok ? {} : { error: r.why }) }).catch(() => {});
    toolsSaid = r.ok ? { ok: true, text: `${h} gets the packs' tools from its next turn or terminal.` } : { ok: false, text: r.why };
    return c.redirect("/settings/agents", 303);
  });
  app.get("/settings", async (c) => {
    const { frame } = await page();
    return c.html(settingsHome(frame, { areas: settingsAreas(), rows: await rowsNow(frame), q: (c.req.query("q") ?? "").slice(0, 100), notes: takeNotes("/settings") }));
  });
  app.post("/settings/keys", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const on = ([] as unknown[]).concat(f.on ?? []);
    await keyPrefs.set(currentViewer(), { scroll: f.scroll, off: KEY_GROUPS.map((g) => g.id).filter((id) => !on.includes(id)) });
    saved = true;
    return c.redirect("/settings/keys", 303);
  });
  app.post("/settings/writes", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const twice = ([] as unknown[]).concat(f.twice ?? []).filter((v): v is string => typeof v === "string");
    await clicks.set(twice);
    saved = true;
    return c.redirect("/settings/writes", 303);
  });
  const ingestPack = (id: unknown) => shown().find((p) => p.ingest && p.manifest.id === id);
  // A new token is shown on the page this answers, once; only its hash is kept.
  app.post("/settings/ingest/new", async (c) => {
    const f = await c.req.parseBody();
    const p = ingestPack(f.pack);
    if (!p) return c.notFound();
    if (!sourceOk(f.source)) {
      settingsBad = ["the source's name"];
      return c.redirect(`/settings/packs/${p.manifest.id}`, 303);
    }
    const token = await createToken(env.DB, p.manifest.id, f.source);
    await logAction(env.DB, { kind: "ingest-token", target: `${p.manifest.id}:${f.source}`, ok: true, detail: "made" }).catch(() => {});
    return showPack(c, p.manifest.id, { pack: p.manifest.id, source: f.source, token });
  });
  app.post("/settings/ingest/revoke", async (c) => {
    const f = await c.req.parseBody();
    const p = ingestPack(f.pack);
    const id = Number(f.id);
    if (!p || !Number.isInteger(id)) return c.notFound();
    const done = await revokeToken(env.DB, p.manifest.id, id);
    await logAction(env.DB, { kind: "ingest-token", target: `${p.manifest.id}:${id}`, ok: done, detail: "revoked" }).catch(() => {});
    return c.redirect(`/settings/packs/${p.manifest.id}`, 303);
  });
  /** When this server started: a page waiting out a restart asks until it changes. */
  app.get("/settings/started", (c) => noStore(c.text(String(startedAt))));
  // The record of calls home, for a security review (#145): the list of kinds, and what was sent.
  app.get("/settings/sent.json", async (c) => {
    c.header("Content-Disposition", 'attachment; filename="dovre-sent.json"');
    return noStore(c.json({ at: Date.now(), catalog: CATALOG, ...(await sentNow()) }));
  });
  app.get("/settings/packs/:id", (c) => showPack(c, c.req.param("id")));
  app.get("/settings/:area", async (c) => {
    const area = c.req.param("area");
    if (!isArea(area) || !settingsAreas().includes(area)) return c.notFound();
    const { frame } = await page();
    const notes = takeNotes(`/settings/${area}`);
    const body = await areaBody(area, frame);
    return c.html(settingsArea(frame, area, { areas: settingsAreas(), rows: await rowsNow(frame), notes, body }));
  });
  // ── The first run, the climb (src/pages/welcome.ts, #417): Today sends here until it's finished or skipped ──
  const setUp = () => !!(env.SETUP_DONE || deps.config?.stored.SETUP_DONE || onboarding.get().done);
  /** Local: the folder and owners asked for on the way up, kept at the summit (they need a restart). */
  let pending: Config = {};
  let climbBad: string[] | undefined;
  const stepsOf = (role: Role | undefined): Step[] => STEPS.filter((s) => s !== "machine" || role !== "po");
  /** Every pack the kit offers: those that run here, and those that can't, with why. */
  const kitPacks = () => [...packs.on.map((p) => ({ m: p.manifest, off: undefined as string | undefined })), ...packs.off.filter((o) => o.manifest).map((o) => ({ m: o.manifest!, off: o.why }))];
  const climbDir = () => {
    return pending.CODE_DIR ?? deps.config?.stored.CODE_DIR ?? env.CODE_DIR;
  };
  /** The scan (local, after the role): which markers the checkouts have. */
  const scanNow = () => {
    const dir = hosted ? undefined : climbDir();
    if (!dir) return { dir, checkouts: 0, found: new Map<string, number>() };
    return { dir, ...scanCheckouts(dir, kitPacks().flatMap((k) => markersOf(k.m))) };
  };
  /** What's suggested at a step: only what was asked before it counts. */
  const suggestedAt = (step: Step, found: Map<string, number>) => {
    const o = onboarding.get();
    const steps = stepsOf(o.role);
    const i = steps.indexOf(step);
    const past = (s: Step) => steps.includes(s) && steps.indexOf(s) < i;
    const answers = { ...(past("q0") ? pick(o.answers, INTERVIEW[o.role!]?.[0]) : {}), ...(past("q1") ? pick(o.answers, INTERVIEW[o.role!]?.[1]) : {}) };
    return suggest(
      kitPacks().filter((k) => !k.off).map((k) => k.m),
      past("role") ? o.role : undefined,
      answers,
      past("machine") ? found.keys() : [],
    );
  };
  const pick = (a: Answers, qid: string | undefined): Answers => (qid && a[qid] !== undefined ? { [qid]: a[qid] } : {});
  /** The packs on at the summit: what was ticked, or else what's suggested. */
  const pickedNow = (found: Map<string, number>) => onboarding.get().picked ?? [...suggestedAt("summit", found).keys()];
  app.get("/welcome", async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const started = c.req.query("started") === "1" && restarting ? restarting : undefined;
    if (started) return c.html(startingPage((await page()).frame, started));
    const o = onboarding.get();
    const steps = stepsOf(o.role);
    const asked = c.req.query("at");
    let step: Step = steps.find((s) => s === asked) ?? "welcome";
    if (!o.role && step !== "welcome" && step !== "role") step = "role";
    const from = steps[steps.indexOf(step) - 1];
    const bad = climbBad;
    climbBad = undefined;
    const scan = step === "welcome" || step === "role" ? undefined : scanNow();
    const found = scan?.found ?? new Map<string, number>();
    const flagsAt = (s: Step | undefined) => (!s ? [] : s === "summit" || s === "packs" ? (s === "summit" ? pickedNow(found) : [...suggestedAt(s, found).keys()]) : [...suggestedAt(s, found).keys()]);
    const now = flagsAt(step);
    const before = new Set(flagsAt(from));
    const names = new Map(kitPacks().map((k) => [k.m.id, k.m.name]));
    const flags = now.filter((id) => names.has(id)).map((id) => ({ name: names.get(id)!, fresh: !before.has(id) }));
    const view: ClimbView = { step, from, flags, role: o.role, forge: o.forge, bad, look: { theme: layout.get().theme, accent: layout.get().accent, motion: layout.get().motion } };
    const fixed = fixedKeys();
    const e = env as unknown as Record<string, string | undefined>;
    const field = (k: string): ClimbField => (fixed.has(k) ? { value: e[k] ?? "", fixed: true } : { value: pending[k] ?? deps.config?.stored[k] ?? e[k] ?? "", fixed: false });
    if (deps.config) {
      view.owners = field("REPO_OWNERS");
      view.codeDir = field("CODE_DIR");
    }
    let refresh: number | undefined;
    if (step === "machine") {
      if (hosted) {
        const online = (await deps.machines?.().catch(() => []))?.find((m) => m.online);
        const handle = /^([a-z0-9-]+)\.dovre\.dev$/i.exec(c.req.header("host")?.split(":")[0] ?? "")?.[1] ?? "<handle>";
        view.machine = { kind: "hosted", handle, online: online ? (online.name ?? "your laptop") : undefined };
        if (!online) refresh = 5;
      } else {
        const byMarker = new Map<string, string[]>();
        for (const k of kitPacks()) for (const mk of markersOf(k.m)) if (found.has(mk)) byMarker.set(mk, [...(byMarker.get(mk) ?? []), k.m.name]);
        view.machine = { kind: "local", dir: scan?.dir, checkouts: scan?.checkouts ?? 0, found: [...found].map(([marker, n]) => ({ marker, n, packs: byMarker.get(marker) ?? [] })) };
      }
    }
    if (step === "q0" || step === "q1") {
      const qid = INTERVIEW[o.role!][step === "q0" ? 0 : 1]!;
      const a = o.answers[qid];
      view.question = { q: QUESTIONS[qid]!, chosen: Array.isArray(a) ? a : a ? [a] : [] };
    }
    if (step === "packs") {
      const sug = suggestedAt("summit", found);
      const picked = o.picked ? new Set(o.picked) : undefined;
      const tiles = kitPacks().map((k): KitTile => ({ id: k.m.id, name: k.m.name, what: k.m.description, why: sug.get(k.m.id) ?? [], on: picked ? picked.has(k.m.id) : sug.has(k.m.id), off: k.off }));
      const on = new Set(tiles.filter((t) => t.on && !t.off).map((t) => t.id));
      const needs = kitPacks()
        .filter((k) => on.has(k.m.id))
        .map((k) => ({ id: k.m.id, name: k.m.name, keys: manifestSettings(k.m).filter((s) => s.required && !packs.env[s.key]?.trim()).map((s) => s.label) }))
        .filter((n) => n.keys.length);
      view.kit = { suggested: tiles.filter((t) => sug.has(t.id)), rest: tiles.filter((t) => !sug.has(t.id)), needs };
    }
    if (step === "summit") {
      const on = new Set(pickedNow(found));
      const k = kitPacks().filter((x) => !x.off && on.has(x.m.id));
      const later = k.flatMap((x) => {
        const p = packs.on.find((c) => c.manifest.id === x.m.id);
        const ob = p && setupOf(p);
        return ob ? [{ id: x.m.id, name: x.m.name, steps: ob.steps.map((s) => s.title) }] : [];
      });
      const online = hosted ? (await deps.machines?.().catch(() => []))?.some((m) => m.online) : true;
      view.summit = { on: k.map((x) => x.m.name), later, waits: hosted && !online, restarts: !!deps.restart && Object.keys(pending).length > 0 };
    }
    return noStore(await c.html(climbPage(view, steps, { refresh })));
  });
  const nextOf = (step: Step) => {
    const steps = stepsOf(onboarding.get().role);
    return `/welcome?at=${steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)]}`;
  };
  /** A local text setting asked on the way: checked as Settings does, kept until the summit. */
  const askGeneral = (form: Record<string, unknown>, key: string) => {
    if (!deps.config || typeof form[key] !== "string") return;
    const { config, bad } = configFromForm({ [key]: form[key] }, { ...deps.config.stored, ...pending }, fixedKeys(), { general: true });
    if (bad.length) climbBad = bad;
    else if (config[key] !== (deps.config.stored[key] ?? undefined)) pending = { ...pending, [key]: config[key] ?? "" };
    else {
      const { [key]: _, ...rest } = pending;
      pending = rest;
    }
    return bad.length === 0;
  };
  app.post("/welcome/role", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const f = await c.req.parseBody();
    const role = typeof f.role === "string" && Object.hasOwn(ROLES, f.role) ? (f.role as Role) : undefined;
    if (!role) return c.redirect("/welcome?at=role", 303);
    const forge = FORGES.find(([x]) => x === f.forge)?.[0] ?? "github";
    const was = onboarding.get();
    // A new role asks new questions: the old answers and picks no longer fit.
    await onboarding.save(was.role === role ? { ...was, forge } : { answers: {}, role, forge, done: was.done });
    if (askGeneral(f, "REPO_OWNERS") === false) return c.redirect("/welcome?at=role", 303);
    return c.redirect(nextOf("role"), 303);
  });
  app.post("/welcome/machine", strictOrigin, async (c) => {
    if (deps.session || hosted) return c.notFound();
    askGeneral(await c.req.parseBody(), "CODE_DIR");
    return c.redirect("/welcome?at=machine", 303);
  });
  for (const step of ["q0", "q1"] as const)
    app.post(`/welcome/${step}`, strictOrigin, async (c) => {
      if (deps.session) return c.notFound();
      await onboarding.ready;
      const o = onboarding.get();
      if (!o.role) return c.redirect("/welcome?at=role", 303);
      const qid = INTERVIEW[o.role][step === "q0" ? 0 : 1]!;
      const f = await c.req.parseBody({ all: true });
      const a = [f.a ?? []].flat().filter((x): x is string => typeof x === "string");
      const answers = answersFrom({ ...o.answers, [qid]: QUESTIONS[qid]!.multi ? a : a[0] });
      if (!QUESTIONS[qid]!.multi && answers[qid] === undefined) return c.redirect(`/welcome?at=${step}`, 303);
      // New answers suggest anew: what was ticked before is forgotten.
      await onboarding.save({ ...o, answers, picked: undefined });
      return c.redirect(nextOf(step), 303);
    });
  app.post("/welcome/packs", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const f = await c.req.parseBody({ all: true });
    const can = new Set(packs.on.map((p) => p.manifest.id));
    const picked = [f.pack ?? []].flat().filter((x): x is string => typeof x === "string" && can.has(x));
    await onboarding.save({ ...onboarding.get(), picked });
    return c.redirect(nextOf("packs"), 303);
  });
  /** The summit's Open Today: the picked packs on and the rest off (Packs page), the folder and owners kept. */
  app.post("/welcome/done", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    const on = new Set(pickedNow(scanNow().found));
    const was = layout.get().packsOff ?? [];
    const ids = packs.on.map((p) => p.manifest.id);
    await layout.save({ ...layout.get(), packsOff: [...new Set([...was.filter((x) => !on.has(x)), ...ids.filter((x) => !on.has(x))])] });
    await onboarding.save({ ...onboarding.get(), picked: [...on], done: true });
    deps.hub?.publish(["snapshot", "packs"]);
    if (!deps.config) return c.redirect("/", 303);
    const config: Config = { ...deps.config.stored, ...pending, SETUP_DONE: "1" };
    for (const [k, v] of Object.entries(pending)) if (v === "") delete config[k];
    const changed = Object.keys(pending).length > 0;
    pending = {};
    if (changed) return c.redirect((await keep(config)) ? "/welcome?started=1" : "/", 303);
    await saveConfig(env.DB, config);
    deps.config.stored = config;
    return c.redirect("/", 303);
  });
  // ── A pack's own setup (src/pages/setup.ts, #418): the pack draws each step, core draws the frame ──
  /** A shown pack with a setup page, by id. */
  const setupPack = (id: string) => shown().find((c) => c.manifest.id === id && !!setupOf(c));
  /** What Next on a step was refused for: shown once, on that step. */
  let setupSaid: { id: string; step: string; error: string } | undefined;
  /** A step as the pack draws it, in the time its pages get. One that throws, is late or breaks the rules is that pack's broken step. */
  const drawStep = async (c: Pack, step: string): Promise<{ body: Html; form: boolean; wait?: string; broke?: string }> => {
    const ms = packs.routeMs ?? PACK_ROUTE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const log = packLog(c.manifest.id);
    try {
      const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`didn't answer in ${ms / 1000} s`)), ms)));
      const got = await Promise.race([Promise.resolve().then(() => c.setup!.draw(ctxOf(c), step)), late]);
      const body = await guardHtml(got?.body ?? "", c.manifest.name, `setup ${step}`, log);
      const form = got?.form === true;
      // A form step's inputs go with Next: a form inside it would be a form in a form.
      if (form && /<form[\s>]/i.test(String(body))) throw new Error("a form step's body holds a form of its own");
      const wait = typeof got?.wait === "string" && got.wait.trim() ? got.wait.trim().slice(0, 200) : undefined;
      return { body: html`<div class="pack-box" data-pack="${c.manifest.id}">${body}</div>`, form, wait };
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 300);
      log(`setup ${step}: ${why}`);
      return {
        body: html`<div class="climb-card"><p><b>${c.manifest.name} broke on this step.</b> The rest of Dovre is fine. The pack's log on <a href="/packs">Packs</a> says what happened. <a href="${bugHref(`/setup/${c.manifest.id}`, why, c.manifest.id)}">Report this</a> if it looks like a bug.</p></div>`,
        form: false,
        wait: "Come back once it's fixed.",
        broke: why,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  app.get("/setup/:id", async (c) => {
    if (deps.session) return c.notFound();
    const p = setupPack(c.req.param("id"));
    if (!p) return c.notFound();
    await onboarding.ready;
    const id = p.manifest.id;
    const { steps } = setupOf(p)!;
    const asked = c.req.query("at");
    const left = setupLeft(p);
    let at = asked === "done" ? steps.length : steps.findIndex((s) => s.id === asked);
    if (at < 0) at = left.length ? steps.findIndex((s) => s.id === left[0]!.id) : 0;
    const said = setupSaid?.id === id && setupSaid.step === steps[at]?.id ? setupSaid.error : undefined;
    setupSaid = undefined;
    const l = layout.get();
    const view: SetupView = { look: { theme: l.theme, accent: l.accent, motion: l.motion }, flags: shown().map((x) => ({ name: x.manifest.name, focus: x === p })), pack: { id, name: p.manifest.name }, steps, at, error: said };
    let status: 200 | 500 = 200;
    if (at < steps.length) {
      const d = await drawStep(p, steps[at]!.id);
      Object.assign(view, { body: d.body, form: d.form, wait: d.wait });
      if (d.broke) status = 500;
    }
    return noStore(await c.html(setupPage(view), status));
  });
  app.post("/setup/:id/next", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    const p = setupPack(c.req.param("id"));
    if (!p) return c.notFound();
    await onboarding.ready;
    const id = p.manifest.id;
    const { steps } = setupOf(p)!;
    const form = await c.req.parseBody({ all: true });
    const i = steps.findIndex((s) => s.id === form.step);
    if (i < 0) return c.redirect(`/setup/${id}`, 303);
    const step = steps[i]!;
    const stay = (error: string) => {
      setupSaid = { id, step: step.id, error: error.slice(0, 300) };
      return c.redirect(`/setup/${id}?at=${step.id}`, 303);
    };
    // Drawn again: a write it waits on may have finished, or not.
    const d = await drawStep(p, step.id);
    if (d.wait) return stay(d.wait);
    if (d.form && p.setup!.save) {
      const fields: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(form).slice(0, 50)) {
        if (k === "step") continue;
        const vs = ([] as unknown[]).concat(v).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 2000)).slice(0, 200);
        if (vs.length) fields[k] = vs.length === 1 ? vs[0]! : vs;
      }
      const r = await Promise.resolve()
        .then(() => p.setup!.save!(ctxOf(p), step.id, fields))
        .catch((e: unknown): { ok: false; error: string } => {
          packLog(id)(`setup ${step.id} save: ${(e as Error)?.message ?? e}`);
          return { ok: false, error: `${p.manifest.name} couldn't keep that. Its log on Packs says why.` };
        });
      if (!r || r.ok !== true) return stay(typeof r?.error === "string" && r.error ? r.error : "Not kept.");
    }
    const o = onboarding.get();
    await onboarding.save({ ...o, setup: { ...o.setup, [id]: [...new Set([...(o.setup?.[id] ?? []), step.id])] } });
    deps.hub?.publish(["snapshot", id]);
    const next = steps[i + 1];
    return c.redirect(`/setup/${id}?at=${next ? next.id : "done"}`, 303);
  });
  app.post("/welcome/skip", strictOrigin, async (c) => {
    if (deps.session) return c.notFound();
    await onboarding.ready;
    await onboarding.save({ ...onboarding.get(), done: true });
    pending = {};
    if (deps.config) {
      await saveConfig(env.DB, { ...deps.config.stored, SETUP_DONE: "1" });
      deps.config.stored = { ...deps.config.stored, SETUP_DONE: "1" };
    }
    return c.redirect("/", 303);
  });
  /** The Work form: kept, then Dovre starts again with it (under the supervisor). */
  for (const path of ["/settings/work"])
    app.post(path, async (c) => {
      if (!deps.config) return c.notFound();
      const { config, bad } = configFromForm(await c.req.parseBody(), deps.config.stored, fixedKeys(), { general: true });
      const back = path;
      if (bad.length) {
        settingsBad = bad;
        return c.redirect(back, 303);
      }
      saved = true;
      await keep(config);
      return c.redirect(back, 303);
    });
  app.post("/settings/notify", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const kinds = new Set([form.kind ?? []].flat().map(String));
    const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : undefined);
    const was = deps.notify?.policy() ?? policyOf(undefined);
    const next = policyOf({
      // The kinds on the form: the core's and the shown packs'; any other keeps what it was.
      kinds: { ...was.kinds, ...Object.fromEntries([...RING_KINDS, ...packRings].map((k) => [k.kind, kinds.has(k.kind)])) },
      // A long turn is set on Settings → Agents (#272).
      longTurnMin: was.longTurnMin,
      bundleSec: num(form.bundleSec),
      quiet: quietOf(form.quietFrom, form.quietTo, form.quietWeekends),
    });
    await deps.notify?.setPolicy(next);
    saved = true;
    return c.redirect("/settings/notifications", 303);
  });
  /** Settings → Agents: how long a turn runs before its end rings (the rest of the policy as it was). */
  app.post("/settings/agents/long-turn", async (c) => {
    if (!deps.notify) return c.notFound();
    const v = (await c.req.parseBody()).longTurnMin;
    await deps.notify.setPolicy(policyOf({ ...deps.notify.policy(), longTurnMin: typeof v === "string" && v.trim() !== "" ? Number(v) : undefined }));
    saved = true;
    return c.redirect("/settings/agents#long-turn", 303);
  });
  app.post("/settings/restart", (c) => {
    // The supervisor (`dovre supervise`, launcher/) starts it again; the page waits on the starting page.
    setTimeout(() => deps.restart?.(), 300);
    return c.redirect("/settings/about", 303);
  });
  app.post("/settings/notify/test", (c) => {
    deps.notify?.test();
    return c.redirect("/settings/notifications#rang-lately", 303);
  });

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

  // ── The relay (launcher/relay.go): an MCP server's question, answered here and only here ──
  app.post("/relay/ask", async (c) => {
    const q = (await c.req.json().catch(() => null)) as { server?: unknown; message?: unknown; schema?: unknown } | null;
    if (!q || typeof q.message !== "string") return c.json({ error: "a question has a message" }, 400);
    return c.json({ id: asks.put({ server: q.server, message: q.message, schema: q.schema }).id });
  });
  app.get("/relay/ask/:id", async (c) => c.json(await asks.wait(c.req.param("id"), 25_000)));

  // ── Page loads, as the page measured them (src/ui/app.js.ts): numbers, a path and its route, nothing else ──
  app.post("/perf", async (c) => {
    const j = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const path = typeof j?.path === "string" && /^\/[\w\-\/.]{0,200}$/.test(j.path) ? j.path : null;
    if (!j || !path) return c.body(null, 204);
    const num = (k: string) => (typeof j[k] === "number" && Number.isFinite(j[k]) ? Math.round(j[k] as number) : -1);
    // A page reloaded from the back/forward cache or a prerender says nothing of the server.
    if (routeOk(j.route) && j.type !== "back_forward" && num("total") >= 0 && num("total") < 120_000) speed.record("page", j.route, num("total"));
    if (num("total") < 800) return c.body(null, 204);
    const line = [new Date().toISOString(), path, String(j.type).replace(/[^a-z_]/g, "").slice(0, 12), ...["total", "redirect", "worker", "connect", "wait", "download", "dom", "load"].map((k) => `${k}=${num(k)}`)].join(" ");
    perfLog(line);
    return c.body(null, 204);
  });
  /** One answer for a group of questions from the same server (the bar's "Allow all", "Deny all"): each answered, each logged. */
  app.post("/relay/asks/answer", async (c) => {
    const form = await c.req.parseBody();
    const ids = (typeof form.ids === "string" ? form.ids : "").split(",").filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 20);
    const shown = asks.list().filter((q) => ids.includes(q.id));
    // Only a group the bar showed: one server, the same choices.
    const same = shown.length > 0 && shown.every((q) => q.server === shown[0]!.server && q.choices.map((x) => x.value).join() === shown[0]!.choices.map((x) => x.value).join());
    if (same)
      for (const q of shown) {
        const done = asks.answer(q.id, form.decline === "1" ? { decline: true } : { choice: typeof form.choice === "string" ? form.choice : undefined });
        if (done) await logAction(env.DB, { kind: "relay.answer", target: q.server, detail: `${form.decline === "1" ? "declined" : String(form.choice)} (all ${shown.length}) · ${q.message.split(String.fromCharCode(10))[0]!.slice(0, 160)}`, ok: true });
      }
    deps.hub?.publish(["snapshot"]);
    const back = c.req.header("referer");
    const path = back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname + new URL(back).search : "/";
    return c.redirect(path, 303);
  });
  app.post("/relay/ask/:id/answer", async (c) => {
    const form = await c.req.parseBody();
    const id = c.req.param("id");
    const shown = asks.list().find((q) => q.id === id);
    const done = asks.answer(id, form.decline === "1" ? { decline: true } : { choice: typeof form.choice === "string" ? form.choice : undefined });
    if (shown && done) {
      const what = form.decline === "1" ? "declined" : String(form.choice);
      const firstLine = shown.message.split(String.fromCharCode(10))[0]!.slice(0, 160);
      await logAction(env.DB, { kind: "relay.answer", target: shown.server, detail: `${what} · ${firstLine}`, ok: true });
    }
    deps.hub?.publish(["snapshot"]);
    const back = c.req.header("referer");
    const path = back && new URL(back).host === new URL(c.req.url).host ? new URL(back).pathname + new URL(back).search : "/";
    return c.redirect(path, 303);
  });

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
