/** What tests share: the hostile string, a snapshot builder, a scripted fake GHE, and the app signed in. */
import type { Forge } from "../src/forge/types.ts";
import { agentsPack } from "../src/packs/core/agents/index.ts";
import { fixedHere, type Here } from "../src/packs/core/agents/here.ts";
import type { Sessions } from "../src/sources/sessions.ts";
import type { Worktree } from "../src/sources/worktrees.ts";
import { createDismissed } from "../src/agents/dismissed.ts";
import { type Desk, localDesk } from "../src/agents/desk.ts";
import type { Runner } from "../src/agents/runner.ts";
import { createQueue, type Queue } from "../src/agents/queue.ts";
import type { Pack } from "../src/packs/types.ts";
import { activePacks } from "../src/packs/registry.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noMemory } from "../src/packs/core/assistant/bino/memory.ts";
import { routeOf } from "../src/packs/core/assistant/bino/route.ts";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import type { Config, PaneId, PaneState, PanesOn } from "../src/config.ts";
import type { Env } from "../src/env.ts";
import { terminalPack } from "../src/packs/core/terminal/index.ts";
import { createTerminals } from "../src/packs/core/terminal/terms.ts";
import type { Gatherer, Snapshot } from "../src/gather.ts";
import type { Session } from "../src/sources/claude.ts";
import type { Deploy, Ghe, Move, Note, Pr } from "../src/sources/ghe.ts";

/** Markup if anything renders it unescaped: put it in every string field of a view's input. */
export const H = `<script>x</script>"'><img src=x onerror=1>`;

export function assertInert(name: string, out: string) {
  for (const live of ["<script>x", "<img src=x", "onerror=1>"]) assert.ok(!out.includes(live), `${name}: ${live} reached the page as markup`);
}

export const pr = (o: Partial<Pr> = {}): Pr => ({
  repo: "ACME/shop-api", number: 1, title: "A PR", url: "https://acme.ghe.com/ACME/shop-api/pull/1", draft: false,
  updatedAt: "2026-10-22T07:00:00Z", branch: "feat/x", author: "ola-nordmann", review: "REVIEW_REQUIRED", checks: "SUCCESS", openThreads: 0,
  body: "", additions: 1, deletions: 0, headSha: "abc1234def", labels: [], files: [], reviews: [], requested: [], runs: [], ...o,
});

export const session = (o: Partial<Session> = {}): Session => ({ sessionId: "s-1", live: true, status: "busy", prs: [], subagentsRunning: 0, ...o });

export const deploy = (o: Partial<Deploy> = {}): Deploy => ({
  id: 10, name: "Deploy to PROD", title: "Deploy to PROD", actor: "per-hansen", createdAt: "2026-10-22T06:45:00Z", url: "https://acme.ghe.com/ACME/people/actions/runs/10",
  sha: "3f59045", headSha: "3f59045aaaa", branch: "main", repo: "ACME/people", envs: [{ id: 5, name: "prod" }], superseded: [], more: false, ...o,
});

export const move = (o: Partial<Move> = {}): Move => ({ at: "2026-10-22T06:00:00Z", actor: "per-hansen", bot: false, repo: "ACME/shop-api", type: "PullRequestEvent", verb: "opened", ref: "ACME/shop-api#2", title: "Fix", url: "https://acme.ghe.com/ACME/shop-api/pull/2", ...o });

export const note = (o: Partial<Note> = {}): Note => ({ id: "1", reason: "mention", type: "Issue", title: "Hello", repo: "ACME/forms", updatedAt: "2026-10-22T06:00:00Z", url: "https://acme.ghe.com/ACME/forms/issues/1", ...o });

export function snapshot(o: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.parse("2026-10-22T07:00:00Z"),
    login: "ola-nordmann",
    org: "ACME",
    prs: { ok: true, value: { mine: [], review: [] } },
    notes: { ok: true, value: [] },
    moves: { ok: true, value: [] },
    deploys: { ok: true, value: [] },
    refs: new Map(),
    changelogs: new Map(),
    red: [],
    name: "Andreas",
    ...o,
  };
}

/** A GHE that answers from `routes` ("METHOD /path" → body), and records every call. */
export function fakeGhe(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const ghe: Ghe = {
    host: "acme.ghe.com",
    async rest<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const method = init.method ?? "GET";
      calls.push({ method, path, body: init.body });
      const key = `${method} ${path}`;
      if (!(key in routes)) throw new Error(`GHE ${key}: 404`);
      const r = routes[key];
      return (typeof r === "function" ? (r as (b: unknown) => unknown)(init.body) : r) as T;
    },
    async graphql<T>() {
      return {} as T;
    },
  };
  return { ghe, calls };
}

export const fixedGatherer = (s: Snapshot): Gatherer & { staled: number } => {
  const g = { staled: 0, get: async () => s, stale: () => void g.staled++, gathering: () => false, peek: () => s };
  return g;
};

const ENV: Omit<Env, "DB"> = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x", SORTING_REPOS: "intake", FORM_REPOS: "FORMS", FORM_SKILL: "issue-forms" };

/** What the agents pack has read on this machine, for a test: its sessions and worktrees. */
export type Machine = { sessions?: Partial<Sessions>; worktrees?: Worktree[] };
const hereOf = (m: Machine = {}) => fixedHere({ live: m.sessions?.live ?? [], recent: m.sessions?.recent ?? [] }, m.worktrees ?? []);

/** The app with a fixed snapshot and a fake GHE, signed in. */
/** `extra.sessions`, `extra.worktrees`: what the agents pack read here. */
export function signedIn(s: Snapshot, routes: Record<string, unknown | ((body: unknown) => unknown)> = {}, extra: Machine & { panes?: PanesOn; config?: { panes: Record<PaneId, PaneState>; stored: Config }; packs?: Pack[]; /** The instance's settings the packs read. */ packEnv?: Record<string, string>; budgetMs?: number; desk?: Desk; /** The forge's abilities (default GitHub: all). */ forge?: Pick<Forge, "id" | "name" | "can">; varsFile?: string } = {}) {
  const db = openDb();
  const { ghe, calls } = fakeGhe(routes);
  const gatherer = fixedGatherer(s);
  // Bino off (no model in tests): its pages still render, and say how to turn it on.
  // Terminals with nothing to run (no host is ever started): their pages render. A core pack, as index.ts adds it.
  const terminals = createTerminals({ hostExe: "no-host", codeDir: ENV.CODE_DIR, programs: [] });
  // The agents pack, with the desk and the sessions cleared away, as index.ts makes them.
  const { pack: agents } = agentsFor({ ...ENV, DB: db.DB }, { here: hereOf(extra), desk: extra.desk });
  const packs = [agents, terminalPack(terminals), ...(extra.packs ?? [])];
  const app = createApp({ ...ENV, DB: db.DB }, { gatherer, ghe, forge: extra.forge, bino: { route: routeOf({ via: "off" }), memory: noMemory("off in tests") }, panes: extra.panes, config: extra.config, packs: { ...activePacks(packs, { env: extra.packEnv ?? {}, hosted: false, which: () => "/bin/x" }), env: extra.packEnv ?? {}, budgetMs: extra.budgetMs, core: ["agents", "terminal"], varsFile: extra.varsFile } });
  const get = (path: string, headers: Record<string, string> = {}) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token", ...headers } });
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", ...headers },
      body: new URLSearchParams(body).toString(),
    });
  return { app, get, post, calls, db, gatherer };
}

/**
 * The agents pack for a test app, as the composition roots build it: what it read here (`here`,
 * default nothing), a desk (the one given, or this machine's over `runner`) and the sessions
 * cleared away.
 */
export function agentsFor(env: Pick<Env, "CODE_DIR" | "CLAUDE_DIR" | "AGENT_DIR" | "DB">, o: { here?: Here; desk?: Desk; runner?: Runner; queue?: Queue } = {}) {
  const here = o.here ?? fixedHere();
  const dismissed = createDismissed(env.DB);
  const desk = o.desk ?? localDesk({ env, runner: o.runner, queue: o.queue ?? createQueue(), sessions: () => here.ready(), onStarted: (sid) => dismissed.remove(sid) });
  return { desk, dismissed, here, pack: agentsPack({ desk, dismissed, here }) };
}

/**
 * createApp with Dovre's agents pack mounted, as the entries do, for tests that build the app by
 * hand: the desk over `deps.runner` (or the one given), the packs given after it.
 */
export function appWithAgents(env: Parameters<typeof createApp>[0], deps: Parameters<typeof createApp>[1] & Machine & { extra?: Pack[]; packEnv?: Record<string, string>; desk?: Desk; queue?: Queue }) {
  const { extra = [], packEnv = {}, sessions, worktrees, desk, queue, ...rest } = deps;
  const agents = agentsFor(env, { here: hereOf({ sessions, worktrees }), desk, runner: rest.runner, queue });
  const given = rest.packs;
  const active = activePacks([agents.pack, ...extra], { env: packEnv, hosted: env.IS_HOSTED === "1", which: () => "/bin/x" });
  return createApp(env, { ...rest, packs: { ...given, on: [...active.on, ...(given?.on ?? [])], off: [...active.off, ...(given?.off ?? [])], env: given?.env ?? packEnv, core: ["agents", ...(given?.core ?? [])] } });
}
