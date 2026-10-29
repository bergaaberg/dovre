/** The tracker's lookups (#262): one issue or PR in full, a search; repos outside the owners refused before the forge. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeLookups } from "../lookups.ts";
import { loadThread, searchThreads, type Thread } from "../../../../sources/threads.ts";
import type { Ghe } from "../../../../sources/ghe.ts";
import type { PackContext } from "../../../types.ts";

const ctx = {} as PackContext;
const PR: Thread = {
  kind: "pr", repo: "acme/web", number: 7, title: "Fix login", state: "OPEN", author: "kari", labels: ["bug"], assignees: ["ola"],
  body: `Fixes it.<!-- hidden template -->\n\n\n\nMore ${"x".repeat(3000)}`,
  comments: [{ author: "ola", at: "2026-10-28T10:00:00Z", body: "Looks good" }],
  pr: { draft: true, review: "CHANGES_REQUESTED", additions: 10, deletions: 2, files: 3, branch: "fix-login", reviews: [{ author: "per", state: "CHANGES_REQUESTED", body: "Rename it" }] },
};

test("tracker lookups: a thread in full, cut; outside the owners refused unasked; search filtered to the owners", async () => {
  const asked: string[] = [];
  const ls = forgeLookups(
    {
      name: "GitHub",
      thread: async (repo, n) => (asked.push(`${repo}#${n}`), repo === "acme/web" && n === 7 ? PR : undefined),
      searchThreads: async (owners, words) => (asked.push(`search ${owners.join("+")} ${words}`), [
        { kind: "issue", repo: "acme/web", number: 3, title: "Certs", state: "OPEN", author: "kari" },
        { kind: "pr", repo: "evil/x", number: 1, title: "Not mine", state: "OPEN", author: "x" },
      ]),
    },
    () => "acme, kari",
  );
  const [thread, search] = ls;
  const text = String(await thread!.run({ ref: "acme/web #7" }, ctx));
  assert.match(text, /^PR acme\/web#7: Fix login\n\nState: open \(draft\), by kari, assigned to ola, labels: bug\./);
  assert.match(text, /Branch fix-login, 3 files, \+10 −2, review: changes requested\./);
  assert.ok(!text.includes("hidden template"));
  assert.match(text, /- ola \(2026-10-28\): Looks good/);
  assert.match(text, /- per: changes requested: Rename it/);
  assert.ok(text.length < 3200);
  assert.match(String(await thread!.run({ ref: "evil/x#1" }, ctx)), /isn't one of the owners' repos/);
  assert.match(String(await thread!.run({ ref: "not a ref" }, ctx)), /isn't a reference/);
  assert.match(String(await thread!.run({ ref: "acme/web#8" }, ctx)), /no issue or PR acme\/web#8/);
  assert.deepEqual(asked, ["acme/web#7", "acme/web#8"], "the forge never hears of evil/x");
  const found = String(await search!.run({ q: "certs" }, ctx));
  assert.equal(found, 'Matching "certs":\n- acme/web#3 issue [open] Certs (kari)');
  assert.equal(asked.at(-1), "search acme+kari certs");
  assert.deepEqual(forgeLookups({ name: "GitLab" }, () => "acme"), [], "a forge without the reads gives none");
});

test("the GitHub reads: names quoted, qualifiers taken apart, a missing thread undefined", async () => {
  const queries: string[] = [];
  const ghe = (answer: unknown): Ghe => ({ host: "github.com", rest: () => Promise.reject(new Error("no")), graphql: async <T>(q: string) => (queries.push(q), answer as T) });
  const t = await loadThread(ghe({ repository: { issueOrPullRequest: { __typename: "Issue", title: "T", state: "OPEN", body: "B", author: { login: "k" }, labels: { nodes: [{ name: "bug" }] }, assignees: { nodes: [] }, comments: { nodes: [{ author: null, body: "c", createdAt: "2026-10-01" }] } } } }), "acme/web", 3);
  assert.deepEqual([t?.kind, t?.title, t?.labels, t?.comments[0]?.author, t?.pr], ["issue", "T", ["bug"], "", undefined]);
  assert.match(queries[0]!, /repository\(owner: "acme", name: "web"\) \{ issueOrPullRequest\(number: 3\)/);
  assert.equal(await loadThread(ghe({ repository: { issueOrPullRequest: null } }), "acme/web", 3), undefined);
  assert.equal(await loadThread(ghe({}), "../x", 3), undefined);
  await searchThreads(ghe({ search: { nodes: [] } }), ["acme", "bad owner"], 'certs repo:evil/x "quoted"');
  assert.match(queries.at(-1)!, /search\(query: "certs repo evil\/x quoted user:acme sort:updated-desc"/);
});
