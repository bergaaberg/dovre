/** The logs' keep-for (#541): old rows of the tables nothing else ends go once a day; what's still running stays. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { createPruner, KEEP_DAYS } from "../src/prune.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (days: number) => NOW - days * DAY;

/** A row just past each table's keep-for, one just inside it, and the ones that stay whatever their age. */
function seed(db: ReturnType<typeof openDb>) {
  const run = (sql: string, ...p: (string | number | null)[]) => db.raw.prepare(sql).run(...p);
  for (const [name, at] of [
    ["old", ago(KEEP_DAYS.actions + 1)],
    ["kept", ago(KEEP_DAYS.actions - 1)],
  ] as const)
    run("INSERT INTO actions (at, kind, target, ok) VALUES (?, 'pr.merge', ?, 1)", iso(at), name);
  for (const [id, at, status] of [
    ["old", ago(KEEP_DAYS.agent_reviews + 1), "done"],
    ["kept", ago(KEEP_DAYS.agent_reviews - 1), "done"],
    ["old-running", ago(KEEP_DAYS.agent_reviews + 1), "running"],
  ] as const)
    run("INSERT INTO agent_reviews (run_id, kind, pr, head_sha, harness, status, started_at) VALUES (?, 'review', 'o/r#1', 'abc', 'claude', ?, ?)", id, status, at);
  for (const [key, at, state] of [
    ["old-done", ago(KEEP_DAYS.auto_runs + 1), "done"],
    ["old-stuck", ago(KEEP_DAYS.auto_runs + 1), "stuck"],
    ["kept-done", ago(KEEP_DAYS.auto_runs - 1), "done"],
    ["old-refused", ago(KEEP_DAYS.auto_runs + 1), "refused"],
    ["old-queued", ago(KEEP_DAYS.auto_runs + 1), "queued"],
    ["old-running", ago(KEEP_DAYS.auto_runs + 1), "running"],
  ] as const)
    run("INSERT INTO auto_runs (key, repo, number, title, state, at, updated) VALUES (?, 'o/r', 1, 't', ?, ?, ?)", key, state, at, at);
  for (const [key, at] of [
    ["old", ago(KEEP_DAYS.auto_spend + 1)],
    ["kept", ago(KEEP_DAYS.auto_spend - 1)],
  ] as const)
    run("INSERT INTO auto_spend (key, run, cost, at) VALUES (?, 'r', 1, ?)", key, at);
  for (const [id, at, state] of [
    ["old", ago(KEEP_DAYS.auto_fixes + 1), "ended"],
    ["kept", ago(KEEP_DAYS.auto_fixes - 1), "ended"],
    ["old-running", ago(KEEP_DAYS.auto_fixes + 1), "running"],
  ] as const)
    run("INSERT INTO auto_fixes (id, key, pr, state, at, updated) VALUES (?, 'o/r#1', 'o/r#2', ?, ?, ?)", id, state, at, at);
  for (const [run_, at, state] of [
    ["old", ago(KEEP_DAYS.pack_ai_calls + 1), null],
    ["kept", ago(KEEP_DAYS.pack_ai_calls - 1), null],
    ["old-done", ago(KEEP_DAYS.pack_ai_calls + 1), "done"],
    ["old-running", ago(KEEP_DAYS.pack_ai_calls + 1), "running"],
  ] as const)
    run("INSERT INTO pack_ai_calls (pack, at, cost, ok, run, state) VALUES ('p', ?, 0.1, 1, ?, ?)", iso(at), run_, state);
  for (const [key, at] of [
    ["old", ago(KEEP_DAYS.summaries + 1)],
    ["kept", ago(KEEP_DAYS.summaries - 1)],
  ] as const)
    run("INSERT INTO summaries (key, text, at) VALUES (?, 's', ?)", key, iso(at));
}

const left = (db: ReturnType<typeof openDb>, table: string, col: string) =>
  (db.raw.prepare(`SELECT ${col} AS k FROM ${table} ORDER BY ${col}`).all() as { k: string }[]).map((r) => r.k);

test("prune: rows past their keep-for go; newer ones, and whatever still runs or waits, stay", async () => {
  const db = openDb();
  seed(db);
  assert.equal(await createPruner(() => NOW).due(db.DB), true);
  assert.deepEqual(left(db, "actions", "target"), ["kept"]);
  assert.deepEqual(left(db, "agent_reviews", "run_id"), ["kept", "old-running"]);
  assert.deepEqual(left(db, "auto_runs", "key"), ["kept-done", "old-queued", "old-refused", "old-running"]);
  assert.deepEqual(left(db, "auto_spend", "key"), ["kept"]);
  assert.deepEqual(left(db, "auto_fixes", "id"), ["kept", "old-running"]);
  assert.deepEqual(left(db, "pack_ai_calls", "run"), ["kept", "old-running"]);
  assert.deepEqual(left(db, "summaries", "key"), ["kept"]);
});

test("prune: once a day between isolates: the mark is in D1, and within a day of it nothing is read", async () => {
  const db = openDb();
  let t = NOW;
  let reads = 0;
  const counting = { ...db.DB, prepare: (sql: string) => (reads++, db.DB.prepare(sql)) };
  const a = createPruner(() => t);
  assert.equal(await a.due(counting), true);
  const after = reads;
  assert.equal(await a.due(counting), false);
  assert.equal(reads, after, "the same isolate asks nothing again within the day");

  // Another isolate reads the mark and leaves it at that.
  db.raw.prepare("INSERT INTO actions (at, kind, target, ok) VALUES (?, 'k', 'late', 1)").run(iso(ago(KEEP_DAYS.actions + 5)));
  const b = createPruner(() => t);
  assert.equal(await b.due(counting), false);
  assert.deepEqual(left(db, "actions", "target"), ["late"]);

  t += DAY;
  assert.equal(await b.due(counting), true);
  assert.deepEqual(left(db, "actions", "target"), []);
});

test("prune: a database that fails is logged, never thrown, and asked again in an hour", async () => {
  let t = NOW;
  let asked = 0;
  const lines: string[] = [];
  const broken = {
    prepare: () => {
      asked++;
      throw new Error("D1_ERROR: no such table: settings");
    },
    batch: async () => [],
  };
  const p = createPruner(() => t, (l) => lines.push(l));
  assert.equal(await p.due(broken as never), false);
  assert.match(lines[0]!, /prune: couldn't drop old log rows: D1_ERROR/);
  assert.equal(await p.due(broken as never), false);
  assert.equal(asked, 1, "not again on the next tick");
  t += 3_600_000;
  await p.due(broken as never);
  assert.equal(asked, 2);
});

test("prune: the two reads that scanned use their index (#541)", () => {
  const db = openDb();
  const plan = (sql: string) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join("; ");
  assert.match(plan("SELECT * FROM actions WHERE kind = 'packs.add' ORDER BY id DESC LIMIT 50"), /USING INDEX actions_kind/);
  assert.doesNotMatch(plan("SELECT * FROM actions WHERE kind = 'packs.add' ORDER BY id DESC LIMIT 50"), /TEMP B-TREE/);
  assert.match(plan("SELECT * FROM agent_reviews WHERE started_at > 5 ORDER BY started_at DESC"), /USING INDEX agent_reviews_started/);
});
