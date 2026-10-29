/**
 * The public demo (demo.dovre.dev): hosted Dovre's pages over made-up data (fixtures.ts). It is a
 * separate entry from createWorker on purpose. It reads no bindings at all (no token, no D1, no
 * Access, no hub, no bridge), so nothing real can reach it, and the open door below can't be turned
 * on in a real instance by a setting. Every write is refused before the app sees it, except asking
 * the scripted Bino (bino.ts), which answers in the same response and keeps nothing.
 */
import { createApp, packsOf } from "../app.ts";
import type { D1 } from "../db.ts";
import type { App, AppEnv, Env } from "../env.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Gatherer, Snapshot } from "../gather.ts";
import type { Ghe } from "../sources/ghe.ts";
import { fixedLayout, type Layout, type LayoutStore } from "../layout.ts";
import { activePacks, refresher, within } from "../packs/registry.ts";
import { type Pack, PACK_API } from "../packs/types.ts";
import { agentsPack } from "../packs/core/agents/index.ts";
import { fixedHere } from "../packs/core/agents/here.ts";
import { assistantPack } from "../packs/core/assistant/index.ts";
import { noMemory } from "../packs/core/assistant/bino/memory.ts";
import { FORGE_CAN } from "../forge/types.ts";
import { createDismissed } from "../agents/dismissed.ts";
import { localDesk } from "../agents/desk.ts";
import { HARNESSES } from "../agents/runner.ts";
import { createQueue } from "../agents/queue.ts";
import type { Context } from "hono";
import { html } from "hono/html";
import { PageHeader, Panel } from "../ui/kit.ts";
import { safeUrl } from "../pages/parts.ts";
import { DEMO_HOST, DEMO_LOGIN, DEMO_ORG, demoPrFiles, demoPrNode, demoSessions, demoSnapshot, demoStats, demoTurns } from "./fixtures.ts";
import { type DemoAnswer, demoBino, demoEngine, demoScriptRoute, demoSeedConvs } from "./bino.ts";
export type { DemoAnswer };
import type { Engine } from "../packs/core/assistant/bino/bino.ts";
import type { Desk } from "../agents/desk.ts";
import type { Stats } from "../stats/stats.ts";
import type { Sessions } from "../sources/sessions.ts";
import type { Turn } from "../agents/conversation.ts";

/** A database that holds nothing and keeps nothing: every read is empty, every write is dropped. */
export function emptyD1(): D1 {
  const statement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
  };
  return { prepare: () => statement, batch: async () => [] } as unknown as D1;
}

/** GitHub that isn't there: pages that ask it directly say it failed, as they do when GitHub is down. */
/** The demo's forge: it answers a demo PR's page and files from the fixtures (#265), and nothing else. */
export function makeNoGhe(host: string = DEMO_HOST): Ghe {
  const no = () => Promise.reject(new Error("Not in the demo: it shows made-up data."));
  return {
    host,
    rest: <T>(path: string) => {
      const m = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/files\?(?:.*&)?page=(\d+)/);
      if (!m) return no();
      return Promise.resolve((m[3] === "1" ? demoPrFiles(m[1]!, Number(m[2])) : []) as T);
    },
    graphql: <T>(query: string) => {
      const m = query.match(/repository\(owner:"([\w.-]+)",name:"([\w.-]+)"\)\{pullRequest\(number:(\d+)\)/);
      const node = m ? demoPrNode(Date.now(), `${m[1]}/${m[2]}`, Number(m[3])) : undefined;
      return node ? Promise.resolve(node as T) : no();
    },
  };
}

/** The snapshot, made fresh each minute so its times read as this morning. */
export function demoGatherer(snapshotFn: (now?: number) => Snapshot = demoSnapshot): Gatherer {
  let s = snapshotFn();
  const now = () => {
    if (Date.now() - s.at > 120_000) s = snapshotFn();
    return s;
  };
  return { get: async () => now(), stale: () => {}, gathering: () => false, peek: () => now() };
}

/** Where an external link would have gone: GitHub paths by default, or another app's when the path starts with its host. */
export function whereTo(path: string): { label: string; site: string } {
  const clean = path.replace(/^\/+/, "");
  const host = clean.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/(.*)$/i);
  if (host) return { label: host[2]!.split("/").filter(Boolean).pop() || host[1]!, site: host[1]! };
  return { label: describeTarget(clean), site: "GitHub" };
}

export function describeTarget(path: string): string {
  const clean = path.replace(/^\/+/, "");
  const prOrIssue = clean.match(/^([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/);
  if (prOrIssue) return `${prOrIssue[1]}#${prOrIssue[2]}`;
  const actionsRun = clean.match(/^([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/);
  if (actionsRun) return `${actionsRun[1]} (run #${actionsRun[2]})`;
  const actions = clean.match(/^([\w.-]+\/[\w.-]+)\/actions/);
  if (actions) return `${actions[1]} actions`;
  const commit = clean.match(/^([\w.-]+\/[\w.-]+)\/commits?\/(.+)/);
  if (commit) return `${commit[1]} (${commit[2]})`;
  const repo = clean.match(/^([\w.-]+\/[\w.-]+)/);
  if (repo) return repo[1];
  return clean || "this link";
}

/** The bar on every page that says what this is, and the splash route for external links. */
const demoPack = (): Pack => ({
  manifest: {
    api: PACK_API,
    id: "demo",
    name: "Demo",
    description: "Says on every page that this is a demo with made-up data.",
    domain: "general",
    paths: ["elsewhere", "read-only"],
  },
  banner: () =>
    html`<div class="notice accent"><div><p><strong>This is a demo.</strong> The repos, people and agents are made up, and nothing you click changes anything. <a href="https://dovre.dev/">← dovre.dev</a> · <a href="https://dovre.dev/docs/">Run your own Dovre</a>.</p></div></div>`,
  routes(app, ctx) {
    const splash = async (c: Context<AppEnv>) => {
      const raw = c.req.path.replace(/^\/elsewhere\/?/, "");
      let target = raw;
      try {
        target = decodeURIComponent(raw);
      } catch {
        target = raw;
      }
      const { label, site } = whereTo(target);
      const referer = c.req.header("referer");
      let backHref = "/";
      if (referer) {
        try {
          const u = new URL(referer);
          const cur = new URL(c.req.url);
          const back = u.pathname + u.search;
          // Only a path of this demo's own: safeUrl() turns `//elsewhere.example` into "#".
          if (u.origin === cur.origin && u.pathname !== c.req.path && safeUrl(back) === back) backHref = back;
        } catch {}
      }
      const body = html`
        ${PageHeader({ title: "External link", crumbs: [{ label: "Demo", href: "/" }, { label: "External link" }] })}
        ${Panel({
          children: html`
            <div class="empty">
              <p>On your own Dovre this opens <strong>${label}</strong> on ${site}. This is a demo, so it stops here.</p>
              <p><a href="${backHref}">Back to the demo</a> · <a href="https://dovre.dev/">← dovre.dev</a> · <a href="https://dovre.dev/docs/">Run your own Dovre</a></p>
            </div>
          `,
        })}
      `;
      return ctx.page(c, { title: "External link · Dovre", current: "/elsewhere", body });
    };
    app.get("/elsewhere", splash);
    app.get("/elsewhere/*", splash);
    // What a refused write shows (the worker draws it as the 403's body): why, and the way back.
    app.get("/read-only", (c) => {
      const back = c.req.query("back") ?? "";
      const backHref = back.startsWith("/") && safeUrl(back) === back ? back : "/";
      const body = html`
        ${PageHeader({ title: "Read-only demo", crumbs: [{ label: "Demo", href: "/" }, { label: "Read-only" }] })}
        ${Panel({
          children: html`
            <div class="empty">
              <p>${whyReadOnly(c.req.query("did") ?? "")}</p>
              <p><a href="${backHref}">Back to the demo</a> · <a href="https://dovre.dev/">← dovre.dev</a> · <a href="https://dovre.dev/docs/">Run your own Dovre</a></p>
            </div>
          `,
        })}
      `;
      return ctx.page(c, { title: "Read-only demo · Dovre", current: "/read-only", body });
    });
  },
});

/** Why a button does nothing here, by the path it posted to. */
export function whyReadOnly(path: string): string {
  if (path === "/refresh" || path === "/stats/refresh") return "Refreshing reads GitHub and your packs again. The demo's data is made up, so there's nothing new to read.";
  if (path.startsWith("/deploys/")) return "On your own Dovre, approving or rejecting a deploy goes to GitHub after a second click to confirm. The demo's deploys are made up.";
  if (path.startsWith("/todo")) return "Your list is saved in your own Dovre. The demo keeps nothing between clicks.";
  if (path.startsWith("/settings")) return "Settings are saved in your own Dovre. The demo's are fixed, so everyone sees the same page.";
  if (/^\/agents\/s\/[^/]+\/reply$/.test(path)) return "A reply goes to the agent's session on your machine. These agents are made up; ask Bino instead, it answers in the demo.";
  return "This is a demo over made-up data, so buttons that would change something stop here.";
}

/** The only writes the demo takes: asking its scripted Bino, in a new conversation or one of your own. */
export function isAllowedDemoWrite(request: Request): boolean {
  if (request.method !== "POST") return false;
  const url = new URL(request.url);
  return url.pathname === "/bino/new" || /^\/bino\/c\/[0-9a-f-]{36}\/say$/i.test(url.pathname);
}

/** A Bino conversation's page, where /bino/new and /say send you: the demo draws it in the same response. */
const CONV_PAGE = /^\/bino\/(?:dock\/)?c\/[0-9a-f-]{36}$/i;

/** Made-up data a demo repo can supply in place of core's (src/demo/fixtures.ts). */
export type DemoFixtures = {
  host?: string;
  org?: string;
  login?: string;
  snapshot?: (now?: number) => Snapshot;
  sessions?: (now?: number) => Sessions;
  turns?: (sid: string) => Turn[];
  stats?: () => Stats;
};

export type DemoOpts = {
  version?: string;
  /** More writes to let through, beyond asking Bino (isAllowedDemoWrite). Every other non-GET stays 403. */
  allowWrite?: (req: Request) => boolean;
  /** The fixed layout (default: tabs PRs, Agents, Deploys). */
  layout?: LayoutStore | Layout;
  fixtures?: DemoFixtures;
  /** Extra packs, next to the demo's own. */
  packs?: Pack[];
  /** Made-up values for those packs' settings (a fake API key, so a pack fed fixtures runs). Never real secrets. */
  settings?: Record<string, string>;
  /** More scripted Bino answers, tried before the built-in ones (src/demo/bino.ts). */
  answers?: DemoAnswer[];
};

export function createDemoWorker(opts: DemoOpts = {}) {
  const version = opts.version ?? "0.2.1";
  const fx = opts.fixtures ?? {};
  const host = fx.host ?? DEMO_HOST;
  const org = fx.org ?? DEMO_ORG;
  const login = fx.login ?? DEMO_LOGIN;
  const snapshotFn = fx.snapshot ?? demoSnapshot;
  const turnsFn = fx.turns ?? demoTurns;
  /** This request's Bino (demoBino): fresh each time, so nothing a visitor asks outlives their request. */
  const current = new AsyncLocalStorage<Engine>();
  let freshEngine: () => Engine = () => {
    throw new Error("demo not built");
  };
  let app: App | undefined;
  let refresh: ReturnType<typeof refresher> | undefined;
  const build = (): App => {
    if (app) return app;
    const DB = emptyD1();
    const env: Env = { DB, GHE_HOST: host, GHE_ORG: org, OWNERS: org, GITHUB_USER: login, CODE_DIR: "/code", CLAUDE_DIR: "/claude", IS_HOSTED: "1", GREETING: "en", TZ_NAME: "UTC" };
    const gatherer = demoGatherer(snapshotFn);
    const sessions = (fx.sessions ?? demoSessions)();
    const here = fixedHere(sessions);
    const dismissed = createDismissed(DB);
    // No runner: nothing can start, and the writes that would ask are refused before the app anyway.
    const queue = createQueue();
    const local = localDesk({ env, queue, sessions: async () => sessions });
    // A session's page reads its transcript from disk; the demo's come from the fixtures.
    const desk: Desk = {
      ...local,
      // The new-session form as it looks with agents installed; starting one is refused like every write (#268).
      // No folder of this machine's on show.
      view: () => ({ ...local.view(), harnesses: [...HARNESSES], workDir: "~/.dovre/agents" }),
      repos: async () => ["accounts", "catalog", "checkout", "web"],
      async session(sid) {
        const session = [...sessions.live, ...sessions.recent].find((x) => x.sessionId === sid);
        return session ? { session, turns: turnsFn(sid), run: undefined, queued: [], discardable: false, turnCost: undefined, replyCopies: false, copies: [], copyOf: undefined } : undefined;
      },
    };
    const settings = { ...opts.settings };
    const { on, off } = activePacks([agentsPack({ desk, dismissed, here }), assistantPack(), demoPack(), ...(opts.packs ?? [])], { env: settings, bindings: {}, hosted: true });
    const stats = (fx.stats ?? demoStats)();
    const snapshot = () => gatherer.peek() ?? snapshotFn();
    const route = demoScriptRoute({ snapshot, answers: opts.answers });
    const memory = noMemory("The demo remembers nothing.");
    freshEngine = () => demoEngine({ route, memory, seed: () => demoSeedConvs(snapshot()) });
    const bino = { remote: demoBino({ route, memory, engine: () => current.getStore() ?? freshEngine() }) };
    app = createApp(env, {
      gatherer,
      ghe: makeNoGhe(host),
      // GitHub as the pages name it; packs read nothing from it (no `work`): the avatar keeps its starting shape.
      forge: { id: "github", name: "GitHub", can: FORGE_CAN, host },
      stats,
      layout: !opts.layout ? fixedLayout({ tabs: ["/prs", "/agents", "/deploys"] }) : "get" in opts.layout ? opts.layout : fixedLayout(opts.layout),
      bino,
      // The one open door: everyone is the demo visitor. Only this entry passes it.
      access: async () => ({ email: "visitor@demo.dovre.dev" }),
      info: { version: `${version}-demo`, startedAt: Date.now() },
      packs: { on, off, env: settings, bindings: {}, core: ["agents", "assistant"] },
    });
    // Packs fed made-up data read it the way they'd read their app: on their schedule, before the page.
    refresh = refresher(on, packsOf(app)!.ctxOf, () => {});
    return app;
  };

  return {
    async fetch(request: Request, bindings: { ASSETS?: { fetch(req: Request): Promise<Response> } } = {}): Promise<Response> {
      const url = new URL(request.url);
      if (bindings.ASSETS && /^\/assets\/(icon[\w-]*\.(png|svg|ico)|fonts\/NordwandMono-\w+\.woff2)$/.test(url.pathname)) {
        const res = await bindings.ASSETS.fetch(new Request(new URL(url.pathname.slice("/assets".length), url), request));
        if (res.ok) return res;
      }
      if (url.pathname === "/bridge") return new Response("Not found", { status: 404 });
      const app = build();
      if (request.method !== "GET" && request.method !== "HEAD" && !isAllowedDemoWrite(request) && !opts.allowWrite?.(request)) {
        // Refused before the app sees it: the request becomes a GET of the read-only page, still a 403.
        const q = new URLSearchParams({ did: url.pathname });
        try {
          const ref = new URL(request.headers.get("referer") ?? "");
          if (ref.origin === url.origin) q.set("back", ref.pathname + ref.search);
        } catch {}
        const page = await app.fetch(new Request(new URL(`/read-only?${q}`, url), { headers: { accept: "text/html" } }));
        return new Response(page.body, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
      }
      // A pack that hangs doesn't hold the page: it shows what it had.
      if (refresh) await within(2000, () => refresh!.due());
      const engine = freshEngine();
      const res = await current.run(engine, async () => {
        let req = request;
        // A follow-up in your own conversation: nothing was kept, so it starts a new one.
        const say = /^\/bino\/c\/([0-9a-f-]{36})\/say$/i.exec(url.pathname);
        if (say && !engine.get(say[1]!)) req = new Request(new URL("/bino/new", url), request);
        const r = await app.fetch(req);
        const to = r.status === 303 ? r.headers.get("location") : null;
        if (request.method !== "POST" || !to || !CONV_PAGE.test(to)) return r;
        // The answer, drawn now: the next request may land on another isolate.
        await engine.idle();
        return app.fetch(new Request(new URL(to, url), { headers: request.headers }));
      });
      // Search engines: the demo isn't the product's page.
      const out = new Response(res.body, res);
      out.headers.set("x-robots-tag", "noindex");
      return out;
    },
  };
}

