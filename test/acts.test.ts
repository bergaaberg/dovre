import { test } from "node:test";
import assert from "node:assert/strict";
import { assignAct, commentAct, createAct, fieldInputs, statusAct, writeAct } from "../src/packs/acts.ts";
import { openDb } from "../src/db.ts";
import { HOSTILE, assertInert, testContext } from "../src/packs/testing.ts";
import type { Found } from "../src/packs/acts.ts";

type Row = { kind: string; target: string; detail: string | null; ok: number; error: string | null };

function world() {
  const { DB, raw } = openDb();
  const ctx = testContext({ db: DB, env: { KEY: "k" } });
  const log = () => raw.prepare("SELECT kind, target, detail, ok, error FROM actions ORDER BY id").all().map((r) => ({ ...r })) as Row[];
  return { ctx, log };
}

const REF = { name: "issue", about: "the issue key, e.g. ENG-123", pattern: /[A-Z]{2,5}-\d{1,6}/, normalize: (s: string) => s.trim().toUpperCase() };
const ready = (ctx: { env: Record<string, string | undefined> }) => (ctx.env.KEY ? undefined : "Set KEY.");

type Issue = Found & { assignee?: string; states?: string[] };
const issues = (): Map<string, Issue> =>
  new Map([
    ["ENG-1", { label: "ENG-1", href: "https://t.example/ENG-1", open: true, state: "Todo", states: ["Todo", "In progress", "Done"] }],
    ["ENG-2", { label: "ENG-2", open: false, state: "Done" }],
  ]);

test("commentAct: re-checks, writes, and logs the target but never the text", async () => {
  const { ctx, log } = world();
  const said: string[] = [];
  const all = issues();
  const act = commentAct<Issue>({ pack: "trk", app: "Tracker", thing: "issue", ref: REF, ready, find: async (k) => all.get(k) ?? null, comment: async (f, t) => (said.push(`${f.label}:${t}`), true) });
  assert.equal(act.kind, "comment");
  assert.deepEqual(act.fields.map((f) => f.name), ["issue", "text"]);

  assert.deepEqual(await act.run({ issue: " eng-1 ", text: "secret words" }, {}, ctx), { ok: true, done: "Commented on ENG-1", href: "https://t.example/ENG-1" });
  assert.deepEqual(said, ["ENG-1:secret words"]);
  // Closed, gone: refused and logged. Malformed: refused, not logged (nothing was tried).
  assert.equal((await act.run({ issue: "ENG-2", text: "x" }, {}, ctx)).ok, false);
  assert.deepEqual(await act.run({ issue: "ENG-9", text: "x" }, {}, ctx), { ok: false, error: "Tracker has no issue ENG-9." });
  assert.equal((await act.run({ issue: "ENG-1; drop", text: "x" }, {}, ctx)).ok, false);
  assert.equal((await act.run({ issue: "ENG-1", text: "  " }, {}, ctx)).ok, false);
  assert.deepEqual(log(), [
    { kind: "trk.comment", target: "ENG-1 comment", detail: null, ok: 1, error: null },
    { kind: "trk.comment", target: "ENG-2 comment", detail: null, ok: 0, error: "Done" },
    { kind: "trk.comment", target: "ENG-9 comment", detail: null, ok: 0, error: "no such issue" },
  ]);
  assert.ok(!JSON.stringify(log()).includes("secret"));
  assert.equal(said.length, 1);
});

test("writeAct: not set up stops before anything; a throw is logged and not done", async () => {
  const { ctx, log } = world();
  const act = writeAct<string>({
    pack: "p", kind: "poke", title: "A poke", when: "w", fields: [{ name: "who", about: "who" }], button: "Poke",
    ready, read: (f) => (f.who ? { target: f.who, value: f.who } : "Give someone."),
    write: async () => { throw new Error("boom"); },
  });
  assert.deepEqual(await act.run({ who: "kari" }, {}, testContext({ db: ctx.db })), { ok: false, error: "Set KEY." });
  assert.deepEqual(await act.run({}, {}, ctx), { ok: false, error: "Give someone." });
  assert.deepEqual(await act.run({ who: "kari" }, {}, ctx), { ok: false, error: "boom" });
  assert.deepEqual(log(), [{ kind: "p.poke", target: "kari", detail: null, ok: 0, error: "boom" }]);
  assert.equal(act.oneClick, undefined); // asks twice unless the pack says so
});

test("createAct: an unknown place is refused; the title is the log's detail, the description isn't", async () => {
  const { ctx, log } = world();
  const act = createAct({
    pack: "trk", app: "Tracker", thing: "issue", ready,
    where: { name: "team", about: "the team key, e.g. ENG", pattern: /[A-Z]{2,5}/, normalize: (s) => s.trim().toUpperCase() },
    create: async (where, title) => (where === "ENG" ? { label: "ENG-7", href: "/trk/ENG-7" } : title === "app says no" ? { refuse: "Quota." } : null),
  });
  assert.deepEqual(await act.run({ team: "eng", title: "Fix it", description: "private body" }, {}, ctx), { ok: true, done: "Created ENG-7", href: "/trk/ENG-7" });
  assert.deepEqual(await act.run({ team: "OPS", title: "Fix it" }, {}, ctx), { ok: false, error: 'Tracker has no team "OPS".' });
  assert.deepEqual(await act.run({ team: "OPS", title: "app says no" }, {}, ctx), { ok: false, error: "Quota." });
  assert.deepEqual(log().map((r) => [r.target, r.detail, r.ok, r.error]), [
    ["ENG issue", "Fix it", 1, null],
    ["OPS issue", null, 0, "no such team"],
    ["OPS issue", null, 0, "Quota."],
  ]);
});

test("assignAct: me by default, and not again to whoever has it", async () => {
  const { ctx } = world();
  const all = issues();
  const got: string[] = [];
  const act = assignAct<Issue>({ pack: "trk", app: "Tracker", thing: "issue", ref: REF, find: async (k) => all.get(k) ?? null, assign: async (f, who) => ((all.get(f.label)!.assignee = who), got.push(who), true) });
  assert.deepEqual(await act.run({ issue: "ENG-1" }, {}, ctx), { ok: true, done: "Assigned ENG-1 to me", href: "https://t.example/ENG-1" });
  assert.deepEqual(await act.run({ issue: "ENG-1", to: "ME" }, {}, ctx), { ok: false, error: "ENG-1 is already yours." });
  assert.equal((await act.run({ issue: "ENG-2", to: "kari" }, {}, ctx)).ok, false); // done: let it be
  assert.deepEqual(got, ["me"]);
});

test("statusAct: only to a status it can move to, matched as the app spells it", async () => {
  const { ctx } = world();
  const all = issues();
  const moved: string[] = [];
  const act = statusAct<Issue>({ pack: "trk", app: "Tracker", thing: "issue", ref: REF, find: async (k) => all.get(k) ?? null, setStatus: async (f, s) => (moved.push(`${f.label}:${s}`), true) });
  assert.deepEqual(await act.run({ issue: "ENG-1", status: "in PROGRESS" }, {}, ctx), { ok: true, done: "Moved ENG-1 to In progress", href: "https://t.example/ENG-1" });
  assert.equal((await act.run({ issue: "ENG-1", status: "todo" }, {}, ctx)).ok, false);
  assert.match(String((await act.run({ issue: "ENG-1", status: "Shipped" }, {}, ctx) as { error: string }).error), /can move to: Todo, In progress, Done/);
  // A done one may be reopened: it has no list, so any status goes to the app.
  assert.equal((await act.run({ issue: "ENG-2", status: "Todo" }, {}, ctx)).ok, true);
  assert.deepEqual(moved, ["ENG-1:In progress", "ENG-2:Todo"]);
});

test("fieldInputs: a box per field, kept text first, hostile values inert", () => {
  const fields = [{ name: "issue", about: HOSTILE, required: true }, { name: "text", about: "the comment", text: true, max: 4000 }];
  const out = String(fieldInputs(fields, { issue: HOSTILE, text: HOSTILE }));
  assertInert("fieldInputs", out);
  assert.match(out, /<input type="text" name="issue"[^>]* required>/);
  assert.match(out, /<textarea name="text" rows="5" maxlength="4000"/);
  assert.match(String(fieldInputs(fields, { issue: "ENG-1" }, { issue: "ENG-2" })), /value="ENG-2"/);
  const act = commentAct({ pack: "trk", app: "Tracker", thing: "issue", ref: REF, find: async () => null, comment: async () => true });
  assert.match(String(act.inputs({ issue: "ENG-1", text: "hi" }, undefined, testContext())), /name="text"/);
});
