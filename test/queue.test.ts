/** Writing to an agent while it works: the message waits, shows as queued, and goes when the turn ends (as in the terminal). */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { createQueue, joined, MAX_QUEUED } from "../src/agents/queue.ts";
import { createRunner, type Run } from "../src/agents/runner.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { appWithAgents, H, assertInert, fakeGhe, snapshot } from "./helpers.ts";

const SID = "44444444-4444-4444-8444-444444444444";
const run = (o: Partial<Run>): Run => ({ id: "r1", harness: "claude", forked: false, cwd: "x", repo: "a", prompt: "p", mode: "default", model: "", allowed: [], status: "done", startedAt: 1, events: [], partial: "", cost: 0, sessionId: SID, ...o });

test("the queue: per session, in order, ten at most, kept across a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "q-")), "queue.json");
  const changed: string[] = [];
  const q = createQueue({ file, onChange: (sid) => changed.push(sid) });
  const a = q.add(SID, { text: "first" })!;
  q.add(SID, { text: "second", mode: "plan" });
  assert.equal(q.add(SID, { text: "  " }), undefined, "nothing to say");
  assert.deepEqual(q.list(SID).map((x) => x.text), ["first", "second"]);
  assert.deepEqual(createQueue({ file }).list(SID).map((x) => x.text), ["first", "second"], "read back after a restart");
  assert.ok(q.remove(SID, a.id));
  assert.ok(!q.remove(SID, a.id));
  for (let i = 0; i < MAX_QUEUED; i++) q.add(SID, { text: `m${i}` });
  assert.equal(q.list(SID).length, MAX_QUEUED);
  assert.equal(joined(q.take(SID)).split("\n\n")[0], "second");
  assert.deepEqual(q.list(SID), []);
  assert.ok(changed.every((s) => s === SID) && changed.length > 3, "every change is news for the session's page");
});

test("a turn's end: goes when it ended well; waits after a refusal, a stop or a failure; back on the queue when the next turn can't start", async () => {
  const q = createQueue();
  const sent: string[] = [];
  let fail = false;
  q.onDrain(async (_sid, items) => {
    if (fail) throw new Error("still working");
    sent.push(joined(items));
  });
  q.add(SID, { text: "a" });
  q.ended(run({ events: [{ t: "denied", tool: "Bash", spec: "Bash(x)", detail: "x" }] }));
  q.ended(run({ status: "stopped" }));
  q.ended(run({ status: "failed" }));
  assert.deepEqual(sent, []);
  q.add(SID, { text: "b" });
  fail = true;
  q.ended(run({}));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(q.list(SID).map((x) => x.text), ["a", "b"], "nothing lost");
  fail = false;
  q.ended(run({}));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ["a\n\nb"]);
  assert.deepEqual(q.list(SID), []);
});

/** Turns that say their session and end when told to; what each was told on stdin. */
function heldSpawn() {
  const prompts: string[] = [];
  const release: (() => void)[] = [];
  const spawnFn = (_bin: string, _args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let said = "";
    stdin.on("data", (d) => (said += d));
    stdin.on("end", () => prompts.push(said));
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, pid: undefined, kill: () => true });
    setImmediate(() => stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SID })}\n`));
    release.push(() => {
      stdout.write(`${JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0 })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
  return { spawnFn, prompts, release };
}

test("the session page: write while it works, see it queued, remove one; the rest goes as the next turn", async () => {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "a", ".git"), { recursive: true });
  const f = heldSpawn();
  const queue = createQueue();
  const runner = createRunner({ spawnFn: f.spawnFn, onChange: (r) => r.status !== "running" && queue.ended(r) });
  const s = snapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const app = appWithAgents({ GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: code, CLAUDE_DIR: join(code, "none"), DB: openDb().DB }, { gatherer, ghe: fakeGhe({}).ghe, runner, queue });
  const get = async (p: string) => (await app.request(`http://localhost${p}`, { headers: { cookie: "u_tk=test-token" } })).text();
  const post = (p: string, body: [string, string][]) =>
    app.request(`http://localhost${p}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  runner.start({ cwd: join(code, "a"), prompt: "fix the build" });
  await new Promise((r) => setTimeout(r, 30));
  let page = await get(`/agents/s/${SID}`);
  assert.match(page, /placeholder="Working… write now, it goes when this turn ends"/);
  assert.match(page, /<form method="post" action="\/agents\/s\/[^"]+\/stop" id="stop-form" hidden><\/form>/);
  assert.match(page, /<div data-live id="reply">/, "the box is its own region, so the chat streams on while I type");
  for (const text of ["also run the tests", H, "and push"]) assert.equal((await post(`/agents/s/${SID}/reply`, [["prompt", text], ["mode", "default"], ["model", ""]])).status, 303);
  assert.equal(f.prompts.length, 1, "nothing sent while it works");
  page = await get(`/agents/s/${SID}`);
  assertInert("queued", page);
  assert.equal(page.match(/Queued: goes when this turn ends/g)?.length, 3);
  const id = queue.list(SID)[1]!.id;
  await post(`/agents/s/${SID}/queue/${id}/remove`, []);
  assert.deepEqual(queue.list(SID).map((x) => x.text), ["also run the tests", "and push"]);
  f.release[0]!();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.prompts.length, 2, "the next turn started by itself");
  assert.equal(f.prompts[1], "also run the tests\n\nand push");
  assert.deepEqual(queue.list(SID), []);
  assert.doesNotMatch(await get(`/agents/s/${SID}`), /Queued:/);
});
