/** The hosted cron's own gather: it waits for it, so the kept snapshot is the cron's, not the last page's. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { createWorker } from "../src/worker.ts";

const keptAt = async (DB: ReturnType<typeof openDb>["DB"]) => (await DB.prepare("SELECT at FROM settings WHERE key = 'snapshot'").first<{ at: string }>())?.at;

test("cron: an isolate that starts from a kept snapshot still waits for its gather and keeps the new one", async () => {
  const realFetch = globalThis.fetch;
  let slow = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    // GitHub takes a moment over my PRs: a gather nobody waits for isn't done when the cron returns.
    if (slow && String(init?.body ?? "").includes("mine:")) await new Promise((r) => setTimeout(r, slow));
    return new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } }));
  }) as typeof fetch;
  const w = createWorker();
  const { DB } = openDb();
  const bindings = { DB, IS_HOSTED: "1", AUTH_MODE: "passkey", ALLOWED_EMAILS: "me@x.dev", GITHUB_USER: "me", GITHUB_TOKEN: "t" };
  const cron = async () => {
    const pending: Promise<unknown>[] = [];
    await w.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, bindings as never, { waitUntil: (p: Promise<unknown>) => void pending.push(p) });
    await Promise.all(pending);
  };
  try {
    // A first isolate has nothing to draw: its cron gathers and keeps it.
    await cron();
    const first = await keptAt(DB);
    assert.ok(first, "the first cron keeps a snapshot");

    // Ten minutes on, a new isolate starts from that kept snapshot.
    const row = (await DB.prepare("SELECT value FROM settings WHERE key = 'snapshot'").first<{ value: string }>())!;
    const doc = JSON.parse(row.value) as { snap: { at: number } };
    doc.snap.at -= 10 * 60_000;
    const old = new Date(doc.snap.at).toISOString();
    await DB.prepare("UPDATE settings SET value = ?, at = ? WHERE key = 'snapshot'").bind(JSON.stringify(doc), old).run();
    await DB.prepare("DELETE FROM forge_reads").run();
    w.reset();
    slow = 60;
    const began = Date.now();
    await cron();
    const kept = await keptAt(DB);
    assert.notEqual(kept, old, "the cron's gather was kept, not left running behind it");
    assert.ok(Date.parse(kept!) >= began, `kept at ${kept}`);
  } finally {
    globalThis.fetch = realFetch;
    w.reset();
  }
});
