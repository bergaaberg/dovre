/** Issue actions (#40): what a form may ask, and what the issue as it is now still allows. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ghe } from "../../../../sources/ghe.ts";
import { actOnIssue, loadIssue } from "../../../../sources/issues.ts";
import { actOf, doneText, refusal } from "../act.ts";
import { issue } from "./fixtures.ts";

const base = { repo: "bergaaberg/dovre", number: "33" };

test("actOf: the owners' repos only, a real number, a known kind, a reason to close, a comment within bounds", () => {
  assert.deepEqual(actOf({ ...base, kind: "assign" }, "bergaaberg", "kari"), { ok: true, act: { kind: "assign", repo: "bergaaberg/dovre", number: 33, login: "kari" } });
  assert.deepEqual(actOf({ ...base, kind: "close", reason: "not_planned" }, "bergaaberg", "kari"), { ok: true, act: { kind: "close", repo: "bergaaberg/dovre", number: 33, reason: "not_planned" } });
  assert.deepEqual(actOf({ ...base, kind: "comment", body: "  thanks \n" }, "bergaaberg", "kari"), { ok: true, act: { kind: "comment", repo: "bergaaberg/dovre", number: 33, body: "thanks" } });
  for (const [form, why] of [
    [{ ...base, repo: "evil/repo", kind: "reopen" }, /your repos/],
    [{ ...base, repo: "bergaaberg/../x", kind: "reopen" }, /your repos/],
    [{ ...base, number: "0", kind: "reopen" }, /number/],
    [{ ...base, number: "1; rm", kind: "reopen" }, /number/],
    [{ ...base, kind: "delete" }, /Not something/],
    [{ ...base, kind: "close" }, /done or as not planned/],
    [{ ...base, kind: "comment", body: "   " }, /empty/],
    [{ ...base, kind: "comment", body: "x".repeat(4001) }, /longer/],
  ] as const) {
    const r = actOf(form, "bergaaberg", "kari");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, why);
  }
  assert.equal(actOf({ ...base, kind: "assign" }, "bergaaberg", "").ok, false);
});

test("refusal: re-checked against the issue now", () => {
  const open = issue({ assignees: ["someone"] });
  const closed = issue({ state: "CLOSED" });
  const a = { repo: "bergaaberg/dovre", number: 33 };
  assert.equal(refusal(open, { ...a, kind: "assign", login: "kari" }), undefined);
  assert.match(refusal(issue({ assignees: ["Kari"] }), { ...a, kind: "assign", login: "kari" })!, /already assigned/);
  assert.match(refusal(closed, { ...a, kind: "assign", login: "kari" })!, /closed/);
  assert.match(refusal(closed, { ...a, kind: "close", reason: "completed" })!, /already closed/);
  assert.match(refusal(open, { ...a, kind: "reopen" })!, /already open/);
  assert.equal(refusal(closed, { ...a, kind: "reopen" }), undefined);
  assert.equal(refusal(closed, { ...a, kind: "comment", body: "x" }), undefined);
  assert.match(refusal(undefined, { ...a, kind: "comment", body: "x" })!, /no such issue/);
  assert.equal(doneText({ kind: "close", repo: "a/b", number: 1, reason: "not_planned" }), "Closed a/b#1 (not planned)");
});

test("GitHub: one issue by REST (a PR or a 404 is none); each act is one call", async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const answers: Record<string, unknown> = {
    "/repos/a/b/issues/1": { number: 1, title: "T", html_url: "https://github.com/a/b/issues/1", state: "closed", created_at: "x", updated_at: "y", user: null, labels: ["bug", { name: "ui" }, {}], assignees: [{ login: "kari" }], comments: 2, milestone: null },
    "/repos/a/b/issues/2": { number: 2, pull_request: {}, title: "", html_url: "", state: "open", created_at: "", updated_at: "", user: null, labels: [], assignees: [], comments: 0, milestone: null },
  };
  const ghe: Ghe = {
    host: "github.com",
    graphql: async () => {
      throw new Error("no graphql");
    },
    rest: async <T>(path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (init?.method) return null as T;
      if (path in answers) return answers[path] as T;
      throw new Error(`GHE GET ${path}: 404 Not Found`);
    },
  };
  const one = await loadIssue(ghe, "a/b", 1);
  assert.equal(one?.state, "CLOSED");
  assert.deepEqual(one?.labels, ["bug", "ui"]);
  assert.deepEqual(one?.assignees, ["kari"]);
  assert.equal(await loadIssue(ghe, "a/b", 2), undefined);
  assert.equal(await loadIssue(ghe, "a/b", 404), undefined);
  await assert.rejects(loadIssue(ghe, "a/../b", 1), /not an issue/);
  calls.length = 0;
  await actOnIssue(ghe, { kind: "assign", repo: "a/b", number: 1, login: "kari" });
  await actOnIssue(ghe, { kind: "close", repo: "a/b", number: 1, reason: "not_planned" });
  await actOnIssue(ghe, { kind: "reopen", repo: "a/b", number: 1 });
  await actOnIssue(ghe, { kind: "comment", repo: "a/b", number: 1, body: "hi" });
  assert.deepEqual(calls, [
    { path: "/repos/a/b/issues/1/assignees", method: "POST", body: { assignees: ["kari"] } },
    { path: "/repos/a/b/issues/1", method: "PATCH", body: { state: "closed", state_reason: "not_planned" } },
    { path: "/repos/a/b/issues/1", method: "PATCH", body: { state: "open" } },
    { path: "/repos/a/b/issues/1/comments", method: "POST", body: { body: "hi" } },
  ]);
});
