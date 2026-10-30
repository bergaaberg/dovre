/**
 * Dovre hosted (PLAN D16, D23): the Worker an instance repo deploys. The instance's own entry calls
 * `createWorker({ packs })` with its packs and exports the result; its wrangler config holds the
 * domain, Access, D1 and whatever bindings its packs need. Cloudflare Access is checked on every
 * request (src/access.ts); without it configured nobody gets in.
 */
import { type Actor, actingAs, currentActor } from "./actor.ts";
import { ownersIn, ownersOf, primaryOf } from "./owners.ts";
import { type AccessVerifier, accessConfigOf, createAccessVerifier } from "./access.ts";
import { keyOk, LEGACY_MACHINE, machineOk } from "./bridge/wire.ts";
import { sameSecret } from "./access.ts";
import { packsOf, createApp } from "./app.ts";
import { activePacks, initAll, refresher } from "./packs/registry.ts";
import type { Pack, Defer, ScheduledEvent } from "./packs/types.ts";
import type { D1 } from "./db.ts";
import type { App, Env } from "./env.ts";
import { createGatherer, type Gatherer, type Snapshot, type SnapshotStore, shownOf } from "./gather.ts";
import { d1SnapshotStore } from "./hosted/snapshot.ts";
import { createGhe, type Ghe, missingGhe } from "./sources/ghe.ts";
import { d1Reads } from "./sources/files.ts";
import { githubForge } from "./forge/github.ts";
import { forgeIdOf, pickForge } from "./forge/pick.ts";
import type { Forge } from "./forge/types.ts";
import { loadMemory, memoryLater } from "./packs/core/assistant/bino/memory.ts";
import { type HubClient, hubClient, type HubNamespace, remoteBino } from "./hosted/client.ts";
import { remoteDesk } from "./bridge/remote.ts";
import { useFoundModels } from "./agents/harnesses/index.ts";
import { agentsPack } from "./packs/core/agents/index.ts";
import { assistantPack } from "./packs/core/assistant/index.ts";
import { issuesPack } from "./packs/core/issues/index.ts";
import { createDismissed } from "./agents/dismissed.ts";
import { localDesk } from "./agents/desk.ts";
import { createQueue } from "./agents/queue.ts";
import { type HubEnv, hostedBinoRoute, MACHINE_HEADER, OWNER_HEADER } from "./hosted/hub.ts";
import { hostedSetup, setupPage, tablesOk } from "./hosted/setup.ts";
import { serveLookups } from "./hosted/lookups.ts";

export interface WorkerBindings {
  DB: D1;
  /** The icons and fonts (assets/, [assets] in the wrangler config), served at /assets/… like the local server does. */
  ASSETS?: { fetch(req: Request): Promise<Response> };
  GITHUB_USER?: string;
  GITHUB_TOKEN?: string;
  /** Which forge the code lives on: "github" (the default) or one an instance pack brings (src/forge/). */
  FORGE?: string;
  /** The one host and the owners tracked there (src/owners.ts); GHE_HOST, GHE_ORG and GITHUB_USER still read. */
  REPO_HOST?: string;
  REPO_OWNERS?: string;
  GHE_HOST?: string;
  GHE_ORG?: string;
  CF_ACCOUNT_ID?: string;
  /** The Access team ("myteam" or "myteam.cloudflareaccess.com") and the application's AUD tag: both needed, or nobody gets in. */
  CF_ACCESS_TEAM?: string;
  CF_ACCESS_AUD?: string;
  /** Instead of Access: any issuer that signs RS256 JWTs and publishes a JWKS (default `<issuer>/.well-known/jwks.json`). Wins when set. */
  AUTH_ISSUER?: string;
  AUTH_AUD?: string;
  AUTH_JWKS_URL?: string;
  ALLOWED_EMAILS?: string;
  IS_HOSTED?: string;
  /** The Durable Object (src/hosted/hub.ts, exported by the instance as DovreHub): pages' live updates and Bino. */
  HUB?: HubNamespace;
  /** Bino through AI Gateway: the gateway's token, and its name (default "dovre"). */
  CF_AIG_TOKEN?: string;
  AI_GATEWAY?: string;
  /** The name of the Anthropic key stored in the gateway, when it isn't `default`. */
  AI_GATEWAY_KEY_ALIAS?: string;
  /**
   * The bridge (PLAN D24, H6, H7): the key machines' frames are signed with (each machine's derived
   * from it), without which /bridge is closed; and the Access service token's client id the one
   * machine `mac` signs in with, when it's Access (machines an issuer names need no setting).
   */
  BRIDGE_CLIENT_ID?: string;
  BRIDGE_KEY?: string;
  /** Cron over HTTP, for hosts without native cron triggers: `POST /_dovre/scheduled` with this as the Bearer key (32+ characters). Unset, the route is a 404. */
  CRON_KEY?: string;
  /** Anything else the packs bind (service bindings, R2, more D1s, send_email) or read (vars, secrets). */
  [binding: string]: unknown;
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

/**
 * POST /_dovre/scheduled with `Authorization: Bearer <CRON_KEY>`: runs the cron and answers 204 when it's done,
 * so a caller can retry per instance. No key set, a wrong one, or another method: 404. Not set up: 503.
 */
async function scheduledIn(request: Request, bindings: WorkerBindings, ctx: Ctx | undefined, notSetUp: (b: WorkerBindings) => Promise<string | undefined>, run: (e: ScheduledEvent, b: WorkerBindings, c: Ctx) => Promise<void>): Promise<Response> {
  const presented = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (request.method !== "POST" || !keyOk(bindings.CRON_KEY) || !sameSecret(presented, bindings.CRON_KEY)) return new Response("Not found", { status: 404 });
  if (await notSetUp(bindings)) return new Response("Not set up", { status: 503, headers: { "cache-control": "no-store" } });
  const later: Promise<unknown>[] = [];
  await run({ cron: request.headers.get("x-dovre-cron")?.slice(0, 64) || "http", scheduledTime: Date.now() }, bindings, ctx ?? { waitUntil: (p) => void later.push(p) });
  if (later.length) await Promise.allSettled(later);
  return new Response(null, { status: 204 });
}

/** The one host: REPO_HOST, else GHE_HOST, else github.com. */
const hostOf = (b: WorkerBindings) => b.REPO_HOST || b.GHE_HOST || "github.com";
/** Every owner tracked, comma-separated: REPO_OWNERS, else GHE_ORG, else GITHUB_USER, else `fallback`. */
const ownersOfBindings = (b: WorkerBindings, fallback: string) => ownersOf(b.REPO_OWNERS || b.GHE_ORG || b.GITHUB_USER || fallback).join(",");

export type { Actor };

/**
 * The instance's own way to get a GitHub token (a GitHub App's broker, say), asked before every call.
 * With `actor`, the call is that person's write (a POST they made), to be made with their own token;
 * without, it's the instance's own (pages, the background snapshot, cron).
 */
export type GithubTokenProvider = (bindings: WorkerBindings, actor?: Actor) => Promise<string>;

/** Runs `fn` as nobody in particular: what it starts (a gather) uses the instance's own token. */
const asInstance = <T>(fn: () => T): T => actingAs(undefined, fn);

/**
 * GitHub with the instance's token provider, else the GITHUB_TOKEN secret; without either, every call
 * fails saying so (pages show it as failed, not empty). A provider that throws fails that call with its message.
 */
export function createHostedGhe(bindings: WorkerBindings, provider?: GithubTokenProvider): Ghe {
  const host = hostOf(bindings);
  // GET answers are kept in D1 for every isolate, so a cold one's cron still gets free 304s (#294).
  const shared = bindings.DB ? d1Reads(bindings.DB) : undefined;
  if (provider) return createGhe({ host, token: () => provider(bindings, currentActor()), shared });
  const token = bindings.GITHUB_TOKEN?.trim();
  if (token) return createGhe({ host, token, shared });
  return missingGhe(host, "No GITHUB_TOKEN: set it with `wrangler secret put GITHUB_TOKEN`.");
}

/**
 * A Worker keeps a request's waitUntil() work up to 30 s after it answers, and a cancelled
 * request's fetches never settle: past this, a gather or pack refresh is given up and started
 * again, and no request waits on one longer.
 */
const STUCK_MS = 25_000;
/** The longest a request waits on the app's start (packs' init, Bino's memory, the kept snapshot). */
const READY_MS = 3_000;
/** The hub's publishes, after the gather: within the 30 s a Worker keeps waitUntil() work. */
const DRAIN_MS = 4_000;

/** Waits on `p` at most `ms`, with the timer in this request (so it fires even if `p` belongs to a dead one). */
const capped = (p: Promise<unknown>, ms = STUCK_MS) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => undefined), new Promise<void>((res) => (t = setTimeout(res, ms)))]).finally(() => clearTimeout(t));
};

/** The real gatherer's remote half: PRs, notifications, movement, deploys. Agents and worktrees live on a machine. */
export function createHostedGatherer(bindings: WorkerBindings, login: string, forge: Forge, store?: SnapshotStore, onGathered?: (s: Snapshot) => void, linked?: () => string[]): Gatherer {
  const g = createGatherer({
    env: { GHE_ORG: primaryOf(ownersOfBindings(bindings, login)), OWNERS: ownersOfBindings(bindings, login) },
    forge,
    login,
    linked,
    maxGatherMs: STUCK_MS,
    store,
    onGathered,
  });
  // The snapshot is shared: a gather a member's action starts still reads as the instance.
  return { ...g, get: (o) => asInstance(() => g.get(o)), stale: () => asInstance(() => g.stale()) };
}

/**
 * /bridge (PLAN D24, H6, H7): a WebSocket upgrade from a machine, handed to the hub, which then
 * wants the signed hello under that machine's key. Who may open one:
 * - a machine the issuer named (a verified token's `service` claim): that machine, and whose it
 *   is when the token says (`owner`, Team T4);
 * - the Access service token whose client id is BRIDGE_CLIENT_ID: the one machine `mac`.
 * A person's token isn't one. Anything else, or no BRIDGE_KEY, is a 404.
 */
export async function bridgeIn(request: Request, bindings: Pick<WorkerBindings, "BRIDGE_CLIENT_ID" | "BRIDGE_KEY">, h: Pick<Hosted, "hub" | "verify">): Promise<Response> {
  const nope = new Response("Not found", { status: 404 });
  if (!keyOk(bindings.BRIDGE_KEY) || !h.hub || !h.verify) return nope;
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return nope;
  const who = await h.verify(request);
  const id = bindings.BRIDGE_CLIENT_ID?.trim();
  const machine = who?.machine ? who.service : who?.service && id && who.service === id ? LEGACY_MACHINE : undefined;
  if (!machineOk(machine)) return nope;
  // The hub takes the machine and its owner from us alone: whatever the request said is replaced.
  const headers = new Headers(request.headers);
  headers.set(MACHINE_HEADER, machine);
  if (who?.machine && who.owner) headers.set(OWNER_HEADER, who.owner);
  else headers.delete(OWNER_HEADER);
  return h.hub.bridge(new Request(request, { headers }));
}

/**
 * /live (H5): a page's live socket. The same check as a page (a person Access let in, on the
 * allow list), and the upgrade must come from this app's own origin, since a browser sends the
 * cookie with another site's socket too. Then the socket goes to the hub. Anything else is a 404.
 */
export async function liveIn(request: Request, h: Pick<Hosted, "hub" | "verify">): Promise<Response> {
  const nope = new Response("Not found", { status: 404 });
  if (!h.hub || !h.verify || request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return nope;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return nope;
  if (request.headers.get("origin") !== new URL(request.url).origin) return nope;
  const who = await h.verify(request);
  if (!who?.email) return nope;
  return h.hub.live(request);
}

/** The vars and secrets among the bindings: what a pack's settings read. */
const stringsOf = (b: WorkerBindings): Record<string, string | undefined> => Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "string")) as Record<string, string>;

type Hosted = { builtAt: number; started: boolean; app: App; ghe: Ghe; gatherer: Gatherer; kept: ReturnType<typeof d1SnapshotStore>; refresh: ReturnType<typeof refresher>; packs: Pack[]; ready: Promise<void>; hub?: HubClient; verify?: AccessVerifier };

export function createWorker(opts: { packs?: Pack[]; /** Its name before WP-M4, for an instance not yet renamed. */ crates?: Pack[]; version?: string; /** Wins over GITHUB_TOKEN. */ githubToken?: GithubTokenProvider } = {}) {
  const version = opts.version ?? "0.2.1";
  // One app per isolate: its caches outlive a request (bindings don't change within an isolate).
  let hosted: Hosted | undefined;
  /** Set once D1, its tables and Access are there (WP-N6); until then every request gets the setup page. */
  let essentials = false;
  const notSetUp = async (bindings: WorkerBindings): Promise<string | undefined> => {
    if (essentials) return undefined;
    const lines = hostedSetup(bindings, { tables: await tablesOk(bindings.DB), githubToken: !!opts.githubToken });
    if (lines.some((l) => l.needed && !l.on)) return setupPage(lines);
    essentials = true;
    return undefined;
  };

  const build = (bindings: WorkerBindings): Hosted => {
    // Its start (D1 reads) belongs to the request that built it: if that one was cancelled, they never
    // settle. Past STUCK_MS unstarted, it's built again rather than leaving every page waiting.
    if (hosted && !hosted.started && Date.now() - hosted.builtAt > STUCK_MS) {
      console.error("dovre: start stuck; building again");
      hosted = undefined;
    }
    if (hosted) return hosted;
    const login = bindings.GITHUB_USER || "operator";
    const strings = stringsOf(bindings);
    const instancePacks = opts.packs ?? opts.crates ?? [];
    // GitHub unless FORGE names a forge one of the instance's packs brings (src/forge/pick.ts).
    const forgeId = forgeIdOf(bindings.FORGE);
    const ghe = forgeId === "github" ? createHostedGhe(bindings, opts.githubToken) : missingGhe(hostOf(bindings), `GitHub isn't this instance's forge (FORGE=${forgeId}).`);
    const forge = pickForge(bindings.FORGE, instancePacks, () => githubForge(ghe), strings);
    // The last snapshot, kept in D1: a fresh isolate draws it at once and gathers behind it.
    const kept = d1SnapshotStore(bindings.DB, version);
    // A finished gather goes to open pages: always its time (or "Syncing…" stays), "snapshot" when it changed something.
    let sig = "";
    const gathered = (s: Snapshot) => {
      const next = shownOf(s);
      hub?.gathered(s.at, next !== sig);
      sig = next;
    };
    // The PRs the packs' pages link (the Mac's agents' sessions): set once the app is built.
    let linked = (): string[] => [];
    const gatherer = createHostedGatherer(bindings, login, forge, { load: () => undefined, save: (s) => kept.save(s) }, (s) => gathered(s), () => linked());

    const env: Env = {
      DB: bindings.DB,
      FORGE: forgeId,
      GHE_HOST: hostOf(bindings),
      GHE_ORG: primaryOf(ownersOfBindings(bindings, "dovre")),
      OWNERS: ownersOfBindings(bindings, "dovre"),
      GITHUB_USER: bindings.GITHUB_USER || login,
      GITHUB_TOKEN: bindings.GITHUB_TOKEN,
      CODE_DIR: "/code",
      CLAUDE_DIR: "/claude",
      IS_HOSTED: "1",
      CF_ACCOUNT_ID: bindings.CF_ACCOUNT_ID,
      CLAUDE_BIN: undefined,
    };
    const access = accessConfigOf(bindings);
    const verify = access ? createAccessVerifier(access) : undefined;
    // The hub, when the instance binds it: live pages, and Bino answering in the object.
    const hub = bindings.HUB ? hubClient(bindings.HUB) : undefined;
    const memory = memoryLater(loadMemory(bindings.DB));
    // The agents desk is the machines', over the bridge (PLAN D24, H7), when it's set up (a BRIDGE_KEY).
    // Without the bridge, a desk with nothing to run: the pages say so.
    const remote = hub && keyOk(bindings.BRIDGE_KEY) ? remoteDesk(hub) : undefined;
    const desk = remote ?? localDesk({ env, queue: createQueue(), sessions: async () => ({ live: [], recent: [] }) });
    // The pickers offer what the machines found in their CLIs' configs (#238), never this server's own home.
    if (remote) useFoundModels((id) => remote.foundModels(id));
    const dismissed = createDismissed(bindings.DB);
    // My open issues from the forge (/tracker), where the forge has them.
    const issues = issuesPack({ forge, owners: () => env.OWNERS ?? env.GHE_ORG, login: () => gatherer.peek()?.login });
    // Dovre's own packs first (agents, assistant: Bino's switch, issues), then the instance's.
    const { on, off } = activePacks([agentsPack({ desk, dismissed, ...(forgeId === "github" ? { github: { ghe, owners: () => ownersIn(env) } } : {}) }), assistantPack(), issues, ...instancePacks], { env: strings, bindings, hosted: true });
    for (const o of off) console.log(`pack ${o.id}: off, ${o.why}`);
    const app = createApp(env, {
      hub,
      events: hub?.events,
      live: !!hub,
      reviewCheck: hub?.reviewCheck,
      bino: hub ? { remote: remoteBino(hub, { route: hostedBinoRoute(bindings as HubEnv), memory, sees: "My list and what your apps share" }) } : undefined,
      gatherer,
      ghe,
      forge,
      access: verify,
      info: { version: `${version}-cf`, startedAt: Date.now() },
      packs: { on, off, env: strings, bindings, core: ["agents", "assistant", "tracker"] },
      setup: () => hostedSetup(bindings, { tables: true, off: packsOf(app)?.off, githubToken: !!opts.githubToken }),
      sent: async () => ({ hosted: true, received: hub ? await hub.sent().catch(() => []) : [] }),
    });
    const mounted = packsOf(app)!;
    linked = mounted.linked;
    const seeded = kept.load().then((s) => {
      if (!s) return;
      gatherer.seed?.(s);
      sig = shownOf(s);
    });
    const ready = Promise.all([initAll(mounted, mounted.ctxOf, (l) => console.log(l)), memory.ready, seeded]).then(() => {});
    const built: Hosted = { builtAt: Date.now(), started: false, app, ghe, gatherer, kept, packs: mounted.on, ready, hub, verify, refresh: refresher(mounted.on, mounted.ctxOf, (l) => console.log(l), { maxMs: STUCK_MS, record: mounted.refreshes, skip: mounted.hidden }) };
    void ready.then(() => (built.started = true));
    hosted = built;
    return hosted;
  };

  // Bino's lookups, for the instance's BinoLookups entrypoint (src/hosted/lookups.ts).
  serveLookups(async (env) => {
    const h = build(env as WorkerBindings);
    await capped(h.ready);
    return packsOf(h.app)!.lookups;
  });

  /** Cron: every pack's scheduled hook, then any refresh that's due and the snapshot. */
  const runScheduled = async (event: ScheduledEvent, bindings: WorkerBindings, ctx: Ctx): Promise<void> => {
    if (await notSetUp(bindings)) return console.error("dovre: not set up yet (D1, its tables or Access): the cron waits");
    const h = build(bindings);
    await capped(h.ready);
    const mounted = packsOf(h.app)!;
    const defer: Defer = (p) => ctx.waitUntil(p);
    await Promise.all(
      h.packs
        .filter((c) => c.scheduled)
        .map((c) =>
          c.scheduled!({ cron: event.cron, scheduledTime: event.scheduledTime }, mounted.ctxOf(c), defer).then(
            () => mounted.refreshes.cron(c.manifest.id, Date.now()),
            (e) => {
              console.error(`pack ${c.manifest.id}: scheduled failed: ${(e as Error)?.message ?? e}`);
              mounted.refreshes.cron(c.manifest.id, Date.now(), String((e as Error)?.message ?? e).slice(0, 300));
            },
          ),
        ),
    );
    // And the snapshot, so a page opened later has something to draw at once.
    await Promise.all([capped(h.refresh.due()), capped(h.gatherer.get().then(() => h.kept.drain()))]);
    // What the cron's calls counted (#253).
    await capped(h.ghe.calls?.flush(bindings.DB, true) ?? Promise.resolve());
    if (h.hub) ctx.waitUntil(capped(h.hub.drain()));
  };

  return {
    async fetch(request: Request, bindings: WorkerBindings, ctx?: Ctx): Promise<Response> {
      const url = new URL(request.url);
      // The icons and fonts: public, as locally (src/pwa.ts), from the static assets.
      if (bindings.ASSETS && /^\/assets\/(icon[\w-]*\.(png|svg|ico)|fonts\/NordwandMono-\w+\.woff2)$/.test(url.pathname)) {
        const res = await bindings.ASSETS.fetch(new Request(new URL(url.pathname.slice("/assets".length), url), request));
        if (res.ok) return res;
      }

      // Cron over HTTP (hosts without cron triggers): the right Bearer CRON_KEY, else a 404 like any unknown path.
      if (url.pathname === "/_dovre/scheduled") return scheduledIn(request, bindings, ctx, notSetUp, runScheduled);

      // Not set up yet (no D1, its tables or Access): say what's missing rather than fail. Names only.
      const page = await notSetUp(bindings);
      if (page && url.pathname === "/healthz") return Response.json({ ok: false, setUp: false, version: `${version}-cf` }, { status: 503, headers: { "cache-control": "no-store" } });
      if (page) return new Response(page, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const h = build(bindings);
      // The Mac's bridge: only its own service token, then the socket goes to the hub.
      if (url.pathname === "/bridge") return bridgeIn(request, bindings, h);
      // A page's live socket: a person, from this app's own pages (a socket's answer can't pass the app's headers).
      if (url.pathname === "/live") return liveIn(request, h);

      // Everything else: the app checks Cloudflare Access on each request (src/access.ts). A start
      // that's slow (or stuck in a cancelled request) is waited on a moment, then the page draws without it.
      await capped(h.ready, READY_MS);
      // A write (POST) by a verified person goes to GitHub with their own token, when the instance's
      // provider tells people apart. The app still checks Access itself; this only names the actor.
      const who = opts.githubToken && request.method === "POST" && h.verify ? await h.verify(request).catch(() => undefined) : undefined;
      const res = who?.email ? await actingAs({ email: who.email }, () => h.app.fetch(request)) : await h.app.fetch(request);
      if (ctx) {
        // A page answered from memory and started a gather, or a pack is due: finish after the response.
        const work = [capped(h.refresh.due())];
        if (h.gatherer.gathering()) work.push(capped(h.gatherer.get({ fresh: true }).then(() => h.kept.drain())));
        // Then what the request and that work published, on its way to the hub. After it, not beside
        // it: a publish made once the hub was drained had nothing keeping the Worker alive for it.
        const hub = h.hub;
        ctx.waitUntil(Promise.all(work).then(() => hub && capped(hub.drain(), DRAIN_MS)));
      }
      return res;
    },

    /** Cron (the instance's triggers). */
    async scheduled(event: ScheduledEvent, bindings: WorkerBindings, ctx: Ctx): Promise<void> {
      await runScheduled(event, bindings, ctx);
    },

    /** Email Routing: the first pack that takes the message handles it; nobody taking it is an error (the sender hears of it). */
    async email(message: { setReject?(reason: string): void }, bindings: WorkerBindings, ctx: Ctx): Promise<void> {
      const h = build(bindings);
      await capped(h.ready);
      const mounted = packsOf(h.app)!;
      const defer: Defer = (p) => ctx.waitUntil(p);
      for (const c of h.packs.filter((c) => c.email)) {
        if (await c.email!(message, mounted.ctxOf(c), defer)) {
          if (h.hub) defer(capped(h.hub.drain()));
          return;
        }
      }
      message.setReject?.("No one here takes this address.");
    },

    /** For tests: forget this isolate's app. */
    reset(): void {
      hosted = undefined;
      essentials = false;
    },
  };
}

/** Core alone, no packs (tests; an instance exports its own). */
const core = createWorker();
export const resetHostedApp = (): void => core.reset();
export default core;
