/**
 * Dovre: the view from the top (PLAN.md). Local only: every route needs the launch-token
 * cookie on a localhost Host; anything else is a 404, as if nothing were here.
 * Settings and Packs, the first run and pack setup, and the relay are route modules in src/routes/,
 * given the part of the app's state they use (src/routes/scope.ts).
 * The packs' side (each one's ctx, core's call of every hook, their assets and routes) is src/packs/mount.ts.
 */
import type { McpRun } from "./ai/mcpcalls.ts";
import type { Run } from "./agents/runner.ts";
import { type AgentHost, type AiRoute } from "./packs/ai.ts";
import { ownersIn } from "./owners.ts";
import { slowLog } from "./slow.ts";
import { createSpeed, type Speed, speedLog, WAITED } from "./speed.ts";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { contextStorage, tryGetContext } from "hono/context-storage";
import { secureHeaders } from "hono/secure-headers";
import { type AccessVerifier, COOKIE, allowed, isLocal, isOwnOrigin, publicOriginOf, sameSecret, secureCookie } from "./access.ts";
import { recentActions } from "./actions/deploys.ts";
import type { App, AppEnv, Env } from "./env.ts";
import type { Gatherer, Snapshot } from "./gather.ts";
import { type Need } from "./home/needs.ts";
import { type Frame, html, type NavItem, SIDE_JS, SIDE_PATH, shell } from "./html.ts";
import { homePage } from "./pages/home.ts";
import { browserZone, currentTz, greetingLang, setWhen, validZone } from "./when.ts";
import type { Ghe } from "./sources/ghe.ts";
import { githubForge } from "./forge/github.ts";
import { type Forge, type ForgeCan, forgeCan } from "./forge/types.ts";
import { streamSSE } from "hono/streaming";
import type { Hub } from "./live.ts";
import type { Runner } from "./agents/runner.ts";
import { statsPage } from "./pages/stats.ts";
import { actionsCard, actionsPage } from "./pages/actions.ts";
import { pagesOf, parseQuery, search } from "./search/search.ts";
import { createGheSearch } from "./search/ghe.ts";
import { searchList, searchPage } from "./pages/search.ts";
import { createBugRoutes } from "./pages/bug.ts";
import { HOME_SOURCE as PACKS_HOME } from "./packs/releases.ts";
import { type Asks, createAsks } from "./relay/asks.ts";
import { type Bino, createBino } from "./packs/core/assistant/bino/bino.ts";
import type { Lookups } from "./packs/core/assistant/bino/lookups.ts";
import { contextOf } from "./packs/core/assistant/bino/context.ts";
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
import { type Config, type PaneId, type PanesOn, type PaneState } from "./config.ts";
import { found } from "./tools.ts";
import { mountPwa } from "./pwa.ts";
import { type Html } from "./ui/kit.ts";
import { writeClicksStore, writeKinds } from "./writes.ts";
import { mountMcp } from "./mcp.ts";
import { mountIngest } from "./packs/ingest.ts";
import { mountPacks, PACK_ROUTE_MS } from "./packs/mount.ts";
import { beforePages, bannersFrom, briefingFrom, docksFrom, linkedFrom, needsFrom, type Off, type Refreshes, refresher } from "./packs/registry.ts";
import type { Keys } from "./secretrefs.ts";
import { manifestSettings } from "./pages/packs.ts";
import type { Copies } from "./packs/copies.ts";
import { strictOrigin } from "./strict.ts";
import { webUrl } from "./open-link.ts";
import { type Layout, type LayoutStore, layoutStore, withTabs } from "./layout.ts";
import { coreTheme, paletteOf } from "./ui/themes.ts";
import { safeUrl } from "./pages/parts.ts";
import type { AiSummary, ListShare, Pack, PackContext, PrSlotArg } from "./packs/types.ts";
import { type Note, type Policy, type Rung } from "./notify.ts";
import { listRepos } from "./sources/claude.ts";
import { GO_KEYS, SCRIPT, SCRIPT_PATH } from "./ui/app.js.ts";
import { SETUP_JS, SETUP_JS_PATH } from "./ui/setup.js.ts";
import { STYLE, STYLE_PATH } from "./ui/style.ts";
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
const appPacks = new WeakMap<App, { on: Pack[]; off: Off[]; ctxOf: (c: Pack) => PackContext; /** Where the composition root's refresher and cron say how each run went. */ refreshes: Refreshes; /** Hidden in Settings → Layout: its refresh doesn't run. */ hidden: (id: string) => boolean; /** What the shown packs say needs me now (src/packs/registry.ts needsFrom). */ needs: () => Need[]; /** Their ring kinds that start off (RingDecl.off). */ startsOff: ReadonlySet<string>; /** The PR links their pages show, for the gather (linkedFrom). */ linked: () => string[]; /** What Bino may look up (hosted: the DO asks through src/hosted/lookups.ts). */ lookups: Lookups; /** Whether a page answers here (its pack is on and shown). */ pageOn: (href: string) => boolean; /** Hosted (#428): once the start read the keys, their packs on or off as they came back. */ keysRead: () => Promise<void>; /** After a pack's refresh failed: its keys read again, at most every 10 minutes. */ keysAgain: (p: Pack) => void; /** The packs' one refresher: the roots' schedule calls its `due()`. */ refresh: ReturnType<typeof refresher>; /** Local: the runner says a turn changed; a pack's turn that ended is told to its refresh (#479). */ agentChanged: (r: Run) => void }>();
export { PACK_ROUTE_MS };
export const packsOf = (app: App) => appPacks.get(app);

/** In a pack session, the paths that answer: the pack's own (its id and manifest paths), sign-in, assets and the event stream. */
export function sessionPath(path: string, owned: string[]): boolean {
  if (path === "/login" || path === "/events" || path.startsWith("/assets/")) return true;
  return owned.some((p) => path === `/${p}` || path.startsWith(`/${p}/`));
}

export function createApp(env: Env, deps: { gatherer: Gatherer; /** Local: where slow requests and page loads are written (data/perf.log). */ perfLog?: (line: string) => void; /** Page speed's counts (src/speed.ts); default: this app's own. */ speed?: Speed; ghe: Ghe; /** Settings → Layout's store (default: kept in D1); the demo's is fixed. */ layout?: LayoutStore; /** The forge (src/forge/): what it can't do is hidden. Default: GitHub through `ghe`. */ forge?: Pick<Forge, "id" | "name" | "can"> & Partial<Pick<Forge, "host" | "work" | "merged" | "repos" | "untriaged" | "shipped" | "file" | "everyRepo" | "pr" | "dir" | "propose">>; /** Local: keeps a pack's picture for the starting page (PackContext.startPicture). */ startPicture?: (svg: string) => void; /** Local: the model packs may ask once I allow them (#466: AI_VIA); none, and `ctx.complete` says so. */ ai?: AiRoute; /** What packs' MCP calls run through (#488): Claude Code here. Tests give a made-up one. */ mcp?: McpRun; /** What packs' agent turns run on (#467); default: the runner's. Tests give a made-up one. */ agents?: AgentHost; runner?: Runner; /** Local: the open terminals' MCP tokens (#172), beside the runner's turns; in a pack session, its own (#371). */ mcpTurns?: (token: string) => { id: string; repo: string; cwd: string } | undefined; /** Local: Settings → Pack tools for agents (#172). */ agentTools?: { view(): Omit<AgentToolsView, "said">; register(h: ToolsHarness): { ok: true } | { ok: false; why: string } }; /** Local mode: opens a checked web address in the system's default browser (src/open-link.ts). */ openUrl?: (href: string) => void; hub?: Hub; notify?: { policy(): Policy; setPolicy(p: Policy): Promise<void>; log(): Rung[]; test(): void; /** Rings these now (a pack's `ctx.ring`, checked). */ ring?(notes: Note[]): void }; info?: { version: string; startedAt: number }; restart?: () => void; /** Kept GHE answers (data/catalog.json). */ kept?: Kept; /** Load what pages need shortly after starting. */ prewarm?: boolean; /** Where the agents' skills are installed (default: the home folder); for tests. */ skillsHome?: string; /** Questions MCP servers put to me through the relay (launcher/relay.go). */ asks?: Asks; /** Bino, the assistant: its model route and memory (src/packs/core/assistant/bino/); hosted, the Durable Object's (src/hosted/client.ts). */ bino?: { route: Route; memory: BinoMemory; file?: string; log?: (line: string) => void } | { remote: Bino }; /** Hosted: a page's event stream comes from the Durable Object (src/hosted/hub.ts). */ events?: () => Promise<Response>; /** Hosted with a hub: pages listen on its /live socket (H5), /events only if that never opens. */ live?: boolean; /** Hosted mode (IS_HOSTED=1): checks Cloudflare Access on every request. Hosted without it, nobody gets in. */ access?: AccessVerifier; /** Which panes run (src/config.ts): `false` is off, gone from the menu, search, Today and its routes. */ panes?: PanesOn; /** What the climb was told (src/onboarding.ts); default: kept in D1. */ onboarding?: OnboardingStore; /** Hosted: the paired machines, for the climb's "Bring your laptop?". */ machines?: () => Promise<{ name?: string; online: boolean }[]>; /** For Settings: each pane's state, and what Settings keeps. */ config?: { panes: Record<PaneId, PaneState>; stored: Config }; /** Hosted: what the instance has and lacks, for Settings' Setup panel (src/hosted/setup.ts). */ setup?: () => SetupLine[]; /** Settings → What Dovre sends (#145): the record of calls home, hosted the hub's, on a machine its bridge's file. */ sent?: () => Promise<SentView>; /** A pack session (#353, src/run.ts): only this pack's pages, sign-in, assets and the event stream; no cockpit. */ session?: { pack: string; /** The one checkout under CODE_DIR its packs see (#368). */ checkout?: string }; /** The packs that run here and those that don't, with why (src/packs/, PLAN D23). */ packs?: { on: Pack[]; off: Off[]; env: Record<string, string | undefined>; bindings?: Record<string, unknown>; /** How long Today waits for a pack's cards (default 250 ms). */ budgetMs?: number; /** How long a pack's page may take before it shows as broken (default 30 s). */ routeMs?: number; /** Dovre's own packs (src/packs/core/), labelled so on the Packs page. */ core?: string[]; /** Local `.dev.vars` path for saving pack settings from `/packs`. */ varsFile?: string; /** Secret settings read from a store (#416; hosted #428). */ keys?: Keys; /** Local: packs copied from dovre-packs, and Update (src/packs/copies.ts). */ copies?: Copies } }): App {
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
  const hosted = env.IS_HOSTED === "1";
  const binoContext = async () =>
    contextOf({
      todos: await sharedList()?.items(),
      s: hosted ? undefined : gatherer.peek(),
      org: hosted ? undefined : env.GHE_ORG,
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

  /** What the climb was told, and how far each pack's own setup is (src/onboarding.ts). */
  const onboarding = deps.onboarding ?? onboardingStore(env.DB);
  // Settings → Layout: packs I've hidden, and packs whose events stay out of the feed (src/layout.ts).
  const layout = deps.layout ?? layoutStore(env.DB);
  // ── Packs (src/packs/mount.ts, PLAN D23): each pack's ctx and core's call of every hook, made here; their routes mount below, after every core route ──
  const {
    packs, ctxOf, packLog, shown, hidden, held, pageOn, shared, sharedList, shipsWasm, styles: packStyles, scripts: packScripts, packThemes,
    packNav, packFeed, packBino, packApps, packFrames, packIsolated, fill, packWhere, packWhat, packActs, packLookups, runLookup, packPages, packFinds, packRefs,
    packCards, packRings, startsOff, packNeeds, packStats, packLinked, refreshes, runPackRefresh, agentChanged, keysRead, keysAgain, packIds, packsGet, instanceRepo, opening, releases,
    setupOf, setupLeft, aiStore, aiAsk, envSeen, bindingsSeen, mountCallbacks, mountAssets, mountRoutes,
  } = mountPacks(app, { env, deps, hosted, ghe, forge, asks, layout, onboarding, publicOrigin, page: (o) => page(o), thinking: () => !!engine?.list().some((x) => x.thinking), settle: (id) => settleSettings(id), pending: (err) => err instanceof Pending, bugHref });
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
  const withPackFrames: typeof appHeaders = (c, next) => {
    const frames = packFrames(c.req.path);
    if (!frames.length) return appHeaders(c, next);
    const key = frames.join(" ");
    let h = framedHeaders.get(key);
    if (!h) framedHeaders.set(key, (h = appPolicy(frames)));
    return h(c, next);
  };
  // The docks' pages (Bino's, a pack's) are framed by the app's own pages (src/html.ts), and only by them.
  // COEP too: an isolated pack's page (`isolated`) may open a dock, and frames only pages that send it.
  const dockHeaders = secureHeaders({
    referrerPolicy: "same-origin",
    xFrameOptions: "SAMEORIGIN",
    crossOriginEmbedderPolicy: true,
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
  // An isolated pack's own pages (API 2.2): COEP beside the COOP every page has, so they're
  // cross-origin isolated and may use SharedArrayBuffer (WebAssembly threads).
  app.use(async (c, next) => {
    await next();
    if (packIsolated(c.req.path)) c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  });

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

  const openUrl = hosted ? undefined : deps.openUrl;
  // A pack's sign-in return (`callback`): before the guard, on this machine's own address, never hosted.
  mountCallbacks();
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

  /** The list as search reads it: its items, and where each is shown. */
  const listOf = async (l: ListShare | undefined) => (l ? { items: await l.items().catch(() => []), href: (id: number) => l.href(id) } : undefined);
  /** A PR's or deploy's summary, from the pack that writes them ("ai.summary"): only its own shape is drawn. */
  const summary = (key: string): AiSummary | undefined => fill("ai.summary", { key }).find((x): x is AiSummary => !!x && (x.state === "pending" || (x.state === "ready" && typeof x.text === "string") || (x.state === "failed" && typeof x.error === "string")));
  appPacks.set(app, { on: packs.on, off: packs.off, ctxOf, refreshes, hidden, needs: packNeeds, startsOff, linked: packLinked, lookups: { specs: () => packLookups().map(({ run: _r, pack: _p, ...spec }) => spec), run: runLookup }, pageOn: (href) => pageOn(href), keysRead, keysAgain, refresh: runPackRefresh, agentChanged });
  mountAssets();

  /**
   * The snapshot a page draws from, and its frame. With nothing gathered yet (the very first
   * start), a page waits a little, then shows "Gathering…" and swaps itself in when it lands.
   */
  /** Every page's frame: menu, docks, styles, sync state. */
  /** Bino answers, and its pack is on (a pack switched off on Packs takes Bino with it, #271). */
  const binoOn = () => !!bino?.route.ready && !!assistant && packs.on.includes(assistant) && !hidden("assistant");
  /** The theme to wear: core's own, or a pack's while that pack is on and shown (else the system's), with its bar colour. */
  const themeNow = (): { theme?: string; bar?: string } => {
    const id = layout.get().theme;
    if (!id || coreTheme(id)) return { theme: id };
    const t = packThemes().find((x) => x.id === id);
    return t ? { theme: t.id, bar: paletteOf(t)["--sky"] } : {};
  };
  const fullFrame = (s: Snapshot, path = ""): Frame => ({ operator: s.login, look: { ...themeNow(), accent: layout.get().accent, font: layout.get().font, textSize: layout.get().textSize, lineHeight: layout.get().lineHeight, binoIcon: layout.get().binoButton === "icon", motion: layout.get().motion, links: openUrl && layout.get().links === "default" ? "default" : undefined }, styles: packStyles, scripts: packScripts, nav: withTabs([...navOf(s, { hosted: env.IS_HOSTED === "1", bino: binoOn(), stats: statsOn(), packs: packs.on.length + packs.off.length > 0 }), ...packNav()], layout.get().tabs), syncedAt: s.at, syncing: gatherer.gathering() && Date.now() - s.at > 120_000, host: env.GHE_HOST, asks: asks.list(), docks: docksFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), bino: binoOn(), face: (o) => fill("bino.face", o)[0] ?? "", banners: bannersFrom(shown(), ctxOf, path, (id, line) => packLog(id)(line)), tz: env.TZ_NAME ? validZone(env.TZ_NAME) : currentTz(), tzAuto: hosted && !env.TZ_NAME?.trim() ? true : undefined, greeting: greetingLang(env.GREETING), live: deps.live ? "ws" : undefined, goOff: Object.keys(GO_KEYS).filter((k) => !pageOn(GO_KEYS[k]!)) });
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
  const { keep, settleSettings, settingsAreas, restarting } = settingsRoutes(app, { packThemes, publicOrigin, refreshes, env, deps, hosted, packs, ctxOf, packLog, shown, layout, onboarding, page, noStore, setupOf, setupLeft, speed, ghe, forge, clicks, aiStore, aiAsk, keyPrefs, openUrl, held, hidden, packIds, envSeen, bindingsSeen, packCards, packRings, packStats, runPackRefresh, instanceRepo, opening, releases, packsGet });
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
      assets: { styles: packStyles, scripts: packScripts },
      // The object hosted has no packs or list of its own: what Bino knows goes with each message.
      context: engine ? undefined : binoContext,
      apps: packApps,
    });

  relayRoutes(app, { env, deps, asks, perfLog, speed });

  // Packs' routes last, each under its own /<id> on its own sub-app (src/packs/mount.ts).
  mountRoutes();

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
