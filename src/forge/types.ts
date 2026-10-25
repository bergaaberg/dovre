/**
 * A forge: where the code, its PRs (merge requests), CI and deploys live. GitHub is the default
 * (src/forge/github.ts); a pack can bring another (`Pack.forge`, picked with FORGE=<id>).
 * One forge per instance. The shapes are GitHub's, which other forges map onto.
 */
import type { Changelog } from "../sources/changelog.ts";
import type { Deploy, Move, Note, Pr, PrRef, RedBranch } from "../sources/ghe.ts";
import type { Issue, IssueAct, IssueSets } from "../sources/issues.ts";

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
 */
export const FORGE_CAN = ["issues", "reviews", "viewer", "stats", "search", "deployApproval", "stacks"] as const;
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
  /** Shared branches whose newest run failed, from the notes. Absent: none. */
  red?(notes: Note[]): Promise<RedBranch[]>;
  /**
   * My open issues in the owners' repos: assigned to me, mentioning me, opened by me, and the
   * unassigned, unlabelled ones in `triage` (`owner/repo`s; a repo outside the owners is left out).
   * Absent: no Issues pack.
   */
  issues?(login: string, owners: string, opts?: { triage?: string[] }): Promise<IssueSets>;
  /** One issue as it is now (for re-checking before a write); undefined: no such issue. Absent: no writes. */
  issue?(repo: string, number: number): Promise<Issue | undefined>;
  /** Assign, close, reopen or comment on an issue. Absent: the Issues page has no actions. */
  issueAct?(act: IssueAct): Promise<void>;
};

/** A forge a pack brings: picked when FORGE is its id. `env` is the pack's env (its settings). */
export type ForgeDecl = { id: string; name: string; create(env: Record<string, string | undefined>): Forge };

export const forgeCan = (f: Pick<Forge, "can">, what: ForgeCan) => f.can.includes(what);

/** What pages need to know of the forge: its name, and what it can do. Default: GitHub, everything. */
export type ForgeView = Pick<Forge, "name" | "can">;
export const GITHUB_VIEW: ForgeView = { name: "GitHub", can: FORGE_CAN };
