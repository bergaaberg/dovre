/**
 * A forge: where the code, its PRs (merge requests), CI and deploys live. GitHub is the default
 * (src/forge/github.ts); a pack can bring another (`Pack.forge`, picked with FORGE=<id>).
 * One forge per instance. The shapes are GitHub's, which other forges map onto.
 */
import type { Proposal } from "../actions/propose.ts";
import type { Changelog } from "../sources/changelog.ts";
import type { Deploy, Move, Note, Pr, PrRef, RedBranch } from "../sources/ghe.ts";
import type { Issue, IssueAct, IssueSets } from "../sources/issues.ts";
import type { Thread, ThreadHit } from "../sources/threads.ts";
export type { Thread, ThreadHit };
export type { Changelog, Deploy, Issue, IssueAct, IssueSets, Move, Note, Pr, PrRef, RedBranch };

/**
 * What a forge can do beyond the gather. Core pages that need one are hidden when the forge lacks it,
 * never a page that fails.
 * - `issues`: the Issues page and new dev tasks
 * - `reviews`: the review pages and agent reviews
 * - `viewer`: the PR diff viewer
 * - `stats`: the Stats page's numbers
 * - `search`: issues and PRs in Ctrl K
 * - `deployApproval`: approving or rejecting a waiting deploy
 * - `stacks`: stacked PRs and retargeting them
 * - `dependabot`: the Dependabot queue and combining a repo's bumps into one PR
 */
export const FORGE_CAN = ["issues", "reviews", "viewer", "stats", "search", "deployApproval", "stacks", "dependabot"] as const;
export type ForgeCan = (typeof FORGE_CAN)[number];

export type Forge = {
  /** "github", "gitlab": what FORGE names. */
  id: string;
  /** "GitHub", "GitLab": how pages say it. */
  name: string;
  /** The one host, as links are built on it ("github.com", "gitlab.example.com"). */
  host: string;
  can: readonly ForgeCan[];
  /** Who I am there. */
  viewer(): Promise<{ login: string; name: string | null }>;
  /** Its API quota is nearly gone: background reads that can wait, wait. Absent: never. */
  low?(): boolean;
  /** My open PRs, and those asking for my review, in the owners' repos (`owners`: comma-separated). */
  prs(login: string, owners: string): Promise<{ mine: Pr[]; review: Pr[] }>;
  /** What asks for me (notifications, todos), newest first. */
  notes(): Promise<Note[]>;
  /** What happened in the owners' repos lately. */
  moves(login: string, owners: string): Promise<Move[]>;
  /** State and title of PRs, by `repo#number` key. A key it can't find is left out. */
  prRefs(keys: Iterable<string>): Promise<Map<string, PrRef>>;
  /** A PR link's `repo#number` key, or undefined when it isn't a PR on this forge. */
  prKeyOfUrl(url: string): string | undefined;
  /** Deploys waiting for my approval in these repos. Absent: none. */
  deploys?(repos: string[]): Promise<Deploy[]>;
  /** What a waiting deploy ships. Absent: no changelogs. */
  changelog?(repo: string, env: string, head: string): Promise<Changelog>;
  /**
   * Shared branches whose newest run failed, from the notes, or, when they can't say (no
   * notifications), from the recent runs in `repos` (those of my open PRs). Absent: none.
   */
  red?(notes: Note[], repos?: string[]): Promise<RedBranch[]>;
  /**
   * My open issues in the owners' repos: assigned to me, mentioning me, opened by me, and the
   * unassigned, unlabelled ones in `triage` (`owner/repo`s; a repo outside the owners is left out).
   * Absent: no Issues pack.
   */
  issues?(login: string, owners: string, opts?: { triage?: string[] }): Promise<IssueSets>;
  /** One issue as it is now (for re-checking before a write); undefined: no such issue. Absent: no writes. */
  issue?(repo: string, number: number): Promise<Issue | undefined>;
  /** One issue or PR in full (its description, latest comments and reviews), for Bino's lookups and agents' tools. Absent: none. */
  thread?(repo: string, number: number): Promise<Thread | undefined>;
  /** Issues and PRs in these owners' accounts matching words, newest first (15 at most). Absent: none. */
  searchThreads?(owners: string[], words: string): Promise<ThreadHit[]>;
  /** Assign, close, reopen or comment on an issue. Absent: the Issues page has no actions. */
  issueAct?(act: IssueAct): Promise<void>;
  /** What I did in the owners' repos since a day (YYYY-MM-DD): counts, days, commit times. Absent: packs read none. */
  work?(login: string, owners: string, since: string): Promise<ForgeWork>;
  /** How many of my PRs merged in the owners' repos since a time (ISO). Absent: packs read none. */
  merged?(login: string, owners: string, since: string): Promise<number>;
  /** The owners' repos that aren't archived (`owner/name`). Absent: packs read none. */
  repos?(owners: string): Promise<string[]>;
  /** One file's text on a repo's default branch; undefined when there's none. Absent: packs read none. */
  file?(repo: string, path: string): Promise<string | undefined>;
  /** A PR changing one file (src/actions/propose.ts), checked already: throws why not. Absent: packs propose none. */
  propose?(p: Proposal): Promise<{ number: number; url: string }>;
};

/**
 * What I did on the forge (Forge.work), for packs to read (PackContext.forge): numbers, dates, repo
 * and language names only.
 */
export type ForgeWork = {
  /** My PRs merged. */
  merged: number;
  /** Others' PRs I reviewed. */
  reviewed: number;
  /** Contributions a day, as the forge counts them. */
  days: { date: string; count: number }[];
  /** My commits, newest first (300 at most): their repo and time, in their own offset. */
  commits: { repo: string; date: string }[];
  /** The biggest languages of the repos I commit to most (six at most), by repo. */
  languages: Record<string, string[]>;
};

/** A forge a pack brings: picked when FORGE is its id. `env` is the pack's env (its settings). */
export type ForgeDecl = { id: string; name: string; create(env: Record<string, string | undefined>): Forge };

export const forgeCan = (f: Pick<Forge, "can">, what: ForgeCan) => f.can.includes(what);

/** What pages need to know of the forge: its name, and what it can do. Default: GitHub, everything. */
export type ForgeView = Pick<Forge, "name" | "can">;
export const GITHUB_VIEW: ForgeView = { name: "GitHub", can: FORGE_CAN };
