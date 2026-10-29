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

const base = "/elsewhere";
const ago = (now: number, min: number) => new Date(now - min * 60_000).toISOString();

const pr = (now: number, o: Partial<Pr> & Pick<Pr, "repo" | "number" | "title">): Pr => ({
  url: `${base}/${o.repo}/pull/${o.number}`,
  draft: false,
  updatedAt: ago(now, 30),
  createdAt: ago(now, 60 * 26),
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
  runs: [{ name: "build", state: "ok", url: `${base}/${o.repo}/actions` }, { name: "test", state: "ok", url: `${base}/${o.repo}/actions` }],
  ...o,
  ...sizeOf(o.repo, o.number),
});
/** A PR's files and size, from its patches, so the list and its page agree. */
function sizeOf(repo: string, n: number): Pick<Pr, "files" | "changedFiles" | "additions" | "deletions"> | {} {
  const files = demoPrFiles(repo, n).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));
  if (!files.length) return {};
  return { files, changedFiles: files.length, additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0) };
}

/** Each demo PR's changed files with their patches, by "repo#number" (the repo without the org). */
const DEMO_FILES: Record<string, { path: string; status?: string; patch: string }[]> = {
  "checkout#412": [
    { path: "src/payments/charge.ts", patch: `@@ -18,9 +18,17 @@ export async function charge(order: Order, card: Card): Promise<Receipt> {
   const body = { amount: order.total, currency: order.currency, card: card.token };
-  const res = await gateway.post("/charges", body);
-  if (!res.ok) throw new ChargeError(res.status);
-  return res.json();
+  // A timeout says nothing about whether the charge went through: ask once, with the same key.
+  const key = order.id;
+  for (let attempt = 1; ; attempt++) {
+    try {
+      const res = await gateway.post("/charges", body, { idempotencyKey: key, timeoutMs: 8_000 });
+      if (!res.ok) throw new ChargeError(res.status);
+      return res.json();
+    } catch (e) {
+      if (!(e instanceof TimeoutError) || attempt > 1) throw e;
+      log.warn("charge timed out, retrying once", { order: order.id });
+    }
+  }
 }` },
    { path: "test/charge.test.ts", patch: `@@ -40,3 +40,15 @@ test("a declined card throws", async () => {
   await assert.rejects(charge(order, declined), ChargeError);
 });
+
+test("a gateway timeout is retried once with the same key", async () => {
+  const gw = fakeGateway([timeout(), ok(receipt)]);
+  assert.deepEqual(await charge(order, card, gw), receipt);
+  assert.deepEqual(gw.keys, [order.id, order.id]);
+});
+
+test("a second timeout gives up", async () => {
+  const gw = fakeGateway([timeout(), timeout()]);
+  await assert.rejects(charge(order, card, gw), TimeoutError);
+  assert.equal(gw.calls, 2);
+});` },
  ],
  "catalog#88": [
    { path: "src/images/serve.ts", patch: `@@ -7,8 +7,12 @@ export async function serveImage(req: Request, env: Env): Promise<Response> {
   const { id, width } = parse(new URL(req.url));
-  const original = await env.IMAGES.get(id);
-  if (!original) return new Response("Not found", { status: 404 });
-  return resize(original, width);
+  const cache = caches.default;
+  const hit = await cache.match(req);
+  if (hit) return hit;
+  const original = await env.IMAGES.get(id);
+  if (!original) return new Response("Not found", { status: 404 });
+  const res = resize(original, width);
+  res.headers.set("Cache-Control", "public, max-age=86400");
+  await cache.put(req, res.clone());
+  return res;
 }` },
    { path: "test/serve.test.ts", patch: `@@ -12,2 +12,8 @@ test("an unknown image is a 404", async () => {
   assert.equal((await serveImage(get("/img/nope"), env)).status, 404);
 });
+
+test("a second request comes from the cache", async () => {
+  await serveImage(get("/img/p1?w=400"), env);
+  await serveImage(get("/img/p1?w=400"), env);
+  assert.equal(env.IMAGES.reads, 1);
+});` },
  ],
  "web#1290": [
    { path: "src/pages/orders.css", patch: `@@ -1,6 +1,14 @@
 .orders { display: grid; gap: 12px; }
-.order { background: #fff; color: #222; border: 1px solid #ddd; }
+.order { background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
+
+@media (prefers-color-scheme: dark) {
+  :root { --surface: #1d1f22; --ink: #e8e6e3; --line: #34373b; }
+}
+@media (prefers-color-scheme: light) {
+  :root { --surface: #fff; --ink: #222; --line: #ddd; }
+}
 .order h3 { margin: 0; }` },
  ],
  "checkout#415": [
    { path: "src/basket/eta.ts", status: "added", patch: `@@ -0,0 +1,14 @@
+/** When the basket would arrive if ordered now: the carrier's estimate for the postcode, plus picking time. */
+export async function deliveryEstimate(postcode: string, now = new Date()): Promise<{ from: Date; to: Date }> {
+  const days = await carrier.estimate(postcode);
+  const picked = now.getHours() < 14 ? now : nextMorning(now);
+  return { from: addWorkdays(picked, days.min), to: addWorkdays(picked, days.max) };
+}
+
+function nextMorning(d: Date): Date {
+  const n = new Date(d);
+  n.setDate(n.getDate() + 1);
+  n.setHours(8, 0, 0, 0);
+  return n;
+}
+` },
    { path: "src/basket/Basket.tsx", patch: `@@ -31,6 +31,10 @@ export function Basket({ items, postcode }: Props) {
   return (
     <section className="basket">
       <Items items={items} />
+      <Suspense fallback={<p className="eta">Working out delivery…</p>}>
+        <Eta postcode={postcode} />
+      </Suspense>
-      <Total items={items} />
+      <Total items={items} showVat />
     </section>
   );` },
  ],
  "accounts#233": [
    { path: "src/auth/reset.ts", patch: `@@ -22,6 +22,13 @@ export async function requestReset(email: string, ip: string): Promise<void> {
   const user = await users.byEmail(email);
+  // At most 3 a quarter-hour per address and 20 per IP: the same answer either way, so it says nothing about who has an account.
+  const ok = await limits.take([\`reset:email:\${email}\`, 3, 15 * 60], [\`reset:ip:\${ip}\`, 20, 15 * 60]);
+  if (!ok) {
+    log.info("reset rate-limited", { ip });
+    return;
+  }
   if (!user) return;
-  await mail.send(user.email, resetMail(user));
+  await mail.send(user.email, resetMail(user), { category: "security" });
 }` },
  ],
};

const fileStats = (patch: string) => {
  const lines = patch.split("\n");
  return { additions: lines.filter((l) => l.startsWith("+")).length, deletions: lines.filter((l) => l.startsWith("-")).length };
};

/** A demo PR's files as the forge's REST API lists them. */
export function demoPrFiles(repo: string, n: number) {
  return (DEMO_FILES[`${repo.split("/")[1]}#${n}`] ?? []).map((f, i) => ({ filename: f.path, status: f.status ?? "modified", ...fileStats(f.patch), patch: f.patch, sha: `d${i}e${n}`.padEnd(40, "0") }));
}

/** A demo PR as the forge's GraphQL answers for its page (src/sources/prview.ts), or undefined. */
export function demoPrNode(now: number, repo: string, n: number): unknown {
  const { mine, review } = demoPrs(now);
  const p = [...mine, ...review].find((x) => x.repo === repo && x.number === n);
  if (!p) return undefined;
  const files = DEMO_FILES[`${repo.split("/")[1]}#${n}`] ?? [];
  const reviewer = p.reviews[0]?.login ?? p.requested[0] ?? "ola-demo";
  const threads = files.length && p.openThreads
    ? Array.from({ length: p.openThreads }, (_, i) => ({
        id: `PRRT_demo${n}${i}`, isResolved: false, isOutdated: false, path: files[0]!.path, line: 10 + i * 4, diffSide: "RIGHT",
        comments: { nodes: [{ databaseId: 9000 + i, author: { login: reviewer }, body: i ? "Does this need a test for the miss case too?" : "This caches the 404 as well, doesn't it? Only put a 200.", createdAt: ago(now, 70 - i * 5), url: `${p.url}#discussion_r${9000 + i}` }] },
      }))
    : [];
  const ctx = (r: Pr["runs"][number]) => ({ name: r.name, status: r.state === "pending" ? "IN_PROGRESS" : "COMPLETED", conclusion: { ok: "SUCCESS", bad: "FAILURE", skipped: "SKIPPED", pending: null }[r.state], detailsUrl: r.url });
  return {
    repository: {
      pullRequest: {
        number: p.number, title: p.title, url: p.url, state: "OPEN", isDraft: p.draft, mergeable: "MERGEABLE",
        baseRefName: "main", headRefName: p.branch, headRefOid: p.headSha, author: { login: p.author },
        body: p.body, additions: p.additions, deletions: p.deletions, changedFiles: files.length,
        createdAt: p.createdAt, updatedAt: p.updatedAt, reviewDecision: p.review, labels: { nodes: p.labels.map((name) => ({ name })) },
        reviewRequests: { nodes: p.requested.map((login) => ({ requestedReviewer: { login } })) },
        reviews: { nodes: p.reviews.map((rv, i) => ({ author: { login: rv.login }, state: rv.state, body: rv.state === "CHANGES_REQUESTED" ? "The tests fail on the cache key; see the two comments." : "", submittedAt: ago(now, 15 + i * 10), url: `${p.url}#review-${i}` })) },
        reviewThreads: { nodes: threads },
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: p.runs.map(ctx) } } } }] },
        timelineItems: {
          nodes: [
            { __typename: "PullRequestCommit", commit: { oid: "c0ffee1234567", messageHeadline: p.title, committedDate: p.createdAt, author: { user: { login: p.author } } } },
            ...p.requested.map((login) => ({ __typename: "ReviewRequestedEvent", createdAt: p.createdAt, actor: { login: p.author }, requestedReviewer: { login } })),
            { __typename: "PullRequestCommit", commit: { oid: "beef5678abcd9", messageHeadline: "Address review notes", committedDate: p.updatedAt, author: { user: { login: p.author } } } },
          ],
        },
      },
    },
  };
}

export function demoPrs(now: number): { mine: Pr[]; review: Pr[] } {
  const r = (name: string) => `${DEMO_ORG}/${name}`;
  return {
    mine: [
      pr(now, { repo: r("checkout"), number: 412, title: "Retry card payments once on a gateway timeout", branch: "feat/payment-retry", review: "APPROVED", updatedAt: ago(now, 18), reviews: [{ login: "ola-demo", state: "APPROVED" }], body: "The gateway times out a few times a day under load, and the customer sees a failed payment that often went through.\n\nThis retries a timed-out charge once with the same idempotency key, so the gateway answers the first charge rather than making a second." }),
      pr(now, { repo: r("catalog"), number: 88, title: "Cache product images at the edge", branch: "feat/image-cache", checks: "FAILURE", updatedAt: ago(now, 52), openThreads: 2, runs: [{ name: "test", state: "bad", url: `${base}/${r("catalog")}/actions` }, { name: "build", state: "ok", url: `${base}/${r("catalog")}/actions` }], reviews: [{ login: "per-demo", state: "CHANGES_REQUESTED" }], review: "CHANGES_REQUESTED", body: "Product images are resized on every request. This puts the resized image in the edge cache for a day." }),
      pr(now, { repo: r("web"), number: 1290, title: "Dark mode for the order history page", branch: "feat/dark-orders", draft: true, checks: "PENDING", updatedAt: ago(now, 140), runs: [{ name: "build", state: "pending", url: `${base}/${r("web")}/actions` }], body: "Draft: the order history follows the system's dark mode. Still to do: the receipts." }),
    ],
    review: [
      pr(now, { repo: r("checkout"), number: 415, title: "Show the delivery estimate in the basket", author: "ola-demo", branch: "feat/delivery-eta", updatedAt: ago(now, 25), requested: [DEMO_LOGIN], body: "Shows when the basket would arrive, from the carrier's estimate for the postcode. Orders after 14:00 are picked the next morning." }),
      pr(now, { repo: r("accounts"), number: 233, title: "Rate-limit password reset emails", author: "per-demo", branch: "fix/reset-limit", updatedAt: ago(now, 95), requested: [DEMO_LOGIN], labels: ["security"], body: "Anyone could send a reset email to any address as often as they liked. This caps it per address and per IP, and answers the same either way." }),
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
      // Hours ago, but inside this week (early on a Monday too), so this week always has them.
      const hAgo = (h: number) => new Date(Math.min(now, Math.max(w.start, now - h * 3600e3))).toISOString();
      // Current week: PR merged yesterday/today
      const num = 410;
      const repo = r("checkout");
      const created = hAgo(28);
      const ready = hAgo(26);
      const reviewed = hAgo(22);
      const merged = hAgo(4);
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

      reviewsGiven.push(hAgo(6));
      reviewsGiven.push(hAgo(18));

      commits.push(
        { repo: r("checkout"), at: hAgo(2), state: "SUCCESS" },
        { repo: r("web"), at: hAgo(5), state: "SUCCESS" },
        { repo: r("catalog"), at: hAgo(12), state: "FAILURE" },
        { repo: r("checkout"), at: hAgo(20), state: "SUCCESS" },
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
