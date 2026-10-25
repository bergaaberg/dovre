/**
 * Agent code review through two skills (REVIEW_SKILL, TRIAGE_SKILL): one reviews
 * someone else's PR (read-only, never posts), the other judges the review left on mine
 * (classifies each comment, drafts replies). Here: which PR gets which, where the skill is, the
 * prompt, and the few commands a review may run without asking. Pure; tested in
 * test/reviews.test.ts. The routes are in src/pages/reviews.ts.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "../agents/runner.ts";
import type { Pr } from "../sources/ghe.ts";
import { DRAFT_FENCE } from "./draft.ts";

export type ReviewKind = "review" | "triage";

/** The skills by name: REVIEW_SKILL and TRIAGE_SKILL, set once at start (setSkills). */
export const SKILL: Record<ReviewKind, string> = { review: "review", triage: "review-triage" };
const SKILL_NAME = /^[\w.-]{1,64}$/;
export function setSkills(o: { review?: string; triage?: string }): void {
  SKILL.review = o.review && SKILL_NAME.test(o.review) ? o.review : "review";
  SKILL.triage = o.triage && SKILL_NAME.test(o.triage) ? o.triage : "review-triage";
}
export const KIND_LABEL: Record<ReviewKind, string> = { review: "Review with an agent", triage: "Assess the review with an agent" };

/**
 * What a review may run without asking, in Claude Code (`--allowedTools`). Each only reads: a
 * Bash rule is matched against every part of a chained command separately (`&&`, `;`, `|`, …),
 * so these never let anything else ride along. Everything else the skill does (a worktree, the
 * build, the tests, `gh api` for line comments) asks, and the session page's "Allow and
 * continue" allows that one exact command. Left out on purpose:
 * - `git fetch`: `--upload-pack=<cmd>` runs a program;
 * - `git worktree add`: a checkout runs the repo's hooks (core.hooksPath can point into the PR);
 * - any `gh api` pattern: a `*` in the middle spans flags like `-X POST`, so no pattern is a GET only.
 * omp allows whole tools, not commands, so it gets none (CLAUDE.md: never widen permissions).
 */
export const REVIEW_ALLOWED = ["Bash(gh pr view *)", "Bash(gh pr diff *)", "Bash(gh pr checks *)"] as const;

export const allowedFor = (h: HarnessId): string[] => (h === "claude" ? [...REVIEW_ALLOWED] : []);

export const prKey = (p: { repo: string; number: number }) => `${p.repo}#${p.number}`;

/** Someone else's PR gets a review; mine gets an assessment once somebody (or a bot) has reviewed it. */
export function kindFor(p: Pr, me: string): ReviewKind | null {
  if (p.author.toLowerCase() !== me.toLowerCase()) return "review";
  return p.reviews.some((r) => r.login.toLowerCase() !== me.toLowerCase()) || p.openThreads > 0 ? "triage" : null;
}

/**
 * Where a harness finds the skill, as agent-skills' install.ps1 links them: Claude Code reads
 * ~/.claude/skills, omp ~/.agents/skills. `clone`: a checkout of agent-skills, whose SKILL.md
 * any harness can be told to read when the skill isn't installed for it.
 */
export function skillOf(kind: ReviewKind, h: HarnessId, o: { home?: string; codeDir?: string; exists?: (p: string) => boolean } = {}): { installed: boolean; path: string } | null {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const name = SKILL[kind];
  const installed = join(home, h === "omp" ? ".agents" : ".claude", "skills", name, "SKILL.md");
  if (exists(installed)) return { installed: true, path: installed };
  const clone = o.codeDir ? join(o.codeDir, "agent-skills", ".claude", "skills", name, "SKILL.md") : "";
  return clone && exists(clone) ? { installed: false, path: clone } : null;
}

const RULES: Record<ReviewKind, string> = {
  review: [
    "Report only. Don't post comments, approve or request changes, and don't edit any file in this checkout.",
    "Give gh the PR's URL (gh pr view <url>, gh pr diff <url>, gh pr checks <url>), so it finds the host by itself.",
    "To build or run the tests, check the PR's branch out in a new git worktree; never switch this checkout's branch.",
    "End with the ranked report, as the skill describes.",
    "Then, last, the review I may post once I've read it (Dovre posts it, you never do): a ```" + DRAFT_FENCE.review + " block holding one JSON object,",
    '{"summary": "…", "comments": [{"path": "src/a.ts", "line": 42, "side": "RIGHT", "body": "…"}]}.',
    "Write it as the skill's Posting section says. path is as in the diff; line is a line in the PR's diff, side RIGHT for the new file or LEFT for a removed line; start_line marks a range. No verdict: I choose that.",
  ].join("\n"),
  triage: [
    "Assess first: classify every comment and draft the replies, then show me the table and stop.",
    "Apply nothing and post nothing until I say so.",
    "Give gh the PR's URL, so it finds the host by itself.",
    "If you need the PR's branch, use a new git worktree; never switch this checkout's branch.",
    "End with the replies I may post once I've read them (Dovre posts them, you never do): a ```" + DRAFT_FENCE.triage + " block holding one JSON object,",
    '{"replies": [{"comment_id": 123, "body": "…"}], "comment": "…"}.',
    "comment_id is a line comment's id, as gh api repos/<org>/<repo>/pulls/<n>/comments lists them; comment is optional, for what was said outside a thread. Write them as the skill's Replying section says.",
  ].join("\n"),
};

/** The prompt: the skill by name where the harness has it installed, else told to read its SKILL.md. */
export function reviewPrompt(kind: ReviewKind, url: string, h: HarnessId, skill: { installed: boolean; path: string }): string {
  const name = SKILL[kind];
  const call = skill.installed
    ? h === "omp"
      ? `/skill:${name} ${url}`
      : `/${name} ${url}`
    : `Read the skill at ${skill.path} and follow it to ${kind === "review" ? "review" : "triage the review on"} ${url}.`;
  return `${call}\n\n${RULES[kind]}`;
}

/** The clone command for a repo that isn't checked out here. */
export const cloneCommand = (host: string, repo: string, codeDir: string) => `git clone https://${host}/${repo}.git "${join(codeDir, repo.split("/").pop()!)}"`;
