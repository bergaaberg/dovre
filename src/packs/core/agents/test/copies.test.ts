/** Replying to a session a terminal has open: a copy, told it's one, shown as one; and the calls a turn was refused, allowed together. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { COPY_NOTE, allowedPrompt, dovreParts } from "../../../../agents/conversation.ts";
import { localDesk } from "../../../../agents/desk.ts";
import { createQueue } from "../../../../agents/queue.ts";
import { createRunner, type Run } from "../../../../agents/runner.ts";
import { agentPage } from "../session.view.ts";
import type { Session } from "../../../../sources/claude.ts";
import { H, assertInert } from "../../../../../test/helpers.ts";

/** A page for ctx.page, as text: its head and body. */
const bodyOf = (p: { head?: unknown; body: unknown }) => `${p.head ?? ""}${p.body}`;

const ORIG = "11111111-1111-4111-8111-111111111111";
const COPY = "44444444-4444-4444-8444-444444444444";

/** Turns that say their session (the copy's when forked), then hang until `end()` (or end at once). */
function fakeSpawn(o: { hang?: boolean; deny?: string[] } = {}) {
  const seen: { args: string[]; stdin: string }[] = [];
  const ends: (() => void)[] = [];
  const spawnFn = (_bin: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const rec = { args, stdin: "" };
    seen.push(rec);
    stdin.on("data", (b) => (rec.stdin += String(b)));
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin, pid: undefined, kill: () => true });
    const sid = args.includes("--fork-session") ? COPY : (args[args.indexOf("--resume") + 1] ?? ORIG);
    const end = () => {
      stdout.write(`${JSON.stringify({ type: "result", result: "", total_cost_usd: 0, permission_denials: (o.deny ?? []).map((command) => ({ tool_name: "Bash", tool_input: { command } })) })}\n`);
      stdout.end();
      setImmediate(() => child.emit("close", 0));
    };
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sid })}\n`);
      if (o.hang) ends.push(end);
      else end();
    });
    return child;
  };
  return { spawnFn, seen, endAll: () => ends.splice(0).forEach((e) => e()) };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup(f: ReturnType<typeof fakeSpawn>) {
  const code = mkdtempSync(join(tmpdir(), "code-"));
  mkdirSync(join(code, "a", ".git"), { recursive: true });
  const runner = createRunner({ spawnFn: f.spawnFn });
  // The original is open in a terminal.
  const terminal: Session = { sessionId: ORIG, live: true, kind: "interactive", cwd: join(code, "a"), repo: "a" } as Session;
  const desk = localDesk({ env: { CODE_DIR: code, CLAUDE_DIR: join(code, "none") }, runner, queue: createQueue(), sessions: async () => ({ live: [terminal], recent: [] }) });
  return { desk, runner };
}

test("a reply to a session open in a terminal starts a copy that's told it's one; the original lists it, and doesn't take its run as its own", async () => {
  const f = fakeSpawn({ hang: true });
  const { desk, runner } = setup(f);
  const before = await desk.session(ORIG);
  assert.equal(before?.replyCopies, true, "a reply goes to a copy");
  const done = await desk.reply(ORIG, { prompt: "from my phone" });
  assert.equal(done.flash, undefined);
  assert.ok(f.seen[0]!.args.includes("--fork-session"));
  assert.equal(f.seen[0]!.stdin, `${COPY_NOTE}\n\nfrom my phone`, "the copy is told it's a copy");
  const run = runner.copiesOf(ORIG)[0]!;
  assert.equal(run.prompt, "from my phone", "lists show what I wrote, not the note");
  await tick();
  const orig = await desk.session(ORIG);
  assert.equal(orig?.run, undefined, "the copy's run isn't the original's");
  assert.deepEqual(orig?.copies?.map((c) => [c.sid, c.status]), [[COPY, "running"]]);
  const copy = await desk.session(COPY);
  assert.equal(copy?.copyOf, ORIG);
  assert.equal(copy?.replyCopies, false, "the copy is the desk's own turn, not a terminal");
  const again = await desk.reply(ORIG, { prompt: "and again" });
  assert.match(again.flash ?? "", /copy made from here is still working/, "not a second copy beside a working one");
  assert.equal(f.seen.length, 1);
  f.endAll();
  await tick();
});

test("Dovre's notes read back from a transcript: a copy started, the calls allowed, and what I wrote besides", () => {
  const specs = ["Bash(tail -5 x.log; launchctl print gui/502/x)", "Bash(git status)"];
  assert.deepEqual(dovreParts(`${COPY_NOTE}\n\nfrom my phone`), { copy: true, rest: "from my phone" });
  assert.deepEqual(dovreParts(allowedPrompt(specs)), { copy: false, allowed: specs, rest: "" });
  assert.deepEqual(dovreParts(`${allowedPrompt(specs)}\n\nqueued while it worked`), { copy: false, allowed: specs, rest: "queued while it worked" });
  // The wording before this change.
  assert.deepEqual(dovreParts("I've allowed `Bash(ls)` for this turn. Go on with what you were doing."), { copy: false, allowed: ["Bash(ls)"], rest: "" });
  assert.deepEqual(dovreParts("I've allowed myself a coffee"), { copy: false, rest: "I've allowed myself a coffee" });
});

test("the calls a turn was refused are one card: each ticked, allowed together, the same call once, hostile text inert", () => {
  const denied = (spec: string, detail = spec) => ({ t: "denied" as const, tool: "Bash", spec, detail });
  const run: Run = { id: "r1", harness: "claude", forked: false, cwd: "/c/a", repo: "a", prompt: "go", mode: "default", model: "", allowed: [], status: "done", startedAt: 1, events: [denied("Bash(tail -5 x)"), denied(`Bash(${H})`, H), denied("Bash(tail -5 x)")], partial: "", cost: 0, sessionId: ORIG };
  const out = bodyOf(agentPage({ sessionId: ORIG, turns: [{ role: "user", text: allowedPrompt(["Bash(ls)"]) }, { role: "user", text: `${COPY_NOTE}\n\n${H}` }], run }));
  assertInert("agent page", out);
  const forms = out.match(new RegExp(`<form method="post" action="/agents/s/${ORIG}/allow"`, "g")) ?? [];
  assert.equal(forms.length, 1, "one form for every refused call");
  assert.equal((out.match(/<input type="checkbox" name="spec" value="Bash\(tail -5 x\)" checked>/g) ?? []).length, 1, "the same call once");
  assert.match(out, /Wants to run 2 calls/);
  assert.match(out, /Allow ticked and go on/);
  assert.match(out, /You allowed <code>Bash\(ls\)<\/code>/, "an allow reads as a line, not my bubble");
  assert.match(out, /Copy started here/);
  assert.doesNotMatch(out, /This is a copy of a session/, "the note to the agent isn't shown as mine");
});
