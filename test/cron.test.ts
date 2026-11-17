/** The hosted cron's own gather: it waits for it, so the kept snapshot is the cron's, not the last page's. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { hostedLookups } from "../src/hosted/lookups.ts";
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

test("cron: where people have their own snapshots, the cron's packs still read the instance's", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => (String(url).endsWith("/user") ? new Response(JSON.stringify({ login: "me" })) : new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } })))) as typeof fetch;
  const seen: string[] = [];
  const probe: Pack = {
    manifest: { api: PACK_API, id: "probe", name: "Probe", description: "Says what the cron sees", domain: "work", execution: "any" },
    scheduled: async (_e, c) => void seen.push(`snapshot ${c.snapshot()?.login} forge ${c.forge()?.login} viewer ${c.viewer()}`),
  };
  // A provider tells people's tokens apart, so each person may get a snapshot of their own (#538).
  const w = createWorker({ packs: [probe], githubToken: async () => "t" });
  const { DB } = openDb();
  const bindings = { DB, IS_HOSTED: "1", AUTH_MODE: "passkey", ALLOWED_EMAILS: "me@x.dev", GITHUB_USER: "me" };
  const cron = async () => {
    const pending: Promise<unknown>[] = [];
    await w.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, bindings as never, { waitUntil: (p: Promise<unknown>) => void pending.push(p) });
    await Promise.all(pending);
  };
  try {
    // The first cron gathers; the second runs its packs with that snapshot, though no page of the
    // owner's was ever drawn in this isolate.
    await cron();
    await cron();
    assert.equal(seen[1], "snapshot me forge me viewer me@x.dev");
    // And a new isolate's first cron draws the kept one.
    w.reset();
    seen.length = 0;
    await cron();
    assert.equal(seen[0], "snapshot me forge me viewer me@x.dev");
  } finally {
    globalThis.fetch = realFetch;
    w.reset();
  }
});

test("hosted Bino's lookups run as whom the answer is for (#544), and as no one when the object names nobody", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => (String(url).endsWith("/user") ? new Response(JSON.stringify({ login: "me" })) : new Response(JSON.stringify({ data: { mine: { nodes: [] }, review: { nodes: [] } } })))) as typeof fetch;
  const probe: Pack = {
    manifest: { api: PACK_API, id: "probe", name: "Probe", description: "Says whom a lookup is for", domain: "work", execution: "any" },
    lookups: (c) => [{ kind: "who", when: "When asked.", fields: [], run: () => `viewer ${c.viewer()}` }],
  };
  createWorker({ packs: [probe], githubToken: async () => "t" });
  const { DB } = openDb();
  const bindings = { DB, IS_HOSTED: "1", AUTH_MODE: "passkey", ALLOWED_EMAILS: "me@x.dev,two@x.dev", GITHUB_USER: "me" };
  try {
    const l = await hostedLookups(bindings);
    const kind = (await l.specs()).find((s) => s.kind.endsWith("who"))!.kind;
    assert.equal((await l.run({ kind, args: {}, who: "Two@X.dev" })).text, "viewer two@x.dev");
    assert.equal((await l.run({ kind, args: {} })).text, "viewer undefined");
  } finally {
    globalThis.fetch = realFetch;
  }
});
