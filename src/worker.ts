/**
 * Dovre hosted (PLAN D16, D23): the Worker an instance repo deploys. The instance's own entry calls
 * `createWorker({ packs })` with its packs and exports the result; its wrangler config holds the
 * domain, Access, D1 and whatever bindings its packs need. Cloudflare Access is checked on every
 * request (src/access.ts); without it configured nobody gets in.
 */
import { hostedKeys } from "./hostedkeys.ts";
import { type Actor, actingAs, currentActor } from "./actor.ts";
import { ownersIn, ownersOf, primaryOf } from "./owners.ts";
import { type AccessVerifier, accessConfigOf, createAccessVerifier } from "./access.ts";
import { DIAL_HEADER, dialProofOk, keyOk, LEGACY_MACHINE, machineOk } from "./bridge/wire.ts";
import { sameSecret } from "./access.ts";
import { viewingAs } from "./viewer.ts";
import { packsOf, createApp } from "./app.ts";
import { CORE_PACKS } from "./packs/own.ts";
import { serverBinding } from "./packs/server.ts";
import { activePacks, beforePages, initAll, type refresher } from "./packs/registry.ts";
import type { Pack, Defer, ScheduledEvent } from "./packs/types.ts";
import type { D1 } from "./db.ts";
import type { App, Env } from "./env.ts";
import { createGatherer, type Gatherer, type Snapshot, type SnapshotStore, shownOf } from "./gather.ts";
import { d1SnapshotStore } from "./hosted/snapshot.ts";
import { createGhe, type Ghe, missingGhe } from "./sources/ghe.ts";
import { d1Reads } from "./sources/files.ts";
import { startWaited } from "./speed.ts";
import { githubForge } from "./forge/github.ts";
import { forgeIdOf, pickForge } from "./forge/pick.ts";
import { type Forge, forgeCan } from "./forge/types.ts";
import { loadMemory, memoryLater } from "./packs/core/assistant/bino/memory.ts";
import { type HubClient, hubClient, type HubNamespace, remoteBino } from "./hosted/client.ts";
import { remoteDesk } from "./bridge/remote.ts";
import { useFoundModels } from "./agents/harnesses/index.ts";
import { agentsPack } from "./packs/core/agents/index.ts";
import { historyPack } from "./packs/core/history/index.ts";
import { createHistory, d1HistoryKept } from "./packs/core/history/store.ts";
import { autoreviewPack } from "./packs/core/autoreview/index.ts";
import { assistantPack } from "./packs/core/assistant/index.ts";
import { todoPack } from "./packs/core/todo/index.ts";
import { deploysPack } from "./packs/core/deploys/index.ts";
import { dependabotPack } from "./packs/core/dependabot/index.ts";
import { stacksPack } from "./packs/core/stacks/index.ts";
import { prsPack } from "./packs/core/prs/index.ts";
import { issuesPack } from "./packs/core/issues/index.ts";
import { createDismissed } from "./agents/dismissed.ts";
import { localDesk } from "./agents/desk.ts";
import { createQueue } from "./agents/queue.ts";
import { type HubEnv, hostedBinoRoute, MACHINE_HEADER, OWNER_HEADER } from "./hosted/hub.ts";
import { hostedSetup, setupPage, tablesOk } from "./hosted/setup.ts";
import { serveLookups } from "./hosted/lookups.ts";
import { createLogin, type Login, loginOn } from "./hosted/login/login.ts";
import { githubAppOf } from "./hosted/login/github.ts";

interface WorkerBindings {
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
  /** The instance repo this Worker is built from (`owner/name`): Packs' Add opens a PR there (#88). */
  INSTANCE_REPO?: string;
  GHE_HOST?: string;
  GHE_ORG?: string;
  CF_ACCOUNT_ID?: string;
  /** An IANA zone for every time shown; unset: the browser's (the u-tz cookie). */
  TZ_NAME?: string;
  GREETING?: string;
  /** The Access team ("myteam" or "myteam.cloudflareaccess.com") and the application's AUD tag: both needed, or nobody gets in. */
  CF_ACCESS_TEAM?: string;
  CF_ACCESS_AUD?: string;
  /** Instead of Access: any issuer that signs RS256 JWTs and publishes a JWKS (default `<issuer>/.well-known/jwks.json`). Wins when set. */
  AUTH_ISSUER?: string;
  AUTH_AUD?: string;
  AUTH_JWKS_URL?: string;
  ALLOWED_EMAILS?: string;
  /** An instance served at workers.dev with Access on that host (#98): the host. */
  WORKERS_DEV_HOST?: string;
  /** "passkey": the built-in login (#522, src/hosted/login/) instead of Cloudflare Access. */
  AUTH_MODE?: string;
  /** The instance's GitHub App (#523, made by provision --github): Sign in with GitHub on the built-in login. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
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
type GithubTokenProvider = (bindings: WorkerBindings, actor?: Actor) => Promise<string>;

/** Runs `fn` as nobody in particular: what it starts (a gather) uses the instance's own token. */
const asInstance = <T>(fn: () => T): T => actingAs(undefined, fn);

/**
 * GitHub with the instance's token provider, else the GITHUB_TOKEN secret; without either, every call
 * fails saying so (pages show it as failed, not empty). A provider that throws fails that call with its message.
 */
function createHostedGhe(bindings: WorkerBindings, provider?: GithubTokenProvider): Ghe {
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
/** How long the cron waits on the packs' refreshes: nobody waits on it, and History's gather can take ~20 s (#294). */
const CRON_REFRESH_MS = 60_000;
/** The longest a request waits on the app's start (packs' init, Bino's memory, the kept snapshot). */
const READY_MS = 3_000;
/** The keys a store holds (#428), read at the start: one slower than this stays unread (Read again reads it). */
const KEYS_MS = 15_000;
/** The hub's publishes, after the gather: within the 30 s a Worker keeps waitUntil() work. */
const DRAIN_MS = 4_000;

/** Waits on `p` at most `ms`, with the timer in this request (so it fires even if `p` belongs to a dead one). */
const capped = (p: Promise<unknown>, ms = STUCK_MS) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => undefined), new Promise<void>((res) => (t = setTimeout(res, ms)))]).finally(() => clearTimeout(t));
};

/** Auto review's model (#326): the assistant's route, called from this Worker's cron, when it can answer. */
function reviewRoute(bindings: WorkerBindings) {
  const r = hostedBinoRoute(bindings as HubEnv);
  return r.ready && r.ask ? { ask: r.ask, model: r.model } : undefined;
}

/** The real gatherer's remote half: PRs, notifications, movement, deploys. Agents and worktrees live on a machine. */
/** How often an unchanged gather still tells pages its time, so their "Synced" stays roughly right. */
const SYNCED_EVERY_MS = 5 * 60_000;

/**
 * Which finished gathers open pages hear about: one that changed what's shown ("snapshot"), the
 * first after stale() (a Refresh shows "Syncing…" until it hears), and otherwise one every
 * SYNCED_EVERY_MS. Each isolate gathers every 45 s, and telling every one was most of the hub's traffic.
 */
export function syncTeller(tell: (at: number, changed: boolean) => void, everyMs = SYNCED_EVERY_MS) {
  let sig = "";
  let toldAt = 0;
  let asked = false;
  return {
    /** What the kept snapshot showed, so the first gather that matches it isn't news. */
    seed(shown: string) {
      sig = shown;
    },
    asked() {
      asked = true;
    },
    gathered(at: number, shown: string) {
      const changed = shown !== sig;
      sig = shown;
      if (!changed && !asked && at - toldAt < everyMs) return;
      asked = false;
      toldAt = at;
      tell(at, changed);
    },
  };
}

function createHostedGatherer(bindings: WorkerBindings, login: string, forge: Forge, store?: SnapshotStore, onGathered?: (s: Snapshot) => void, linked?: () => string[]): Gatherer {
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
export async function bridgeIn(request: Request, bindings: Pick<WorkerBindings, "BRIDGE_CLIENT_ID" | "BRIDGE_KEY">, h: Pick<Hosted, "hub" | "verify" | "login">): Promise<Response> {
  const nope = new Response("Not found", { status: 404 });
  if (!keyOk(bindings.BRIDGE_KEY) || !h.hub || !h.verify) return nope;
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return nope;
  // The built-in login (#522): no Access before us, so the dial proves BRIDGE_KEY itself.
  if (h.login) {
    if (!(await dialProofOk(bindings.BRIDGE_KEY, request.headers.get(DIAL_HEADER)))) return nope;
    const headers = new Headers(request.headers);
    headers.set(MACHINE_HEADER, LEGACY_MACHINE);
    headers.delete(OWNER_HEADER);
    return h.hub.bridge(new Request(request, { headers }));
  }
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

type Hosted = { builtAt: number; started: boolean; app: App; ghe: Ghe; gatherer: Gatherer; kept: ReturnType<typeof d1SnapshotStore>; refresh: ReturnType<typeof refresher>; packs: Pack[]; ready: Promise<void>; hub?: HubClient; verify?: AccessVerifier; login?: Login };

export function createWorker(opts: { packs?: Pack[]; version?: string; /** Wins over GITHUB_TOKEN. */ githubToken?: GithubTokenProvider } = {}) {
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
    // A store's reference (#428): its pack starts off, and turns on once the start has read it.
    const keys = hostedKeys(strings, { log: (l) => console.log(`secrets: ${l}`) });
    const instancePacks = opts.packs ?? [];
    // GitHub unless FORGE names a forge one of the instance's packs brings (src/forge/pick.ts).
    const forgeId = forgeIdOf(bindings.FORGE);
    const ghe = forgeId === "github" ? createHostedGhe(bindings, opts.githubToken) : missingGhe(hostOf(bindings), `GitHub isn't this instance's forge (FORGE=${forgeId}).`);
    const forge = pickForge(bindings.FORGE, instancePacks, () => githubForge(ghe), strings);
    // The last snapshot, kept in D1: a fresh isolate draws it at once and gathers behind it.
    const kept = d1SnapshotStore(bindings.DB, version);
    // A finished gather goes to open pages when it's worth telling them (syncTeller).
    const sync = syncTeller((at, changed) => hub?.gathered(at, changed));
    // The PRs the packs' pages link (the Mac's agents' sessions): set once the app is built.
    let linked = (): string[] => [];
    const plain = createHostedGatherer(bindings, login, forge, { load: () => undefined, save: (s) => kept.save(s) }, (s) => sync.gathered(s.at, shownOf(s)), () => linked());
    // A Refresh or an action waits on the next gather's "Synced", changed or not.
    const gatherer: Gatherer = { ...plain, stale: () => (sync.asked(), plain.stale()) };

    const env: Env = {
      DB: bindings.DB,
      FORGE: forgeId,
      GHE_HOST: hostOf(bindings),
      GHE_ORG: primaryOf(ownersOfBindings(bindings, "dovre")),
      OWNERS: ownersOfBindings(bindings, "dovre"),
      GITHUB_USER: bindings.GITHUB_USER || login,
      GITHUB_TOKEN: bindings.GITHUB_TOKEN,
      INSTANCE_REPO: bindings.INSTANCE_REPO,
      CODE_DIR: "/code",
      CLAUDE_DIR: "/claude",
      IS_HOSTED: "1",
      CF_ACCOUNT_ID: bindings.CF_ACCOUNT_ID,
      // Unset: times follow the browser's zone (src/app.ts, the u-tz cookie).
      TZ_NAME: bindings.TZ_NAME,
      GREETING: bindings.GREETING,
      CLAUDE_BIN: undefined,
    };
    const access = accessConfigOf(bindings);
    // The built-in login when it's on (AUTH_MODE=passkey), else Cloudflare Access or another issuer.
    const builtIn = loginOn(bindings) ? createLogin({ db: bindings.DB, allowedEmails: (bindings.ALLOWED_EMAILS ?? "").split(","), github: githubAppOf(bindings) }) : undefined;
    const verify = builtIn?.verify ?? (access ? createAccessVerifier(access) : undefined);
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
    // Dovre's own packs first (agents, autoreview, assistant: Bino's switch, issues), then the instance's.
    const { on, off } = activePacks([agentsPack({ desk, dismissed, ...(forgeId === "github" ? { github: { ghe, owners: () => ownersIn(env) } } : {}) }), autoreviewPack({ ...(forgeId === "github" ? { github: { ghe, owners: () => ownersIn(env) } } : {}), reviewer: () => reviewRoute(bindings) }), ...(forgeId === "github" ? [historyPack({ history: (changed) => createHistory({ ghe, org: () => ownersIn(env), login: () => gatherer.peek()?.login, kept: d1HistoryKept(bindings.DB), onChange: changed }) })] : []), assistantPack(), todoPack({ links: () => ({ ghe: env.GHE_HOST, org: env.GHE_ORG }) }), prsPack({ ghe, owners: () => ownersIn(env), forge, stale: () => gatherer.stale(), checker: () => { const r = hub ? hostedBinoRoute(bindings as HubEnv) : undefined; return hub && r?.ready && r.ask ? { model: r.model, start: (job, topic) => hub.reviewCheck(job, topic) } : undefined; } }), deploysPack({ ghe, owners: () => ownersIn(env), approve: forgeCan(forge, "deployApproval"), stale: () => gatherer.stale() }), ...(forgeCan(forge, "stacks") ? [stacksPack({ ghe, owners: () => ownersIn(env) })] : []), ...(forgeCan(forge, "dependabot") ? [dependabotPack({ ghe, owners: () => ownersIn(env), stale: () => gatherer.stale() })] : []), issues, ...instancePacks], { env: strings, unread: keys.unread(), bindings, hosted: true });
    for (const o of off) console.log(`pack ${o.id}: off, ${o.why}`);
    const app = createApp(env, {
      hub,
      machines: hub ? async () => (await hub.mac()).machines : undefined,
      events: hub?.events,
      live: !!hub,
      bino: hub ? { remote: remoteBino(hub, { route: hostedBinoRoute(bindings as HubEnv), memory, sees: "My list and what your apps share" }) } : undefined,
      gatherer,
      ghe,
      forge,
      access: verify,
      info: { version: `${version}-cf`, startedAt: Date.now() },
      packs: { on, off, env: strings, keys, bindings, core: [...CORE_PACKS] },
      setup: () => hostedSetup(bindings, { tables: true, off: packsOf(app)?.off, githubToken: !!opts.githubToken, servers: on.filter((p) => p.server).map((p) => ({ name: p.manifest.name, binding: serverBinding(p.manifest.id) })) }),
      sent: async () => ({ hosted: true, received: hub ? await hub.sent().catch(() => []) : [] }),
    });
    const mounted = packsOf(app)!;
    linked = mounted.linked;
    const seeded = kept.load().then((s) => {
      if (!s) return;
      gatherer.seed?.(s);
      sync.seed(shownOf(s));
    });
    const ready = Promise.all([initAll(mounted, mounted.ctxOf, (l) => console.log(l)), memory.ready, seeded, capped(keys.read(), KEYS_MS)]).then(() => mounted.keysRead());
    const built: Hosted = { builtAt: Date.now(), started: false, app, ghe, gatherer, kept, packs: mounted.on, ready, hub, verify, login: builtIn, refresh: mounted.refresh };
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

  /**
   * Cron: every pack's scheduled hook, then any refresh that's due and the snapshot. The hooks run
   * as the instance's owner (the first of ALLOWED_EMAILS): background work for them sees what their
   * pages see, such as their paired machines. Without it, a cron sees no one's machine.
   */
  const runScheduled = async (event: ScheduledEvent, bindings: WorkerBindings, ctx: Ctx): Promise<void> => {
    const owner = (bindings.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim()).find(Boolean);
    return viewingAs(owner, () => scheduledAs(event, bindings, ctx));
  };
  const scheduledAs = async (event: ScheduledEvent, bindings: WorkerBindings, ctx: Ctx): Promise<void> => {
    if (await notSetUp(bindings)) return console.error("dovre: not set up yet (D1, its tables or Access): the cron waits");
    const h = build(bindings);
    await capped(h.ready);
    const mounted = packsOf(h.app)!;
    const defer: Defer = (p) => ctx.waitUntil(p);
    // What a page reads first, the cron reads too: the remote desk's paired machines, say, which
    // Auto review asks for a run's model. Without it a fresh isolate's desk lists no machine.
    await beforePages(h.packs, mounted.ctxOf, (id, line) => console.error(`pack ${id}: ${line}`));
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
    await Promise.all([capped(h.refresh.due(), CRON_REFRESH_MS), capped(h.gatherer.get().then(() => h.kept.drain()))]);
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
        // 304 too: a browser revalidating a cached font gets "not modified", not the app's 404.
        if (res.ok || res.status === 304) return res;
      }

      // Cron over HTTP (hosts without cron triggers): the right Bearer CRON_KEY, else a 404 like any unknown path.
      if (url.pathname === "/_dovre/scheduled") return scheduledIn(request, bindings, ctx, notSetUp, runScheduled);

      // Not set up yet (no D1, its tables or Access): say what's missing rather than fail. Names only.
      const page = await notSetUp(bindings);
      if (page && url.pathname === "/healthz") return Response.json({ ok: false, setUp: false, version: `${version}-cf` }, { status: 503, headers: { "cache-control": "no-store" } });
      if (page) return new Response(page, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      const h = build(bindings);
      // The built-in login: its own pages, and anyone without a session is sent to them (pages) or
      // turned away (anything else). With Access, Cloudflare did this before the Worker.
      if (h.login) {
        const own = await h.login.handle(request);
        if (own) return own;
        // Through without a session: the bridge (its own proof) and a pack's ingest POSTs (their own token, src/packs/ingest.ts).
        const ownCheck = url.pathname === "/bridge" || (request.method === "POST" && /^\/[a-z0-9-]+\/ingest\//.test(url.pathname));
        if (!ownCheck && !(await h.login.verify(request))?.email) {
          const page = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
          return page ? new Response(null, { status: 302, headers: { location: "/_auth/login", "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
        }
      }
      // The Mac's bridge: only its own service token, then the socket goes to the hub.
      if (url.pathname === "/bridge") return bridgeIn(request, bindings, h);
      // A page's live socket: a person, from this app's own pages (a socket's answer can't pass the app's headers).
      if (url.pathname === "/live") return liveIn(request, h);

      // Everything else: the app checks Cloudflare Access on each request (src/access.ts). A start
      // that's slow (or stuck in a cancelled request) is waited on a moment, then the page draws without it.
      if (!h.started) {
        const t0 = performance.now();
        await capped(h.ready, READY_MS);
        startWaited.set(request, performance.now() - t0);
      }
      // A write (POST) by a verified person goes to GitHub with their own token, when the instance's
      // provider tells people apart. The app still checks Access itself; this only names the actor.
      const who = opts.githubToken && request.method === "POST" && h.verify ? await h.verify(request).catch(() => undefined) : undefined;
      // The request's context goes along: a route's c.executionCtx.waitUntil() keeps its job past the
      // response. Without it that throws, and a job started in the request dies when it answers.
      const call = () => h.app.fetch(request, {}, ctx as Parameters<typeof h.app.fetch>[2]);
      const res = who?.email ? await actingAs({ email: who.email }, call) : await call();
      if (ctx) {
        // A page answered from memory and started a gather, or a pack is due: finish after the response.
        const work = [capped(h.refresh.due())];
        if (h.gatherer.gathering()) work.push(capped(h.gatherer.get({ fresh: true }).then(() => h.kept.drain())));
        // Then what the request and that work published, on its way to the hub. After it, not beside
        // it: a publish made once the hub was drained had nothing keeping the Worker alive for it.
        const hub = h.hub;
        // The calls that work made are counted too (#253): the request's own flush went out before it.
        const counted = () => capped(h.ghe.calls?.flush(bindings.DB, true) ?? Promise.resolve());
        ctx.waitUntil(Promise.all(work).then(() => Promise.all([hub && capped(hub.drain(), DRAIN_MS), counted()])));
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
