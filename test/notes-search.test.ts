import assert from "node:assert/strict";
import { test } from "node:test";
import { githubForge } from "../src/forge/github.ts";
import { loadNotes, notesRefused, redFromRuns } from "../src/sources/ghe.ts";
import { fakeGhe } from "./helpers.ts";

const REFUSED = () => {
  throw new Error(`GHE GET /notifications?per_page=50: 403 {"message":"Resource not accessible by integration"}`);
};
const NOW = Date.parse("2026-10-25T12:00:00Z");

test("notesRefused: the App token's and the fine-grained PAT's 403, not other failures", () => {
  assert.ok(notesRefused(new Error(`GHE GET /notifications?per_page=50: 403 {"message":"Resource not accessible by integration"}`)));
  assert.ok(notesRefused(new Error(`GHE GET /notifications?per_page=50: 403 {"message":"Resource not accessible by personal access token"}`)));
  assert.ok(!notesRefused(new Error("GHE GET /notifications?per_page=50: 401 Bad credentials")));
  assert.ok(!notesRefused(new Error(`GHE GET /repos/a/b: 403 {"message":"Resource not accessible by integration"}`)));
});

test("loadNotes: refused notifications become mention notes from a search, newest week only", async () => {
  const { ghe } = fakeGhe({ "GET /notifications?per_page=50": REFUSED });
  let query = "";
  ghe.graphql = (async (q: string) => {
    query = q;
    return { s: { nodes: [
      { __typename: "PullRequest", id: "PR_1", url: "https://github.com/acme/web/pull/4", title: "Fix <b>it</b>", updatedAt: "2026-10-24T10:00:00Z", repository: { nameWithOwner: "acme/web" } },
      { __typename: "Issue", id: "I_2", url: "https://github.com/acme/api/issues/9", title: "Ask", updatedAt: "2026-10-23T10:00:00Z", repository: { nameWithOwner: "acme/api" } },
      {},
      null,
    ] } };
  }) as typeof ghe.graphql;
  let searched: boolean | undefined;
  const notes = await loadNotes(ghe, { now: NOW, searched: (y) => (searched = y) });
  assert.equal(searched, true);
  assert.match(query, /mentions:@me updated:>=2026-10-18/);
  assert.deepEqual(notes.map((n) => [n.id, n.reason, n.type, n.repo, n.url]), [
    ["search:PR_1", "mention", "PullRequest", "acme/web", "https://github.com/acme/web/pull/4"],
    ["search:I_2", "mention", "Issue", "acme/api", "https://github.com/acme/api/issues/9"],
  ]);
});

test("loadNotes: other failures still fail, and readable notifications are used as before", async () => {
  const bad = fakeGhe({});
  await assert.rejects(loadNotes(bad.ghe), /404/);
  const { ghe } = fakeGhe({ "GET /notifications?per_page=50": [{ id: "7", reason: "mention", updated_at: "2026-10-24T10:00:00Z", subject: { type: "Issue", title: "Hi", url: "https://api.acme.ghe.com/repos/acme/web/issues/3" }, repository: { full_name: "acme/web" } }] });
  let searched: boolean | undefined;
  const notes = await loadNotes(ghe, { searched: (y) => (searched = y) });
  assert.equal(searched, false);
  assert.equal(notes[0]!.url, "https://acme.ghe.com/acme/web/issues/3");
});

const run = (name: string, head_branch: string, conclusion: string, at: string) => ({ name, head_branch, conclusion, html_url: `https://github.com/acme/web/actions/runs/${at}`, updated_at: at });

test("redFromRuns: a shared branch is red while its newest runs of a workflow failed, counted in a row", async () => {
  const { ghe } = fakeGhe({
    "GET /repos/acme/web/actions/runs?event=push&status=completed&per_page=50": {
      workflow_runs: [
        run("test", "main", "failure", "3"),
        run("test", "main", "failure", "2"),
        run("test", "main", "success", "1"),
        run("lint", "main", "success", "3"),
        run("lint", "main", "failure", "2"),
        run("test", "feat/x", "failure", "3"),
      ],
    },
  });
  assert.deepEqual(await redFromRuns(ghe, "acme/web"), [{ repo: "acme/web", branch: "main", workflow: "test", failures: 2, since: "2", url: "https://github.com/acme/web/actions/runs/3" }]);
  assert.deepEqual(await redFromRuns(ghe, "acme/gone"), [], "a repo it can't read is not red");
});

test("githubForge: red reads the PRs' repos only when the notes came from search", async () => {
  const runs = { workflow_runs: [run("test", "main", "failure", "3")] };
  const refused = fakeGhe({ "GET /notifications?per_page=50": REFUSED, "GET /repos/acme/web/actions/runs?event=push&status=completed&per_page=50": runs });
  refused.ghe.graphql = (async () => ({ s: { nodes: [] } })) as typeof refused.ghe.graphql;
  const f = githubForge(refused.ghe);
  const notes = await f.notes();
  assert.equal((await f.red!(notes, ["acme/web", "acme/web"])).length, 1);
  assert.equal(refused.calls.filter((c) => c.path.includes("/actions/runs")).length, 1, "each repo read once");

  const readable = fakeGhe({ "GET /notifications?per_page=50": [], "GET /repos/acme/web/actions/runs?event=push&status=completed&per_page=50": runs });
  const g = githubForge(readable.ghe);
  assert.deepEqual(await g.red!(await g.notes(), ["acme/web"]), []);
  assert.equal(readable.calls.filter((c) => c.path.includes("/actions/runs")).length, 0);
});
