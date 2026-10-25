/**
 * The demo's made-up world (demo.dovre.dev): one fictional org on a host that doesn't exist
 * (example.com is reserved), so no link leads to a real repo or person. Times are relative to
 * `now`, so the demo always looks like this morning.
 */
import type { Snapshot } from "../gather.ts";
import type { Deploy, Move, Note, Pr } from "../sources/ghe.ts";
import type { Session } from "../sources/claude.ts";
import type { Sessions } from "../sources/sessions.ts";
import type { Turn } from "../agents/conversation.ts";
import type { History, MyPr, OpenPr, Commit, Release } from "../stats/history.ts";
import { weeksOf } from "../stats/history.ts";
import type { SpendDay } from "../stats/spend.ts";
import { osloDay } from "../stats/spend.ts";
import type { Stats, StatsView } from "../stats/stats.ts";

export const DEMO_HOST = "git.example.com";
export const DEMO_ORG = "northwind";
export const DEMO_LOGIN = "kari-demo";

const base = `https://${DEMO_HOST}`;
const ago = (now: number, min: number) => new Date(now - min * 60_000).toISOString();

const pr = (now: number, o: Partial<Pr> & Pick<Pr, "repo" | "number" | "title">): Pr => ({
  url: `${base}/${o.repo}/pull/${o.number}`,
  draft: false,
  updatedAt: ago(now, 30),
  branch: "feat/change",
  author: DEMO_LOGIN,
  review: "REVIEW_REQUIRED",
  checks: "SUCCESS",
  openThreads: 0,
  body: "",
  additions: 40,
  deletions: 8,
  headSha: "a1b2c3d4e5f6a7b8",
  labels: [],
  files: [],
  reviews: [],
  requested: [],
  runs: [{ name: "build", state: "ok", url: null }, { name: "test", state: "ok", url: null }],
  ...o,
});

export function demoPrs(now: number): { mine: Pr[]; review: Pr[] } {
  const r = (name: string) => `${DEMO_ORG}/${name}`;
  return {
    mine: [
      pr(now, { repo: r("checkout"), number: 412, title: "Retry card payments once on a gateway timeout", branch: "feat/payment-retry", review: "APPROVED", updatedAt: ago(now, 18), additions: 86, deletions: 12, reviews: [{ login: "ola-demo", state: "APPROVED" }], files: [{ path: "src/payments/charge.ts", additions: 54, deletions: 9 }, { path: "test/charge.test.ts", additions: 32, deletions: 3 }] }),
      pr(now, { repo: r("catalog"), number: 88, title: "Cache product images at the edge", branch: "feat/image-cache", checks: "FAILURE", updatedAt: ago(now, 52), openThreads: 2, runs: [{ name: "test", state: "bad", url: null }, { name: "build", state: "ok", url: null }], reviews: [{ login: "per-demo", state: "CHANGES_REQUESTED" }], review: "CHANGES_REQUESTED" }),
      pr(now, { repo: r("web"), number: 1290, title: "Dark mode for the order history page", branch: "feat/dark-orders", draft: true, checks: "PENDING", updatedAt: ago(now, 140), runs: [{ name: "build", state: "pending", url: null }] }),
    ],
    review: [
      pr(now, { repo: r("checkout"), number: 415, title: "Show the delivery estimate in the basket", author: "ola-demo", branch: "feat/delivery-eta", updatedAt: ago(now, 25), requested: [DEMO_LOGIN], additions: 120, deletions: 30 }),
      pr(now, { repo: r("accounts"), number: 233, title: "Rate-limit password reset emails", author: "per-demo", branch: "fix/reset-limit", updatedAt: ago(now, 95), requested: [DEMO_LOGIN], labels: ["security"], additions: 44, deletions: 6 }),
    ],
  };
}

export function demoNotes(now: number): Note[] {
  return [
    { id: "n1", reason: "review_requested", type: "PullRequest", title: "Show the delivery estimate in the basket", repo: `${DEMO_ORG}/checkout`, updatedAt: ago(now, 25), url: `${base}/${DEMO_ORG}/checkout/pull/415` },
    { id: "n2", reason: "mention", type: "Issue", title: "Search returns old prices after a sale ends", repo: `${DEMO_ORG}/catalog`, updatedAt: ago(now, 70), url: `${base}/${DEMO_ORG}/catalog/issues/91` },
    { id: "n3", reason: "ci_activity", type: "CheckSuite", title: "test workflow run failed for feat/image-cache branch", repo: `${DEMO_ORG}/catalog`, updatedAt: ago(now, 50), url: `${base}/${DEMO_ORG}/catalog/actions` },
  ];
}

export function demoMoves(now: number): Move[] {
  const m = (min: number, o: Omit<Move, "at" | "bot">): Move => ({ at: ago(now, min), bot: false, ...o });
  return [
    m(12, { actor: "ola-demo", repo: `${DEMO_ORG}/checkout`, type: "PullRequestReviewEvent", verb: "reviewed (approved)", ref: `${DEMO_ORG}/checkout#412`, title: "Retry card payments once on a gateway timeout", url: `${base}/${DEMO_ORG}/checkout/pull/412` }),
    m(40, { actor: "per-demo", repo: `${DEMO_ORG}/accounts`, type: "PullRequestEvent", verb: "opened", ref: `${DEMO_ORG}/accounts#233`, title: "Rate-limit password reset emails", url: `${base}/${DEMO_ORG}/accounts/pull/233` }),
    m(65, { actor: "lise-demo", repo: `${DEMO_ORG}/web`, type: "PullRequestEvent", verb: "merged", ref: `${DEMO_ORG}/web#1287`, title: "Faster first paint on the front page", url: `${base}/${DEMO_ORG}/web/pull/1287` }),
    m(90, { actor: "ola-demo", repo: `${DEMO_ORG}/checkout`, type: "PushEvent", verb: "pushed 3 to", title: "feat/delivery-eta", url: `${base}/${DEMO_ORG}/checkout/commits/feat%2Fdelivery-eta` }),
  ];
}

export function demoDeploys(now: number): Deploy[] {
  return [
    {
      id: 7001, name: "Deploy to production", title: "Deploy to production", actor: "lise-demo", createdAt: ago(now, 35),
      url: `${base}/${DEMO_ORG}/web/actions/runs/7001`, sha: "9f8e7d6", headSha: "9f8e7d6c5b4a3921", branch: "main", repo: `${DEMO_ORG}/web`,
      envs: [{ id: 3, name: "production" }], superseded: [], more: false,
    },
  ];
}

export function demoSnapshot(now = Date.now()): Snapshot {
  return {
    at: now - 60_000,
    login: DEMO_LOGIN,
    org: DEMO_ORG,
    prs: { ok: true, value: demoPrs(now) },
    notes: { ok: true, value: demoNotes(now) },
    moves: { ok: true, value: demoMoves(now) },
    deploys: { ok: true, value: demoDeploys(now) },
    refs: new Map(),
    changelogs: new Map(),
    red: [{ repo: `${DEMO_ORG}/catalog`, branch: "feat/image-cache", workflow: "test", failures: 2, since: ago(now, 50), url: `${base}/${DEMO_ORG}/catalog/actions` }],
    name: "Kari",
  };
}

/** Two agents at work on the (made-up) Mac: one busy, one waiting for an answer. */
export function demoSessions(now = Date.now()): Sessions {
  const s = (o: Partial<Session> & Pick<Session, "sessionId">): Session => ({ live: true, prs: [], subagentsRunning: 0, kind: "interactive", lastAt: ago(now, 2), ...o });
  return {
    live: [
      s({ sessionId: "d0e0a001-0000-4000-8000-000000000001", status: "busy", statusSince: now - 4 * 60_000, repo: `${DEMO_ORG}/checkout`, branch: "feat/payment-retry", title: "Add a retry test for gateway timeouts", lastPrompt: "Cover the timeout path with a test", cost: 0.42 }),
      s({ sessionId: "d0e0a001-0000-4000-8000-000000000002", harness: "codex", status: "idle", statusSince: now - 20 * 60_000, repo: `${DEMO_ORG}/catalog`, branch: "feat/image-cache", title: "Find why the image cache test fails", lastPrompt: "Why does test/cache.test.ts fail on CI only?", cost: 0.18 }),
    ],
    recent: [
      s({ sessionId: "d0e0a001-0000-4000-8000-000000000003", live: false, status: "idle", repo: `${DEMO_ORG}/web`, branch: "feat/dark-orders", title: "Dark mode for order history", lastAt: ago(now, 180), cost: 0.65, prs: [{ url: `${base}/${DEMO_ORG}/web/pull/1290`, repo: `${DEMO_ORG}/web`, number: 1290 }] }),
    ],
  };
}

/** What each made-up session said, for its page. */
const TALK: Record<string, { tools: { name: string; detail: string }[]; reply: string }> = {
  "1": { tools: [{ name: "Read", detail: "src/payments/charge.ts" }, { name: "Grep", detail: "timeout" }], reply: "The gateway call has a 10 s timeout and no retry. I'm adding a test that fakes a slow gateway and checks we retry once, then fail with a clear message." },
  "2": { tools: [{ name: "Read", detail: "test/cache.test.ts" }, { name: "Bash", detail: "pnpm test cache" }], reply: "It passes here and fails on CI because CI runs in UTC: the cache key includes the local date. Should I key it by UTC date, or freeze the clock in the test?" },
  "3": { tools: [{ name: "Edit", detail: "src/orders/history.css" }], reply: "Dark mode is in for the order history page, and the draft PR is open as web#1290." },
};

export function demoTurns(sid: string): Turn[] {
  const s = [...demoSessions().live, ...demoSessions().recent].find((x) => x.sessionId === sid);
  const talk = TALK[sid.slice(-1)];
  if (!s || !talk) return [];
  return [
    { role: "user", text: s.lastPrompt ?? s.title ?? "" },
    { role: "tools", calls: talk.tools },
    { role: "assistant", text: talk.reply },
  ];
}

const DAY = 86400e3;

/** 12 weeks of plausible history for the Northwind org. */
export function demoHistory(now = Date.now()): History {
  const weeks = weeksOf(now);
  const r = (name: string) => `${DEMO_ORG}/${name}`;

  // 12 weeks of org merged PR counts (varied, current week partial)
  const orgCounts = [19, 24, 16, 28, 22, 18, 31, 26, 21, 27, 23, 11];
  const orgMerged = weeks.map((w, i) => ({ week: w.key, n: orgCounts[i] ?? 20 }));

  const prTitles = [
    ["checkout", "Idempotent payment capture webhook handler"],
    ["web", "Responsive checkout summary on mobile"],
    ["catalog", "Batch cache invalidation for catalog updates"],
    ["accounts", "Sanitize redirect URLs after OAuth sign-in"],
    ["checkout", "Support Klarna Pay in 3 in Nordic markets"],
    ["web", "Preload hero assets for catalog index"],
    ["catalog", "Faceted search filter by brand and rating"],
    ["accounts", "Audit log retention policy for user data"],
    ["checkout", "Currency formatting helper for EUR and NOK"],
    ["web", "Virtualised table for order history lists"],
    ["catalog", "Export catalog delta feed for search indexer"],
    ["checkout", "Address validation fallback when lookup times out"],
    ["accounts", "Passkey registration flow for customer accounts"],
    ["web", "Accessible keyboard navigation in modal dialogs"],
    ["catalog", "Image thumbnail generation on upload"],
    ["checkout", "Validate card expiration before tokenization"],
    ["web", "Order confirmation print stylesheet"],
    ["catalog", "Tax rate lookup by postal code"],
  ];

  const mine: MyPr[] = [];
  const reviewsGiven: string[] = [];
  const releases: Release[] = [];
  const commits: Commit[] = [];

  let prIdx = 0;
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]!;
    const isCurrentWeek = i === weeks.length - 1;

    if (isCurrentWeek) {
      // Current week: PR merged yesterday/today
      const num = 410;
      const repo = r("checkout");
      const created = new Date(now - 28 * 3600e3).toISOString();
      const ready = new Date(now - 26 * 3600e3).toISOString();
      const reviewed = new Date(now - 22 * 3600e3).toISOString();
      const merged = new Date(now - 4 * 3600e3).toISOString();
      mine.push({
        repo,
        number: num,
        title: "Fast retry for transient payment timeouts",
        url: `${base}/${repo}/pull/${num}`,
        createdAt: created,
        readyAt: ready,
        firstReviewAt: reviewed,
        mergedAt: merged,
        state: "MERGED",
        draft: false,
      });

      reviewsGiven.push(new Date(now - 6 * 3600e3).toISOString());
      reviewsGiven.push(new Date(now - 18 * 3600e3).toISOString());

      commits.push(
        { repo: r("checkout"), at: new Date(now - 2 * 3600e3).toISOString(), state: "SUCCESS" },
        { repo: r("web"), at: new Date(now - 5 * 3600e3).toISOString(), state: "SUCCESS" },
        { repo: r("catalog"), at: new Date(now - 12 * 3600e3).toISOString(), state: "FAILURE" },
        { repo: r("checkout"), at: new Date(now - 20 * 3600e3).toISOString(), state: "SUCCESS" },
      );
    } else {
      // Past weeks: 1 or 2 merged PRs per week for Kari
      const prCount = i % 3 === 0 ? 2 : 1;
      for (let p = 0; p < prCount && prIdx < prTitles.length; p++) {
        const [repoShort, title] = prTitles[prIdx++]!;
        const num = 300 + prIdx * 7;
        const repo = r(repoShort!);
        const created = new Date(w.start + (p * 2 + 1) * DAY + 9 * 3600e3).toISOString();
        const ready = new Date(w.start + (p * 2 + 1) * DAY + 10 * 3600e3).toISOString();
        const reviewed = new Date(w.start + (p * 2 + 1) * DAY + 13.5 * 3600e3).toISOString();
        const merged = new Date(w.start + (p * 2 + 2) * DAY + 15 * 3600e3).toISOString();
        mine.push({
          repo,
          number: num,
          title: title!,
          url: `${base}/${repo}/pull/${num}`,
          createdAt: created,
          readyAt: ready,
          firstReviewAt: reviewed,
          mergedAt: merged,
          state: "MERGED",
          draft: false,
        });
      }

      reviewsGiven.push(new Date(w.start + 2.5 * DAY + 14 * 3600e3).toISOString());
      if (i % 2 === 0) {
        reviewsGiven.push(new Date(w.start + 4.2 * DAY + 11 * 3600e3).toISOString());
      }

      if (i % 2 === 1) {
        releases.push({
          repo: r(i % 4 === 1 ? "web" : "checkout"),
          at: new Date(w.start + 4 * DAY + 16 * 3600e3).toISOString(),
          tag: `v1.${i}.0`,
        });
      }

      const commitCount = 10 + (i % 4);
      for (let c = 0; c < commitCount; c++) {
        const isBad = (i + c) % 11 === 0;
        commits.push({
          repo: r(c % 2 === 0 ? "web" : "checkout"),
          at: new Date(w.start + ((c % 5) + 0.5) * DAY + (9 + (c % 8)) * 3600e3).toISOString(),
          state: isBad ? "FAILURE" : "SUCCESS",
        });
      }
    }
  }

  const open: OpenPr[] = [
    { repo: r("checkout"), number: 412, title: "Retry card payments once on a gateway timeout", url: `${base}/${r("checkout")}/pull/412`, createdAt: ago(now, 18), draft: false, mine: true },
    { repo: r("catalog"), number: 88, title: "Cache product images at the edge", url: `${base}/${r("catalog")}/pull/88`, createdAt: ago(now, 52), draft: false, mine: true },
    { repo: r("web"), number: 1290, title: "Dark mode for the order history page", url: `${base}/${r("web")}/pull/1290`, createdAt: ago(now, 140), draft: true, mine: true },
    { repo: r("checkout"), number: 415, title: "Show the delivery estimate in the basket", url: `${base}/${r("checkout")}/pull/415`, createdAt: ago(now, 25), draft: false, mine: false },
    { repo: r("accounts"), number: 233, title: "Rate-limit password reset emails", url: `${base}/${r("accounts")}/pull/233`, createdAt: ago(now, 95), draft: false, mine: false },
    { repo: r("catalog"), number: 81, title: "Bulk price update CSV importer", url: `${base}/${r("catalog")}/pull/81`, createdAt: ago(now, 5 * 24 * 60), draft: false, mine: false },
    { repo: r("web"), number: 1270, title: "Upgrade to Tailwind CSS v4", url: `${base}/${r("web")}/pull/1270`, createdAt: ago(now, 16 * 24 * 60), draft: false, mine: true },
  ];

  return {
    at: now - 60_000,
    login: DEMO_LOGIN,
    mine,
    reviewsGiven,
    open,
    orgMerged,
    releases,
    commits,
    repos: 4,
  };
}

/** 7–14 days of plausible agent spend (Claude Code and omp). */
export function demoSpend(now = Date.now()): SpendDay[] {
  const baseSpend = [
    { claude: 18.4, omp: 0.25, sessions: 3 },
    { claude: 32.1, omp: 0.40, sessions: 5 },
    { claude: 24.8, omp: 0.15, sessions: 4 },
    { claude: 41.5, omp: 0.60, sessions: 6 },
    { claude: 15.2, omp: 0.10, sessions: 2 },
    { claude: 0.0, omp: 0.0, sessions: 0 },
    { claude: 0.0, omp: 0.0, sessions: 0 },
    { claude: 28.6, omp: 0.35, sessions: 4 },
    { claude: 35.4, omp: 0.50, sessions: 5 },
    { claude: 19.2, omp: 0.20, sessions: 3 },
    { claude: 44.0, omp: 0.75, sessions: 6 },
    { claude: 22.5, omp: 0.30, sessions: 4 },
    { claude: 0.0, omp: 0.0, sessions: 0 },
    { claude: 1.25, omp: 0.10, sessions: 3 },
  ];
  const days: SpendDay[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = baseSpend[13 - i]!;
    days.push({
      day: osloDay(now - i * DAY),
      claude: d.claude,
      omp: d.omp,
      sessions: d.sessions,
    });
  }
  return days;
}

/** Fixed stats for the demo worker, refreshed with the clock so times stay relative. */
export function demoStats(now = Date.now()): Stats {
  let at = now;
  let v: StatsView = { history: demoHistory(at), gathering: false, spend: demoSpend(at), spendAt: at };
  const get = () => {
    const cur = Date.now();
    if (cur - at > 120_000) {
      at = cur;
      v = { history: demoHistory(at), gathering: false, spend: demoSpend(at), spendAt: at };
    }
    return v;
  };
  return {
    view: () => get(),
    refresh: () => {},
  };
}
