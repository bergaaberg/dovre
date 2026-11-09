/**
 * Packs talk to the model (#466, #467): what each pack may ask, kept in pack_ai, and the guarded
 * calls it gets as `ctx.complete` and `ctx.agent`. A pack says in its manifest what it wants and why
 * (`ai`); nothing is allowed until I allow it on Settings → Packs → the pack. Core picks the route,
 * a pack picks only what I let it have, and a day's spend stops at my cap. Each call or turn is
 * logged in pack_ai_calls: when, what it cost, whether it answered; never the prompt or the reply.
 *
 * Levels: `text` (a prompt in, text out: no tools, no files) and `agent`, which takes in text too:
 * an agent turn in one of the repos I allowed, either `read` (plan mode in its checkout under
 * CODE_DIR) or `sandbox` (a fresh clone in a container, host-only network). Never a host turn that
 * edits. A turn sees over /mcp only its own pack's tools and those I granted by name; anything that
 * asks for approval is refused, since nobody is there to answer. One turn at a time per pack, its
 * dollars held against the day's cap until it ends.
 */
import type { Complete } from "../ai/llm.ts";
import type { McpScope, Run } from "../agents/runner.ts";
import type { SandboxState } from "../agents/sandbox.ts";
import type { D1 } from "../db.ts";
import { ownedRepo } from "../sources/files.ts";
import type { PackAgent, PackAgentAsk, PackAgentCan, PackAgentRun, PackAgentStart, PackAgentWhere, PackAi, PackAiAsk, PackCompleteAsk } from "./types.ts";

export type AiLevel = "off" | "text" | "agent";
export type AiSize = "small" | "any";
export type AiGrant = {
  level: AiLevel;
  size: AiSize;
  dayUsd: number;
  /** An agent's grant (#467): where it may run, which repos (`mine`: all of the owners'), other packs' tools by MCP name, and a run's caps. */
  where: PackAgentWhere[];
  repos: "mine" | string[];
  tools: string[];
  runUsd: number;
  turns: number;
};

export const NO_GRANT: AiGrant = { level: "off", size: "small", dayUsd: 1, where: [], repos: [], tools: [], runUsd: 1, turns: 30 };
/** The most a day's cap may be, per pack. */
export const MAX_DAY_USD = 50;
/** The most one agent turn may spend, and its turns at most. */
export const MAX_RUN_USD = 20;
export const MAX_TURNS = 200;
/** An agent turn's wall clock. */
export const AGENT_MINUTES = 30;

const WHERE: readonly PackAgentWhere[] = ["read", "sandbox"];
const TOOL = /^[a-z][a-z0-9_]{0,80}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
/** A write kind of its own, as `writes` names them. */
const KIND = /^[a-z][a-z0-9-]{0,40}$/;

/** Each route by name, as Settings says it. */
export const AI_ROUTE_NAMES: Record<string, string> = { claude: "Claude Code", omp: "Copilot through omp", copilot: "Copilot CLI", agy: "Antigravity", codex: "Codex", off: "nothing" };

/** The model this machine lends packs, and its names for each size (none: the route's own). */
export type AiRoute = { complete: Complete; via: string; models?: { small?: string; large?: string } };

const oneLine = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, 200) : undefined);

/** What a manifest asks for, read safely: a `why` of one line for each, or nothing. */
export function aiAskOf(m: { ai?: unknown } | undefined): PackAiAsk | undefined {
  const ai = m?.ai as { text?: { why?: unknown }; agent?: Record<string, unknown> } | undefined;
  if (!ai || typeof ai !== "object") return undefined;
  const textWhy = ai.text && typeof ai.text === "object" ? oneLine(ai.text.why) : undefined;
  const agent = agentAskOf(ai.agent);
  if (!textWhy && !agent) return undefined;
  return { ...(textWhy ? { text: { why: textWhy } } : {}), ...(agent ? { agent } : {}) };
}

function agentAskOf(a: Record<string, unknown> | undefined): PackAgentAsk | undefined {
  if (!a || typeof a !== "object") return undefined;
  const why = oneLine(a.why);
  const where = WHERE.filter((w) => Array.isArray(a.where) && a.where.includes(w));
  if (!why || !where.length) return undefined;
  const tools = Array.isArray(a.tools) ? [...new Set(a.tools.filter((t): t is string => typeof t === "string" && TOOL.test(t)))].slice(0, 20) : [];
  const lands = where.includes("sandbox") && typeof a.lands === "string" && KIND.test(a.lands) ? a.lands : undefined;
  return { why, where, ...(tools.length ? { tools } : {}), ...(lands ? { lands } : {}) };
}

const money = (v: unknown, max: number, dflt: number, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n * 100) / 100) : dflt;
};
/** Repo names from a line ("a/b, c/d"), plain ones only. */
export const reposOf = (v: unknown): string[] =>
  typeof v === "string" ? [...new Set(v.split(/[\s,]+/).filter((r) => REPO.test(r) && !r.split("/").some((p) => p === "." || p === "..")))].slice(0, 20) : [];

/**
 * A grant from the Settings form, bounded, and never more than the manifest asks for: no agent
 * level, place or tool it didn't ask for. Without `ask` (tests of the bounds), the agent level stays off.
 */
export function grantOf(form: Record<string, unknown>, ask?: PackAiAsk): AiGrant {
  const a = ask?.agent;
  const level: AiLevel = form.level === "agent" ? (a ? "agent" : "off") : form.level === "text" ? "text" : "off";
  const size: AiSize = form.size === "any" ? "any" : "small";
  const dayUsd = money(form.dayUsd, MAX_DAY_USD, NO_GRANT.dayUsd);
  const where = a ? a.where.filter((w) => form[`where_${w}`] === "on" || form[`where_${w}`] === true) : [];
  const tools = (a?.tools ?? []).filter((t) => form[`tool_${t}`] === "on" || form[`tool_${t}`] === true);
  const repos = form.reposAll === "mine" ? "mine" : reposOf(form.repos);
  const runUsd = money(form.runUsd, MAX_RUN_USD, NO_GRANT.runUsd, 0.01);
  const t = Number(form.turns);
  const turns = Number.isInteger(t) && t >= 1 ? Math.min(MAX_TURNS, t) : NO_GRANT.turns;
  return { level, size, dayUsd, where, repos, tools, runUsd, turns };
}

/** A grant as kept, read back without trusting it. */
type Row = { pack: string; level: string; size: string; day_usd: number; places: string | null; repos: string | null; tools: string | null; run_usd: number | null; turns: number | null };
function rowGrant(r: Row): AiGrant {
  const level: AiLevel = r.level === "agent" || r.level === "text" ? r.level : "off";
  const where = WHERE.filter((w) => (r.places ?? "").split(",").includes(w));
  const tools = (r.tools ?? "").split(",").filter((t) => TOOL.test(t));
  const repos = r.repos === "*" ? "mine" : reposOf(r.repos ?? "");
  const t = Number(r.turns);
  return { level, size: r.size === "any" ? "any" : "small", dayUsd: money(r.day_usd, MAX_DAY_USD, NO_GRANT.dayUsd), where, repos, tools, runUsd: money(r.run_usd, MAX_RUN_USD, NO_GRANT.runUsd, 0.01), turns: Number.isInteger(t) && t >= 1 ? Math.min(MAX_TURNS, t) : NO_GRANT.turns };
}

/** Where today starts, on this machine's clock. */
const dayStart = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** An agent turn as pack_ai_calls keeps it: no prompt, no output. */
export type AgentRow = { pack: string; run: string; at: string; cost: number; state: string; place: PackAgentWhere; repo: string };

/** Grants, kept in memory once loaded (pages read them while drawing), and each pack's spend today. */
export function packAiStore(db: D1, now: () => number = Date.now) {
  const grants = new Map<string, AiGrant>();
  let loading: Promise<void> | undefined;
  const load = () =>
    (loading ??= (async () => {
      const { results } = await db.prepare("SELECT pack, level, size, day_usd, places, repos, tools, run_usd, turns FROM pack_ai").all<Row>();
      for (const r of results) grants.set(r.pack, rowGrant(r));
    })().catch((e) => {
      loading = undefined;
      throw e;
    }));
  const toAgent = (r: Record<string, unknown>): AgentRow => ({ pack: String(r.pack), run: String(r.run), at: String(r.at), cost: Number(r.cost) || 0, state: String(r.state), place: r.place === "sandbox" ? "sandbox" : "read", repo: String(r.repo ?? "") });
  return {
    load,
    /** What it may do now (off until loaded, or never allowed). */
    grant: (pack: string): AiGrant => grants.get(pack) ?? NO_GRANT,
    async set(pack: string, g: AiGrant): Promise<void> {
      await load();
      await db
        .prepare("INSERT OR REPLACE INTO pack_ai (pack, level, size, day_usd, places, repos, tools, run_usd, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(pack, g.level, g.size, g.dayUsd, g.where.join(","), g.repos === "mine" ? "*" : g.repos.join(","), g.tools.join(","), g.runUsd, g.turns)
        .run();
      grants.set(pack, g);
    },
    /** Today's dollars: what calls and ended turns cost, and what running turns may still spend. */
    async spent(pack: string): Promise<number> {
      const r = await db.prepare("SELECT COALESCE(SUM(cost), 0) AS usd FROM pack_ai_calls WHERE pack = ? AND at >= ?").bind(pack, dayStart(now())).first<{ usd: number }>();
      return Number(r?.usd ?? 0);
    },
    async record(pack: string, cost: number, ok: boolean): Promise<void> {
      await db.prepare("INSERT INTO pack_ai_calls (pack, at, cost, ok) VALUES (?, ?, ?, ?)").bind(pack, new Date(now()).toISOString(), cost, ok ? 1 : 0).run();
    },
    /** A turn started: its run's dollars held until it ends. */
    async started(pack: string, run: string, held: number, place: PackAgentWhere, repo: string): Promise<void> {
      await db.prepare("INSERT INTO pack_ai_calls (pack, at, cost, ok, kind, run, state, place, repo) VALUES (?, ?, ?, 0, 'agent', ?, 'running', ?, ?)").bind(pack, new Date(now()).toISOString(), held, run, place, repo).run();
    },
    /** A turn ended (or was forgotten): what it cost, in place of what was held. */
    async ended(run: string, cost: number, state: string): Promise<void> {
      await db.prepare("UPDATE pack_ai_calls SET cost = ?, state = ?, ok = ? WHERE kind = 'agent' AND run = ?").bind(cost, state, state === "done" ? 1 : 0, run).run();
    },
    async running(pack: string): Promise<AgentRow[]> {
      const { results } = await db.prepare("SELECT * FROM pack_ai_calls WHERE pack = ? AND kind = 'agent' AND state = 'running'").bind(pack).all<Record<string, unknown>>();
      return results.map(toAgent);
    },
    async agentRun(pack: string, run: string): Promise<AgentRow | undefined> {
      const r = await db.prepare("SELECT * FROM pack_ai_calls WHERE pack = ? AND kind = 'agent' AND run = ?").bind(pack, run).first<Record<string, unknown>>();
      return r ? toAgent(r) : undefined;
    },
  };
}
export type PackAiStore = ReturnType<typeof packAiStore>;

/**
 * What agent turns run on (local only): the runner, and the checks around it that live elsewhere.
 * `checkout`: the checkout under CODE_DIR whose origin is `repo`. `land`: a sandbox run's commits as
 * a draft PR under `kind` (src/actions/sandbox.ts), then the run is told.
 */
export type AgentHost = {
  start(o: { cwd: string; prompt: string; sandbox: boolean; model: string; budget: number; turns: number; maxMs: number; scope: McpScope }): Run;
  get(id: string): Run | undefined;
  checkout(repo: string): Promise<string | undefined>;
  sandbox(): SandboxState | undefined;
  owners(): string;
  land(run: Run, kind: string): Promise<{ number: number; url: string } | { error: string }>;
};

/** The agent's last word, bounded. */
const saidOf = (run: Pick<Run, "events">): string => {
  const r = [...run.events].reverse().find((e) => e.t === "result");
  return r?.t === "result" ? r.text.trim().slice(0, 8000) : "";
};

/** A pack's `ai()`, `complete()` and `agent`: what it may do, and the doors to the model. */
export function packAiFor(o: { id: string; ask: PackAiAsk | undefined; store: PackAiStore | undefined; route: AiRoute | undefined; hosted: boolean; log: (line: string) => void; agents?: AgentHost; audit?: (detail: string, ok: boolean) => void }) {
  const why = (): string | undefined => {
    if (o.hosted) return "not hosted yet";
    if (!o.ask?.text) return "it didn't ask for AI in its manifest";
    if (!o.store) return "no database here";
    if (o.store.grant(o.id).level === "off") return "not allowed: Settings → Packs → this pack";
    if (!o.route) return "no model here: Settings → Work → Model for packs";
    return undefined;
  };
  const ai = (): PackAi => {
    const no = why();
    const g = o.store?.grant(o.id) ?? NO_GRANT;
    return no ? { text: false, why: no } : { text: true, size: g.size, dayUsd: g.dayUsd };
  };
  const complete = async (p: PackCompleteAsk): Promise<{ text: string; cost: number }> => {
    await o.store?.load().catch(() => {});
    const no = why();
    if (no) throw new Error(`AI: ${no}`);
    const store = o.store!;
    const route = o.route!;
    const g = store.grant(o.id);
    if (p.size === "large" && g.size !== "any") throw new Error("AI: only the small model is allowed for this pack");
    const spent = await store.spent(o.id);
    if (spent >= g.dayUsd) throw new Error(`AI: today's cap ($${g.dayUsd.toFixed(2)}) is spent; it opens again tomorrow`);
    if (typeof p.system !== "string" || typeof p.user !== "string") throw new Error("AI: system and user are text");
    const model = route.models?.[p.size === "large" ? "large" : "small"];
    try {
      const r = await route.complete({ system: p.system.slice(0, 20_000), user: p.user.slice(0, 100_000), ...(model ? { model } : {}), ...(p.signal ? { signal: p.signal } : {}) });
      const cost = Number.isFinite(r.cost) && r.cost > 0 ? r.cost : 0;
      await store.record(o.id, cost, true).catch((e) => o.log(`ai: can't log a call: ${(e as Error).message}`));
      return { text: r.text, cost };
    } catch (e) {
      await store.record(o.id, 0, false).catch(() => {});
      throw e;
    }
  };
  return { ai, complete, agent: packAgentFor(o) };
}

/** What the manifest asks and I granted, both: never more than either. */
function allowedOf(ask: PackAgentAsk, g: AiGrant) {
  const where = ask.where.filter((w) => g.where.includes(w));
  const tools = (ask.tools ?? []).filter((t) => g.tools.includes(t));
  return { where, tools };
}

function packAgentFor(o: Parameters<typeof packAiFor>[0]): PackAgent {
  const a = o.ask?.agent;
  const whyNot = (): string | undefined => {
    if (o.hosted) return "not hosted yet";
    if (!a) return "it didn't ask for agent turns in its manifest";
    if (!o.store) return "no database here";
    if (o.store.grant(o.id).level !== "agent") return "not allowed: Settings → Packs → this pack";
    if (!o.agents) return "agents can't run here";
    if (!allowedOf(a, o.store.grant(o.id)).where.length) return "no place to run allowed: Settings → Packs → this pack";
    return undefined;
  };
  const can = (): PackAgentCan => {
    const no = whyNot();
    if (no) return { ok: false, why: no };
    const g = o.store!.grant(o.id);
    const { where, tools } = allowedOf(a!, g);
    return { ok: true, where, repos: g.repos === "mine" ? "mine" : [...g.repos], tools, runUsd: g.runUsd, turns: g.turns, minutes: AGENT_MINUTES };
  };
  /** Its turns that ended since it last looked: their cost in place of what was held. */
  const settle = async (rows: { run: string }[]): Promise<number> => {
    let still = 0;
    for (const r of rows) {
      const run = o.agents?.get(r.run);
      if (run?.status === "running") still++;
      else if (run) await o.store!.ended(r.run, run.cost, run.status);
      // Forgotten by the runner: what was held stays spent, since what it cost isn't known.
      else await o.store!.ended(r.run, (await o.store!.agentRun(o.id, r.run))?.cost ?? 0, "gone");
    }
    return still;
  };

  return {
    can,
    async start(s: PackAgentStart) {
      await o.store?.load().catch(() => {});
      const no = whyNot();
      if (no) return { error: `AI: ${no}` };
      const store = o.store!;
      const host = o.agents!;
      const g = store.grant(o.id);
      const { where, tools } = allowedOf(a!, g);
      if (!s || typeof s !== "object") return { error: "AI: say what to start" };
      if (!where.includes(s.where)) return { error: `AI: ${s.where === "sandbox" || s.where === "read" ? `${s.where} turns aren't allowed for this pack` : "where is read or sandbox"}` };
      if (s.size === "large" && g.size !== "any") return { error: "AI: only the small model is allowed for this pack" };
      const repo = ownedRepo(host.owners(), s.repo);
      if (!repo) return { error: `AI: ${String(s.repo).slice(0, 100)} isn't in your repos` };
      if (g.repos !== "mine" && !g.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return { error: `AI: ${repo} isn't one of the repos allowed for this pack` };
      const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
      if (!prompt || prompt.length > 20_000) return { error: "AI: a prompt is text, at most 20,000 characters" };
      if (s.where === "sandbox") {
        const st = host.sandbox();
        if (!st) return { error: "AI: sandbox runs aren't set up on this machine" };
        if (!st.ok) return { wait: st.why };
      }
      if (await settle(await store.running(o.id))) return { wait: "One turn at a time: its last one is still running." };
      const spent = await store.spent(o.id);
      if (spent + g.runUsd > g.dayUsd) return { wait: `Today's cap ($${g.dayUsd.toFixed(2)}) can't hold another $${g.runUsd.toFixed(2)} run; it opens again tomorrow.` };
      const cwd = await host.checkout(repo);
      if (!cwd) return { error: `AI: there's no checkout of ${repo} in the code folder` };
      let run: Run;
      try {
        run = host.start({ cwd, prompt, sandbox: s.where === "sandbox", model: s.size === "large" ? "sonnet" : "haiku", budget: g.runUsd, turns: g.turns, maxMs: AGENT_MINUTES * 60_000, scope: { pack: o.id, tools } });
      } catch (e) {
        return { wait: `Couldn't start: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
      }
      await store.started(o.id, run.id, g.runUsd, s.where, repo).catch((e) => o.log(`ai: can't log a turn: ${(e as Error).message}`));
      o.audit?.(`${s.where} turn in ${repo}`, true);
      return { run: run.id };
    },
    async result(id: string) {
      if (typeof id !== "string" || !o.store) return undefined;
      const row = await o.store.agentRun(o.id, id).catch(() => undefined);
      if (!row) return undefined;
      const run = o.agents?.get(id);
      if (row.state === "running") await settle([row]);
      const base = { run: id, where: row.place, repo: row.repo };
      if (!run) return { ...base, status: "failed", cost: row.cost, said: "" } satisfies PackAgentRun;
      const out = run.out;
      const commits = out?.state === "ready" ? out.commits.length : out?.state === "none" || out?.state === "failed" ? 0 : undefined;
      return { ...base, status: run.status, cost: run.cost, said: saidOf(run), ...(commits !== undefined ? { commits } : {}), ...(out?.state === "ready" && out.pr ? { pr: { ...out.pr } } : {}) } satisfies PackAgentRun;
    },
    async land(id: string) {
      await o.store?.load().catch(() => {});
      const no = whyNot();
      if (no) return { error: `AI: ${no}` };
      if (!a!.lands) return { error: "AI: it didn't say in its manifest which write kind it lands under" };
      const row = typeof id === "string" ? await o.store!.agentRun(o.id, id).catch(() => undefined) : undefined;
      if (!row || row.place !== "sandbox") return { error: "AI: that isn't a sandbox run this pack started" };
      const run = o.agents!.get(id);
      if (!run) return { error: "AI: that run is gone" };
      if (run.status === "running") return { error: "AI: it's still running" };
      const out = run.out;
      if (!out || out.state === "collecting") return { error: "AI: its commits are still coming home" };
      if (out.state !== "ready") return { error: "AI: it made no commits to land" };
      if (out.pr) return { ...out.pr };
      if (out.ci) return { error: "AI: its commits change CI config, so they aren't pushed for a pack" };
      const g = o.store!.grant(o.id);
      const repo = ownedRepo(o.agents!.owners(), out.repo);
      if (!repo || repo.toLowerCase() !== row.repo.toLowerCase()) return { error: "AI: its checkout's origin isn't the repo it was started in" };
      if (g.repos !== "mine" && !g.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) return { error: `AI: ${repo} isn't one of the repos allowed for this pack` };
      return o.agents!.land(run, `${o.id}.${a!.lands}`);
    },
  };
}
