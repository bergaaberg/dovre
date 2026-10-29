/**
 * What I'm looking at when I ask Bino from its pane: the page's address, turned here into a line of
 * names and states from what's gathered, under the same rule as the rest of Bino's context
 * (src/packs/core/assistant/bino/context.ts): never a PR body, an agent's prompt or recap, a tool result, or anything a
 * private page shows. Terminal and the Lab are named, never described, and so is a private
 * pack's page (manifest `private`: chats, mail, query results). Another pack's page is described by the pack (`about`),
 * under the same rule.
 */
import type { Snapshot } from "../../../../gather.ts";
import { inFiles } from "../../../../sources/ghe.ts";

/** Pages whose content never reaches Bino: shells, artifacts (and private packs' pages, below). */
const PRIVATE: [string, string][] = [
  ["/terminal", "Terminal"],
  ["/lab", "Lab"],
];

const PAGES: [string, string][] = [
  ["/prs/stacks", "Pull requests: stacks"],
  ["/prs", "Pull requests"],
  ["/deploys", "Deploys"],
  ["/todo", "My list"],
  ["/movement", "Moved (what changed lately)"],
  ["/code", "Code (their checkouts)"],
  ["/stats", "Stats"],
  ["/issues", "New work (a dev task or an issue)"],
  ["/settings", "Settings"],
  ["/search", "Search"],
  ["/bino", "Bino"],
];

const under = (path: string, p: string) => path === p || path.startsWith(`${p}/`);
const one = (s: string, max = 160) => s.replace(/\s+/g, " ").trim().slice(0, max);
const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

/** A pack as Bino's view knows it: its id and other paths, and what it says one of its pages is. */
export type ViewApp = {
  id: string;
  name: string;
  paths?: string[];
  /** Dovre's own pack, not one of my apps. */ own?: boolean;
  /** Its pages are named, never described (manifest `private`); `about` isn't asked. */ private?: boolean;
  /** What the pack says the page is; it may read its app first (awaited ABOUT_MS at most). */
  about?: (path: string) => string | undefined | Promise<string | undefined>;
  /** Its needs now (titles and where they point), for a page it says nothing about. */
  needs?: () => { title: string; href: string }[];
};

/** How long a pack's `about` may take before Bino goes on with the page's name alone. */
export const ABOUT_MS = 2000;

/** Said when Bino has only the page's name: it says so, rather than guessing from the rest of its context. */
const ONLY_NAME = "You only know which page this is, not what it shows: if asked about it, say so in one line first.";

async function aboutOf(app: ViewApp, path: string): Promise<string | undefined> {
  if (!app.about) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => app.about!(path)), new Promise<undefined>((ok) => (timer = setTimeout(ok, ABOUT_MS, undefined)))]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The page at `raw` (a path and query from this app), as Bino may hear it; "" when it isn't one. */
export async function viewOf(raw: string, s?: Snapshot, apps: ViewApp[] = []): Promise<string> {
  if (!raw.startsWith("/") || raw.startsWith("//")) return "";
  let path: string;
  try {
    path = decodeURI(new URL(raw, "http://x").pathname);
  } catch {
    return "";
  }
  path = path.slice(0, 300);
  const priv = PRIVATE.find(([p]) => under(path, p));
  if (priv) return `the ${priv[1]} page. What it shows is kept from you: don't guess at it.`;
  if (path === "/") return "Today, the overview of their day.";

  const pr = /^\/prs\/([\w.-]+)\/([\w.-]+)\/(\d{1,9})(\/files)?$/.exec(path);
  if (pr) {
    const [, owner, repo, n, files] = pr;
    const full = `${owner}/${repo}`;
    const p = s?.prs.ok ? [...s.prs.value.mine, ...s.prs.value.review].find((x) => x.repo === full && x.number === Number(n)) : undefined;
    if (!p) return `pull request ${full}#${n}${files ? ", its files" : ""} (not among the PRs Dovre gathered).`;
    const bad = p.runs.filter((r) => r.state === "bad").map((r) => one(r.name, 60));
    const parts = [
      `pull request ${full}#${n} «${one(p.title)}» by ${p.author}${p.draft ? " (draft)" : ""}${files ? ", its files" : ""}`,
      p.review ? `review: ${REVIEW[p.review] ?? p.review.toLowerCase()}` : "",
      p.reviews.length ? `reviews: ${p.reviews.slice(0, 8).map((r) => `${r.login} ${r.state.toLowerCase().replace(/_/g, " ")}`).join(", ")}` : "",
      p.requested.length ? `asked: ${p.requested.slice(0, 8).join(", ")}` : "",
      bad.length ? `failing checks: ${bad.slice(0, 6).join(", ")}` : p.runs.some((r) => r.state === "pending") ? "checks running" : p.runs.length ? "checks green" : "",
      p.openThreads ? `${p.openThreads} open review threads` : "",
      `+${p.additions} −${p.deletions}${inFiles(p)}${p.files.length ? `: ${p.files.slice(0, 20).map((f) => one(f.path, 120)).join(", ")}${p.files.length > 20 ? ", …" : ""}` : ""}`,
      p.labels.length ? `labels: ${p.labels.slice(0, 8).join(", ")}` : "",
    ];
    return `${parts.filter(Boolean).join("; ")}.`;
  }

  // A pack's page: its own words when it has them (names and states, its `about` hook), else which app.
  const app = apps.find((a) => under(path, `/${a.id}`) || a.paths?.some((p) => under(path, `/${p}`)));
  if (app) {
    if (app.private) return `a page of their app ${one(app.name, 60)}. What it shows is kept from you: don't guess at it.`;
    const said = await aboutOf(app, path);
    if (typeof said === "string" && said.trim()) return one(said, 600);
    const named = app.own ? `a page of Dovre's ${one(app.name, 60)} (${one(path, 120)}).` : `a page of their app ${one(app.name, 60)} (${one(path, 120)}).`;
    // What the pack says needs me here is a start: its needs that point at this page.
    let here: string[] = [];
    try {
      here = (app.needs?.() ?? []).filter((n) => typeof n?.href === "string" && typeof n.title === "string" && n.href.startsWith("/") && !n.href.startsWith("//") && under(new URL(n.href, "http://x").pathname, path)).map((n) => one(n.title, 120));
    } catch {}
    return [named, here.length ? `What ${one(app.name, 60)} says needs them here: ${here.slice(0, 6).join("; ")}.` : "", ONLY_NAME].filter(Boolean).join(" ");
  }
  const page = PAGES.find(([p]) => under(path, p));
  return page ? `the ${page[1]} page.` : "a page in Dovre.";
}
