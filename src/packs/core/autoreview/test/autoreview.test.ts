/** Auto review (#326): its PRs kept from the agents pack's share, their levels, and the PR page's row. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../../../db.ts";
import { autoStore } from "../../../../agents/auto.ts";
import type { Desk } from "../../../../agents/desk.ts";
import { testContext } from "../../../testing.ts";
import type { AutoPr, AutoShare, PackContext } from "../../../types.ts";
import { autoShare } from "../../agents/share.ts";
import { autoreviewPack } from "../index.ts";
import { prOf, prsStore } from "../store.ts";
import { levelFact } from "../view.ts";
import { H, assertInert } from "../../../../../test/helpers.ts";

const PR = "https://github.com/acme/web/pull/7";
const autoPr = (o: Partial<AutoPr> = {}): AutoPr => ({ key: "acme/web#3", repo: "acme/web", number: 3, title: "Fix", pr: PR, run: "r1", cost: 1, updated: 1, ...o });
const shareOf = (prs: AutoPr[]): AutoShare => ({ prs: async () => prs, run: async () => undefined, limits: async () => ({ on: true, runUsd: 5, dayUsd: 20, minutes: 60 }), fix: async () => ({ wait: "" }), land: async () => ({ wait: "" }) });

test("prOf: owner/repo and the number from a PR's address, nothing from anything else", () => {
  assert.deepEqual(prOf(PR), { repo: "acme/web", number: 7 });
  assert.equal(prOf("https://github.com/acme/web/issues/7"), undefined);
  assert.equal(prOf("javascript:alert(1)//github.com/a/b/pull/1"), undefined);
});

test("the store: a PR added once, levels kept round by round and clamped, and a row moves only from the state it was seen in", async () => {
  const { DB } = openDb();
  let t = 100;
  const s = prsStore(DB, () => t);
  assert.equal(await s.add({ pr: PR, issue: "acme/web#3" }), true);
  assert.equal(await s.add({ pr: PR, issue: "acme/web#3" }), false, "kept already");
  assert.equal(await s.add({ pr: "not a pr", issue: "x" }), false);
  let [r] = await s.all();
  assert.deepEqual({ ...r, levels: r!.levels }, { pr: PR, repo: "acme/web", number: 7, issue: "acme/web#3", run: null, author: null, round: 0, head: null, review: null, fix: null, level: null, levels: [], cost: 0, state: "reviewing", why: null, claim: null, heard: 100, at: 100, updated: 100 });
  t = 200;
  assert.equal(await s.level(PR, "fixing", { head: "abc", level: 3 }), false, "not in that state");
  assert.equal(await s.level(PR, "reviewing", { head: "abc", level: 9, cost: 0.5 }), true);
  assert.equal(await s.move(PR, "fixing", "yours"), false);
  assert.equal(await s.move(PR, "reviewing", "fixing", { round: 1, why: "two should-fixes" }), true);
  await s.move(PR, "fixing", "reviewing");
  await s.level(PR, "reviewing", { head: "def", level: 2 });
  [r] = await s.all();
  assert.equal(r!.level, 2);
  assert.equal(r!.cost, 0.5);
  assert.deepEqual(r!.levels.map((l) => [l.round, l.head, l.level]), [[0, "abc", 5], [1, "def", 2]]);
});

test("the agents pack shares its auto runs that ended in a PR, and a run's result without its internals", async () => {
  const { DB } = openDb();
  const autos = autoStore(DB);
  await autos.put({ repo: "acme/web", number: 3, title: "Fix", state: "queued" });
  await autos.put({ repo: "acme/web", number: 4, title: "Other", state: "queued" });
  await autos.move("acme/web#3", "queued", "done", { pr: PR, run: "r1", cost: 2 });
  const desk = { run: async (id: string) => (id === "r1" ? { id, status: "done", cost: 2, model: "opus", endedAt: 5, prompt: "secret", events: [] } : undefined) } as unknown as Desk;
  const share = autoShare(DB, desk);
  assert.deepEqual((await share.prs()).map((p) => [p.key, p.pr, p.run, p.cost]), [["acme/web#3", PR, "r1", 2]]);
  assert.deepEqual(await share.run("r1"), { id: "r1", status: "done", cost: 2, model: "opus", endedAt: 5 });
  assert.equal(await share.run("gone"), undefined);
  // The agent's last word, when it has one; never its prompt or its other events.
  (desk as unknown as { run: (id: string) => Promise<unknown> }).run = async (id) => ({ id, status: "done", cost: 2, model: "opus", prompt: "secret", events: [{ t: "tool", name: "Bash" }, { t: "result", text: " Done. " }] });
  assert.deepEqual(await share.run("r1"), { id: "r1", status: "done", cost: 2, model: "opus", said: "Done." });
});

test("the pack: off without the agents pack's share, else keeps each new auto PR, says so once, and shows it on the PR's page", async () => {
  const { DB } = openDb();
  const p = autoreviewPack();
  assert.deepEqual(p.manifest.requires, ["agents"]);
  assert.deepEqual(p.writes!.map((w) => w.kind), ["review", "fix", "reply", "merge"]);
  const published: string[][] = [];
  let share: AutoShare | undefined;
  const ctx = testContext({ db: DB, publish: (t) => published.push(t), required: ((id: string, name: string) => (id === "agents" && name === "auto" ? share : undefined)) as PackContext["required"] }) as PackContext;
  await p.init!(ctx);
  await p.refresh!(ctx);
  assert.deepEqual(published, []);
  share = shareOf([autoPr()]);
  await p.refresh!(ctx);
  await p.refresh!(ctx);
  assert.deepEqual(published, [["autoreview"]], "once, when it changed");
  const facts = p.slots!(ctx)["pr.facts"]!;
  assert.deepEqual(facts({ repo: "Acme/Web", number: 7, branch: "b", title: "t", url: PR }).map(([k]) => k), ["Auto review"]);
  assert.deepEqual(facts({ repo: "acme/web", number: 8, branch: "b", title: "t", url: PR }), []);
});

test("the PR page's row: waiting for a first review, then the level, the round and the levels so far; hostile text inert", () => {
  const base = { pr: PR, repo: "acme/web", number: 7, issue: "acme/web#3", run: null, author: null, claim: null, head: null, review: null, fix: null, cost: 0, heard: 1, at: 1, updated: 1 };
  assert.equal(String(levelFact({ ...base, round: 0, level: null, levels: [], state: "reviewing", why: null })[1]), "Waiting for its first review · being reviewed");
  const out = String(levelFact({ ...base, round: 2, level: 4, levels: [1, 3, 4].map((level, round) => ({ round, head: "h", level, at: 1 })), state: "yours", why: H })[1]);
  assert.match(out, /^Level 4 of 5 · round 2 · handed to you: /);
  assert.match(out, /Levels so far: 1 → 3 → 4/);
  assertInert("level row", out);
});
