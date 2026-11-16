/**
 * A review finding as a record (#555): one problem a reviewer reports on a diff, with a severity,
 * tags from a fixed list, the lines it's on, a title, why it matters and how to fix it. Auto
 * review keeps them in its own table (src/packs/core/autoreview/findings.ts); the shape lives here
 * so other reviews can take it. Pure.
 */
import type { PrFile } from "../sources/prview.ts";
import { cleanPath, cleanText, type LineComment, placeComments, type Side } from "./draft.ts";

/** Most severe first. Critical and high must be fixed before a merge; medium and low are only reported. */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What a finding is about. A reviewer uses only these. */
export const FINDING_TAGS = ["correctness", "security", "performance", "ux", "tests", "error-handling", "scope", "clarity"] as const;
export type FindingTag = (typeof FINDING_TAGS)[number];

/**
 * Where a finding stands. `open` as reported; `force-fix` and `force-ignore` are the owner's word
 * on it, at any severity; `fixed` once a later review of newer commits doesn't raise it; `merged`
 * when it was folded into another finding of the same problem.
 */
export const FINDING_STATUSES = ["open", "force-fix", "force-ignore", "fixed", "merged"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

const MAX_TITLE = 150;
/** Why and the fix together stay inside one comment (draft.ts `MAX_BODY`). */
const MAX_WHY = 3000;
const MAX_FIX = 2000;
const MAX_TAGS = 4;

/** A finding as a reviewer reports it, on lines of the diff. `startLine` when it spans several; `fix` may be empty. */
export type Found = { severity: Severity; tags: FindingTag[]; path: string; line: number; startLine?: number; side: Side; title: string; body: string; fix: string };

/** Does it hold a PR back: the owner said fix it, or it's open and critical or high. */
export const gates = (f: { severity: Severity; status: FindingStatus }) => f.status === "force-fix" || (f.status === "open" && (f.severity === "critical" || f.severity === "high"));

const lineOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
const oneLine = (v: unknown, max: number) => cleanText(v, max * 4).replace(/\s+/g, " ").slice(0, max).trim();

/**
 * One finding from what a reviewer wrote (a parsed JSON object), or null when it lacks a known
 * severity, a path, a line the forge would take a comment on, or any text. Unknown tags are left
 * out; a title that's missing is the text's first line.
 */
export function foundOf(raw: unknown, files: PrFile[]): Found | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const severity = (SEVERITIES as readonly unknown[]).includes(r.severity) ? (r.severity as Severity) : undefined;
  const path = cleanPath(r.path);
  const line = lineOf(r.line);
  const body = cleanText(r.text, MAX_WHY);
  if (!severity || !path || !line || !body) return null;
  const side: Side = r.side === "LEFT" ? "LEFT" : "RIGHT";
  const start = lineOf(r.start);
  const placed = placeComments([{ path, line, side, body, ...(start && start < line ? { startLine: start } : {}) }], files).inline[0];
  if (!placed) return null;
  const tags = [...new Set(Array.isArray(r.tags) ? r.tags : [])].filter((t): t is FindingTag => (FINDING_TAGS as readonly unknown[]).includes(t)).slice(0, MAX_TAGS);
  const title = oneLine(r.title, MAX_TITLE) || oneLine(body.split("\n")[0], MAX_TITLE);
  return { severity, tags, path, line, ...(placed.startLine ? { startLine: placed.startLine } : {}), side, title, body, fix: cleanText(r.fix, MAX_FIX) };
}

const LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** A finding as its line comment says it: severity and title, why, the suggested fix, its tags. Markdown. */
export function findingBody(f: Found): string {
  return [`**${LABEL[f.severity]}:** ${f.title}`, f.body, f.fix ? `**Suggested fix:** ${f.fix}` : "", f.tags.length ? `<sub>${f.tags.join(", ")}</sub>` : ""].filter(Boolean).join("\n\n");
}

/** Where it goes on the PR, with `body` as its comment. */
export const findingPlace = (f: Found, body: string): LineComment => ({ path: f.path, line: f.line, ...(f.startLine ? { startLine: f.startLine } : {}), side: f.side, body });

/** Counts by severity, as "1 critical, 2 high, 1 low"; empty for none. */
export function severityCounts(list: { severity: Severity }[]): string {
  return SEVERITIES.map((s) => [s, list.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

/** Most severe first, in the order reported within a severity. */
export const bySeverity = <T extends { severity: Severity }>(list: T[]): T[] => [...list].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
