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

// ── The same problem, reported twice (#555 step 2) ──

/** Lines apart two findings may be and still point at the same code. */
const SLACK = 3;
/** How alike two titles must be beside nearby lines, and by themselves once the code has moved. */
const ALIKE = 0.25;
const ALIKE_MOVED = 0.6;
const SMALL = new Set(["the", "and", "for", "not", "with", "that", "this", "from", "when", "are", "was", "but", "its", "into", "can", "may", "does"]);

const wordsOf = (title: string) => new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !SMALL.has(w)));

/** How alike two titles are, 0 to 1: the words they share over the words either has. */
export function titlesAlike(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.size || !y.size) return 0;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both);
}

type Where = Pick<Found, "path" | "line" | "startLine" | "side" | "title" | "tags">;
const near = (a: Where, b: Where) => a.side === b.side && (a.startLine ?? a.line) <= b.line + SLACK && (b.startLine ?? b.line) <= a.line + SLACK;

/**
 * Whether two findings report the same problem: the same file, nearby lines, and a similar title
 * or a shared tag. `moved`: they're from different commits, where lines shift, so clearly similar
 * titles are enough. `titled`: a shared tag isn't enough (for folding into a finding the owner
 * said to ignore: a new problem beside it mustn't vanish with it).
 */
export function sameProblem(a: Where, b: Where, o: { moved?: boolean; titled?: boolean } = {}): boolean {
  if (a.path !== b.path) return false;
  const alike = titlesAlike(a.title, b.title);
  if (near(a, b)) return alike >= ALIKE || (!o.titled && a.tags.some((t) => b.tags.includes(t)));
  return !!o.moved && alike >= ALIKE_MOVED;
}

/**
 * Several reviewers' findings on one commit as one list, the most severe first: those reporting
 * the same problem become one finding, in the words of the most severe, with every tag, the
 * widest lines and what the others called it. One reviewer's own findings never fold: listing
 * two, it meant two problems.
 */
export function foldFound(byReviewer: Found[][]): Found[] {
  const groups: { first: Found; from: Set<number>; rest: Found[] }[] = [];
  const all = bySeverity(byReviewer.flatMap((list, who) => list.map((f) => ({ f, who }))).map((x) => ({ ...x, severity: x.f.severity })));
  for (const { f, who } of all) {
    const g = groups.find((g) => !g.from.has(who) && sameProblem(g.first, f));
    if (g) {
      g.from.add(who);
      g.rest.push(f);
    } else groups.push({ first: f, from: new Set([who]), rest: [] });
  }
  return groups.map(({ first, rest }) => {
    if (!rest.length) return first;
    const start = Math.min(...[first, ...rest].map((f) => f.startLine ?? f.line));
    const line = Math.max(...[first, ...rest].map((f) => f.line));
    const also = [...new Set(rest.map((f) => f.title))].filter((t) => t !== first.title);
    const { startLine: _s, ...one } = first;
    return {
      ...one,
      tags: [...new Set([first, ...rest].flatMap((f) => f.tags))],
      line,
      ...(start < line ? { startLine: start } : {}),
      body: also.length ? `${first.body}\n\nAlso reported as: ${also.map((t) => `"${t}"`).join("; ")}.` : first.body,
    };
  });
}

/** Statuses an earlier finding can have and still take a problem raised again. */
const ACTIVE: readonly FindingStatus[] = ["open", "force-fix", "force-ignore"];

/**
 * Which earlier finding each of `found` raises again, by its place in `found`: the problem was
 * reported on an older commit and is still there. Each earlier finding takes one, and one the
 * owner decided on comes before one that's merely open, so what they said about it stands.
 */
export function raisedAgain<T extends Where & { status: FindingStatus }>(found: Found[], earlier: T[]): Map<number, T> {
  const left = earlier.filter((e) => ACTIVE.includes(e.status)).sort((a, b) => Number(a.status === "open") - Number(b.status === "open"));
  const out = new Map<number, T>();
  found.forEach((f, i) => {
    const at = left.findIndex((e) => sameProblem(e, f, { moved: true, titled: e.status === "force-ignore" }));
    if (at >= 0) out.set(i, left.splice(at, 1)[0]!);
  });
  return out;
}
