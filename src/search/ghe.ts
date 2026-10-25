/**
 * Issues and PRs on GHE for search (Ctrl K), beyond what's gathered: `repo#123` is fetched as
 * that issue or PR; other text goes to GHE's issue search within the org. Answers are kept two
 * minutes per query, so typing and pausing doesn't spend the search API's 30-a-minute.
 */
import { ownerQuery, owns, primaryOf } from "../owners.ts";
import type { Ghe } from "../sources/ghe.ts";
import type { Row } from "./search.ts";

type Item = { number: number; title: string; html_url: string; state: string; pull_request?: unknown; repository_url?: string; draft?: boolean; merged_at?: string | null };

const NUMBERED = /^([\w.-]+)\s*#\s*(\d{1,7})$/;
const repoOf = (item: Item, fallback = "") => item.repository_url?.split("/repos/")[1] ?? fallback;

export function rowOf(item: Item, org: string, fallbackRepo = ""): Row {
  const repo = repoOf(item, fallbackRepo);
  const pr = !!item.pull_request;
  const short = repo.replace(`${primaryOf(org)}/`, "");
  const inOrg = /^[\w.-]+\/[\w.-]+$/.test(repo) && owns(org, repo.split("/")[0]!);
  const state = pr ? ((item.pull_request as { merged_at?: string | null })?.merged_at ? "merged" : item.state === "open" ? (item.draft ? "draft PR" : "open PR") : "closed PR") : item.state === "open" ? "open issue" : "closed issue";
  return {
    title: `#${item.number} ${String(item.title ?? "").slice(0, 140)}`,
    sub: `${short} · ${state}`,
    // Org PRs open in Dovre's own viewer; issues on GHE.
    href: pr && inOrg ? `/prs/${repo}/${item.number}` : item.html_url,
    icon: pr ? "⇄" : "◌",
    also: [String(item.number), `#${item.number}`, `${short}#${item.number}`, short],
    out: !(pr && inOrg),
    found: true,
  };
}

export function createGheSearch(ghe: Ghe, org: string, opts: { now?: () => number; keepMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const kept = new Map<string, { at: number; rows: Row[] }>();
  return async function find(raw: string): Promise<Row[]> {
    const q = raw.trim().slice(0, 120);
    if (q.length < 3) return [];
    const hit = kept.get(q.toLowerCase());
    if (hit && now() - hit.at < (opts.keepMs ?? 120_000)) return hit.rows;
    let rows: Row[] = [];
    const n = q.match(NUMBERED);
    if (n) {
      const repo = `${org}/${n[1]}`;
      try {
        const item = await ghe.rest<Item>(`/repos/${repo}/issues/${n[2]}`);
        rows = [rowOf(item, org, repo)];
      } catch {}
    } else {
      const r = await ghe.rest<{ items: Item[] }>(`/search/issues?q=${encodeURIComponent(`${q} ${ownerQuery(org)}`)}&per_page=8&sort=updated`).catch(() => ({ items: [] as Item[] }));
      rows = (r.items ?? []).map((i) => rowOf(i, org));
    }
    if (kept.size > 200) kept.clear();
    kept.set(q.toLowerCase(), { at: now(), rows });
    return rows;
  };
}
