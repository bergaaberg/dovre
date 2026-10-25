/**
 * The public demo (demo.dovre.dev): hosted Dovre's pages over made-up data (fixtures.ts). It is a
 * separate entry from createWorker on purpose. It reads no bindings at all (no token, no D1, no
 * Access, no hub, no bridge), so nothing real can reach it, and the open door below can't be turned
 * on in a real instance by a setting. Every write is refused before the app sees it.
 */
import { createApp } from "../app.ts";
import type { D1 } from "../db.ts";
import type { App, Env } from "../env.ts";
import type { Gatherer } from "../gather.ts";
import type { Ghe } from "../sources/ghe.ts";
import { activePacks } from "../packs/registry.ts";
import { type Pack, PACK_API } from "../packs/types.ts";
import { agentsPack } from "../packs/core/agents/index.ts";
import { fixedHere } from "../packs/core/agents/here.ts";
import { assistantPack } from "../packs/core/assistant/index.ts";
import { avatarPack } from "../packs/core/avatar/index.ts";
import { createDismissed } from "../agents/dismissed.ts";
import { localDesk } from "../agents/desk.ts";
import { createQueue } from "../agents/queue.ts";
import { html } from "hono/html";
import { DEMO_HOST, DEMO_LOGIN, DEMO_ORG, demoSessions, demoSnapshot, demoTurns } from "./fixtures.ts";
import type { Desk } from "../agents/desk.ts";

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
const noGhe: Ghe = {
  host: DEMO_HOST,
  rest: () => Promise.reject(new Error("Not in the demo: it shows made-up data.")),
  graphql: () => Promise.reject(new Error("Not in the demo: it shows made-up data.")),
};

/** The snapshot, made fresh each minute so its times read as this morning. */
function demoGatherer(): Gatherer {
  let s = demoSnapshot();
  const now = () => {
    if (Date.now() - s.at > 120_000) s = demoSnapshot();
    return s;
  };
  return { get: async () => now(), stale: () => {}, gathering: () => false, peek: () => now() };
}

/** The bar on every page that says what this is. */
const demoPack = (): Pack => ({
  manifest: { api: PACK_API, id: "demo", name: "Demo", description: "Says on every page that this is a demo with made-up data.", domain: "general" },
  banner: () =>
    html`<div class="notice accent"><div><p><strong>This is a demo.</strong> The repos, people and agents are made up, and nothing you click changes anything. <a href="https://dovre.dev/docs/">Run your own Dovre</a>.</p></div></div>`,
});

const READ_ONLY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Read-only demo</title>
<body>
<h1>This demo is read-only</h1><p>The demo shows made-up data, so buttons that would change something stop here.</p>
<p><a href="/">Back to the demo</a> · <a href="https://dovre.dev/docs/">Run your own Dovre</a></p></body>`;

export function createDemoWorker(opts: { version?: string } = {}) {
  const version = opts.version ?? "0.2.0";
  let app: App | undefined;
  const build = (): App => {
    if (app) return app;
    const DB = emptyD1();
    const env: Env = { DB, GHE_HOST: DEMO_HOST, GHE_ORG: DEMO_ORG, OWNERS: DEMO_ORG, GITHUB_USER: DEMO_LOGIN, CODE_DIR: "/code", CLAUDE_DIR: "/claude", IS_HOSTED: "1" };
    const gatherer = demoGatherer();
    const sessions = demoSessions();
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
        return session ? { session, turns: demoTurns(sid), run: undefined, queued: [], discardable: false, turnCost: undefined, replyCopies: false, copies: [], copyOf: undefined } : undefined;
      },
    };
    const avatar = avatarPack({ feeds: () => ({ working: 1, asking: 0, trouble: [], busy: false }) });
    const { on, off } = activePacks([agentsPack({ desk, dismissed, here }), assistantPack(), avatar, demoPack()], { env: {}, bindings: {}, hosted: true });
    app = createApp(env, {
      gatherer,
      ghe: noGhe,
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
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(READ_ONLY, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
