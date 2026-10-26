/**
 * Dovre: the view from the top (PLAN.md). Local only: every route needs the launch-token
 * cookie on a localhost Host; anything else is a 404, as if nothing were here.
 */
import { ownersIn } from "./owners.ts";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { contextStorage, tryGetContext } from "hono/context-storage";
import { secureHeaders } from "hono/secure-headers";
import { type AccessVerifier, COOKIE, allowed, isLocal, isOwnOrigin, publicOriginOf, sameSecret, secureCookie } from "./access.ts";
import { decide, logAction, recentActions, rejectSuperseded, repoIn, runId } from "./actions/deploys.ts";
import type { App, AppEnv, Env } from "./env.ts";
import type { Gatherer, Snapshot } from "./gather.ts";
import { type Need, needsOf } from "./home/needs.ts";
import { dockShell, type Frame, html, type NavItem, SIDE_JS, SIDE_PATH, shell, tabsOf } from "./html.ts";
import { deploysPage } from "./pages/deploys.ts";
import { CORE_CARDS, packOrder, homePage } from "./pages/home.ts";
import { currentGreeting, currentTz, greetingLang, setWhen, validZone } from "./when.ts";
import { createTodoRoutes, linkCtxOf, todoCard } from "./pages/todo.ts";
import { listTodos } from "./todo/store.ts";
import { movementPage, prsPage } from "./pages/pages.ts";
import type { Ghe } from "./sources/ghe.ts";
import { githubForge } from "./forge/github.ts";
import { type Forge, type ForgeCan, forgeCan } from "./forge/types.ts";
import type { Summaries } from "./ai/summaries.ts";
import { streamSSE } from "hono/streaming";
import type { Hub } from "./live.ts";
import type { Run } from "./agents/runner.ts";
import type { Runner } from "./agents/runner.ts";
import { SID, findSession, modelOf } from "./agents/desk.ts";
import { createStats, type Stats } from "./stats/stats.ts";
import { statsPage } from "./pages/stats.ts";
import { actionsCard, actionsPage } from "./pages/actions.ts";
import { pagesOf, parseQuery, type Row as SearchRow, search } from "./search/search.ts";
import { createGheSearch } from "./search/ghe.ts";
import { searchList, searchPage } from "./pages/search.ts";
import { createIssueRoutes } from "./pages/issues.ts";
import { type Asks, askInBar, createAsks } from "./relay/asks.ts";
import { type Bino, createBino } from "./packs/core/assistant/bino/bino.ts";
import { appsOf, contextOf } from "./packs/core/assistant/bino/context.ts";
import type { BinoMemory } from "./packs/core/assistant/bino/memory.ts";
import type { Route } from "./packs/core/assistant/bino/route.ts";
import { createBinoRoutes } from "./packs/core/assistant/bino/routes.ts";
import { agentViews, createReviewRoutes, type ReviewDeps } from "./pages/reviews.ts";
import type { Kept } from "./issues/templates.ts";
import { edgePath, type SetupLine, settingsPage, setupLines } from "./pages/settings.ts";
import { splashPage, welcomePage } from "./pages/welcome.ts";
import { type Choice, type Config, configFromForm, type PaneId, type PanesOn, type PaneState, saveConfig } from "./config.ts";
import { fixedKeys } from "./env.ts";
import { found } from "./tools.ts";
import { mountPwa } from "./pwa.ts";
import type { Html } from "./ui/kit.ts";
import { mountIngest, tokensPanel, createToken, listTokens, revokeToken, sourceOk } from "./packs/ingest.ts";
import { type AvatarFeeds, avatarFrom, actsFrom, beforePages, bannersFrom, briefingFrom, docksFrom, fillOf, settingsFrom, whatFrom, whereFrom, linkedFrom, needsFrom, noteFrom, type Off, type Refreshes, refresher, refreshLog, ringsOf, safely, todayCards } from "./packs/registry.ts";
import { packsPage } from "./pages/packs.ts";
import { removeDevVar, upsertDevVar } from "./setup.ts";
import { strictOrigin } from "./strict.ts";
import { type LayoutStore, layoutFromForm, layoutStore, withTabs } from "./layout.ts";
import { type LayoutView, layoutPanel } from "./pages/layout.ts";
import { packFeedOf } from "./home/feed.ts";
import { safeUrl } from "./pages/parts.ts";
import type { Pack, PackContext, TodayCard } from "./packs/types.ts";
import { hashOf } from "./ui/style.ts";
import { type Note, type Policy, RING_KINDS, type Rung, policyOf, rings } from "./notify.ts";
import { listRepos } from "./sources/claude.ts";
import { SCRIPT, SCRIPT_PATH } from "./ui/app.js.ts";
import { STYLE, STYLE_PATH } from "./ui/style.ts";
import { branchName, retarget } from "./actions/stacks.ts";
import { stacksOf, waitText } from "./home/stacks.ts";
import { createViewerRoutes } from "./pages/viewer.ts";
import { viewingAs } from "./viewer.ts";
import { createStacks } from "./sources/stacks.ts";
import { stacksPage } from "./pages/stacks.ts";

/** Each pane's pages: 404 while it's switched off. */
const PANE_PATHS: [PaneId, RegExp][] = [
  ["bino", /^\/bino(\/|$)/],
  ["stats", /^\/stats(\/|$)/],
  ["reviews", /^\/prs\/(agent|draft)(\/|$)/],
  ["lab", /^\/lab(\/|$)/],
];

/** Core pages only some forges serve (src/forge/types.ts): not here at all when this one can't. Stats and reviews go with their panes. */
const FORGE_PATHS: [ForgeCan, RegExp][] = [
  ["issues", /^\/issues(\/|$)/],
  ["viewer", /^\/prs\/[^/]+\/[^/]+\/\d+(\/files)?$/],
  ["stacks", /^\/prs\/stacks(\/|$)/],
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

export function navOf(s: Snapshot, opts: { hosted?: boolean; lab?: boolean; bino?: boolean; /** Shown unless switched off. */ stats?: boolean; /** The forge takes new issues (default yes). */ issues?: boolean; /** This instance lists packs (on or off). */ packs?: boolean } = {}): NavItem[] {
  const deploys = s.deploys.ok ? s.deploys.value.length : 0;
  const prs = s.prs.ok ? s.prs.value.mine.length + s.prs.value.review.length : 0;
  // The rail (src/html.ts): groups in order; "You" sits at the foot.
  const items: (NavItem | false)[] = [
    { href: "/", title: "Today", icon: "home" },
    opts.stats !== false && { href: "/stats", title: "Stats", icon: "chart" },
    { href: "/prs", title: "Pull requests", icon: "pr", group: "Code", order: 10, count: prs, hot: s.prs.ok && s.prs.value.review.length > 0 },
    { href: "/deploys", title: "Deploys", icon: "rocket", group: "Code", order: 20, count: deploys, hot: deploys > 0 },
    !opts.hosted && { href: "/code", title: "Code", icon: "code", group: "Code", order: 40 },
    !opts.hosted && { href: "/movement", title: "Moved", icon: "health", group: "Code", order: 50 },
    !!opts.bino && { href: "/bino", title: "Bino", icon: "chat", group: "Agents", order: 20 },
    !opts.hosted && { href: "/todo", title: "My list", icon: "list", group: "Plan" },
    !opts.hosted && opts.issues !== false && { href: "/issues/new", title: "New work", icon: "plus", group: "Plan" },
    !!opts.packs && { href: "/packs", title: "Packs", icon: "layers", group: "You" },
    { href: "/settings", title: "Settings", icon: "gear", group: "You" },
    !opts.hosted && !!opts.lab && { href: "/lab", title: "Lab", icon: "flask", group: "You" },
  ];
  return items.filter((x): x is NavItem => !!x);
}

/** A built app's packs, for the composition roots (their refresh schedule, cron, email). */
const appPacks = new WeakMap<App, { on: Pack[]; off: Off[]; ctxOf: (c: Pack) => PackContext; /** Where the composition root's refresher and cron say how each run went. */ refreshes: Refreshes; /** Hidden in Settings → Layout: its refresh doesn't run. */ hidden: (id: string) => boolean; /** What the shown packs say needs me now (src/packs/registry.ts needsFrom). */ needs: () => Need[]; /** What the packs tell the avatar (avatarFrom), and whether anything has it at work (a pack's thing working, or Bino answering). */ feeds: () => AvatarFeeds & { busy: boolean }; /** The PR links their pages show, for the gather (linkedFrom). */ linked: () => string[] }>();
export const packsOf = (app: App) => appPacks.get(app);

export function createApp(env: Env, deps: { gatherer: Gatherer; ghe: Ghe; /** Settings → Layout's store (default: kept in D1); the demo's is fixed. */ layout?: LayoutStore; /** The forge (src/forge/): what it can't do is hidden. Default: GitHub through `ghe`. */ forge?: Pick<Forge, "id" | "name" | "can">; summaries?: Summaries; runner?: Runner; hub?: Hub; notify?: { policy(): Policy; setPolicy(p: Policy): Promise<void>; log(): Rung[]; test(): void; /** Rings these now (a pack's `ctx.ring`, checked). */ ring?(notes: Note[]): void }; info?: { version: string; startedAt: number }; restart?: () => void; /** Kept GHE answers (data/catalog.json). */ kept?: Kept; /** Load what pages need shortly after starting. */ prewarm?: boolean; /** Where the agents' skills are installed (default: the home folder); for tests. */ skillsHome?: string; /** Questions MCP servers put to me through the relay (launcher/relay.go). */ asks?: Asks; /** Bino, the assistant: its model route and memory (src/packs/core/assistant/bino/); hosted, the Durable Object's (src/hosted/client.ts). */ bino?: { route: Route; memory: BinoMemory; file?: string; log?: (line: string) => void } | { remote: Bino }; /** Hosted: a page's event stream comes from the Durable Object (src/hosted/hub.ts). */ events?: () => Promise<Response>; /** Hosted with a hub: pages listen on its /live socket (H5), /events only if that never opens. */ live?: boolean; /** Hosted mode (IS_HOSTED=1): checks Cloudflare Access on every request. Hosted without it, nobody gets in. */ access?: AccessVerifier; /** The Stats page's numbers, gathered in the background (src/stats/stats.ts). */ stats?: Stats; /** Which panes run (src/config.ts): `false` is off, gone from the menu, search, Today and its routes. */ panes?: PanesOn; /** For Settings: each pane's state, and what Settings keeps. */ config?: { panes: Record<PaneId, PaneState>; stored: Config }; /** Hosted: what the instance has and lacks, for Settings' Setup panel (src/hosted/setup.ts). */ setup?: () => SetupLine[]; /** The packs that run here and those that don't, with why (src/packs/, PLAN D23). */ packs?: { on: Pack[]; off: Off[]; env: Record<string, string | undefined>; bindings?: Record<string, unknown>; /** How long Today waits for a pack's cards (default 250 ms). */ budgetMs?: number; /** Dovre's own packs (src/packs/core/), labelled so on the Packs page. */ core?: string[]; /** Local `.dev.vars` path for saving pack settings from `/packs`. */ varsFile?: string } }): App {
  setWhen({ tz: env.TZ_NAME, lang: env.GREETING });
  const app: App = new Hono<AppEnv>();
  // The request each page is drawn for, without passing it down (the packs' bars are told the path).
  app.use(contextStorage());
  // Local only: the one public address a proxy serves this Dovre at (#74). A bad value throws here.
  const publicOrigin = env.IS_HOSTED === "1" ? undefined : publicOriginOf(env.PUBLIC_ORIGIN);
  if (publicOrigin)
    app.use((c, next) => {
      c.set("publicOrigin", publicOrigin);
      return next();
    });
  const { gatherer, ghe } = deps;
  const summary = (key: string) => deps.summaries?.get(key);
  let flash: { ok: boolean; message: string } | undefined;
  const asks = deps.asks ?? createAsks();
  const stats = deps.stats ?? createStats({ ghe, org: ownersIn(env), login: () => gatherer.peek()?.login, onChange: () => deps.hub?.publish(["stats"]) });
  // Bino: what it's told comes from what's gathered, my list and what each pack says it may know, never more (src/packs/core/assistant/bino/context.ts).
  // Hosted, GitHub's snapshot stays out: the apps' packs say what matters there.
  const hostedMode = env.IS_HOSTED === "1";
  const binoContext = async () =>
    contextOf({
      todos: await listTodos(env.DB),
      s: hostedMode ? undefined : gatherer.peek(),
      org: hostedMode ? undefined : env.GHE_ORG,
      about: env.ABOUT_ME,
      apps: packBino(),
    });
  // The assistant pack is Bino's switch (PACK_ASSISTANT=off): switched off, there's no Bino.
  const binoDeps = deps.packs?.off.some((o) => o.id === "assistant") ? undefined : deps.bino;
  const engine =
    binoDeps && !("remote" in binoDeps)
      ? createBino({
          route: binoDeps.route,
          memory: binoDeps.memory,
          file: binoDeps.file,
          log: binoDeps.log,
          context: async (_c, given) => given ?? binoContext(),
          onChange: (c) => deps.hub?.publish([`bino:${c.id}`, "bino"]),
          kinds: () => packActs(),
        })
      : undefined;
  const bino: Bino | undefined = binoDeps && "remote" in binoDeps ? binoDeps.remote : engine;
  // ── The lab: prototypes and artifacts, kept in data/lab (never committed); in the nav only when there is one ──
  const labDir = resolve(env.U_DB ? dirname(env.U_DB) : "data", "lab");
  /** What this instance's forge can do beyond the gather (GitHub: everything). */
  const forge = deps.forge ?? githubForge(ghe);
  const can = (what: ForgeCan) => forgeCan(forge, what);
  /** A pane switched off on Settings (src/config.ts), or one the forge can't serve. */
  const off = (id: PaneId) => deps.panes?.[id] === false || (id === "stats" && !can("stats")) || (id === "reviews" && !can("reviews"));
  /** A core path the forge can't serve (FORGE_PATHS): it 404s, and menus and search leave it out. */
  const forgeHidden = (href: string) => {
    const path = href.split(/[?#]/)[0]!;
    return FORGE_PATHS.some(([what, re]) => !can(what) && re.test(path));
  };
  const hasLab = () => env.IS_HOSTED !== "1" && !off("lab") && existsSync(resolve(labDir, "index.html"));

  const appHeaders = secureHeaders({
    referrerPolicy: "same-origin",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
    },
  });
  // The docks' pages (Bino's, a pack's) are framed by the app's own pages (src/html.ts), and only by them.
  const dockHeaders = secureHeaders({
    referrerPolicy: "same-origin",
    xFrameOptions: "SAMEORIGIN",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
    },
  });
  // The lab's policy is set per page (below): it needs the page's own origin to name /lab/.
  const labHeaders = secureHeaders({ referrerPolicy: "same-origin", contentSecurityPolicy: undefined });
  /** A dock's page: Bino's, or one under a pack's /<id>/dock when that pack has a dock. */
  const dockPath = (path: string) => {
    const m = /^\/([a-z][a-z0-9-]*)\/dock(\/|$)/.exec(path);
    return !!m && (m[1] === "bino" || packs.on.some((x) => x.manifest.id === m[1] && !!x.dock));
  };
  app.use((c, next) => (c.req.path.startsWith("/lab/") ? labHeaders(c, next) : dockPath(c.req.path) ? dockHeaders(c, next) : appHeaders(c, next)));

  /** Exchanges the launch token for a cookie, on localhost only. */
  mountPwa(app, deps.info ?? { version: "dev", startedAt: Date.now() }, { files: env.IS_HOSTED !== "1" });

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
  const ctxOf = (c: Pack): PackContext => {
    let ctx = contexts.get(c.manifest.id);
    if (!ctx)
      contexts.set(
        c.manifest.id,
        (ctx = {
          env: packs.env,
          bindings: packs.bindings ?? {},
          hosted,
          db: env.DB,
          publish: (topics) => deps.hub?.publish(topics),
          snapshot: () => gatherer.peek(),
          gathered: async () => gatherer.peek() ?? (await Promise.race([gatherer.get().catch(() => undefined), new Promise<undefined>((res) => setTimeout(res, 1200))])),
          fill: (name, arg) => fill(name, arg),
          page: async (cx, o) => {
            const { frame } = await page({ path: cx.req.path });
            return cx.html(shell({ title: o.title, frame, current: o.current ?? cx.req.path, body: o.body, head: o.head }));
          },
          dockPage: (cx, o) => cx.html(dockShell({ title: o.title, body: o.body, head: o.head, styles: PACK_CSS ? [PACK_CSS.path] : undefined })),
          log: packLog(c.manifest.id),
          ring: (n) => {
            const note = noteFrom(c.manifest.id, n, packRings);
            if (note && deps.notify && rings(deps.notify.policy(), note.kind)) deps.notify.ring?.([note]);
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
  // Settings → Layout: packs I've hidden, and packs whose events stay out of the feed (src/layout.ts).
  const layout = deps.layout ?? layoutStore(env.DB);
  const hidden = (id: string) => !!layout.get().packsOff?.includes(id);
  const shown = () => packs.on.filter((c) => !hidden(c.manifest.id));
  const packCss = packs.on.filter((c) => c.styles).map((c) => `/* ${c.manifest.id} */\n${c.styles}`).join("\n");
  const PACK_CSS = packCss ? { path: `/assets/packs.${hashOf(packCss)}.css`, body: packCss } : undefined;
  const packNav = () => shown().flatMap((c) => (c.nav ? safely(() => c.nav!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`nav: ${(e as Error)?.message ?? e}`)) : []));
  const packFeed = () =>
    packFeedOf(
      shown().filter((c) => !layout.get().feedOff?.includes(c.manifest.id)).flatMap((c) => (c.feed ? safely(() => c.feed!(ctxOf(c)), [], (e) => packLog(c.manifest.id)(`feed: ${(e as Error)?.message ?? e}`)).map((item) => ({ pack: c.manifest, item })) : [])),
      Date.now(),
    );
  const packBino = () =>
    appsOf(shown().flatMap((c) => (c.bino ? [{ name: c.manifest.name, own: packs.core?.includes(c.manifest.id), text: safely(() => c.bino!(ctxOf(c)), "", (e) => packLog(c.manifest.id)(`bino: ${(e as Error)?.message ?? e}`)) }] : [])));
  // Core pages' named places (types.ts SlotMap): what each shown pack puts there.
  const fill = fillOf(shown, ctxOf, (id, line) => packLog(id)(line));
  /** What the packs call an actions-log entry of theirs (a name for an id). */
  const packWhere = (a: { kind: string; target: string }) => whereFrom(fill, a);
  const packWhat = (kind: string) => whatFrom(fill, kind);
  /** What Bino may propose that the packs carry out (`acts`): local only, as Bino's own are. */
  const packActs = () => (hosted ? [] : actsFrom(shown(), ctxOf, (id, line) => packLog(id)(line)));
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
  const packCards = (): Promise<{ cards: TodayCard[]; failed: Off[] }> => todayCards(shown(), ctxOf, packs.budgetMs ?? 250);
  /** The packs' kinds of notification (Settings), and what they say needs me (rung once per key by the composition root). */
  const packRings = ringsOf(packs.on, RING_KINDS.map((k) => k.kind), (id, line) => packLog(id)(line));
  const packNeeds = () => needsFrom(shown(), ctxOf, packRings, (id, line) => packLog(id)(line));
  const refreshes = refreshLog(() => deps.hub?.publish(["packs"]));
  const runPackRefresh = refresher(packs.on, ctxOf, (l) => console.log(l), { record: refreshes, skip: hidden });
  appPacks.set(app, { on: packs.on, off: packs.off, ctxOf, refreshes, hidden, needs: packNeeds, feeds: () => {
      const a = avatarFrom(shown(), ctxOf, (id, line) => packLog(id)(line));
      return { ...a, busy: a.working > 0 || !!engine?.list().some((x) => x.thinking) };
    }, linked: () => linkedFrom(shown(), ctxOf, (id, line) => packLog(id)(line)) });
  if (PACK_CSS)
    app.get(PACK_CSS.path, (c) => {
      c.header("Content-Type", "text/css; charset=utf-8");
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.body(PACK_CSS.body);
    });

  /**
   * The snapshot a page draws from, and its frame. With nothing gathered yet (the very first
   * start), a page waits a little, then shows "Gathering…" and swaps itself in when it lands.
   */
  /** Every page's frame: menu, docks, styles, sync state. */
  const frameOf = (s: Snapshot, path = ""): Frame => ({ operator: s.login, look: { theme: layout.get().theme, accent: layout.get().accent }, styles: PACK_CSS ? [PACK_CSS.path] : undefined, nav: withTabs([...navOf(s, { hosted: env.IS_HOSTED === "1", lab: hasLab(), bino: !!bino?.route.ready, stats: !off("stats"), issues: can("issues"), packs: packs.on.length + packs.off.length > 0 }), ...packNav()], layout.get().tabs), syncedAt: s.at, syncing: gatherer.gathering() && Date.now() - s.at > 120_000, host: env.GHE_HOST, asks: asks.list(), docks: docksFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), bino: !!bino?.route.ready, face: (o) => fill("bino.face", o)[0] ?? "", banners: bannersFrom(shown(), ctxOf, path, (id, line) => packLog(id)(line)), tz: env.TZ_NAME ? validZone(env.TZ_NAME) : currentTz(), greeting: greetingLang(env.GREETING), live: deps.live ? "ws" : undefined });

  const page = async (o: { wait?: boolean; /** The page's path: a pack's bar may leave its own page out. */ path?: string } = {}): Promise<{ s: Snapshot; frame: Frame }> => {
    const got = gatherer.peek() ? await gatherer.get({ wait: o.wait }) : await Promise.race([gatherer.get(), new Promise<undefined>((res) => setTimeout(res, 1200))]);
    if (!got) throw new Pending();
    return { s: got, frame: frameOf(got, o.path ?? tryGetContext()?.req.path) };
  };

  app.get("/", async (c) => {
    if (c.req.query("fresh") === "1") {
      gatherer.stale();
      return c.redirect("/", 303);
    }
    if (deps.config && !setUp()) return c.redirect("/welcome", 303);
    const { s, frame } = await page();
    const todo = todoCard(await listTodos(env.DB), linkCtxOf(env, s, packRefs()));
    const actions = actionsCard(await recentActions(env.DB, 6), packWhere, packWhat);
    const packToday = packs.on.length ? await packCards() : undefined;
    return c.html(homePage(frame, s, summary, { cards: layout.get().cards, packs: packToday, apps: briefingFrom(shown(), ctxOf, (id, line) => packLog(id)(line)), own: packs.core, feed: { events: packFeed(), only: env.IS_HOSTED === "1" }, topics: shown().map((c) => c.manifest.id), avatar: fill("today.hero", {})[0], ghe: env.GHE_HOST, forge, rules: packRefs(), agent: await reviewViews(s), todo, actions}));
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
  // ── Agent review of PRs (src/pages/reviews.ts) ──
  /** A finished review's report doesn't change: read once, from the run or the session's transcript. */
  const reports = new Map<string, string>();
  const reviewDeps: ReviewDeps = {
    db: env.DB,
    runner: deps.runner,
    page,
    modelOf,
    home: deps.skillsHome,
    lastMessage(r) {
      const hit = reports.get(r.runId);
      if (hit !== undefined) return hit;
      const run = deps.runner?.get(r.runId);
      const fromRun = run ? ([...run.events].reverse().find((e) => e.t === "result" && e.text.trim()) as { text: string } | undefined)?.text ?? ([...run.events].reverse().find((e) => e.t === "text") as { text: string } | undefined)?.text : undefined;
      // The agent's own last message: what the session page shows, never a tool result.
      const fromTranscript = !fromRun && r.sessionId && SID.test(r.sessionId) ? [...findSession(env.CLAUDE_DIR, r.sessionId, []).turns].reverse().find((t) => t.role === "assistant") : undefined;
      const text = fromRun ?? (fromTranscript && "text" in fromTranscript ? fromTranscript.text : undefined);
      if (text !== undefined) reports.set(r.runId, text);
      return text;
    },
  };
  /** The agent-review block on each PR card: nothing while reviews are switched off. */
  const reviewViews = (s: Snapshot) => (off("reviews") ? Promise.resolve(() => "" as const) : agentViews(reviewDeps, s));
  /** What a live response showed isn't kept by the browser either. */
  const noStore = (res: Response) => (res.headers.set("Cache-Control", "no-store"), res);

  // ── Search (src/search/search.ts): /search as a page; with frag=1, just the list the palette swaps in ──
  const gheSearch = createGheSearch(ghe, ownersIn(env));
  // ── Stats (src/stats/): drawn from what's kept; a visit gathers again when it's due ──
  app.get("/stats", async (c) => {
    const { frame } = await page();
    stats.refresh();
    return c.html(statsPage(frame, stats.view(), { forge }));
  });
  app.post("/stats/refresh", async (c) => {
    stats.refresh(true);
    return c.redirect("/stats", 303);
  });

  app.get("/search", async (c) => {
    const { s, frame } = await page();
    const raw = (c.req.query("q") ?? "").slice(0, 200);
    const pages = pagesOf({ bino: !!bino?.route.ready, lab: hasLab(), stats: !off("stats") }).concat(packs.on.length + packs.off.length ? [{ title: "Packs", href: "/packs", icon: "▦", about: "This instance's apps: on or off here and why, refreshes, settings", also: ["apps", "plugins", "modules", "manifest"] }] : [], packPages());
    // GHE's own search too: on the page, and in the palette once typing pauses (remote=1). At most 3.5 s.
    const parsed = parseQuery(raw, c.req.query("only"));
    const remote = (c.req.query("frag") !== "1" || c.req.query("remote") === "1") && can("search") && (!parsed.only || parsed.only === "issues") ? await Promise.race([gheSearch(parsed.q).catch(() => []), new Promise<[]>((res) => setTimeout(() => res([]), 3500))]) : [];
    const found = packFinds();
    const r = search({ s, hidden: forgeHidden, viewer: can("viewer"), todos: await listTodos(env.DB), repos: listRepos(env.CODE_DIR), pages, apps: found.apps, kinds: found, remote }, raw, { only: c.req.query("only"), per: c.req.query("frag") === "1" ? undefined : 10 });
    if (c.req.query("frag") === "1") return noStore(await c.html(html`${searchList(r)}`));
    return c.html(searchPage(frame, r, raw));
  });

  app.get("/prs", async (c) => {
    const { s, frame } = await page();
    return c.html(prsPage(frame, s, summary, await reviewViews(s), { lead: (p) => fill("pr.lead", p), facts: (p) => fill("pr.facts", p).flat() }, forge));
  });
  // ── Stacked PRs (src/home/stacks.ts, src/sources/stacks.ts) ──
  const stackSource = createStacks(ghe, ownersIn(env), { kept: deps.kept });
  let stackFlash: { ok: boolean; message: string } | undefined;
  app.get("/prs/stacks", async (c) => {
    const { s, frame } = await page();
    const shown = stackFlash;
    stackFlash = undefined;
    // A first read walks every chain (seconds): the page says so and fills itself in.
    const loading = stackSource.load(s.login).then((value) => ({ ok: true as const, value }), (e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
    const got = await Promise.race([loading, new Promise<undefined>((res) => setTimeout(res, 1500))]);
    if (!got) return c.html(stacksPage(frame, { org: env.GHE_ORG, me: s.login, pending: true }));
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return c.html(stacksPage(frame, { org: env.GHE_ORG, me: s.login, flash: shown, ...(got.ok ? { stacks: stacksOf(got.value, { since }) } : { error: got.error }) }));
  });
  // ── Dovre's own PR viewer, diff viewer and code explorer (src/pages/viewer.ts) ──
  app.route(
    "/",
    createViewerRoutes(env, {
      ghe,
      frame: async () => (await page()).frame,
      hub: deps.hub,
      facts: (p) => fill("pr.facts", p).flat(),
      kept: deps.kept,
      agentFor: async (repo, n) => {
        const { s } = await page();
        const p = s.prs.ok ? [...s.prs.value.mine, ...s.prs.value.review].find((x) => x.repo === repo && x.number === n) : undefined;
        return p ? (await reviewViews(s))(p) : "";
      },
      stackFor: async (repo, n) => {
        const { s } = await page();
        // Only when the stacks are already known: the page never waits for the walk.
        const got = await Promise.race([stackSource.load(s.login).catch(() => undefined), new Promise<undefined>((res) => setTimeout(res, 30))]);
        if (!got) return undefined;
        for (const st of stacksOf(got)) {
          const node = st.nodes.find((x) => x.pr.repo === repo && x.pr.number === n);
          if (node && st.nodes.length > 1) return html`<a href="/prs/stacks">${node.position} of ${st.nodes.length} in a stack</a>${node.waits ? ` · ${waitText(node.waits)}` : ""}`;
        }
        return undefined;
      },
    }),
  );
  app.post("/prs/stacks/retarget", async (c) => {
    const form = await c.req.parseBody();
    const repo = repoIn(ownersIn(env), form.repo);
    const number = runId(form.number);
    const from = branchName(form.from);
    stackFlash = repo && number && from ? await retarget(ghe, env.DB, repo, number, from) : { ok: false, message: "That isn't a PR in the org." };
    if (stackFlash.ok) void gatherer.get().then((s) => stackSource.load(s.login, { fresh: true })).catch(() => undefined);
    return c.redirect("/prs/stacks", 303);
  });
  app.get("/movement", async (c) => {
    const { s, frame } = await page();
    const view = ["timeline", "me", "bots"].includes(c.req.query("view") ?? "") ? c.req.query("view")! : "people";
    return c.html(movementPage(frame, s, view));
  });

  /** Runs decided here that the snapshot may not know yet: drawn as decided until a gather after the decision lands. */
  const decided = new Map<number, { state: "approved" | "rejected"; at: number }>();
  app.get("/deploys", async (c) => {
    // No waiting on the gather the decision started: what was decided shows from `decided`, and the page swaps when the gather lands.
    const { s, frame } = await page({ wait: false });
    for (const [id, d] of decided) if ((s.began ?? s.at) > d.at || Date.now() - d.at > 10 * 60_000) decided.delete(id);
    const shown = flash;
    flash = undefined;
    // Only deploy decisions here; everything else is on Today's Actions card and /actions.
    const log = (await recentActions(env.DB, 200)).filter((a) => a.kind.startsWith("deploy.")).slice(0, 20);
    // What's in prod for each repo: the packs' line ("deploy.prod").
    const prodLine = (repo: string) => html`${fill("deploy.prod", { repo })}`;
    return c.html(deploysPage(frame, s, { log, flash: shown, decided, summary, rules: packRefs(), ghe: env.GHE_HOST, prodLine, approve: can("deployApproval") }));
  });
  for (const state of ["approved", "rejected"] as const) {
    app.post(`/deploys/${state === "approved" ? "approve" : "reject"}`, async (c) => {
      const form = await c.req.parseBody();
      const repo = repoIn(ownersIn(env), form.repo);
      const run = runId(form.run);
      flash = repo && run ? await decide(ghe, env.DB, repo, run, state) : { ok: false, message: "That isn't a run in the org." };
      if (flash.ok && run) decided.set(run, { state, at: Date.now() });
      gatherer.stale();
      return c.redirect("/deploys", 303);
    });
  }
  app.post("/deploys/reject-superseded", async (c) => {
    const form = await c.req.parseBody();
    const repo = repoIn(ownersIn(env), form.repo);
    const workflow = typeof form.workflow === "string" && form.workflow.length < 200 ? form.workflow : null;
    try {
      const r = repo && workflow ? await rejectSuperseded(ghe, env.DB, repo, workflow) : { ok: false, message: "That isn't a workflow in the org.", ids: [] };
      for (const id of r.ids) decided.set(id, { state: "rejected", at: Date.now() });
      flash = { ok: r.ok, message: r.message };
    } catch (e) {
      flash = { ok: false, message: String((e as Error).message ?? e) };
    }
    gatherer.stale();
    return c.redirect("/deploys", 303);
  });

  // ── Settings: what's here, the panes (src/config.ts), notifications ──
  let saved = false;
  /** Set when a save restarts Dovre: when this server started, so the page knows when the next one is up. */
  let restarting: number | undefined;
  let settingsBad: string[] | undefined;
  const startedAt = deps.info?.startedAt ?? Date.now();
  /** My teams in the org on GHE, to pick from (asked once, kept 10 minutes; never waited on long). */
  let teamsKept: { at: number; list: Choice[] } | undefined;
  const myTeams = async (): Promise<Choice[] | undefined> => {
    if (teamsKept && Date.now() - teamsKept.at < 10 * 60_000) return teamsKept.list;
    const ask = ghe
      .rest<{ slug?: unknown; name?: unknown; organization?: { login?: unknown } }[]>("/user/teams?per_page=100")
      .then((r) => {
        const list = (Array.isArray(r) ? r : [])
          .filter((t) => String(t.organization?.login ?? "").toLowerCase() === env.GHE_ORG.toLowerCase() && typeof t.slug === "string" && /^[\w.-]{1,100}$/.test(t.slug))
          .map((t) => ({ value: String(t.slug), label: typeof t.name === "string" && t.name ? `${t.name} (${t.slug})` : String(t.slug) }));
        teamsKept = { at: Date.now(), list };
        return list;
      })
      .catch(() => undefined);
    return Promise.race([ask, new Promise<undefined>((res) => setTimeout(res, 1500))]);
  };
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
  /** What the Panes and Work forms show: what Settings keeps, and what .dev.vars or the environment fixes. */
  const panesView = () => {
    if (!deps.config) return undefined;
    const fixed = fixedKeys();
    const e = env as unknown as Record<string, string | undefined>;
    const values: Record<string, string | undefined> = { ...deps.config.stored, CODE_DIR: deps.config.stored.CODE_DIR ?? env.CODE_DIR };
    for (const k of fixed) values[k] = e[k];
    return { panes: deps.config.panes, values, fixed };
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
    };
  };
  app.post("/settings/layout", async (c) => {
    const { frame } = await page();
    const v = await layoutView(frame);
    const next = layoutFromForm(await c.req.parseBody({ all: true }), { hrefs: v.pages.map((p) => p.href), cards: v.cards.map((x) => x.id), feeds: v.feeds.map((f) => f.id), packs: v.packs.map((x) => x.id) });
    // Cards not drawn just now (a pack hidden or slow) keep where I put them.
    await layout.save({ ...next, cards: { ...v.layout.cards, ...next.cards } });
    saved = true;
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect("/settings#layout", 303);
  });
  app.post("/settings/layout/reset", async (c) => {
    await layout.reset();
    saved = true;
    deps.hub?.publish(["snapshot", "packs"]);
    return c.redirect("/settings#layout", 303);
  });

  // Its address before WP-M4.
  app.get("/crates", (c) => c.redirect("/packs", 301));
  let packSaved: string | undefined;
  app.get("/packs", async (c) => {
    const { frame } = await page();
    const wasSaved = packSaved;
    packSaved = undefined;
    return c.html(packsPage(frame, { on: packs.on, off: packs.off, env: packs.env, hosted, refreshes, core: packs.core, saved: wasSaved }));
  });
  app.post("/packs/:id/settings", strictOrigin, async (c) => {
    if (hosted) return c.notFound();
    const id = c.req.param("id");
    const onPack = packs.on.find((x) => x.manifest.id === id);
    const offEntry = packs.off.find((x) => x.id === id);
    const manifest = onPack?.manifest ?? offEntry?.manifest;
    const settings = Array.isArray(manifest?.settings)
      ? manifest.settings.filter((s) => s && typeof s.key === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(s.key))
      : [];
    if (!manifest || !settings.length) return c.notFound();
    const body = await c.req.parseBody();
    for (const s of settings) {
      const val = body[s.key];
      const raw = typeof val === "string" ? val.replace(/[\r\n]+/g, " ").trim().slice(0, 2000) : "";
      if (s.secret) {
        if (body[`clear.${s.key}`] === "1") {
          delete packs.env[s.key];
          if (packs.varsFile) removeDevVar(packs.varsFile, s.key);
        } else if (raw) {
          packs.env[s.key] = raw;
          if (packs.varsFile) upsertDevVar(packs.varsFile, s.key, raw);
        }
      } else if (raw) {
        packs.env[s.key] = raw;
        if (packs.varsFile) upsertDevVar(packs.varsFile, s.key, raw);
      } else {
        delete packs.env[s.key];
        if (packs.varsFile) removeDevVar(packs.varsFile, s.key);
      }
    }
    const missing = settings.find((s) => s.required && !packs.env[s.key]?.trim());
    if (onPack && missing) {
      packs.on.splice(packs.on.indexOf(onPack), 1);
      packs.off.push({ id, name: manifest.name, why: `${missing.key} isn't set`, manifest, pack: onPack });
    } else if (offEntry?.pack && !missing) {
      const p = offEntry.pack;
      packs.off.splice(packs.off.indexOf(offEntry), 1);
      packs.on.push(p);
      try {
        await p.init?.(ctxOf(p));
      } catch (e) {
        packs.on.splice(packs.on.indexOf(p), 1);
        packs.off.push({ id, name: manifest.name, why: `didn't start: ${(e as Error)?.message ?? e}`, manifest });
      }
      if (packs.on.includes(p)) void runPackRefresh.one(p);
    } else if (offEntry && missing) {
      offEntry.why = `${missing.key} isn't set`;
    } else if (onPack) {
      void runPackRefresh.one(onPack);
    }
    packSaved = manifest.name;
    deps.hub?.publish([id, "packs", "snapshot"]);
    return c.redirect(`/packs#pack-${encodeURIComponent(id)}`, 303);
  });

  /** The packs' Settings panels, with core's ingest tokens under each pack that takes ingest (dovre#109). */
  const packPanels = async (made?: { pack: string; source: string; token: string }) => {
    const own = settingsFrom(shown(), ctxOf, (id, line) => packLog(id)(line));
    const out: { id: string; name: string; body: Html }[] = [];
    for (const p of shown()) {
      const id = p.manifest.id;
      const mine = own.find((x) => x.id === id);
      if (!p.ingest) {
        if (mine) out.push(mine);
        continue;
      }
      const tokens = tokensPanel(p, await listTokens(env.DB, id).catch(() => []), { hosted, made: made?.pack === id ? made : undefined });
      out.push({ id, name: p.manifest.name, body: html`${mine?.body ?? ""}${tokens}` });
    }
    return out;
  };
  const showSettings = async (c: Context<AppEnv>, made?: { pack: string; source: string; token: string }) => {
    const { frame } = await page();
    const wasSaved = saved;
    const bad = settingsBad;
    saved = false;
    settingsBad = undefined;
    if (made) c.header("Cache-Control", "no-store");
    return c.html(settingsPage(frame, { rings: packRings, packs: await packPanels(made), policy: deps.notify?.policy() ?? policyOf(undefined), log: deps.notify?.log() ?? [], saved: wasSaved, restarting, info: deps.info, canRestart: !!deps.restart, setup: deps.setup?.() ?? setupNow(frame.operator), panes: panesView(), bad, teams: deps.config ? await myTeams() : undefined, layout: layoutPanel(await layoutView(frame)) }));
  };
  app.get("/settings", (c) => showSettings(c));
  const ingestPack = (id: unknown) => shown().find((p) => p.ingest && p.manifest.id === id);
  // A new token is shown on the page this answers, once; only its hash is kept.
  app.post("/settings/ingest/new", async (c) => {
    const f = await c.req.parseBody();
    const p = ingestPack(f.pack);
    if (!p) return c.notFound();
    if (!sourceOk(f.source)) {
      settingsBad = ["the source's name"];
      return c.redirect(`/settings#pack-${p.manifest.id}`, 303);
    }
    const token = await createToken(env.DB, p.manifest.id, f.source);
    await logAction(env.DB, { kind: "ingest-token", target: `${p.manifest.id}:${f.source}`, ok: true, detail: "made" }).catch(() => {});
    return showSettings(c, { pack: p.manifest.id, source: f.source, token });
  });
  app.post("/settings/ingest/revoke", async (c) => {
    const f = await c.req.parseBody();
    const p = ingestPack(f.pack);
    const id = Number(f.id);
    if (!p || !Number.isInteger(id)) return c.notFound();
    const done = await revokeToken(env.DB, p.manifest.id, id);
    await logAction(env.DB, { kind: "ingest-token", target: `${p.manifest.id}:${id}`, ok: done, detail: "revoked" }).catch(() => {});
    return c.redirect(`/settings#pack-${p.manifest.id}`, 303);
  });
  /** When this server started: a page waiting out a restart asks until it changes. */
  app.get("/settings/started", (c) => noStore(c.text(String(startedAt))));
  // ── The first-run page (src/pages/welcome.ts): Today sends here until it's answered or skipped ──
  const setUp = () => !!(env.SETUP_DONE || deps.config?.stored.SETUP_DONE);
  let welcomeBad: string[] | undefined;
  app.get("/welcome", async (c) => {
    const view = panesView();
    if (!view) return c.notFound();
    const { frame } = await page();
    const bad = welcomeBad;
    welcomeBad = undefined;
    const started = c.req.query("started") === "1" && restarting ? restarting : undefined;
    // The splash first; Get started opens the setup.
    if (!started && !bad && c.req.query("go") !== "1") return c.html(splashPage({ version: deps.info?.version ?? "dev" }));
    return c.html(welcomePage(frame, { setup: setupNow(frame.operator), panes: view, teams: started ? undefined : await myTeams(), canRestart: !!deps.restart, bad, started }));
  });
  app.post("/welcome", async (c) => {
    if (!deps.config) return c.notFound();
    const { config, bad } = configFromForm(await c.req.parseBody(), deps.config.stored, fixedKeys(), { panes: true, general: true });
    if (bad.length) {
      welcomeBad = bad;
      return c.redirect("/welcome?go=1", 303);
    }
    return c.redirect((await keep({ ...config, SETUP_DONE: "1" })) ? "/welcome?started=1" : "/", 303);
  });
  app.post("/welcome/skip", async (c) => {
    if (!deps.config) return c.notFound();
    await saveConfig(env.DB, { ...deps.config.stored, SETUP_DONE: "1" });
    deps.config.stored = { ...deps.config.stored, SETUP_DONE: "1" };
    return c.redirect("/", 303);
  });
  /** The Panes form, or the Work form: kept, then Dovre starts again with it (under the supervisor). */
  for (const [path, scope] of [["/settings/panes", { panes: true }], ["/settings/work", { general: true }]] as const)
    app.post(path, async (c) => {
      if (!deps.config) return c.notFound();
      const { config, bad } = configFromForm(await c.req.parseBody(), deps.config.stored, fixedKeys(), scope);
      if (bad.length) {
        settingsBad = bad;
        return c.redirect("/settings", 303);
      }
      saved = true;
      await keep(config);
      return c.redirect("/settings", 303);
    });
  app.post("/settings/notify", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const kinds = new Set([form.kind ?? []].flat().map(String));
    const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : undefined);
    const next = policyOf({
      // The kinds on the form: the core's and the shown packs'; any other keeps what it was.
      kinds: { ...(deps.notify?.policy().kinds ?? {}), ...Object.fromEntries([...RING_KINDS, ...packRings].map((k) => [k.kind, kinds.has(k.kind)])) },
      longTurnMin: num(form.longTurnMin),
      bundleSec: num(form.bundleSec),
      workHoursOnly: form.workHoursOnly === "on",
    });
    await deps.notify?.setPolicy(next);
    saved = true;
    return c.redirect("/settings", 303);
  });
  app.post("/settings/restart", (c) => {
    // The supervisor (`dovre supervise`, launcher/) starts it again; the page waits on the starting page.
    setTimeout(() => deps.restart?.(), 300);
    return c.redirect("/settings", 303);
  });
  app.post("/settings/notify/test", (c) => {
    deps.notify?.test();
    return c.redirect("/settings", 303);
  });

  app.route("/", createReviewRoutes(env, { ...reviewDeps, ghe, stale: () => gatherer.stale() }));
  app.route("/", createIssueRoutes(env, { ghe, frame: async () => (await page()).frame, kept: deps.kept, newWork: () => fill("work.new", {}), list: () => (shown().some((x) => x.manifest.id === "tracker") ? "/tracker" : undefined), prewarm: deps.prewarm }));
  // ── My list (src/pages/todo.ts): small things kept on this machine ──
  app.route("/", createTodoRoutes(env, { page, rules: packRefs, hub: deps.hub, bino: !!bino?.route.ready, proposals: async () => html`${fill("todo.proposals", {})}` }));
  if (bino)
    app.route(
      "/",
      createBinoRoutes(env, {
        bino,
        page,
        hub: deps.hub,
        peek: () => gatherer.peek(),
        packAct: (kind) => packActs().find((k) => k.kind === kind),
        // The object hosted has no packs or list of its own: what Bino knows goes with each message.
        context: engine ? undefined : binoContext,
        apps: () =>
          packs.on.map((c) => ({
            id: c.manifest.id,
            name: c.manifest.name,
            paths: c.manifest.paths,
            own: packs.core?.includes(c.manifest.id),
            private: c.manifest.private === true,
            about: c.about ? (path: string) => safely(() => c.about!(ctxOf(c), path), undefined, (e) => packLog(c.manifest.id)(`about: ${(e as Error)?.message ?? e}`)) : undefined,
          })),
      }),
    );

  // ── The lab: design prototypes made from real data, kept in data/lab (never committed) ──
  // Lab pages are inline-scripted prototypes and artifacts. They may show and frame each other,
  // and nothing else: no fetch, no forms, no frames of the app's own pages, so a page in data/lab
  // can't act (or read) as me. They get a way back to the app.
  const labCsp = (origin: string) =>
    [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      `img-src data: ${origin}/assets/ ${origin}/lab/`,
      "font-src data:",
      `frame-src ${origin}/lab/`,
      "connect-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join("; ");
  const LAB_EXIT = `<a href="/" target="_top" id="u-lab-exit" style="position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:6px 11px;border-radius:8px;background:#0e1922;color:#e6ecf0;font:600 13px/1.2 'Segoe UI',system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 10px rgb(0 0 0 / .3);opacity:.85">← Dovre</a><script>if (window.top !== window) document.getElementById("u-lab-exit").remove();</script>`;
  app.get("/lab", (c) => c.redirect("/lab/index.html", 303));
  app.get("/lab/*", async (c) => {
    const rel = decodeURIComponent(c.req.path.slice("/lab/".length));
    const file = resolve(labDir, rel);
    if (!/^[\w/-]+\.html$/.test(rel) || !file.startsWith(labDir + sep) || !existsSync(file)) return c.notFound();
    let body = await readFile(file, "utf8");
    // Pages written for the artifact viewer leave out the document skeleton it adds.
    if (!/^\s*<!doctype/i.test(body))
      body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
    // The way back, on every lab page shown on its own (a page framed by the lab's index has the index's).
    body = /<body[^>]*>/i.test(body) ? body.replace(/<body[^>]*>/i, (m) => m + LAB_EXIT) : LAB_EXIT + body;
    c.header("Content-Security-Policy", labCsp(new URL(c.req.url).origin));
    return c.html(body);
  });

  // ── The relay (launcher/relay.go): an MCP server's question, answered here and only here ──
  app.post("/relay/ask", async (c) => {
    const q = (await c.req.json().catch(() => null)) as { server?: unknown; message?: unknown; schema?: unknown } | null;
    if (!q || typeof q.message !== "string") return c.json({ error: "a question has a message" }, 400);
    return c.json({ id: asks.put({ server: q.server, message: q.message, schema: q.schema }).id });
  });
  app.get("/relay/ask/:id", async (c) => c.json(await asks.wait(c.req.param("id"), 25_000)));

  // ── Slow page loads, as the page measured them (src/ui/app.js.ts): numbers and a path, nothing else ──
  app.post("/perf", async (c) => {
    const j = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const path = typeof j?.path === "string" && /^\/[\w\-\/.]{0,200}$/.test(j.path) ? j.path : null;
    if (!j || !path) return c.body(null, 204);
    const num = (k: string) => (typeof j[k] === "number" && Number.isFinite(j[k]) ? Math.round(j[k] as number) : -1);
    const line = [new Date().toISOString(), path, String(j.type).replace(/[^a-z_]/g, "").slice(0, 12), ...["total", "redirect", "worker", "connect", "wait", "download", "dom", "load"].map((k) => `${k}=${num(k)}`)].join(" ");
    try {
      const file = resolve(env.U_DB ? dirname(env.U_DB) : "data", "perf.log");
      if (!existsSync(file) || statSync(file).size < 200_000) appendFileSync(file, `${line}${String.fromCharCode(10)}`);
    } catch {}
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
  // (A pack's /<id>/callback, mounted before the guard above, is its own, not the core's.)
  const callbacks = new Set((deps.packs?.on ?? []).filter((x) => x.callback).map((x) => `/${x.manifest.id}/callback`));
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
    // Hidden in Settings → Layout or switched off: its pages answer 404 until it's on and shown again.
    const gate = async (cx: Context<AppEnv>, next: () => Promise<void>) => (hidden(id) || !packs.on.includes(c) ? cx.notFound() : next());
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
  for (const o of packs.off) {
    if (o.pack && !mountPackRoutes(o.pack, true)) delete o.pack;
  }

  app.notFound((c) => c.text("Not found", 404));
  app.onError((err, c) => {
    if (err instanceof Pending) return c.html(pendingPage(new URL(c.req.url).pathname, { ...frameOf({ ...EMPTY, login: env.GITHUB_USER ?? "" }), syncedAt: undefined, syncing: false }));
    console.error(err);
    return c.text(`Something broke: ${err.message}`, 500);
  });
  return app;
}
