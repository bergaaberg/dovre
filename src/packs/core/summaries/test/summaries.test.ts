/** AI summaries as a pack (#390): what it queues from a snapshot, what it keeps, and the summary on a PR card. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../../../db.ts";
import { deploySummaryKey, prSummaryKey } from "../../../../gather.ts";
import type { Changelog } from "../../../../sources/changelog.ts";
import { H, assertInert, pr, signedIn, snapshot } from "../../../../../test/helpers.ts";
import { createSummaries } from "../store.ts";
import { summariesPack, wantAll } from "../index.ts";

const change = { kind: "feature", title: "Ny side", author: "per", text: "Ny side", sha: "abc1234" } as Changelog["changes"][number];
const changelog = (changes: Changelog["changes"]): Changelog => ({ repo: "ACME/people", env: "prod", head: "bbb", prodSha: "aaa", prodAt: new Date(Date.now() - 3 * 86400e3).toISOString(), changes, commits: changes.length, additions: 1, deletions: 0, files: 1, compareUrl: "https://acme.ghe.com/x" }) as Changelog;

test("it queues every open PR at its head commit and every deploy that ships something, once each", async () => {
  const db = openDb();
  const asked: string[] = [];
  const sum = createSummaries(db.DB, async ({ user }) => (asked.push(user), { text: "Kort.", cost: 0 }));
  const mine = pr({ number: 3, title: "Mine" });
  const s = snapshot({
    prs: { ok: true, value: { mine: [mine, pr({ number: 4, headSha: "" })], review: [pr({ number: 5, title: "Theirs" })] } },
    changelogs: new Map([
      [1, { ok: true, value: changelog([change]) }],
      [2, { ok: true, value: { ...changelog([]), head: "ccc" } }],
    ]),
  });
  wantAll(sum, s, Date.now());
  wantAll(sum, s, Date.now());
  await sum.idle();
  assert.equal(asked.length, 3, "two PRs with a head commit and the deploy that ships something; the second pass asks nothing");
  assert.match(asked.find((u) => u.includes("#3"))!, /Title: Mine/);
  assert.match(asked.find((u) => u.includes("deploy"))!, /last 3 days[^]*\[feature\] Ny side \(per\)/);
  assert.deepEqual(sum.get(prSummaryKey(mine)), { state: "ready", text: "Kort." });
  assert.deepEqual(sum.get(deploySummaryKey(changelog([change]))), { state: "ready", text: "Kort." });
  // Kept: a restart reads it back.
  const again = createSummaries(db.DB, async () => assert.fail("not asked again"));
  await again.load();
  assert.deepEqual(again.get(prSummaryKey(mine)), { state: "ready", text: "Kort." });
});

test("a failed summary says so, and isn't asked again", async () => {
  let n = 0;
  const sum = createSummaries(openDb().DB, async () => (n++, Promise.reject(new Error("quota"))));
  sum.want("k", () => ({ system: "", user: "" }));
  await sum.idle();
  sum.want("k", () => ({ system: "", user: "" }));
  await sum.idle();
  assert.deepEqual([sum.get("k"), n], [{ state: "failed", error: "quota" }, 1]);
});

test("without a model here it doesn't run; with one, a PR card shows its summary, escaped", async () => {
  assert.equal(summariesPack({}).available!({} as never), false);
  const p = pr({ number: 7, title: "Seven" });
  const pack = summariesPack({ complete: async () => ({ text: "x", cost: 0 }) });
  assert.equal(pack.available!({} as never), true);
  const { get, db } = signedIn(snapshot({ prs: { ok: true, value: { mine: [p], review: [] } } }), {}, { packs: [pack] });
  await db.DB.prepare("INSERT INTO summaries (key, text, error, cost, at) VALUES (?, ?, NULL, 0, ?)").bind(prSummaryKey(p), `Fixes ${H}`, new Date().toISOString()).run();
  const page = await (await get("/prs")).text();
  assertInert("summaries", page);
  assert.match(page, /class="clamp ai-clamp">Fixes /);
  assert.match(page, /<p class="ai"><span class="spark">Summary<\/span>Fixes /);
});

test("with the pack off, a PR shows no summary line at all", async () => {
  const { get } = signedIn(snapshot({ prs: { ok: true, value: { mine: [pr({ title: "Mine" })], review: [] } } }), {}, { packs: [summariesPack({ complete: async () => ({ text: "x", cost: 0 }) })], packEnv: { PACK_SUMMARIES: "off" } });
  assert.doesNotMatch(await (await get("/prs")).text(), /No summary|Writing a summary|class="ai/);
});
