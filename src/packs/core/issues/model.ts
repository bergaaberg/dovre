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
