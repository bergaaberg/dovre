/** Agents asking for my OK, answered from any page: which runs ask, Allow (the exact calls, one click), No, back to where I was. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { agentAsksOf } from "../asks.ts";
import { agentPage } from "../session.view.ts";
import { createRunner, type Run } from "../../../../agents/runner.ts";
import { createApp } from "../../../../app.ts";
import { openDb } from "../../../../db.ts";
import { H, agentsFor, assertInert, fakeGhe, snapshot } from "../../../../../test/helpers.ts";
import { activePacks } from "../../../registry.ts";

const SID = "22222222-2222-4222-8222-222222222222";
const run = (o: Partial<Run>): Run => ({ id: "r1", harness: "claude", forked: false, cwd: "C:\\Code\\a", repo: "a", prompt: "fix it", mode: "default", model: "", allowed: [], status: "done", startedAt: 1, events: [], partial: "", cost: 0, sessionId: SID, ...o });
const denied = (spec: string, detail = spec) => ({ t: "denied" as const, tool: "Bash", spec, detail });

test("asks: an ended run with refused calls, until a later turn (or a fork of it) answers", () => {
  const ask = run({ events: [denied("Bash(dotnet test)", "dotnet test"), denied("Bash(dotnet test)", "dotnet test"), denied("Bash(git push)", "git push")] });
  assert.deepEqual(agentAsksOf([ask]).map((a) => [a.sid, a.specs, a.details]), [[SID, ["Bash(dotnet test)", "Bash(git push)"], ["dotnet test", "git push"]]]);
  assert.equal(agentAsksOf([{ ...ask, status: "running" }]).length, 0, "still working");
  assert.equal(agentAsksOf([ask, run({ id: "r2", startedAt: 2, events: [] })]).length, 0, "answered by the next turn");
  assert.equal(agentAsksOf([ask, run({ id: "r3", startedAt: 2, sessionId: "33333333-3333-4333-8333-333333333333", resumed: SID, forked: true })]).length, 0, "answered in a fork");
  assert.equal(agentAsksOf([ask], (sid) => sid === SID).length, 0, "cleared away");
  assert.equal(agentAsksOf([run({ events: [{ t: "result", text: "", cost: 0, error: false }] })]).length, 0, "nothing refused");
});

test("asks: a call refused though the turn had it allowed isn't asked again (#163)", () => {
  const stuck = denied("Bash(cd /tmp/x && sed -n 1,2p f)");
  assert.equal(agentAsksOf([run({ allowed: [stuck.spec], events: [stuck] })]).length, 0, "Allow wouldn't help");
  const both = agentAsksOf([run({ allowed: [stuck.spec], events: [stuck, denied("Bash(git status)")] })]);
  assert.deepEqual(both.map((a) => a.specs), [["Bash(git status)"]], "only the new call");
});

test("session page: an allowed call refused again says why, with no Allow for it (#163)", () => {
  const stuck = denied(`Bash(cd /tmp/x && ${H})`, `cd /tmp/x && ${H}`);
  const page = (r: Run) => { const p = agentPage({ sessionId: SID, turns: [], run: r }); return `${p.head ?? ""}${p.body}`; };
  const only = page(run({ allowed: [stuck.spec], events: [stuck] }));
  assertInert("refused again", only);
  assert.match(only, /Allowed, and refused again/);
  assert.doesNotMatch(only, /\/allow"/, "no Allow form");
  const mixed = page(run({ allowed: [stuck.spec], events: [stuck, denied("Bash(git status)")] }));
  assert.match(mixed, /Allowed, and refused again/);
  assert.match(mixed, /name="spec" value="Bash\(git status\)"/);
  assert.doesNotMatch(mixed, /name="spec" value="Bash\(cd \/tmp/, "the stuck call isn't offered");
  assert.doesNotMatch(page(run({ events: [stuck] })), /refused again/, "first refusal: just the Allow card");
});

/** A turn that says its session, then ends with `deny` refused (or nothing). */
function fakeSpawn(deny: string[]) {
  const seen: string[][] = [];
  const spawnFn = (_bin: string, args: string[]) => {
    seen.push(args);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined, kill: () => true });
    const first = seen.length === 1;
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: SID })}\n`);
      stdout.write(`${JSON.stringify({ type: "result", result: "", total_cost_usd: 0, permission_denials: first ? deny.map((command) => ({ tool_name: "Bash", tool_input: { command } })) : [] })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
  return { spawnFn, seen };
}

test("the bar on every page: Allow runs the refused calls, exactly, and comes back to the page I was on", async () => {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "a", ".git"), { recursive: true });
  const f = fakeSpawn(["dotnet test", H]);
  const runner = createRunner({ spawnFn: f.spawnFn });
  const s = snapshot();
  const gatherer = { get: async () => s, stale: () => {}, gathering: () => false, peek: () => s };
  const env = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: code, CLAUDE_DIR: join(code, "none"), DB: openDb().DB };
  const agents = agentsFor(env, { runner });
  const app = createApp(env, { gatherer, ghe: fakeGhe({}).ghe, runner, packs: { ...activePacks([agents.pack], { env: {}, hosted: false }), env: {} } });
  const get = async (p: string) => (await app.request(`http://localhost${p}`, { headers: { cookie: "u_tk=test-token" } })).text();
  const post = (p: string, body: [string, string][], referer?: string) =>
    app.request(`http://localhost${p}`, { method: "POST", headers: { cookie: "u_tk=test-token", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded", ...(referer ? { referer } : {}) }, body: new URLSearchParams(body).toString() });
  const r = runner.start({ cwd: join(code, "a"), prompt: "fix the build" });
  for (let i = 0; i < 50 && r.status === "running"; i++) await new Promise((res) => setTimeout(res, 10));
  const prs = await get("/prs");
  assertInert("bar", prs);
  assert.match(prs, /Agent in a wants to run/);
  assert.match(prs, new RegExp(`<form method="post" action="/agents/s/${SID}/allow"><input type="hidden" name="spec" value="Bash\\(dotnet test\\)">`));
  assert.doesNotMatch(await get(`/agents/s/${SID}`), /Agent in a wants to run/, "not twice on the session's own page");
  const res = await post(`/agents/s/${SID}/allow`, [["spec", "Bash(dotnet test)"], ["spec", "Bash(evil\nrm)"], ["mode", "default"], ["model", ""], ["back", "1"]], "http://localhost/prs?x=1");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/prs?x=1", "back where I was");
  const args = f.seen[1]!;
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1), ["Bash(dotnet test)"], "only the exact call; a spec with a line break is dropped");
  assert.ok(args.includes("--resume") && args.includes(SID));
  assert.ok(!args.some((a) => /bypass|dangerously/i.test(a)));
  await new Promise((r) => setTimeout(r, 40));
  assert.doesNotMatch(await get("/prs"), /wants to run/, "answered");
  const elsewhere = await post(`/agents/s/${SID}/allow`, [["spec", "Bash(x)"], ["back", "1"]], "https://evil.example/");
  assert.equal(elsewhere.headers.get("location"), `/agents/s/${SID}`, "a foreign referer isn't followed");
});
