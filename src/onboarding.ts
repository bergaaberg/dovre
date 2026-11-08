/**
 * What the climb (#417, src/pages/welcome.ts) was told: the role, where code lives, the two
 * answers, the packs picked, and whether it's done. Kept in the settings table under "onboarding",
 * the same hosted and here, so Bino and "Suggest packs again" can read it back. Read strictly: an
 * old or edited row can't set anything this file doesn't know.
 */
import type { D1 } from "./db.ts";
import { type Answers, INTERVIEW, QUESTIONS, ROLES } from "./packs/suggest.ts";
import type { Role } from "./packs/types.ts";

export const FORGES = [
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["none", "None"],
] as const;
export type ForgeChoice = (typeof FORGES)[number][0];

export type Onboarding = {
  role?: Role;
  forge?: ForgeChoice;
  answers: Answers;
  /** The packs switched on at the summit, by id. */
  picked?: string[];
  /** The climb was finished or skipped: Today stops sending here. */
  done?: boolean;
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const isRole = (r: unknown): r is Role => typeof r === "string" && Object.hasOwn(ROLES, r);

/** Only questions the interview has and options they offer; a single-answer question keeps one. */
export function answersFrom(raw: unknown): Answers {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Answers = {};
  for (const qid of new Set(Object.values(INTERVIEW).flat())) {
    const q = QUESTIONS[qid]!;
    const ok = (x: unknown): x is string => typeof x === "string" && q.opts.some((o) => o.v === x);
    const a = v[qid];
    if (q.multi) {
      if (Array.isArray(a)) out[qid] = [...new Set(a.filter(ok))];
    } else if (ok(a)) out[qid] = a;
  }
  return out;
}

export function onboardingOf(raw: unknown): Onboarding {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Onboarding = { answers: answersFrom(v.answers) };
  if (isRole(v.role)) out.role = v.role;
  if (FORGES.some(([f]) => f === v.forge)) out.forge = v.forge as ForgeChoice;
  if (Array.isArray(v.picked)) out.picked = [...new Set(v.picked.filter((x): x is string => typeof x === "string" && ID.test(x)))].slice(0, 200);
  if (v.done === true) out.done = true;
  return out;
}

export type OnboardingStore = { get(): Onboarding; save(o: Onboarding): Promise<void>; ready: Promise<void> };

/** Loaded once at start (`ready`), kept in memory, written through on each save. */
export function onboardingStore(db: D1): OnboardingStore {
  let now: Onboarding = { answers: {} };
  const ready = db
    .prepare("SELECT value FROM settings WHERE key = 'onboarding'")
    .first<{ value: string }>()
    .then((row) => {
      try {
        now = onboardingOf(JSON.parse(row?.value ?? "{}"));
      } catch {}
    })
    .catch(() => {});
  return {
    ready,
    get: () => now,
    async save(o) {
      now = onboardingOf(o);
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, at) VALUES ('onboarding', ?, ?)").bind(JSON.stringify(now), new Date().toISOString()).run();
    },
  };
}
