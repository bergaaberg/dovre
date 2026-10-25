/**
 * The public demo (demo.dovre.dev): hosted Dovre's pages over made-up data (fixtures.ts). It is a
 * separate entry from createWorker on purpose. It reads no bindings at all (no token, no D1, no
 * Access, no hub, no bridge), so nothing real can reach it, and the open door below can't be turned
 * on in a real instance by a setting. Every write is refused before the app sees it.
 */
import { createApp } from "../app.ts";
import type { D1 } from "../db.ts";
import type { App, AppEnv, Env } from "../env.ts";
import type { Gatherer, Snapshot } from "../gather.ts";
import type { Ghe } from "../sources/ghe.ts";
import { fixedLayout, type LayoutStore } from "../layout.ts";
import { activePacks } from "../packs/registry.ts";
import { type Pack, PACK_API } from "../packs/types.ts";
import { agentsPack } from "../packs/core/agents/index.ts";
import { fixedHere } from "../packs/core/agents/here.ts";
import { assistantPack } from "../packs/core/assistant/index.ts";
import { noMemory } from "../packs/core/assistant/bino/memory.ts";
import { avatarPack } from "../packs/core/avatar/index.ts";
import { createDismissed } from "../agents/dismissed.ts";
import { localDesk } from "../agents/desk.ts";
import { createQueue } from "../agents/queue.ts";
import type { Context } from "hono";
import { html } from "hono/html";
import { PageHeader, Panel } from "../ui/kit.ts";
import { safeUrl } from "../pages/parts.ts";
import { DEMO_HOST, DEMO_LOGIN, DEMO_ORG, demoSessions, demoSnapshot, demoStats, demoTurns } from "./fixtures.ts";
import { demoScriptRoute, demoSeedConvs } from "./bino.ts";
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
export function makeNoGhe(host: string = DEMO_HOST): Ghe {
  return {
    host,
    rest: () => Promise.reject(new Error("Not in the demo: it shows made-up data.")),
    graphql: () => Promise.reject(new Error("Not in the demo: it shows made-up data.")),
  };
}
const noGhe = makeNoGhe();

/** The snapshot, made fresh each minute so its times read as this morning. */
export function demoGatherer(snapshotFn: (now?: number) => Snapshot = demoSnapshot): Gatherer {
  let s = snapshotFn();
  const now = () => {
    if (Date.now() - s.at > 120_000) s = snapshotFn();
    return s;
  };
  return { get: async () => now(), stale: () => {}, gathering: () => false, peek: () => now() };
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
    paths: ["elsewhere"],
  },
  banner: () =>
    html`<div class="notice accent"><div><p><strong>This is a demo.</strong> The repos, people and agents are made up, and nothing you click changes anything. <a href="https://dovre.dev/docs/">Run your own Dovre</a>.</p></div></div>`,
  routes(app, ctx) {
    const splash = async (c: Context<AppEnv>) => {
      const raw = c.req.path.replace(/^\/elsewhere\/?/, "");
      let target = raw;
      try {
        target = decodeURIComponent(raw);
      } catch {
        target = raw;
      }
      const label = describeTarget(target);
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
              <p>On your own Dovre this opens <strong>${label}</strong> on GitHub. This is a demo, so it stops here.</p>
              <p><a href="${backHref}">Back to the demo</a> · <a href="https://dovre.dev/docs/">Run your own Dovre</a></p>
            </div>
          `,
        })}
      `;
      return ctx.page(c, { title: "External link · Dovre", current: "/elsewhere", body });
    };
    app.get("/elsewhere", splash);
    app.get("/elsewhere/*", splash);
  },
});

const READ_ONLY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Read-only demo</title>
<body>
<h1>This demo is read-only</h1><p>The demo shows made-up data, so buttons that would change something stop here.</p>
<p><a href="/">Back to the demo</a> · <a href="https://dovre.dev/docs/">Run your own Dovre</a></p></body>`;

export function isAllowedDemoWrite(request: Request): boolean {
  if (request.method !== "POST") return false;
  const url = new URL(request.url);
  return url.pathname === "/bino/new" || /^\/bino\/c\/[0-9a-f-]{36}\/say$/i.test(url.pathname);
}

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
  allowWrite?: (req: Request) => boolean;
  layout?: LayoutStore | { tabs?: string[]; [key: string]: unknown };
  fixtures?: DemoFixtures;
  packs?: Pack[];
};

export function createDemoWorker(opts: DemoOpts = {}) {
  const version = opts.version ?? "0.2.0";
  const fixtures = opts.fixtures;
  const host = fixtures?.host ?? DEMO_HOST;
  const org = fixtures?.org ?? DEMO_ORG;
  const login = fixtures?.login ?? DEMO_LOGIN;
  const snapshotFn = fixtures?.snapshot ?? demoSnapshot;
  const sessionsFn = fixtures?.sessions ?? demoSessions;
  const turnsFn = fixtures?.turns ?? demoTurns;
  const statsFn = fixtures?.stats ?? demoStats;

  let app: App | undefined;
  const build = (): App => {
    if (app) return app;
    const DB = emptyD1();
    const env: Env = { DB, GHE_HOST: host, GHE_ORG: org, OWNERS: org, GITHUB_USER: login, CODE_DIR: "/code", CLAUDE_DIR: "/claude", IS_HOSTED: "1", GREETING: "en", TZ_NAME: "UTC" };
    const gatherer = demoGatherer(snapshotFn);
    const sessions = sessionsFn();
    const here = fixedHere(sessions);
    const dismissed = createDismissed(DB);
    // No runner: nothing can start, and the writes that would ask are refused before the app anyway.
    const queue = createQueue();
    const local = localDesk({ env, queue, sessions: async () => sessions });
    // A session's page reads its transcript from disk; the demo's come from the fixtures.
    const desk: Desk = {
      ...local,
      async session(sid) {
        const session = [...sessions.live, ...sessions.recent].find((x) => x.sessionId === sid);
        return session ? { session, turns: turnsFn(sid), run: undefined, queued: [], discardable: false, turnCost: undefined, replyCopies: false, copies: [], copyOf: undefined } : undefined;
      },
    };
    const avatar = avatarPack({ feeds: () => ({ working: 1, asking: 0, trouble: [], busy: false }) });
    const extraPacks = opts.packs ?? [];
    const { on, off } = activePacks([agentsPack({ desk, dismissed, here }), assistantPack(), avatar, demoPack(), ...extraPacks], { env: {}, bindings: {}, hosted: true });
    const stats = statsFn();
    const layout = opts.layout ? ("get" in opts.layout ? (opts.layout as LayoutStore) : fixedLayout(opts.layout)) : fixedLayout({ tabs: ["/prs", "/agents", "/deploys"] });
    const initialSnapshot = gatherer.peek() ?? snapshotFn();
    const route = demoScriptRoute({ snapshot: () => gatherer.peek() ?? snapshotFn() });
    const memory = noMemory("The demo remembers nothing.");
    const seed = demoSeedConvs(initialSnapshot);
    const store = { load: () => seed, save: () => {} };
    const bino = { route, memory, store, maxConvs: 20 };
    app = createApp(env, {
      gatherer,
      ghe: makeNoGhe(host),
      stats,
      layout,
      bino,
      // The one open door: everyone is the demo visitor. Only this entry passes it.
      access: async () => ({ email: "visitor@demo.dovre.dev" }),
      info: { version: `${version}-demo`, startedAt: Date.now() },
      packs: { on, off, env: {}, bindings: {}, core: ["agents", "assistant", "avatar"] },
    });
    return app;
  };

  return {
    async fetch(request: Request, bindings: { ASSETS?: { fetch(req: Request): Promise<Response> } } = {}): Promise<Response> {
      const url = new URL(request.url);
      if (bindings.ASSETS && /^\/assets\/(icon[\w-]*\.(png|svg|ico)|fonts\/NordwandMono-\w+\.woff2)$/.test(url.pathname)) {
        const res = await bindings.ASSETS.fetch(new Request(new URL(url.pathname.slice("/assets".length), url), request));
        if (res.ok) return res;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        const allowed = opts.allowWrite ? opts.allowWrite(request) : isAllowedDemoWrite(request);
        if (!allowed) return new Response(READ_ONLY, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (url.pathname === "/bridge") return new Response("Not found", { status: 404 });
      const res = await build().fetch(request);
      // Search engines: the demo isn't the product's page.
      const out = new Response(res.body, res);
      out.headers.set("x-robots-tag", "noindex");
      return out;
    },
  };
}

export default createDemoWorker();
