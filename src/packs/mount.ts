/**
 * The packs' side of the app (#481): each pack's `ctx`, core's call of every hook for the packs
 * shown here (through the `…From`s in registry.ts), their styles, scripts and files, and their
 * routes. createApp (src/app.ts) makes it once, before its own routes, and mounts the three kinds
 * of route where they belong: sign-in returns before the guard, assets among core's, pages last.
 */
import { Hono, type Context } from "hono";
import { allowed, isLocal } from "../access.ts";
import { logAction, repoIn } from "../actions/deploys.ts";
import { packProposals } from "../actions/propose.ts";
import type { App, AppEnv } from "../env.ts";
import { packFeedOf } from "../home/feed.ts";
import { dockShell, html, shell } from "../html.ts";
import { RING_KINDS, rings } from "../notify.ts";
import { ownersIn, owns } from "../owners.ts";
import { manifestSettings } from "../pages/packs.ts";
import { WEEKS } from "../pages/stats.ts";
import { askInBar } from "../relay/asks.ts";
import type { AppScope } from "../routes/scope.ts";
import { d1Reads, packReads } from "../sources/files.ts";
import { RAW_CHANGE } from "../ui/on.js.ts";
import { Notice, PageHeader } from "../ui/kit.ts";
import { hashOf, STYLE } from "../ui/style.ts";
import { currentViewer } from "../viewer.ts";
import { agentHostOf } from "./agenthost.ts";
import type { Run } from "../agents/runner.ts";
import { type AgentHost, aiAskOf, packAiFor, packAiStore } from "./ai.ts";
import { checkoutIn, checkoutsIn } from "./checkouts.ts";
import { envReads, packEnv } from "./env.ts";
import { boxed, classesOf, guardHtml, scopeCss, scriptOf } from "./guard.ts";
import { loggedFor } from "./logged.ts";
import { packDirOf, programsFor } from "./programs.ts";
import { aboutFrom, actsFrom, binoFrom, feedFrom, fillOf, fillOwnOf, findsFrom, framesFrom, heldOff, linkedFrom, lookupsFrom, navFrom, needsFrom, noteFrom, pagesFrom, pulseFrom, refresher, refreshLog, refsFrom, requiresOf, ringsOf, safely, settleRequires, sharedFrom, shareOf, statsFrom, TODAY_MS, todayCards, usesOf, whatFrom, whereFrom, type Off } from "./registry.ts";
import { createReleases, type GetJson } from "./releases.ts";
import { kvFor, kvInMemory } from "./store.ts";
import { onboardOf } from "./suggest.ts";
import type { ListShare, Pack, PackAiAsk, PackContext, PackShares, Pulse, TodayCard, WasmFile } from "./types.ts";
import { fileWhy, isWasm, isWasmFile, packFileAt, packFileNameOk, packFileType, packFileWhy, shaOk, WASM_INLINE_MAX, wasmFileAt, wasmNameOk } from "./wasm.ts";

/** Hosted: a pack's refresh running longer than this is given up (as the worker gives up a gather). */
const REFRESH_STUCK_MS = 25_000;
/** How long a sandbox run that ended may take to bring its commits home before its pack is told anyway. */
const TURN_HOME_MS = 120_000;
/** How long a pack's page may take before it shows as broken (a long job redirects to a page that fills itself in). */
export const PACK_ROUTE_MS = 30_000;

/** hashOf (FNV-1a) over bytes: a module's URL changes when it does. */
function hashBytes(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
  return (h >>> 0).toString(36);
}

/** What createApp hands over: its state (src/routes/scope.ts), and what it makes after the packs, asked for when used. */
export type MountOpts = Pick<AppScope, "env" | "deps" | "hosted" | "ghe" | "forge" | "asks" | "layout" | "onboarding" | "page" | "publicOrigin"> & {
  /** Bino is answering somewhere (the pulse's `busy`). */
  thinking(): boolean;
  /** A pack's settings read again, and it on or off by them (src/routes/settings.ts). */
  settle(id: string): Promise<unknown>;
  /** A page thrown for nothing gathered yet: createApp answers it, not the pack's broken page. */
  pending(err: unknown): boolean;
  /** The bug page, filled in from a broken page. */
  bugHref(path: string, why: string, pack?: string): string;
};

export function mountPacks(app: App, o: MountOpts) {
  const { env, deps, hosted, ghe, forge, asks, layout, onboarding, page, publicOrigin } = o;
  const { gatherer } = deps;
  // What packs may read from the owners' repos (#139): checked and kept a few minutes, shared by every pack.
  const reads = packReads(forge, () => ownersIn(env), { shared: d1Reads(env.DB) });
  // A pack's PR changing one file (dovre#203): its declared kinds only, in the owners' repos, logged.
  const proposals = (c: Pack) => packProposals({ pack: { id: c.manifest.id, name: c.manifest.name }, kinds: (c.writes ?? []).map((w) => w.kind), owners: () => ownersIn(env), db: env.DB, propose: (p) => forge.propose!(p) });
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
  // ── Packs (src/packs/, PLAN D23): mounted after every core route, each hook isolated ──
  const packs = { env: {}, ...deps.packs, on: [...(deps.packs?.on ?? [])], off: [...(deps.packs?.off ?? [])] };
  const packLog = (id: string) => (line: string) => console.log(`pack ${id}: ${line}`);
  const log = (id: string, line: string) => packLog(id)(line);
  /** Dovre's own packs (src/packs/core/). */
  const own = (id: string) => packs.core?.includes(id);
  const contexts = new Map<string, PackContext>();
  const envSeen = envReads();
  /** Each pack's questions in the bar, by id (`asking`). */
  const asked = new Map<string, Set<string>>();
  const askedBy = (id: string) => asked.get(id) ?? asked.set(id, new Set()).get(id)!;
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
  /** What a pack asks of the model; a `lands` kind or an MCP write's kind it doesn't list in its `writes` is left out. */
  const aiAsk = (c: Pack): PackAiAsk | undefined => {
    let a = aiAskOf(c.manifest);
    const mine = (kind: string) => (c.writes ?? []).some((w) => w.kind === kind);
    if (a?.mcp?.writes) {
      const { mcp, ...rest } = a;
      const writes = Object.fromEntries(Object.entries(mcp.writes ?? {}).filter(([, kind]) => mine(kind)));
      // With no tool left, there's nothing to allow.
      a = mcp.reads?.length || Object.keys(writes).length ? { ...rest, mcp: { ...mcp, writes } } : rest.text || rest.agent ? rest : undefined;
    }
    const lands = a?.agent?.lands;
    if (!a?.agent || !lands || mine(lands)) return a;
    const { lands: _, ...agent } = a.agent;
    return { ...a, agent };
  };
  const ctxOf = (c: Pack): PackContext => {
    let ctx = contexts.get(c.manifest.id);
    if (!ctx)
      contexts.set(
        c.manifest.id,
        (ctx = {
          // Dovre's own packs are wired by closure (#480); the rest read through a view that notes what isn't theirs (#475).
          env: packs.core?.includes(c.manifest.id) ? packs.env : packEnv(c.manifest, packs.env, (key) => envSeen.note(c.manifest.id, key) && packLog(c.manifest.id)(`reads ${key}, which isn't one of its settings`)),
          bindings: packs.bindings ?? {},
          hosted,
          ...(hosted ? {} : { codeDir: env.CODE_DIR, checkouts: () => (env.CODE_DIR ? checkoutsIn(env.CODE_DIR, deps.session?.checkout) : []), checkout: (name: unknown) => (env.CODE_DIR ? checkoutIn(env.CODE_DIR, name, deps.session?.checkout) : null) }),
          ...(hosted ? {} : programsFor(c.manifest, { dir: packDirOf(env.U_DB, c.manifest.id), checkouts: () => (env.CODE_DIR ? checkoutsIn(env.CODE_DIR, deps.session?.checkout).flatMap((n) => checkoutIn(env.CODE_DIR!, n) ?? []) : []) })),
          db: env.DB,
          store: { kv: env.DB ? kvFor(c.manifest.id, env.DB) : kvInMemory() },
          logged: loggedFor(c.manifest.id, env.DB, packLog(c.manifest.id)),
          viewer: currentViewer,
          publish: (topics) => deps.hub?.publish(topics),
          snapshot: () => gatherer.peek(),
          gathered: async () => gatherer.peek() ?? (await Promise.race([gatherer.get().catch(() => undefined), new Promise<undefined>((res) => setTimeout(res, 1200))])),
          fill: (name, arg) => fill(name, arg),
          fillOwn: (name, arg) => fillOwn(c, name, arg),
          soon: (ms) => runPackRefresh.soon(c, ms),
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
            mcp: deps.mcp,
            audit: (detail, ok) => void logAction(env.DB, { kind: "packs.agent", target: c.manifest.id, detail, ok }).catch(() => {}),
          }),
          pulse: () => pulseNow(),
          forge: () => {
            const login = gatherer.peek()?.login;
            if (!login) return undefined;
            const owners = ownersIn(env);
            const f = forge;
            return { id: f.id, name: f.name, host: f.host ?? env.GHE_HOST, login, owners, owns: (repo: string) => typeof repo === "string" && owns(owners, repo.split("/")[0]!), ...(f.work ? { work: (since: string) => f.work!(login, owners, since) } : {}), ...(f.merged ? { merged: (since: string) => f.merged!(login, owners, since) } : {}), ...reads, ...(f.propose ? { propose: proposals(c) } : {}) };
          },
          wasm: (name) => wasmPaths.get(c.manifest.id)?.get(name),
          file: (name) => filePaths.get(c.manifest.id)?.get(name),
          // Only from a pack it requires or uses, while that one is on and shown (#326).
          required: (id: string, name: string) => {
            const from = (requiresOf(c.manifest).includes(id) || usesOf(c.manifest).includes(id)) && !hidden(id) ? packs.on.find((p) => p.manifest.id === id) : undefined;
            return from ? (shareOf(from, ctxOf, name, log) as never) : undefined;
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
  /** Switched off on the Packs page, or requires a pack that is (#326). */
  const held = () => heldOff(packs.on, layout.get().packsOff ?? []);
  const hidden = (id: string) => held().has(id);
  const shown = () => packs.on.filter((c) => !hidden(c.manifest.id));
  /**
   * Whether a page answers here (#405): a core path, or one a shown pack holds (its /<id> or a
   * manifest path). Core's links to a page whose pack is off are left out: Today, the g keys, the
   * installed app's shortcuts. Read at request time, once every route is mounted.
   */
  let corePaths = new Set<string | undefined>();
  const pageOn = (href: string) => {
    const seg = href.split(/[/?#]/)[1] ?? "";
    return seg === "" || corePaths.has(seg) || shown().some((c) => c.manifest.id === seg || (c.manifest.paths ?? []).includes(seg));
  };
  /** What the first shown pack sharing it shares under a name: core reads packs' contracts by name, never their ids. */
  const shared = <K extends keyof PackShares>(name: K): PackShares[K] | undefined => sharedFrom(shown(), ctxOf, name, log);
  /** My list (`list`, #393): Bino and search read it, never its store. */
  const sharedList = (): ListShare | undefined => shared("list");
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
  const packNav = () => navFrom(shown(), ctxOf, log);
  const packFeed = () => packFeedOf(feedFrom(shown().filter((c) => !layout.get().feedOff?.includes(c.manifest.id)), ctxOf, log), Date.now());
  /** What each pack says Bino may know (binoFrom). */
  const packBino = () => binoFrom(shown(), ctxOf, log, own);
  /** The packs as Bino's pages know them, and what each says a page of its is (`about`). */
  const packApps = () => aboutFrom(packs.on, ctxOf, log, own);
  /** The origins a pack's own page may frame (`frames`), for that page's policy. */
  const packFrames = (path: string) => framesFrom(packs.on, ctxOf, path, log);
  // Core pages' named places (types.ts SlotMap): what each shown pack puts there.
  const fill = fillOf(shown, ctxOf, log);
  // A pack's own named places (its manifest's `hosts`, #477): what the shown packs that use it put there.
  const fillOwn = fillOwnOf(shown, ctxOf, log);
  /** What the packs call an actions-log entry of theirs (a name for an id). */
  const packWhere = (a: { kind: string; target: string }) => whereFrom(fill, a);
  const packWhat = (kind: string) => whatFrom(fill, kind);
  /** What Bino may propose that the packs carry out (`acts`): local only, as Bino's own are. */
  const packActs = () => (hosted ? [] : actsFrom(shown(), ctxOf, log));
  /** What Bino may look up in the packs' apps (`lookups`), here and hosted. */
  const packLookups = () => lookupsFrom(shown(), ctxOf, log);
  /** One lookup, logged as `<pack>.lookup`: its kind and the fields' names, never what came back. */
  const runLookup = async (l: { kind: string; args: Record<string, string> }): Promise<{ text: string; error?: boolean }> => {
    const k = packLookups().find((x) => x.kind === l.kind);
    if (!k) return { text: "That app isn't on here now.", error: true };
    const args = Object.fromEntries(k.fields.flatMap((f) => (typeof l.args?.[f.name] === "string" && l.args[f.name] ? [[f.name, l.args[f.name]!.slice(0, f.max)]] : [])));
    const got = await k.run(args);
    await logAction(env.DB, { kind: `${k.pack}.lookup`, target: k.kind, detail: Object.keys(args).length ? `by ${Object.keys(args).join(", ")}` : undefined, ok: !got.error }).catch(() => {});
    return got;
  };
  const packPages = () => pagesFrom(shown(), ctxOf, log);
  /** The packs' rows for search (findsFrom). */
  const packFinds = () => findsFrom(shown(), ctxOf, log);
  /** The packs' kinds of reference (a ticket key…), for links in My list and deploys. */
  const packRefs = () => refsFrom(shown(), ctxOf, log);
  const packCards = (): Promise<{ cards: TodayCard[]; failed: Off[] }> => todayCards(shown(), ctxOf, packs.budgetMs ?? TODAY_MS, log);
  /** The packs' kinds of notification (Settings), and what they say needs me (rung once per key by the composition root). */
  const packRings = ringsOf(packs.on, RING_KINDS.map((k) => k.kind), log);
  /** The packs' kinds that are off until I switch them on. */
  const startsOff = new Set(packRings.filter((r) => r.off).map((r) => r.kind));
  const packNeeds = () => needsFrom(shown(), ctxOf, packRings, log);
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
    void packs.keys!.read(ks).then((changed) => (changed ? o.settle(id).then(() => deps.hub?.publish([id, "packs"])) : undefined)).catch(() => {});
  };
  // The one refresher: the composition roots' schedule runs through it too (`packsOf(app).refresh`),
  // so an asked, a scheduled and a soon refresh of a pack never run beside each other. Hosted, a
  // refresh that never settles is given up (a cancelled request's I/O); locally a soon gets a timer.
  const runPackRefresh = refresher(packs.on, ctxOf, (l) => console.log(l), {
    record: refreshes,
    skip: hidden,
    failed: keysAgain,
    ...(hosted
      ? { maxMs: REFRESH_STUCK_MS }
      : {
          timer: (fn: () => void, ms: number) => {
            const t = setTimeout(fn, ms);
            t.unref?.();
            return () => clearTimeout(t);
          },
        }),
  });
  /** Agent turns whose end their pack has heard of (or is about to), newest last. */
  const toldTurns = new Set<string>();
  /**
   * A turn changed (the runner says so, local only): once it has ended, and a sandbox run's commits
   * are home (or two minutes passed without), its pack's refresh is told, once (#479).
   */
  const agentChanged = (r: Run, late = false): void => {
    const id = r.scope?.pack;
    if (!id || r.status === "running" || toldTurns.has(r.id)) return;
    if (r.sandbox && (!r.out || r.out.state === "collecting") && !late) {
      if (lateTurns.has(r.id)) return;
      lateTurns.add(r.id);
      setTimeout(() => agentChanged(r, true), TURN_HOME_MS).unref?.();
      return;
    }
    lateTurns.delete(r.id);
    toldTurns.add(r.id);
    if (toldTurns.size > 500) toldTurns.delete(toldTurns.values().next().value!);
    const c = packs.on.find((p) => p.manifest.id === id);
    if (!c?.refresh || hidden(id)) return;
    void Promise.resolve()
      .then(() => ctxOf(c).agent.result(r.id))
      .then((run) => (run && run.status !== "running" ? runPackRefresh.agent(c, run) : undefined))
      .catch((e) => packLog(id)(`a turn's end wasn't told: ${(e as Error)?.message ?? e}`));
  };
  const lateTurns = new Set<string>();
  const keysRead = async () => {
    const ids = [...packs.on.map((p) => p.manifest), ...packs.off.map((o) => o.manifest)].filter((m) => m && manifestSettings(m).some((s) => s.secret && packs.keys?.state(s.key))).map((m) => m!.id);
    for (const id of ids) await o.settle(id);
    if (ids.length) deps.hub?.publish(["packs", "snapshot", ...ids]);
  };
  /** How things are across the shown packs (`pulse`); a pack reading it from its own `pulse` gets nothing back. */
  let pulsing = false;
  const pulseNow = (): Pulse => {
    if (pulsing) return { working: 0, asking: 0, trouble: [], busy: false };
    pulsing = true;
    try {
      const a = pulseFrom(shown(), ctxOf, log);
      return { ...a, busy: a.working > 0 || !!o.thinking() };
    } finally {
      pulsing = false;
    }
  };
  const mountAssets = () => {
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
  };
  /** The packs' panels for /stats, over the weeks I picked (Settings → Layout). */
  // Days touch at most five weeks: that's what a pack drawing weekly gets.
  const packStats = () => {
    const l = layout.get();
    return statsFrom(shown(), ctxOf, l.statsDays ? Math.ceil(l.statsDays / 7) + 1 : (l.statsWeeks ?? WEEKS), log, l.statsDays);
  };
  // A pack's sign-in return (`callback`), the same way: before the guard, on this machine's own
  // address, never hosted. The pack checks its own one-time state; a hidden pack's is a 404.
  const mountCallbacks = () => {
    if (hosted) return;
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
  };
  // Packs' routes last, each under its own /<id> on its own sub-app: none can shadow a core route,
  // another pack's, or add middleware in front of anything but its own paths.
  // (A pack's /<id>/callback and /<id>/ingest/*, mounted before the guard above, are its own, not the core's.)
  const mountRoutes = () => {
    const callbacks = new Set([
      ...(deps.packs?.on ?? []).filter((x) => x.callback).map((x) => `/${x.manifest.id}/callback`),
      ...(deps.packs?.on ?? []).filter((x) => x.ingest).map((x) => `/${x.manifest.id}/ingest/*`),
    ]);
    corePaths = new Set(app.routes.filter((r) => !callbacks.has(r.path)).map((r) => r.path.split("/")[1]));
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
        const body = html`${PageHeader({ title: c.manifest.name })}${Notice({ tone: "bad", children: html`<p><strong>${c.manifest.name} broke on this page.</strong> The rest of Dovre is fine. The pack's log on the <a href="/packs">Packs</a> page says what happened. <a href="${o.bugHref(cx.req.path, why, id)}">Report this</a> if it looks like a bug.</p><p class="mono t3">${why.slice(0, 300)}</p>` })}`;
        try {
          const res = await ctxOf(c).page(cx, { title: c.manifest.name, body });
          return new Response(res.body, { status: 500, headers: res.headers });
        } catch {
          return cx.text(`${c.manifest.name} broke on this page: ${why.slice(0, 300)}`, 500);
        }
      };
      sub.onError((err, cx) => (o.pending(err) ? Promise.reject(err) : brokePage(cx, String((err as Error)?.message ?? err))));
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
  };
  return {
    packs, ctxOf, packLog, shown, hidden, held, pageOn, shared, sharedList, shipsWasm,
    styles: PACK_CSS ? [PACK_CSS.path] : undefined, scripts: packScripts,
    packNav, packFeed, packBino, packApps, packFrames, fill, packWhere, packWhat, packActs, packLookups, runLookup, packPages, packFinds, packRefs,
    packCards, packRings, startsOff, packNeeds, packStats, packLinked: () => linkedFrom(shown(), ctxOf, log),
    refreshes, runPackRefresh, agentChanged, keysRead, keysAgain, packIds, packsGet, instanceRepo, opening, releases,
    setupOf, setupLeft, aiStore, aiAsk, envSeen,
    mountCallbacks, mountAssets, mountRoutes,
  };
}
