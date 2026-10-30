/** A fake forge's answers for what was said on acme/web#7 (owner.ts): its comments, line comments and reviews. */
export type Said = {
  kind: "issue" | "line" | "review";
  login: string;
  at: number;
  id?: number;
  body?: string;
  /** A review's: COMMENTED (the default), CHANGES_REQUESTED, APPROVED. */
  state?: string;
  /** A line comment's review, or a review's own id. */
  review?: number;
  /** When it was edited, if it was. */
  edited?: number;
  path?: string;
};

export const iso = (t: number) => new Date(t).toISOString();

let next = 500;

/** The list for a GET of one of the three, or undefined for any other path. */
export function saidAt(path: string, said: Said[]): unknown[] | undefined {
  const kind = path.startsWith("/repos/acme/web/issues/7/comments") ? "issue" : path.startsWith("/repos/acme/web/pulls/7/comments") ? "line" : path.startsWith("/repos/acme/web/pulls/7/reviews?") ? "review" : undefined;
  if (!kind) return undefined;
  return said
    .filter((s) => s.kind === kind)
    .map((s) => {
      const id = s.id ?? (kind === "review" ? s.review : undefined) ?? next++;
      const common = { id, node_id: `N_${id}`, user: { login: s.login }, body: s.body ?? "Please rename it." };
      if (kind === "review") return { ...common, state: s.state ?? "COMMENTED", submitted_at: iso(s.at) };
      return { ...common, created_at: iso(s.at), updated_at: iso(s.edited ?? s.at), ...(kind === "line" ? { path: s.path ?? "src/a.ts", line: 2, pull_request_review_id: s.review ?? null } : {}) };
    });
}

/** A GraphQL answer to owner.ts's question: who edited each node asked about (none, unless `by` says). */
export function editorsOf(q: string, by: Record<string, string> = {}): { nodes: { id: string; editor: { login: string } | null }[] } {
  const ids = JSON.parse(/nodes\(ids:(\[[^\]]*\])\)/.exec(q)?.[1] ?? "[]") as string[];
  return { nodes: ids.map((id) => ({ id, editor: by[id] ? { login: by[id]! } : null })) };
}
