/**
 * A paired machine's sign-in (H6, dovre-site#9): the credentials file, the JWT refresh that rotates
 * the refresh token, unpairing, and the PATH a bridge started at login gets (H8).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Creds, jwtHeaders, loadCreds, parseCreds, saveCreds, Unpaired } from "../src/bridge/creds.ts";
import { type BridgeSocket, startBridge } from "../src/bridge/mac.ts";
import type { Desk } from "../src/agents/desk.ts";
import { withToolDirs } from "../src/tools.ts";

const CREDS: Creds = {
  server: "https://dovre.dev",
  handle: "alice",
  machine: "m1a2b3c4d5e6f7a8",
  name: "laptop",
  hub: "wss://alice.dovre.dev/bridge",
  frame_key: "f".repeat(64),
  refresh_token: "r0",
};

test("creds: only a whole, well-formed file counts", () => {
  assert.deepEqual(parseCreds(JSON.stringify(CREDS)), CREDS);
  assert.equal(parseCreds("{"), undefined);
  assert.equal(parseCreds(JSON.stringify({ ...CREDS, frame_key: "short" })), undefined, "a key too short");
  assert.equal(parseCreds(JSON.stringify({ ...CREDS, refresh_token: "" })), undefined);
  assert.equal(parseCreds(JSON.stringify({ ...CREDS, server: "http://evil.example" })), undefined, "tokens never go over plain http");
  assert.equal(parseCreds(JSON.stringify({ ...CREDS, hub: "ws://alice.dovre.dev/bridge" })), undefined);
});

test("creds: saved owner-only, and read back", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dovre-creds-")), "bridge.json");
  saveCreds(file, CREDS);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadCreds(file), CREDS);
  assert.equal(loadCreds(file + ".nope"), undefined);
});

test("creds: a JWT per dial, refreshed near expiry, each rotated refresh token saved before use", async () => {
  let now = 0;
  const asked: string[] = [];
  const saved: string[] = [];
  let n = 0;
  const headers = jwtHeaders({
    creds: CREDS,
    save: (c) => saved.push(c.refresh_token),
    now: () => now,
    fetch: async (url, init) => {
      assert.equal(url, "https://dovre.dev/bridge/token");
      const b = JSON.parse(init.body);
      assert.equal(b.grant_type, "refresh_token");
      asked.push(b.refresh_token);
      n++;
      return { status: 200, json: async () => ({ access_token: `jwt${n}`, expires_in: 600, refresh_token: `r${n}` }) };
    },
  });
  assert.deepEqual(await headers(), { "Cf-Access-Jwt-Assertion": "jwt1" });
  now = 300_000;
  assert.deepEqual(await headers(), { "Cf-Access-Jwt-Assertion": "jwt1" }, "still good: no refresh");
  now = 560_000;
  assert.deepEqual(await headers(), { "Cf-Access-Jwt-Assertion": "jwt2" }, "under a minute left: refreshed");
  assert.deepEqual(asked, ["r0", "r1"], "each refresh uses the token the last one handed back");
  assert.deepEqual(saved, ["r1", "r2"]);
});

test("creds: invalid_grant is unpaired; anything else is a failed dial, tried again", async () => {
  const unpaired = jwtHeaders({ creds: CREDS, save: () => {}, fetch: async () => ({ status: 400, json: async () => ({ error: "invalid_grant" }) }) });
  await assert.rejects(unpaired(), Unpaired);
  const down = jwtHeaders({ creds: CREDS, save: () => assert.fail("nothing to save"), fetch: async () => ({ status: 503, json: async () => ({}) }) });
  await assert.rejects(down(), (e: Error) => !(e instanceof Unpaired) && /503/.test(e.message));
});

test("bridge: closed as revoked (4004), it stops and doesn't dial again", async () => {
  let dials = 0;
  let revoked = 0;
  const dial = (): BridgeSocket => {
    dials++;
    const s: BridgeSocket = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    setImmediate(() => s.onclose?.({ code: 4004, reason: "revoked" }));
    return s;
  };
  startBridge({ url: "wss://alice.dovre.dev/bridge", key: CREDS.frame_key, headers: {}, desk: {} as Desk, sessions: async () => ({ live: [], recent: [] }), dial, onRevoked: () => revoked++, timing: { backoffMs: 5 } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(dials, 1);
  assert.equal(revoked, 1);
});

test("H8: PATH gains the folders agent CLIs install to, once, only those that exist", () => {
  const there = new Set(["/home/a/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"]);
  const exists = (p: string) => there.has(p);
  assert.equal(withToolDirs("/usr/bin:/bin", { platform: "linux", home: "/home/a", env: {}, exists }), "/usr/bin:/bin:/home/a/.local/bin:/usr/local/bin");
  assert.equal(withToolDirs("/usr/local/bin/:/usr/bin", { platform: "linux", home: "/home/a", env: {}, exists }), "/usr/local/bin/:/usr/bin:/home/a/.local/bin", "already there");
  assert.equal(withToolDirs("", { platform: "darwin", home: "/home/a", env: {}, exists }), "/home/a/.local/bin:/usr/local/bin:/opt/homebrew/bin");
  const win = new Set(["C:\\Users\\a\\.local\\bin", "C:\\Users\\a\\AppData\\Roaming\\npm"]);
  assert.equal(
    withToolDirs("C:\\Windows;c:\\users\\a\\appdata\\roaming\\npm\\", { platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, exists: (p) => win.has(p) }),
    "C:\\Windows;c:\\users\\a\\appdata\\roaming\\npm\\;C:\\Users\\a\\.local\\bin",
  );
});

