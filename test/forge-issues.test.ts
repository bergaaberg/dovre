/** Forge issues (#37): my open issues by set, one search query, the owners' repos only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubForge } from "../src/forge/github.ts";
import { brokenForge } from "../src/forge/pick.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import { type IssueNode, issueQueries, issueSetsOf, loadIssues, normalizeIssue } from "../src/sources/issues.ts";

const node = (o: Partial<IssueNode> = {}): IssueNode => ({
  number: 33,
  title: "Today header on a wide screen",
  url: "https://github.com/bergaaberg/dovre/issues/33",
  state: "OPEN",
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
  author: { login: "kari" },
  repository: { nameWithOwner: "bergaaberg/dovre" },
  labels: { nodes: [{ name: "layout" }, null, { name: "ui" }] },
  assignees: { nodes: [{ login: "kari" }] },
  comments: { totalCount: 3 },
  milestone: null,
  closedByPullRequestsReferences: { nodes: [{ number: 36, state: "OPEN", repository: { nameWithOwner: "bergaaberg/dovre" } }] },
  issueType: { name: "Bug" },
  subIssuesSummary: { completed: 2, total: 3 },
  ...o,
});

function ghe(answer: (q: string) => unknown): Ghe & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    host: "github.com",
    rest: async () => {
      throw new Error("no rest");
    },
    graphql: async <T>(q: string) => {
      seen.push(q);
      return answer(q) as T;
    },
  };
}

test("normalizeIssue: labels, assignees, linked PRs, sub-issues; empty extras are left out", () => {
  const i = normalizeIssue(node());
  assert.deepEqual(i.labels, ["layout", "ui"]);
  assert.deepEqual(i.prs, [{ key: "bergaaberg/dovre#36", state: "OPEN" }]);
  assert.deepEqual(i.subIssues, { done: 2, total: 3 });
  assert.equal(i.type, "Bug");
  assert.equal(i.comments, 3);
  const bare = normalizeIssue(node({ author: null, labels: null, subIssuesSummary: { completed: 0, total: 0 }, issueType: null, closedByPullRequestsReferences: null }));
  assert.equal(bare.author, "ghost");
  assert.deepEqual(bare.labels, []);
  assert.deepEqual(bare.prs, []);
  assert.equal("subIssues" in bare, false);
  assert.equal("type" in bare, false);
  assert.equal("milestone" in bare, false);
});

test("issueQueries: scoped to the owners; triage only for the owners' well-formed repos", () => {
  const q = issueQueries("kari", "bergaaberg,northwind", ["bergaaberg/dovre", "evil/repo", "not a repo", "bergaaberg/dovre"]);
  assert.equal(q.assigned, "is:issue is:open assignee:kari user:bergaaberg user:northwind archived:false");
  assert.match(q.mentioned!, /mentions:kari/);
  assert.match(q.authored!, /author:kari/);
  assert.equal(q.triage, "is:issue is:open no:assignee no:label repo:bergaaberg/dovre archived:false");
  assert.equal("triage" in issueQueries("kari", "bergaaberg", ["evil/repo"]), false);
  assert.equal("triage" in issueQueries("kari", "bergaaberg"), false);
});

test("issueSetsOf: drops repos outside the owners, PRs and empty nodes; newest first", () => {
  const sets = issueSetsOf(
    {
      assigned: { nodes: [node({ number: 1, updatedAt: "2026-10-01T00:00:00Z" }), node({ number: 2 }), node({ repository: { nameWithOwner: "evil/repo" } }), {}, null, node({ repository: null })] },
      mentioned: { nodes: [node({ number: 5 })] },
    },
    "bergaaberg",
  );
  assert.deepEqual(sets.assigned.map((i) => i.number), [2, 1]);
  assert.deepEqual(sets.mentioned.map((i) => i.number), [5]);
  assert.deepEqual(sets.authored, []);
  assert.deepEqual(sets.triage, []);
});

test("loadIssues: one query of aliases; retried without the newer fields where the server lacks them", async () => {
  const g = ghe(() => ({ assigned: { nodes: [node()] }, mentioned: { nodes: [] }, authored: { nodes: [] }, triage: { nodes: [node({ number: 9 })] } }));
  const sets = await githubForge(g).issues!("kari", "bergaaberg", { triage: ["bergaaberg/dovre"] });
  assert.equal(g.seen.length, 1);
  assert.match(g.seen[0]!, /assigned: search\(/);
  assert.match(g.seen[0]!, /triage: search\(/);
  assert.equal(sets.assigned[0]!.number, 33);
  assert.equal(sets.triage[0]!.number, 9);

  const old = ghe((q) => {
    if (q.includes("issueType")) throw new Error("GHE graphql: 200 Field 'issueType' doesn't exist on type 'Issue'");
    return { assigned: { nodes: [node({ issueType: undefined, subIssuesSummary: undefined })] } };
  });
  const got = await loadIssues(old, "kari", "bergaaberg");
  assert.equal(old.seen.length, 2);
  assert.doesNotMatch(old.seen[1]!, /issueType|subIssuesSummary/);
  assert.equal(got.assigned.length, 1);
  assert.doesNotMatch(old.seen[0]!, /triage:/);

  const down = ghe(() => {
    throw new Error("GHE graphql: 502");
  });
  await assert.rejects(loadIssues(down, "kari", "bergaaberg"), /502/);
  assert.equal(down.seen.length, 1);
});

test("a forge without issues() has none: the Issues pack stays off", () => {
  assert.equal(brokenForge("lab", "nope").issues, undefined);
});
