/**
 * What owners said on an auto PR (#326 step 6): their comments, line comments and reviews since
 * the loop last took them in (the row's `heard`). Each starts a fix round, and while one is open,
 * or an owner's Request changes is, the level is at most 2.
 *
 * The trust rule is the label's (src/actions/auto.ts `untrusted`): only owners count, and the
 * text must be as they left it. A comment edited since it was posted counts only when an owner
 * edited it; otherwise the PR is handed to me. Dovre posts as me, so its own posts carry `MARK`
 * and are never taken for mine.
 */
import { ownersOf } from "../../../owners.ts";
import type { Ghe } from "../../../sources/ghe.ts";
import type { PrRow } from "./store.ts";

/** In every post Auto review makes on a PR (hidden when rendered): what tells its posts from mine. */
export const MARK = "<!-- dovre:autoreview -->";
export const marked = (body: string) => `${body}\n\n${MARK}`;

/** At most this many owner comments go into one fix round; the rest wait for the next. */
export const MAX_SAID = 30;
const MAX_TEXT = 3000;

/** One thing an owner said. `line` ones are review threads, which a fix session replies on. */
export type OwnerSaid = { id: number; kind: "line" | "issue" | "review"; by: string; at: number; text: string; path?: string; line?: number | null; requested?: boolean };
/** `said`: oldest first. `requested`: owners whose latest verdict since is Request changes. `refused`: why some of it can't be acted on. */
export type Heard = { said: OwnerSaid[]; requested: string[]; refused?: string };

type Raw = {
  id?: number;
  node_id?: string;
  user?: { login?: string } | null;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  state?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  pull_request_review_id?: number | null;
};

const list = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

/** Owners' words on the PR posted after `since` (ms), Dovre's own left out. */
export async function ownerSays(d: { ghe: Pick<Ghe, "rest" | "graphql">; owners: string; login: string }, row: Pick<PrRow, "repo" | "number" | "review">, since: number): Promise<Heard> {
  const owners = new Set([d.login, ...ownersOf(d.owners)].map((o) => o.toLowerCase()));
  const iso = new Date(since).toISOString();
  const base = `/repos/${row.repo}`;
  const [issue, lines, reviews] = await Promise.all([
    d.ghe.rest<Raw[]>(`${base}/issues/${row.number}/comments?since=${iso}&per_page=100`),
    d.ghe.rest<Raw[]>(`${base}/pulls/${row.number}/comments?since=${iso}&per_page=100`),
    d.ghe.rest<Raw[]>(`${base}/pulls/${row.number}/reviews?per_page=100`),
  ]);
  const by = (r: Raw) => String(r.user?.login ?? "");
  const mine = (r: Raw) => owners.has(by(r).toLowerCase()) && !String(r.body ?? "").includes(MARK);
  const after = (at: string | undefined) => !!at && Date.parse(at) > since;
  const text = (r: Raw) => String(r.body ?? "").trim().slice(0, MAX_TEXT);
  const ok = (r: Raw) => Number.isInteger(r.id) && mine(r);

  const theirs = list(reviews).filter((r) => ok(r) && after(r.submitted_at) && r.id !== row.review);
  // Each owner's latest verdict since: Request changes holds until they approve or a round takes it in.
  const verdict = new Map<string, Raw>();
  for (const r of theirs) if (r.state === "CHANGES_REQUESTED" || r.state === "APPROVED") {
    const was = verdict.get(by(r));
    if (!was || Date.parse(r.submitted_at!) >= Date.parse(was.submitted_at!)) verdict.set(by(r), r);
  }
  const requested = [...verdict].filter(([, r]) => r.state === "CHANGES_REQUESTED").map(([login]) => login);

  const items: (OwnerSaid & { node?: string; edited: boolean })[] = [
    ...list(issue)
      .filter((c) => ok(c) && after(c.created_at) && text(c))
      .map((c) => ({ id: c.id!, kind: "issue" as const, by: by(c), at: Date.parse(c.created_at!), text: text(c), node: c.node_id, edited: edited(c) })),
    ...list(lines)
      .filter((c) => ok(c) && after(c.created_at) && c.pull_request_review_id !== row.review && text(c))
      .map((c) => ({ id: c.id!, kind: "line" as const, by: by(c), at: Date.parse(c.created_at!), text: text(c), path: String(c.path ?? ""), line: c.line ?? c.original_line ?? null, node: c.node_id, edited: edited(c) })),
    // A review's body; its line comments come in above. Reviews have no edit time over REST: each is asked.
    // A Request changes its owner has approved since is over.
    ...theirs
      .filter((r) => (r.state === "CHANGES_REQUESTED" && requested.includes(by(r))) || (r.state === "COMMENTED" && text(r)))
      .map((r) => ({ id: r.id!, kind: "review" as const, by: by(r), at: Date.parse(r.submitted_at!), text: text(r) || "(Request changes, with no text: see their line comments.)", node: r.node_id, edited: true, ...(r.state === "CHANGES_REQUESTED" ? { requested: true } : {}) })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_SAID);

  const refused = await editedByOthers(d.ghe, items.filter((i) => i.edited), owners);
  return { said: items.map(({ node: _n, edited: _e, ...s }) => s), requested, ...(refused ? { refused } : {}) };
}

/** Changed after it was posted (GitHub sets `updated_at` to the second it was made). */
const edited = (c: Raw) => !!c.updated_at && !!c.created_at && Date.parse(c.updated_at) - Date.parse(c.created_at) > 1000;

/**
 * Who last edited each of these, over one GraphQL call (only when something was edited): why the
 * first one an owner didn't edit can't be acted on, or undefined. Unreadable counts as not an owner.
 */
async function editedByOthers(ghe: Pick<Ghe, "graphql">, items: { kind: string; by: string; node?: string }[], owners: Set<string>): Promise<string | undefined> {
  if (!items.length) return undefined;
  const ids = items.map((i) => i.node).filter((n): n is string => typeof n === "string" && /^[\w=-]{1,100}$/.test(n));
  let editors = new Map<string, string | null>();
  if (ids.length) {
    try {
      const q = `query{nodes(ids:${JSON.stringify(ids)}){...on IssueComment{id editor{login}}...on PullRequestReviewComment{id editor{login}}...on PullRequestReview{id editor{login}}}}`;
      const r = await ghe.graphql<{ nodes?: ({ id?: string; editor?: { login?: string } | null } | null)[] }>(q);
      editors = new Map((r?.nodes ?? []).filter((n) => n?.id).map((n) => [n!.id!, n!.editor ? String(n!.editor.login ?? "") : null]));
    } catch {}
  }
  for (const i of items) {
    if (!i.node || !editors.has(i.node)) return `Dovre couldn't check who edited ${i.by}'s comment, so it doesn't act on it.`;
    const who = editors.get(i.node);
    if (who !== null && who !== undefined && !owners.has(who.toLowerCase())) return `${who || "Someone"} edited ${i.by}'s comment after it was posted, so Dovre doesn't act on it.`;
  }
  return undefined;
}

/** What owners said that's open, as "acme's Request changes and 2 owner comments"; empty for nothing. */
export function heardLine(h: Pick<Heard, "said" | "requested">): string {
  const n = h.said.filter((s) => !s.requested).length;
  return [h.requested.length ? `${h.requested.join(" and ")}'s Request changes` : "", n ? `${n} owner comment${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
}

/** The same as a level's cap says it: "2 owner comments are open". */
export function heardOpen(h: Pick<Heard, "said" | "requested">): string {
  const line = heardLine(h);
  return line ? `${line} ${h.requested.length + h.said.filter((s) => !s.requested).length > 1 ? "are" : "is"} open` : "";
}
