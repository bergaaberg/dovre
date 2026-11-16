/** Auto review (#326): its PRs kept from the agents pack's share, their levels, and the PR page's row. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { openDb } from "../../../../db.ts";
import { autoStore } from "../../../../agents/auto.ts";
import type { Desk } from "../../../../agents/desk.ts";
import { testContext } from "../../../testing.ts";
import type { PackContext } from "../../../types.ts";
import type { AutoPr, AutoShare } from "../../agents/share.ts";
import { autoOf, autoShare } from "../../agents/share.ts";
import { autoreviewPack } from "../index.ts";
import { prOf, prsStore } from "../store.ts";
import { type Finding, findingsStore } from "../findings.ts";
import { DECIDE_HREF, findingsFact, levelFact } from "../view.ts";
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
  assert.deepEqual({ ...r, levels: r!.levels }, { pr: PR, repo: "acme/web", number: 7, issue: "acme/web#3", run: null, author: null, round: 0, head: null, review: null, fix: null, level: null, levels: [], cost: 0, state: "reviewing", why: null, claim: null, heard: 100, at: 100, updated: 100, base: null });
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
  assert.deepEqual(p.writes!.map((w) => w.kind), ["review", "fix", "reply", "merge", "decide"]);
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
  const base = { pr: PR, repo: "acme/web", number: 7, issue: "acme/web#3", run: null, author: null, claim: null, head: null, review: null, fix: null, base: null, cost: 0, heard: 1, at: 1, updated: 1 };
  assert.equal(String(levelFact({ ...base, round: 0, level: null, levels: [], state: "reviewing", why: null })[1]), "Waiting for its first review · being reviewed");
  const out = String(levelFact({ ...base, round: 2, level: 4, levels: [1, 3, 4].map((level, round) => ({ round, head: "h", level, at: 1 })), state: "yours", why: H })[1]);
  assert.match(out, /^Level 4 of 5 · round 2 · handed to you: /);
  assert.match(out, /Levels so far: 1 → 3 → 4/);
  assertInert("level row", out);
});

test("autoOf: the agents pack's own share, narrowed; anything else under that name is nothing (#478)", () => {
  const share = shareOf([]);
  const asked: string[] = [];
  const ctxWith = (got: unknown) => ({ required: ((id: string, name: string) => (asked.push(`${id}/${name}`), got)) as PackContext["required"] });
  assert.equal(autoOf(ctxWith(share)), share);
  assert.deepEqual(asked, ["agents/auto"]);
  for (const off of [undefined, null, "auto", 5, {}, { ...share, land: "soon" }, { prs: share.prs }]) assert.equal(autoOf(ctxWith(off)), undefined);
});

test("the PR page's findings: the ones holding the PR back first, what I can say about each, how many are fixed; no buttons once the PR has left the loop; hostile text inert", () => {
  const f = (o: Partial<Finding>): Finding => ({ id: "0123456789ab", pr: PR, round: 0, head: "h", severity: "low", tags: ["clarity"], path: "src/a.ts", line: 2, side: "RIGHT", title: "Vague name", body: "b", fix: "", status: "open", review: 99, comment: 501, raised: 1, at: 1, updated: 1, ...o });
  const list = [f({}), f({ id: "aaaaaaaaaaaa", severity: "high", title: H, path: H, line: 9, startLine: 4, raised: 2 }), f({ id: "bbbbbbbbbbbb", status: "force-ignore", title: "Ignored one" }), f({ id: "cccccccccccc", status: "fixed" }), f({ id: "dddddddddddd", status: "force-fix", title: "Asked for" })];
  const [label, body] = findingsFact(list, { repo: "acme/web", number: 7, live: true, flash: { ok: true, message: H } })!;
  const out = String(body);
  assert.equal(label, "Findings");
  assertInert("findings row", out);
  assert.ok(out.indexOf("holds the PR back") < out.indexOf("Vague name"), "what holds it back comes first");
  assert.match(out, /:4-9 · open, holds the PR back · raised by 2 reviews/);
  assert.match(out, /you said fix it, holds the PR back/);
  assert.match(out, /1 fixed\./);
  const posts = [...out.matchAll(/name="id" value="([0-9a-f]{12})"><input type="hidden" name="to" value="([a-z-]+)"/g)].map((m) => `${m[1]!.slice(0, 2)}:${m[2]}`);
  assert.deepEqual(posts.sort(), ["01:force-fix", "01:force-ignore", "aa:force-ignore", "bb:open", "dd:open"], "a finding already holding it back needs no Fix it; a decided one can be undone; a fixed one takes nothing");
  assert.ok(out.includes(`action="${DECIDE_HREF}"`));
  assert.doesNotMatch(String(findingsFact(list, { repo: "acme/web", number: 7, live: false })![1]), /<form/);
  assert.equal(findingsFact([], { repo: "acme/web", number: 7, live: true }), undefined);
  assert.equal(String(findingsFact([f({ status: "fixed" })], { repo: "acme/web", number: 7, live: true })![1]), "1 fixed, none standing.");
});

test("the pack's route: my word on a finding of a kept PR is taken, logged and shown on its page; anything else is refused", async () => {
  const { DB } = openDb();
  const p = autoreviewPack({ github: { ghe: {} as never, owners: () => "acme" } });
  const ctx = testContext({ db: DB, required: (() => undefined) as PackContext["required"] }, { id: "autoreview" }) as PackContext;
  const store = prsStore(DB);
  await store.add({ pr: PR, issue: "acme/web#3", run: "r1" });
  await store.level(PR, "reviewing", { head: "sha1", level: 4, base: 4, review: 99 });
  await store.move(PR, "reviewing", "yours");
  await findingsStore(DB).reported(PR, { round: 0, head: "sha1", review: 99 }, [{ id: "0123456789ab", severity: "low", tags: ["clarity"], path: "src/a.ts", line: 2, side: "RIGHT", title: "Vague name", body: "b", fix: "" }]);
  await p.init!(ctx);
  const app = new Hono();
  p.routes!(app as never, ctx);
  const post = (fields: Record<string, string>) => app.request(DECIDE_HREF, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });
  for (const bad of [{ repo: "evil/web", number: "7", id: "0123456789ab", to: "force-fix" }, { repo: "acme/web", number: "8", id: "0123456789ab", to: "force-fix" }, { repo: "acme/web", number: "7", id: "nope", to: "force-fix" }, { repo: "acme/web", number: "7", id: "0123456789ab", to: "fixed" }])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await findingsStore(DB).of(PR))[0]!.status, "open");

  const res = await post({ repo: "acme/web", number: "7", id: "0123456789ab", to: "force-fix" });
  assert.deepEqual([res.status, res.headers.get("location")], [303, "/prs/acme/web/7"]);
  assert.equal((await findingsStore(DB).of(PR))[0]!.status, "force-fix");
  assert.equal((await store.all())[0]!.state, "fixing");
  const log = await DB.prepare("SELECT kind, target, detail, ok FROM actions").all<Record<string, unknown>>();
  assert.deepEqual(log.results.map((x) => ({ ...x })), [{ kind: "autoreview.decide", target: "acme/web#7", detail: "to be fixed: the low finding on src/a.ts:2", ok: 1 }]);
  const facts = p.slots!(ctx)["pr.facts"]!({ repo: "acme/web", number: 7, branch: "b", title: "t", url: PR });
  assert.deepEqual(facts.map(([k]) => k), ["Auto review", "Findings"]);
  assert.match(String(facts[1]![1]), /Finding to be fixed\. Fix round 1 starts for it\./);
  assert.match(String(facts[1]![1]), /you said fix it, holds the PR back/);
});
