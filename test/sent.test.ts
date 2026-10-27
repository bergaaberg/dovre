/**
 * What Dovre sends (#145): calls home are recorded with names and sizes, never values; the bridge's
 * file keeps 30 days; and no call to Dovre's own services skips the record.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jwtHeaders } from "../src/bridge/creds.ts";
import { fileLedger, prune, readSent, sentFiles } from "../src/bridge/sentfile.ts";
import { CATALOG, DAY_MS, fieldsOf, type Ledger, lineOf, parseLines, recorded, recordOf, type SentCall, tally } from "../src/sent.ts";

const root = join(import.meta.dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const arrayLedger = () => {
  const calls: Omit<SentCall, "k">[] = [];
  const frames: [string, string, number][] = [];
  const ledger: Ledger = { call: (c) => void calls.push(c), frame: (h, k, b) => void frames.push([h, k, b]) };
  return { calls, frames, ledger };
};

test("fieldsOf: a JSON body's top-level names, sorted; never a value, and nothing for anything else", () => {
  assert.deepEqual(fieldsOf(JSON.stringify({ refresh_token: "r-secret", grant_type: "refresh_token" })), ["grant_type", "refresh_token"]);
  assert.deepEqual(fieldsOf(JSON.stringify({ "<script>": 1, ok: 2 })), ["ok"], "odd names left out");
  for (const odd of [undefined, "", "not json", "[1,2]", "null", '"text"']) assert.deepEqual(fieldsOf(odd), [], String(odd));
});

test("recorded: each call with its host, path, purpose, size and answer; a failed one too, and the error still thrown", async () => {
  const { calls, ledger } = arrayLedger();
  const ok = recorded(ledger, "bridge.token", async () => ({ status: 200 }));
  await ok("https://dovre.dev/bridge/token?x=1", { method: "post", body: JSON.stringify({ refresh_token: "r-secret" }) });
  assert.equal(calls.length, 1);
  const { at, ...rest } = calls[0]!;
  assert.ok(at > 0);
  assert.deepEqual(rest, { host: "dovre.dev", path: "/bridge/token", method: "POST", purpose: "bridge.token", bytes: 28, fields: ["refresh_token"], status: 200 });
  assert.doesNotMatch(JSON.stringify(calls), /r-secret|x=1/, "no values, no query");

  const down = recorded(ledger, "bridge.token", async () => {
    throw new Error("offline");
  });
  await assert.rejects(down("https://dovre.dev/bridge/token", { method: "POST" }), /offline/);
  assert.equal(calls[1]!.status, undefined);
});

test("the bridge's token refresh is recorded: grant_type and refresh_token named, the token itself never", async () => {
  const { calls, ledger } = arrayLedger();
  const creds = { server: "https://dovre.dev", handle: "alice", machine: "m1a2b3c4d5e6f7a8", name: "laptop", hub: "wss://alice.dovre.dev/bridge", frame_key: "f".repeat(64), refresh_token: "r0-secret" };
  const next = jwtHeaders({ creds, save: () => {}, ledger, fetch: async () => ({ status: 200, json: async () => ({ access_token: "jwt", expires_in: 600, refresh_token: "r1" }) }) });
  await next();
  assert.deepEqual(calls.map((c) => [c.purpose, c.host, c.path, c.fields, c.status]), [["bridge.token", "dovre.dev", "/bridge/token", ["grant_type", "refresh_token"], 200]]);
  assert.doesNotMatch(JSON.stringify(calls), /r0-secret/);
});

test("tally and recordOf: frames summed per hour, then per day; calls newest first; past 30 days, gone", () => {
  const t = tally();
  const now = Date.UTC(2026, 9, 27, 12);
  t.add("a.dovre.dev", "state", 100, now);
  t.add("a.dovre.dev", "state", 50, now + 60_000);
  t.add("a.dovre.dev", "state", 10, now + 3600_000);
  t.add("a.dovre.dev", "ping", 4, now);
  const lines = t.take();
  assert.equal(lines.length, 3, "one line an hour a kind");
  assert.equal(t.size(), 0);
  const old: SentCall = { k: "call", at: now - 31 * DAY_MS, host: "dovre.dev", path: "/bridge/token", method: "POST", purpose: "bridge.token", bytes: 1, fields: [] };
  const recent = { ...old, at: now - 1000 };
  const newer = { ...old, at: now };
  const r = recordOf([...lines, old, recent, newer, { k: "frames", hour: now - 40 * DAY_MS, host: "x", kind: "state", count: 9, bytes: 9 }], now + 2 * 3600_000);
  assert.deepEqual(r.calls.map((c) => c.at), [now, now - 1000]);
  assert.deepEqual(r.frames.map((f) => [f.kind, f.count, f.bytes]), [["ping", 1, 4], ["state", 3, 160]]);
});

test("lineOf: only well-formed lines count; anything else in the file is skipped", () => {
  assert.equal(lineOf({ k: "call", at: 1, host: "h", path: "/p", method: "POST", purpose: "x", bytes: 1, fields: ["a", "<b>"] })?.k, "call");
  assert.deepEqual((lineOf({ k: "call", at: 1, host: "h", path: "/p", method: "POST", purpose: "x", bytes: 1, fields: ["a", "<b>"] }) as SentCall).fields, ["a"]);
  for (const odd of [null, 1, {}, { k: "call", at: -1 }, { k: "frames", hour: 1, host: "h", kind: "<x>", count: 1, bytes: 1 }, { k: "other" }]) assert.equal(lineOf(odd), undefined, JSON.stringify(odd));
  assert.equal(parseLines('{"k":"frames","hour":1,"host":"h","kind":"state","count":1,"bytes":2}\nnot json\n\n{"k":"x"}\n').length, 1);
});

test("the bridge's file: owner-only, calls at once, frames on flush and stop; a reader sums repeated hours; old lines pruned on start", () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-sent-"));
  const file = join(dir, "sent.jsonl");
  const now = Date.now();
  const l = fileLedger(file, { flushMs: 60 * 60_000 });
  l.call({ at: now, host: "dovre.dev", path: "/bridge/token", method: "POST", purpose: "bridge.token", bytes: 3, fields: ["grant_type"], status: 200 });
  l.frame("a.dovre.dev", "state", 100, now);
  assert.equal(readSent(file).length, 1, "frames wait for a flush");
  l.flush();
  l.frame("a.dovre.dev", "state", 20, now);
  l.stop();
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const r = recordOf(readSent(file), now);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.frames.map((f) => [f.kind, f.count, f.bytes]), [["state", 2, 120]], "two lines for one hour, summed");

  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ k: "call", at: now - 40 * DAY_MS, host: "h", path: "/", method: "GET", purpose: "old", bytes: 0, fields: [] }) + "\nnot json\n");
  prune(file, now);
  assert.deepEqual(readSent(file).map((x) => x.k).sort(), ["call", "frames", "frames"], "the old call and the bad line are gone");
  assert.equal(readSent(join(dir, "none.jsonl")).length, 0);
});

test("sentFiles: where the launcher keeps a bridge's record, on each platform, then a checkout's", () => {
  assert.equal(sentFiles({ env: {}, home: "/Users/a", platform: "darwin", checkout: "/c" })[0], join("/Users/a", "Library", "Application Support", "dovre", "bridge-data", "sent.jsonl"));
  assert.equal(sentFiles({ env: { DOVRE_BRIDGE_HOME: "/x" }, home: "/h", platform: "linux", checkout: "/c" })[0], join("/x", "bridge-data", "sent.jsonl"));
  assert.equal(sentFiles({ env: {}, home: "/h", platform: "linux", checkout: "/c" })[0], join("/h", ".config", "dovre", "bridge-data", "sent.jsonl"));
  assert.equal(sentFiles({ env: {}, home: "/h", platform: "linux", checkout: "/c" })[1], join("/c", "data", "bridge", "sent.jsonl"));
});

// ── The guarantee: no call home skips the record ──

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l, i) => ({ n: i + 1, l: l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, "") }));

test("guard: in the bridge, every fetch and socket goes through the record (src/sent.ts)", () => {
  const raw = sources(join(root, "src", "bridge")).flatMap((file) =>
    code(file)
      .filter(({ l }) => /(^|[^.\w])fetch\(|new WebSocket\(/.test(l) && !/\brecorded(Dial)?\(/.test(l))
      .map(({ n, l }) => `${file.slice(root.length + 1)}:${n}: ${l.trim()}`),
  );
  assert.deepEqual(raw, [], "a call home that isn't recorded");
});

test("guard: Dovre's own hosts appear in code only where they're links, the catalog, or a header that names Dovre", () => {
  const allowed = new Set(["src/sent.ts", "src/demo/worker.ts", "src/packs/core/assistant/bino/gateway.ts"]);
  const hits = sources(join(root, "src")).flatMap((file) => {
    const rel = file.slice(root.length + 1);
    if (allowed.has(rel)) return [];
    return code(file)
      .filter(({ l }) => /dovre\.dev\b/.test(l))
      .map(({ n, l }) => `${rel}:${n}: ${l.trim()}`);
  });
  assert.deepEqual(hits, [], "a new place that names dovre.dev: route it through src/sent.ts and add it to CATALOG");
  // The gateway's one mention is OpenRouter's referer header, not a call to dovre.dev.
  const gw = code(join(root, "src/packs/core/assistant/bino/gateway.ts")).filter(({ l }) => /dovre\.dev/.test(l));
  assert.deepEqual(gw.map(({ l }) => l.trim()), ['"http-referer": "https://dovre.dev",']);
});

test("guard: the launcher's calls home all go through postJSON, which records each one", () => {
  const go = readFileSync(join(root, "launcher", "bridge.go"), "utf8");
  assert.equal((go.match(/\bc\.(Post|Get|Do)\(|http\.(Get|Post|NewRequest)\(/g) ?? []).length, 1, "one place that calls out");
  const post = go.slice(go.indexOf("func postJSON"), go.indexOf("\n}\n", go.indexOf("func postJSON")));
  assert.match(post, /c\.Post\(/);
  assert.equal((post.match(/recordSent\(/g) ?? []).length, 2, "recorded whether or not it got an answer");
});

test("the catalog names each kind once, and says what it sends and when", () => {
  assert.equal(new Set(CATALOG.map((c) => c.id)).size, CATALOG.length);
  for (const c of CATALOG) for (const k of ["who", "what", "to", "sends", "when", "recorded"] as const) assert.ok(c[k].length > 3, `${c.id}.${k}`);
});
