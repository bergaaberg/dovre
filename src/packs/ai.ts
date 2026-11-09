/**
 * Packs talk to the model (#466): what each pack may ask, kept in pack_ai, and the guarded call it
 * gets as `ctx.complete`. A pack says in its manifest what it wants and why (`ai`); nothing is
 * allowed until I allow it on Settings → Packs → the pack. Core picks the route (AI_VIA), a pack
 * picks only the size I let it have, and a day's spend stops at my cap. Each call is logged in
 * pack_ai_calls: when, what it cost, whether it answered; never the prompt or the reply.
 *
 * Levels: `text` (a prompt in, text out: no tools, no files). `agent` is phase 2 (#467).
 */
import type { Complete } from "../ai/llm.ts";
import type { D1 } from "../db.ts";
import type { PackAi, PackAiAsk, PackCompleteAsk } from "./types.ts";

export type AiLevel = "off" | "text";
export type AiSize = "small" | "any";
export type AiGrant = { level: AiLevel; size: AiSize; dayUsd: number };

export const NO_GRANT: AiGrant = { level: "off", size: "small", dayUsd: 1 };
/** The most a day's cap may be, per pack. */
export const MAX_DAY_USD = 50;

/** Each route by name, as Settings says it. */
export const AI_ROUTE_NAMES: Record<string, string> = { claude: "Claude Code", omp: "Copilot through omp", copilot: "Copilot CLI", agy: "Antigravity", codex: "Codex", off: "nothing" };

/** The model this machine lends packs, and its names for each size (none: the route's own). */
export type AiRoute = { complete: Complete; via: string; models?: { small?: string; large?: string } };

/** What a manifest asks for, read safely: a `why` of one line, or nothing. */
export function aiAskOf(m: { ai?: unknown } | undefined): PackAiAsk | undefined {
  const t = (m?.ai as { text?: { why?: unknown } } | undefined)?.text;
  if (!t || typeof t !== "object" || typeof t.why !== "string" || !t.why.trim()) return undefined;
  return { text: { why: t.why.replace(/\s+/g, " ").trim().slice(0, 200) } };
}

export function grantOf(form: Record<string, unknown>): AiGrant {
  const level: AiLevel = form.level === "text" ? "text" : "off";
  const size: AiSize = form.size === "any" ? "any" : "small";
  const n = Number(form.dayUsd);
  const dayUsd = Number.isFinite(n) && n >= 0 ? Math.min(MAX_DAY_USD, Math.round(n * 100) / 100) : NO_GRANT.dayUsd;
  return { level, size, dayUsd };
}

/** Where today starts, on this machine's clock. */
const dayStart = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** Grants, kept in memory once loaded (pages read them while drawing), and each pack's spend today. */
export function packAiStore(db: D1, now: () => number = Date.now) {
  const grants = new Map<string, AiGrant>();
  let loading: Promise<void> | undefined;
  const load = () =>
    (loading ??= (async () => {
      const { results } = await db.prepare("SELECT pack, level, size, day_usd FROM pack_ai").all<{ pack: string; level: string; size: string; day_usd: number }>();
      for (const r of results) grants.set(r.pack, grantOf({ level: r.level, size: r.size, dayUsd: r.day_usd }));
    })().catch((e) => {
      loading = undefined;
      throw e;
    }));
  return {
    load,
    /** What it may do now (off until loaded, or never allowed). */
    grant: (pack: string): AiGrant => grants.get(pack) ?? NO_GRANT,
    async set(pack: string, g: AiGrant): Promise<void> {
      await load();
      await db.prepare("INSERT OR REPLACE INTO pack_ai (pack, level, size, day_usd) VALUES (?, ?, ?, ?)").bind(pack, g.level, g.size, g.dayUsd).run();
      grants.set(pack, g);
    },
    async spent(pack: string): Promise<number> {
      const r = await db.prepare("SELECT COALESCE(SUM(cost), 0) AS usd FROM pack_ai_calls WHERE pack = ? AND at >= ?").bind(pack, dayStart(now())).first<{ usd: number }>();
      return Number(r?.usd ?? 0);
    },
    async record(pack: string, cost: number, ok: boolean): Promise<void> {
      await db.prepare("INSERT INTO pack_ai_calls (pack, at, cost, ok) VALUES (?, ?, ?, ?)").bind(pack, new Date(now()).toISOString(), cost, ok ? 1 : 0).run();
    },
  };
}
export type PackAiStore = ReturnType<typeof packAiStore>;

/** A pack's `ai()` and `complete()`: what it may do, and the one door to the model. */
export function packAiFor(o: { id: string; ask: PackAiAsk | undefined; store: PackAiStore | undefined; route: AiRoute | undefined; hosted: boolean; log: (line: string) => void }) {
  const why = (): string | undefined => {
    if (o.hosted) return "not hosted yet";
    if (!o.ask?.text) return "it didn't ask for AI in its manifest";
    if (!o.store) return "no database here";
    if (o.store.grant(o.id).level !== "text") return "not allowed: Settings → Packs → this pack";
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
  return { ai, complete };
}
