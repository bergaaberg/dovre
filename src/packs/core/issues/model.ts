/** What the Issues pack keeps in memory, and the pure rules over it: which set, what's stale. */
import type { Issue, IssueSets } from "../../../forge/types.ts";
import { ISSUE_SETS } from "../../../sources/issues.ts";

export type SetId = (typeof ISSUE_SETS)[number];
export { ISSUE_SETS };

export const SET_LABEL: Record<SetId, string> = { assigned: "Assigned", mentioned: "Mentioned", authored: "Opened by me", triage: "Triage" };

/** The last read: its sets, or why it failed (the sets before it are kept to show). */
export type IssuesKept = { at: number; sets?: IssueSets; error?: string };

export const DAY = 86_400_000;
export const DEFAULT_STALE_DAYS = 14;

/** ISSUES_STALE_DAYS: whole days, 1 to 365; anything else is the default. */
export function staleDaysOf(raw: string | undefined): number {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_STALE_DAYS;
}

/** ISSUES_TRIAGE_REPOS: `owner/repo`s, comma- or space-separated. */
export const triageReposOf = (raw: string | undefined): string[] => (raw ?? "").split(/[\s,]+/).filter(Boolean);

/** Days since it last changed, when that's past the limit; else undefined. */
export function staleFor(i: Issue, days: number, now: number): number | undefined {
  const at = Date.parse(i.updatedAt);
  if (!Number.isFinite(at)) return undefined;
  const d = Math.floor((now - at) / DAY);
  return d >= days ? d : undefined;
}

export const setOf = (raw: string | undefined): SetId => (ISSUE_SETS as readonly string[]).includes(raw ?? "") ? (raw as SetId) : "assigned";

/** An issue's key: `owner/repo#n`. */
export const keyOf = (i: Pick<Issue, "repo" | "number">) => `${i.repo}#${i.number}`;

/** How long an issue that came into a set counts as new (a need, the brief). */
export const FRESH_MS = DAY;

/** The sets that ask something of me when an issue comes into them. */
export const ASKING = ["assigned", "mentioned"] as const satisfies readonly SetId[];

/**
 * When each issue came into each asking set, by `set:key`. The first read only learns what's
 * there (nothing in it is new); after that an issue not seen in a set before is new from now.
 * One that leaves a set and comes back is new again.
 */
export function cameIn(seen: Map<string, number> | undefined, sets: IssueSets, now: number): Map<string, number> {
  const next = new Map<string, number>();
  for (const s of ASKING) for (const i of sets[s]) {
    const k = `${s}:${keyOf(i)}`;
    next.set(k, seen ? (seen.get(k) ?? now) : 0);
  }
  return next;
}

/** The issues new in the asking sets now, newest first. */
export function freshOf(sets: IssueSets | undefined, came: Map<string, number>, now: number): { set: (typeof ASKING)[number]; issue: Issue; at: number }[] {
  if (!sets) return [];
  return ASKING.flatMap((set) => sets[set].flatMap((issue) => {
    const at = came.get(`${set}:${keyOf(issue)}`) ?? 0;
    return at > 0 && now - at < FRESH_MS ? [{ set, issue, at }] : [];
  })).sort((a, b) => b.at - a.at);
}

/** What Bino may know: counts and `repo#n`s, never titles or bodies (other people's words). */
export function binoLine(sets: IssueSets | undefined, fresh: { set: string; issue: Issue }[], triage: boolean): string {
  if (!sets) return "";
  const parts = [`${sets.assigned.length} assigned to me`, `${sets.mentioned.length} mentioning me`, `${sets.authored.length} opened by me`, ...(triage ? [`${sets.triage.length} waiting for triage`] : [])];
  const news = fresh.length ? ` New for me: ${[...new Set(fresh.map((f) => keyOf(f.issue)))].slice(0, 10).join(", ")}.` : "";
  return `Open issues: ${parts.join(", ")}.${news}`;
}
