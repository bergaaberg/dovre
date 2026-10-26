/**
 * Search across Dovre (Ctrl K): pages by the names people type for them, and what's gathered
 * (PRs, deploys, checkouts, My list, what the packs offer: agents and worktrees among them), and things to
 * do. Text folded
 * (æ ø å, case, punctuation), a name's start beats its middle, a word's start next, then the other
 * names a thing answers to. Pure: what to search in, and the query, in; groups of rows out.
 */
import type { Snapshot } from "../gather.ts";
import type { Todo } from "../todo/store.ts";

export type Row = { title: string; sub?: string; href: string; icon: string; also?: string[]; /** Leaves the app (a new tab). */ out?: boolean; /** Found by GHE's search for this query: kept, after what matches here. */ found?: boolean };
export type Group = { id: Kind; title: string; rows: Row[] };
export type Kind = "pages" | "prs" | "issues" | "deploys" | "agents" | "apps" | "code" | "todo" | "actions";

export const KINDS: { id: Kind; title: string; prefix?: string }[] = [
  { id: "pages", title: "Go to" },
  { id: "prs", title: "Pull requests", prefix: "pr" },
  { id: "issues", title: "Issues and PRs on GHE", prefix: "i" },
  { id: "deploys", title: "Deploys", prefix: "d" },
  { id: "agents", title: "Agents", prefix: "a" },
  { id: "apps", title: "In your apps", prefix: "x" },
  { id: "code", title: "Worktrees and checkouts", prefix: "w" },
  { id: "todo", title: "My list", prefix: "t" },
  { id: "actions", title: "Do", prefix: ">" },
];

/** Folded for matching: lower case, æ ø å as a keyboard without them types them, only letters, digits and #. */
export function fold(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[^a-z0-9#]/g, "");
}

/** How well a row answers a folded query, best 0, or null for no match. */
export function score(r: Pick<Row, "title" | "also">, q: string): number | null {
  if (!q) return 0;
  const t = fold(r.title);
  if (t.startsWith(q)) return 0;
  const words = r.title.toLowerCase().split(/[^a-z0-9æøå#]+/).filter(Boolean).map(fold);
  if (words.some((w) => w.startsWith(q))) return 1;
  if (t.includes(q)) return 2;
  const also = (r.also ?? []).filter(Boolean).map(fold);
  if (also.some((a) => a.startsWith(q))) return 3;
  if (also.some((a) => a.includes(q))) return 4;
  return null;
}

/** A page Dovre has, and the other names it answers to. */
export type Page = { title: string; href: string; icon: string; about: string; also: string[] };

/** Every page, in menu order. `on` leaves out the ones this machine hasn't got (Bino, Lab). */
export function pagesOf(on: { bino?: boolean; lab?: boolean; /** Offered unless switched off. */ stats?: boolean } = {}): Page[] {
  const all: (Page & { need?: keyof typeof on; unless?: keyof typeof on })[] = [
    { title: "Today", href: "/", icon: "◐", about: "What needs you, the last 24 hours", also: ["home", "morning", "i dag", "oversikt", "feed"] },
    { title: "Stats", href: "/stats", icon: "▥", about: "Twelve weeks in numbers and charts", also: ["statistics", "statistikk", "charts", "metrics", "numbers", "spend", "cost"], unless: "stats" },
    { title: "Pull requests", href: "/prs", icon: "⇄", about: "Asking for your review, and yours", also: ["pr", "prs", "reviews", "pull"] },
    { title: "Stacks", href: "/prs/stacks", icon: "≡", about: "Stacked PRs, bottom first", also: ["stacked", "chain", "retarget"] },
    { title: "Deploys", href: "/deploys", icon: "⇡", about: "Waiting for prod, and what ships", also: ["release", "prod", "approve", "ship", "utrulling"] },
    { title: "My list", href: "/todo", icon: "☐", about: "Your own list, with dates", also: ["todo", "tasks", "liste", "huskeliste"] },
    { title: "Actions", href: "/actions", icon: "✓", about: "What Dovre did for you: deploys, messages, issues, production", also: ["log", "history", "decided", "logg", "historikk"] },
    { title: "New work", href: "/issues/new", icon: "+", about: "A dev task, or an issue", also: ["issue", "dev task", "create", "ny sak", "new"] },
    { title: "Moved", href: "/movement", icon: "↯", about: "What people did in the org, 24 h", also: ["movement", "activity", "people", "team", "timeline"] },
    { title: "Code", href: "/code", icon: "{}", about: "Your checkouts at any commit", also: ["browse", "explorer", "files", "source", "kode"] },
    { title: "Bino", href: "/bino", icon: "◍", about: "Talk a piece of work through", also: ["assistant", "chat", "ask"], need: "bino" },
    { title: "Settings", href: "/settings", icon: "⚙", about: "Setup, notifications, restart", also: ["setup", "notifications", "config", "innstillinger"] },
    { title: "Lab", href: "/lab", icon: "⚗", about: "Prototypes and looks", also: ["prototypes", "designs", "looks", "menus"], need: "lab" },
  ];
  return all.filter((p) => (!p.need || on[p.need]) && (!p.unless || on[p.unless] !== false)).map(({ need: _n, unless: _u, ...p }) => p);
}

const ACTIONS: Row[] = [
  { title: "New dev task under an issue", icon: "+", href: "/issues/new?kind=task", also: ["task", "sub-issue", "oppgave"] },
  { title: "Add to My list", icon: "☐", href: "/todo", also: ["todo", "remember", "husk"] },
  { title: "Refresh everything", icon: "↻", href: "/?fresh=1", also: ["sync", "reload", "fetch", "oppdater"] },
];

const short = (repo: string, org: string) => repo.replace(`${org}/`, "");
const line = (t: unknown, n = 120) => String(t ?? "").split("\n")[0]!.trim().slice(0, n);

export type Sources = {
  s: Pick<Snapshot, "org" | "prs" | "deploys"> & Partial<Pick<Snapshot, "refs" | "notes" | "moves">>;
  /** Dovre's PR viewer is here (default yes); else a PR found opens on the forge. */
  viewer?: boolean;
  /** Core pages that aren't here (the forge can't serve them): left out of pages and actions. */
  hidden?: (href: string) => boolean;
  /** Issues and PRs GHE's own search found for this query (src/search/ghe.ts). */
  remote?: Row[];
  todos?: Todo[];
  /** What the packs offer for search (their `finds`, checked in app.ts), under "In your apps". */
  apps?: Row[];
  /** What the packs offer for one of search's own groups (a find's `kind`): agents, worktrees, things to start. */
  kinds?: { agents?: Row[]; code?: Row[]; actions?: Row[] };
  /** Checkouts right under the code folder (by folder name). */
  repos?: string[];
  pages?: Page[];
};

/** `ACME/repo#12` from a GitHub issue or PR URL; `group/sub/repo#12` from a GitLab one (`/-/issues/`, `/-/merge_requests/`). */
const keyOfUrl = (url: string): string | undefined => {
  const m = url.match(/^(?:https:\/\/[^/]+|\/elsewhere)\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/) ?? url.match(/^(?:https:\/\/[^/]+|\/elsewhere)\/([\w.-]+(?:\/[\w.-]+)+)\/-\/(?:issues|merge_requests)\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : undefined;
};
/** A PR's (or merge request's) web URL. */
const isPrUrl = (url: string) => /\/pull\/\d+|\/-\/merge_requests\/\d+/.test(url);

/**
 * Issues and PRs beyond mine: what's gathered (PRs agents linked, notifications, the day's
 * moves), then what GHE's search found. Each once; my own open PRs are under Pull requests.
 */
function issuesOf(s: Sources["s"], mine: Set<string>, remote: Row[], viewer = true): Row[] {
  const org = s.org;
  const out = new Map<string, Row>();
  const add = (key: string | undefined, r: Omit<Row, "also" | "icon"> & { pr: boolean }) => {
    if (!key || mine.has(key) || out.has(key)) return;
    const [repo, n] = key.split("#") as [string, string];
    const short = repo.replace(`${org}/`, "");
    const inOrg = viewer && repo.startsWith(`${org}/`);
    out.set(key, { title: `#${n} ${line(r.title)}`, sub: `${short}${r.sub ? ` · ${r.sub}` : ""}`, href: r.pr && inOrg ? `/prs/${repo}/${n}` : r.href, icon: r.pr ? "⇄" : "◌", also: [n, `#${n}`, `${short}#${n}`, short], out: !(r.pr && inOrg) });
  };
  for (const [key, ref] of s.refs ?? []) add(key, { title: ref.title, sub: `${ref.state.toLowerCase()} PR`, href: ref.url, pr: true });
  for (const n of s.notes?.ok ? s.notes.value : []) add(keyOfUrl(n.url), { title: n.title, sub: n.type === "PullRequest" ? "PR" : n.type === "Issue" ? "issue" : n.type, href: n.url, pr: n.type === "PullRequest" });
  for (const m of s.moves?.ok ? s.moves.value : []) if (m.ref && m.title) add(m.ref, { title: m.title, sub: m.verb.replace(/_/g, " "), href: m.url, pr: isPrUrl(m.url) });
  const rows = [...out.values()];
  const seen = new Set(rows.map((r) => r.href));
  return [...rows, ...remote.filter((r) => !seen.has(r.href))];
}

/** Everything that can be found, by kind. */
export function corpus(src: Sources): Record<Kind, Row[]> {
  const { s } = src;
  const org = s.org;
  const prs = s.prs.ok ? [...s.prs.value.review, ...s.prs.value.mine] : [];
  const code = src.kinds?.code ?? [];
  const inCode = new Set(code.map((r) => r.href));
  const mineKeys = new Set(prs.map((p) => `${p.repo}#${p.number}`));
  const here = (r: { href: string }) => !src.hidden?.(r.href);
  return {
    pages: (src.pages ?? pagesOf()).filter(here).map((p) => ({ title: p.title, sub: p.about, href: p.href, icon: p.icon, also: p.also })),
    prs: prs.map((p) => ({
      title: line(p.title),
      sub: `${short(p.repo, org)}#${p.number}${p.draft ? " · draft" : ""}${p.author ? ` · ${p.author}` : ""}`,
      href: src.viewer === false ? p.url : `/prs/${p.repo}/${p.number}`,
      icon: "⇄",
      also: [String(p.number), `#${p.number}`, short(p.repo, org), p.branch ?? "", p.author ?? ""],
    })),
    issues: issuesOf(s, mineKeys, src.remote ?? [], src.viewer !== false),
    deploys: s.deploys.ok
      ? s.deploys.value.map((d) => ({ title: line(d.title), sub: `${short(d.repo, org)} · waits for ${d.envs.map((e) => e.name).join(", ") || "prod"}`, href: "/deploys", icon: "⇡", also: [short(d.repo, org), d.actor, "prod"] }))
      : [],
    agents: src.kinds?.agents ?? [],
    apps: src.apps ?? [],
    code: [
      ...code,
      ...(src.repos ?? []).filter((r) => !inCode.has(`/code/${encodeURIComponent(r)}`)).map((r) => ({ title: r, sub: "checkout", href: `/code/${encodeURIComponent(r)}`, icon: "{}", also: [] })),
    ],
    todo: (src.todos ?? []).filter((t) => t.state !== "done").map((t) => ({ title: line(t.title), sub: `${t.state}${t.due ? ` · ${t.due}` : ""}`, href: `/todo#t-${t.id}`, icon: "☐", also: [line(t.notes, 200)] })),
    // The packs' things to start go before "Refresh everything", which stays last.
    actions: [...ACTIONS.slice(0, -1), ...(src.kinds?.actions ?? []), ...ACTIONS.slice(-1)].filter(here),
  };
}

/** A query, maybe narrowed to one kind by a prefix ("pr: 863", "a:review", "> new"). */
export function parseQuery(raw: string, only?: string): { q: string; only?: Kind } {
  const text = raw.trim().slice(0, 200);
  const m = text.match(/^(pr|i|d|a|x|w|t)\s*:\s*(.*)$/i) ?? text.match(/^(>)\s*(.*)$/);
  if (m) return { q: m[2]!, only: KINDS.find((k) => k.prefix === m[1]!.toLowerCase())!.id };
  const k = KINDS.find((x) => x.id === only);
  return { q: text, only: k?.id };
}

/** What a query finds, best first within each kind; with nothing typed, where you go and what's newest. */
export function search(src: Sources, raw: string, opts: { only?: string; per?: number } = {}): { q: string; only?: Kind; groups: Group[]; total: number } {
  const { q, only } = parseQuery(raw, opts.only);
  const f = fold(q);
  const all = corpus(src);
  const groups: Group[] = [];
  let total = 0;
  for (const k of KINDS) {
    if (only && k.id !== only) continue;
    let rows = all[k.id];
    if (!f) {
      // Nothing typed: the main pages, what's most recent, a few things to do.
      if (!only && !["pages", "prs", "agents", "actions"].includes(k.id)) continue;
      rows = only ? rows.slice(0, 40) : rows.slice(0, k.id === "pages" ? 6 : k.id === "actions" ? 3 : 4);
    } else {
      const ranked = rows
        .map((r, i) => ({ r, i, s: score(r, f) ?? (r.found ? 5 : null) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => a.s! - b.s! || a.i - b.i);
      total += ranked.length;
      rows = ranked.slice(0, only ? 40 : (opts.per ?? (k.id === "pages" ? 5 : 4))).map((x) => x.r);
    }
    if (rows.length) groups.push({ id: k.id, title: k.title, rows });
  }
  return { q, only, groups, total };
}
