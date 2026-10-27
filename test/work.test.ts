/** GitHub's answer to Forge.work: two counts, the calendar, my commits and their repos' languages. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ghe } from "../src/sources/ghe.ts";
import { loadMerged, loadWork } from "../src/sources/work.ts";

test("work: counts, days, commits (three pages at most) and the top repos' languages; odd answers left out", async () => {
  const queries: string[] = [];
  const paths: string[] = [];
  const ghe: Ghe = {
    host: "github.com",
    async graphql<T>(q: string) {
      queries.push(q);
      if (q.includes("search(type: ISSUE")) return { s: { issueCount: q.includes("reviewed-by") ? 7 : 3 } } as T;
      if (q.includes("contributionCalendar")) return { user: { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays: [{ date: "2026-10-26", contributionCount: 2 }, { date: 5 }] }] } } } } as T;
      return { r0: { languages: { nodes: [{ name: "TypeScript" }, { name: 3 }] } } } as T;
    },
    async rest<T>(path: string) {
      paths.push(path);
      return { items: [{ repository: { full_name: "ACME/a" }, commit: { author: { date: "2026-10-26T22:00:00+02:00" } } }, { repository: {}, commit: {} }] } as T;
    },
  };
  const w = await loadWork(ghe, "me", "ACME", "2026-08-01");
  assert.deepEqual(w, { merged: 3, reviewed: 7, days: [{ date: "2026-10-26", count: 2 }], commits: [{ repo: "ACME/a", date: "2026-10-26T22:00:00+02:00" }], languages: { "ACME/a": ["TypeScript"] } });
  assert.equal(paths.length, 1, "a short page is the last");
  assert.match(decodeURIComponent(paths[0]!), /author:me user:ACME committer-date:>=2026-08-01/);
  assert.match(queries[0]!, /user:ACME is:pr author:me is:merged merged:>=2026-08-01/);
  assert.equal(await loadMerged(ghe, "me", "ACME", "2026-10-26T10:00:00Z"), 3);
});
