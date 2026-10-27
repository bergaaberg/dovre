/**
 * For a pack's tests: a PackContext with harmless defaults (nothing gathered, an empty page, no
 * slots filled), so a test names only what it needs and keeps compiling when the context grows.
 * A pack imports it as `dovre/packs/testing.ts`. Below it, what a test of a pack's pages needs.
 */
import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import { type D1, openDb } from "../db.ts";
import type { Env } from "../env.ts";
import type { Forge } from "../forge/types.ts";
import type { Snapshot } from "../gather.ts";
import type { Session } from "../sources/claude.ts";
import type { Deploy, Ghe, Pr } from "../sources/ghe.ts";
import { noMemory } from "./core/assistant/bino/memory.ts";
import { routeOf } from "./core/assistant/bino/route.ts";
import { activePacks } from "./registry.ts";
import type { Pack, PackContext } from "./types.ts";

export function testContext(over: Partial<PackContext> = {}): PackContext {
  return {
    env: {},
    bindings: {},
    hosted: false,
    db: undefined as unknown as D1,
    publish: () => {},
    snapshot: () => undefined,
    gathered: async () => undefined,
    fill: () => [],
    page: async () => new Response(),
    dockPage: () => new Response(),
    log: () => {},
    ring: () => {},
    ask: async () => ({ action: "cancel" }),
    asking: () => false,
    pulse: () => ({ working: 0, asking: 0, trouble: [], busy: false }),
    forge: () => undefined,
    startPicture: () => {},
    ...over,
  };
}

// ── For tests of a pack's pages: made-up data, hostile text, and an app around the pack ──

/** Markup if anything renders it unescaped: put it in every string field of a view's input. */
export const HOSTILE = `<script>x</script>"'><img src=x onerror=1>`;

/** Fails when hostile text (HOSTILE) reached the page as markup. */
export function assertInert(name: string, out: string) {
  for (const live of ["<script>x", "<img src=x", "onerror=1>"]) assert.ok(!out.includes(live), `${name}: ${live} reached the page as markup`);
}

export const testPr = (o: Partial<Pr> = {}): Pr => ({
  repo: "ACME/shop-api", number: 1, title: "A PR", url: "https://acme.ghe.com/ACME/shop-api/pull/1", draft: false,
  updatedAt: "2026-10-22T07:00:00Z", branch: "feat/x", author: "ola-nordmann", review: "REVIEW_REQUIRED", checks: "SUCCESS", openThreads: 0,
  body: "", additions: 1, deletions: 0, headSha: "abc1234def", labels: [], files: [], reviews: [], requested: [], runs: [], ...o,
});

export const testSession = (o: Partial<Session> = {}): Session => ({ sessionId: "s-1", live: true, status: "busy", prs: [], subagentsRunning: 0, ...o });

export const testDeploy = (o: Partial<Deploy> = {}): Deploy => ({
  id: 10, name: "Deploy to PROD", title: "Deploy to PROD", actor: "per-hansen", createdAt: "2026-10-22T06:45:00Z", url: "https://acme.ghe.com/ACME/people/actions/runs/10",
  sha: "3f59045", headSha: "3f59045aaaa", branch: "main", repo: "ACME/people", envs: [{ id: 5, name: "prod" }], superseded: [], more: false, ...o,
});

/** A gathered snapshot: 2026-10-22 07:00 UTC, ola-nordmann in ACME, nothing open. */
export function testSnapshot(o: Partial<Snapshot> = {}): Snapshot {
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

/**
 * Dovre around these packs, signed in, on a fresh database: `get` and `post` (a form, from this
 * app's own origin unless `headers` say otherwise) answer as the app would. GitHub answers nothing;
 * Bino is off.
 */
export function packApp(packs: Pack[], o: { snapshot?: Snapshot; /** The instance's settings the packs read. */ env?: Record<string, string>; forge?: Pick<Forge, "id" | "name" | "can"> & Partial<Pick<Forge, "host" | "work" | "merged" | "repos" | "file">>; hosted?: boolean; /** Local: the code folder packs see as `ctx.codeDir`. */ codeDir?: string } = {}) {
  const db = openDb();
  const s = o.snapshot ?? testSnapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const ghe: Ghe = { host: "acme.ghe.com", rest: () => Promise.reject(new Error("no GitHub in tests")), graphql: () => Promise.reject(new Error("no GitHub in tests")) };
  const env = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: o.codeDir ?? "x", CLAUDE_DIR: "x", SORTING_REPOS: "intake", FORM_REPOS: "FORMS", FORM_SKILL: "issue-forms", DB: db.DB } as Env;
  const app = createApp(env, { gatherer, ghe, forge: o.forge, bino: { route: routeOf({ via: "off" }), memory: noMemory("off in tests") }, packs: { ...activePacks(packs, { env: o.env ?? {}, hosted: !!o.hosted, which: () => "/bin/x" }), env: o.env ?? {} } });
  const get = (path: string, headers: Record<string, string> = {}) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token", ...headers } });
  const post = (path: string, body: Record<string, string> | string, headers: Record<string, string> = {}) =>
    app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { cookie: "u_tk=test-token", "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", ...headers },
      body: new URLSearchParams(body).toString(),
    });
  return { app, get, post, db };
}
