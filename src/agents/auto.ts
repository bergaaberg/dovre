/**
 * Auto runs (#207): issues an owner labelled `dovre:auto` are picked up on their own and worked on
 * in a sandbox run, ending in a draft PR. This file is what's decided without the forge: the
 * limits on Settings, an issue's own options block, the prompt, quiet hours, and the queue (D1's
 * `auto_runs`, so a restart or another Worker isolate carries on). The forge side and the loop
 * that drives it are src/actions/auto.ts.
 */
import type { D1 } from "../db.ts";
import { EFFORTS, type Effort } from "./runner.ts";
import { dtf } from "../when.ts";

export const AUTO_LABEL = "dovre:auto";
export const DONE_LABEL = "dovre:auto-done";
export const STUCK_LABEL = "dovre:auto-stuck";

/**
 * What Settings allows. `off`: repos (owner/name) left out while the rest are on. `quiet`: hours
 * (0–23, in the instance's timezone) when nothing new starts, `from` up to `to`, across midnight
 * when `from` > `to`.
 */
export type AutoSettings = { on: boolean; off: string[]; atOnce: number; runUsd: number; dayUsd: number; minutes: number; quiet: { from: number; to: number } | null };

export const DEFAULT_AUTO: AutoSettings = { on: false, off: [], atOnce: 1, runUsd: 5, dayUsd: 20, minutes: 60, quiet: null };

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const hour = (v: unknown): number | undefined => {
  if (v === "" || v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : undefined;
};
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** Settings from anything (the stored JSON, or the form): every value bounded, defaults for the rest. */
export function autoSettingsOf(v: unknown): AutoSettings {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const offList = Array.isArray(o.off) ? o.off : typeof o.off === "string" ? o.off.split(/[\s,]+/) : [];
  const from = hour((o.quiet as { from?: unknown } | undefined)?.from ?? o.quietFrom);
  const to = hour((o.quiet as { to?: unknown } | undefined)?.to ?? o.quietTo);
  return {
    on: o.on === true || o.on === "on",
    off: [...new Set(offList.map((x) => String(x).trim()).filter((x) => REPO.test(x)).map((x) => x.toLowerCase()))].slice(0, 100),
    atOnce: Math.round(num(o.atOnce, DEFAULT_AUTO.atOnce, 1, 5)),
    runUsd: num(o.runUsd, DEFAULT_AUTO.runUsd, 0.5, 100),
    dayUsd: num(o.dayUsd, DEFAULT_AUTO.dayUsd, 0.5, 500),
    minutes: Math.round(num(o.minutes, DEFAULT_AUTO.minutes, 5, 240)),
    quiet: from !== undefined && to !== undefined && from !== to ? { from, to } : null,
  };
}

export async function loadAutoSettings(db: D1): Promise<AutoSettings> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'auto'").first<{ value: string }>();
    return autoSettingsOf(row ? JSON.parse(row.value) : {});
  } catch {
    return { ...DEFAULT_AUTO };
  }
}

export async function saveAutoSettings(db: D1, s: AutoSettings): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value, at) VALUES ('auto', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at")
    .bind(JSON.stringify(s), new Date().toISOString())
    .run();
}

/** Whether `repo` may run now, by Settings. */
export const repoOn = (s: AutoSettings, repo: string) => s.on && !s.off.includes(repo.toLowerCase());

/** The hour at `now` in `tz` (an IANA zone; invalid or empty: this machine's). */
export function localHour(now: number, tz?: string): number {
  const fmt = (zone?: string) => dtf("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" });
  let f: Intl.DateTimeFormat;
  try {
    f = fmt(tz || undefined);
  } catch {
    f = fmt();
  }
  return Number(f.formatToParts(new Date(now)).find((x) => x.type === "hour")?.value ?? 0) % 24;
}

/** Inside quiet hours: `from` up to (not including) `to`, across midnight when `from` > `to`. */
export function isQuiet(s: Pick<AutoSettings, "quiet">, h: number): boolean {
  if (!s.quiet) return false;
  const { from, to } = s.quiet;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/**
 * An issue's own options: a fenced block with the info string `dovre`, `key: value` a line. They
 * can only narrow what Settings allows: `budget` and `minutes` up to Settings' caps, a known
 * `model` and `effort`, a plain branch name as `base`. Anything else is ignored.
 */
export type AutoOptions = { model?: string; effort?: Effort; budget?: number; minutes?: number; base?: string };

const MODELS = ["opus", "sonnet", "haiku"];
const BRANCH = /^[\w][\w./-]{0,120}$/;

export function autoOptionsOf(body: string | null | undefined): AutoOptions {
  const m = /^(`{3,}|~{3,})[ \t]*dovre[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m.exec(String(body ?? ""));
  if (!m) return {};
  const out: AutoOptions = {};
  for (const line of m[2]!.split(/\r?\n/).slice(0, 20)) {
    const kv = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv as unknown as [string, string, string];
    if (k === "model" && MODELS.includes(v.toLowerCase())) out.model = v.toLowerCase();
    else if (k === "effort" && (EFFORTS as readonly string[]).includes(v.toLowerCase())) out.effort = v.toLowerCase() as Effort;
    else if (k === "budget") {
      const n = Number(v.replace(/^\$/, ""));
      if (Number.isFinite(n) && n > 0) out.budget = n;
    } else if (k === "minutes") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.minutes = n;
    } else if (k === "base" && BRANCH.test(v) && !v.includes("..") && !v.endsWith(".lock") && !v.endsWith("/")) out.base = v;
  }
  return out;
}

/** What a run gets: the issue's options within Settings' caps. */
export function capsFor(s: AutoSettings, o: AutoOptions): { model: string; effort?: Effort; budget: number; maxMs: number } {
  return {
    model: o.model ?? "",
    ...(o.effort ? { effort: o.effort } : {}),
    budget: Math.min(s.runUsd, o.budget ?? Infinity),
    maxMs: Math.round(Math.min(s.minutes, o.minutes ?? Infinity) * 60_000),
  };
}

/** The issue as the agent reads it: a fixed preamble first. Repo instructions (CLAUDE.md) still apply in the clone. */
export function autoPrompt(i: { repo: string; number: number; title: string; body: string | null }): string {
  const body = String(i.body ?? "").trim().slice(0, 15_000);
  return [
    `You are working on GitHub issue ${i.repo}#${i.number} on your own. Its owner labelled it for Dovre to do unattended: nobody is watching, and nobody can answer questions.`,
    "",
    "- Do what the issue asks, and only that. Follow the repo's own instructions (CLAUDE.md and the like).",
    "- Don't change CI config, release or deploy settings, or anything about secrets, unless the issue asks for exactly that.",
    "- Run the repo's checks (typecheck, tests) before you commit, and fix what you broke.",
    "- Commit your work on the current branch. Your commits become a draft PR the owner reviews; mention the issue in the commit message.",
    "- If you can't do it, or it isn't clear enough to do safely, commit nothing and say why in your last message.",
    "",
    `# ${i.title.slice(0, 300)}`,
    "",
    body || "(The issue has no description.)",
  ].join("\n");
}

// ── The queue ──

export type AutoState = "queued" | "starting" | "running" | "waiting" | "done" | "stuck" | "refused";
export type AutoRow = {
  key: string;
  repo: string;
  number: number;
  title: string;
  state: AutoState;
  run: string | null;
  cost: number;
  why: string | null;
  pr: string | null;
  seen: string | null;
  options: string | null;
  at: number;
  updated: number;
};

export const autoKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
/** States that hold a slot (count against "at once"). */
export const BUSY: AutoState[] = ["starting", "running"];

export function autoStore(db: D1, now: () => number = Date.now) {
  /** The row's current run has cost this much so far: shown on the row, and kept per run for the day's cap. */
  async function setCost(key: string, cost: number): Promise<void> {
    await db.prepare("UPDATE auto_runs SET cost = ? WHERE key = ?").bind(cost, key).run();
    await db
      .prepare(
        "INSERT INTO auto_spend (key, run, cost, at) SELECT key, run, ?, ? FROM auto_runs WHERE key = ? AND run IS NOT NULL " +
          "ON CONFLICT (key, run) DO UPDATE SET cost = excluded.cost, at = excluded.at",
      )
      .bind(cost, now(), key)
      .run();
  }
  return {
    setCost,
    async all(): Promise<AutoRow[]> {
      const { results } = await db.prepare("SELECT * FROM auto_runs ORDER BY at DESC LIMIT 200").all<AutoRow>();
      return results;
    },
    async get(key: string): Promise<AutoRow | undefined> {
      return (await db.prepare("SELECT * FROM auto_runs WHERE key = ?").bind(key).first<AutoRow>()) ?? undefined;
    },
    /** A new turn for the issue (or a fresh one, relabelled after it ended): queued, or refused with why. */
    async put(r: { repo: string; number: number; title: string; state: "queued" | "refused"; why?: string; seen?: string; options?: AutoOptions }): Promise<void> {
      const t = now();
      await db
        .prepare(
          "INSERT INTO auto_runs (key, repo, number, title, state, run, cost, why, pr, seen, options, at, updated) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?, ?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET title = excluded.title, state = excluded.state, run = NULL, cost = 0, why = excluded.why, pr = NULL, seen = excluded.seen, options = excluded.options, at = excluded.at, updated = excluded.updated",
        )
        .bind(autoKey(r.repo, r.number), r.repo, r.number, r.title.slice(0, 300), r.state, r.why ?? null, r.seen ?? null, r.options ? JSON.stringify(r.options) : null, t, t)
        .run();
    },
    /** Moves a row on, only from the state it was seen in: false when someone else (another isolate) moved it first. */
    async move(key: string, from: AutoState, to: AutoState, set: { run?: string | null; cost?: number; why?: string | null; pr?: string | null } = {}): Promise<boolean> {
      const r = await db
        .prepare("UPDATE auto_runs SET state = ?, run = COALESCE(?, run), cost = COALESCE(?, cost), why = ?, pr = COALESCE(?, pr), updated = ? WHERE key = ? AND state = ?")
        .bind(to, set.run ?? null, set.cost ?? null, set.why ?? null, set.pr ?? null, now(), key, from)
        .run();
      const moved = Number(r.meta?.changes ?? 0) === 1;
      if (moved && set.cost !== undefined) await setCost(key, set.cost);
      return moved;
    },
    /** What auto runs reported since `since` have cost (the day's cap is over the last 24 hours), every run counted. */
    async spent(since: number): Promise<number> {
      const row = await db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM auto_spend WHERE at >= ?").bind(since).first<{ c: number }>();
      return Number(row?.c ?? 0);
    },
  };
}
export type AutoStore = ReturnType<typeof autoStore>;
