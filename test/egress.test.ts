/** A sandbox run's way out (#208): the token only on model calls, tunnels only to allowed hosts, the rest refused and told. */
import assert from "node:assert/strict";
import { request, type IncomingMessage } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { allowed, allowOf, inSubnet, openEgress, PLACEHOLDER_TOKEN } from "../src/agents/egress.ts";
import { boxEnv, netOf } from "../src/agents/sandbox.ts";

test("allowOf: lowercased names and *. rules from .dovre/sandbox.json; junk, IPs and odd JSON left out", () => {
  assert.deepEqual(allowOf(JSON.stringify({ allow: ["Registry.npmjs.org", "*.example.com", "registry.npmjs.org", "1.2.3.4", "a b", "*", "*.com.", 3, "localhost"] })), ["registry.npmjs.org", "*.example.com"]);
  assert.deepEqual(allowOf("not json"), []);
  assert.deepEqual(allowOf(JSON.stringify({ allow: "registry.npmjs.org" })), []);
  assert.deepEqual(allowOf(undefined), []);
  assert.equal(allowOf(JSON.stringify({ allow: Array.from({ length: 80 }, (_, i) => `h${i}.example.com`) })).length, 50);
});

test("allowed: exact names, and under a *. rule but not the bare suffix", () => {
  const list = ["registry.npmjs.org", "*.example.com"];
  assert.ok(allowed(list, "registry.npmjs.org"));
  assert.ok(allowed(list, "REGISTRY.npmjs.org."));
  assert.ok(allowed(list, "a.b.example.com"));
  assert.ok(!allowed(list, "example.com"));
  assert.ok(!allowed(list, "evilexample.com"));
  assert.ok(!allowed(list, "registry.npmjs.org.evil.io"));
});

test("inSubnet: IPv4 and IPv4-mapped addresses in the CIDR only", () => {
  assert.ok(inSubnet("192.168.128.7", "192.168.128.0/24"));
  assert.ok(inSubnet("::ffff:192.168.128.7", "192.168.128.0/24"));
  assert.ok(!inSubnet("192.168.129.7", "192.168.128.0/24"));
  assert.ok(!inSubnet("192.168.86.28", "192.168.128.0/24"));
  assert.ok(!inSubnet("::1", "192.168.128.0/24"));
  assert.ok(!inSubnet(undefined, "192.168.128.0/24"));
  assert.ok(!inSubnet("10.0.0.1", "garbage"));
});

test("netOf: the gateway and subnet of a host-only network; a NAT network or junk is not one", () => {
  const net = (mode: string) => JSON.stringify([{ configuration: { mode }, status: { ipv4Gateway: "192.168.128.1", ipv4Subnet: "192.168.128.0/24" } }]);
  assert.deepEqual(netOf(net("hostOnly")), { gateway: "192.168.128.1", subnet: "192.168.128.0/24" });
  assert.equal(netOf(net("nat")), undefined);
  assert.equal(netOf(""), undefined);
  assert.equal(netOf(JSON.stringify([{ configuration: { mode: "hostOnly" }, status: { ipv4Gateway: "x; rm -rf", ipv4Subnet: "192.168.128.0/24" } }])), undefined);
});

test("boxEnv: the model API and proxies at the gateway, a placeholder token, no side traffic", () => {
  const env = boxEnv("192.168.128.1", 41000, "k".repeat(24));
  assert.match(env, /^ANTHROPIC_BASE_URL=http:\/\/192\.168\.128\.1:41000\/r\/k{24}$/m);
  assert.match(env, new RegExp(`^CLAUDE_CODE_OAUTH_TOKEN=${PLACEHOLDER_TOKEN}$`, "m"));
  assert.match(env, /^HTTPS_PROXY=http:\/\/k{24}:x@192\.168\.128\.1:41000$/m);
  assert.match(env, /^NO_PROXY=192\.168\.128\.1$/m);
  assert.match(env, /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$/m);
});

/** A fake model API: records what came, answers 200 "ok". */
function fakeModel() {
  const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const model = (o: { path: string; headers: Record<string, string | string[] | undefined> }, cb: (r: IncomingMessage) => void) => {
    const req = new PassThrough() as unknown as import("node:http").ClientRequest;
    const rec = { path: o.path, headers: o.headers, body: "" };
    seen.push(rec);
    (req as unknown as PassThrough).on("data", (b) => (rec.body += String(b)));
    (req as unknown as PassThrough).on("finish", () => {
      const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
      Object.assign(res, { statusCode: 200, headers: { "content-type": "text/plain" } });
      cb(res);
      res.end("ok");
    });
    return req;
  };
  return { model, seen };
}

const send = (port: number, o: { method: string; path: string; headers?: Record<string, string>; body?: string }) =>
  new Promise<{ status: number; body: string }>((res, rej) => {
    const q = request({ host: "127.0.0.1", port, method: o.method, path: o.path, headers: o.headers }, (r) => {
      let body = "";
      r.on("data", (b) => (body += String(b)));
      r.on("end", () => res({ status: r.statusCode ?? 0, body }));
    });
    q.on("error", rej);
    q.end(o.body ?? "");
  });

const KEY_A = "a".repeat(24);
const KEY_B = "b".repeat(24);
const basic = (key: string) => `Basic ${Buffer.from(`${key}:x`).toString("base64")}`;

/** A CONNECT through the proxy as run `key`: the status line, and the socket when it's open. */
const tunnelTo = (port: number, target: string, key?: string) =>
  new Promise<{ status: number; sock: Socket }>((res, rej) => {
    const q = request({ host: "127.0.0.1", port, method: "CONNECT", path: target, headers: key ? { "proxy-authorization": basic(key) } : {} });
    q.on("connect", (r, sock) => res({ status: r.statusCode ?? 0, sock }));
    q.on("error", rej);
    q.end();
  });

test("the proxy: a run's model calls get its token in place of the placeholder; other paths, unknown keys and plain HTTP are refused", async (t) => {
  const { model, seen } = fakeModel();
  const denied: string[] = [];
  const way = await openEgress({ subnet: "127.0.0.0/8", listen: "127.0.0.1", upstream: { model } });
  t.after(() => way.close());
  way.add(KEY_A, { token: "sk-ant-oat01-real", allow: [], onDeny: (h) => denied.push(h) });
  const ok = await send(way.port, { method: "POST", path: `/r/${KEY_A}/v1/messages?beta=true`, headers: { authorization: `Bearer ${PLACEHOLDER_TOKEN}`, "x-api-key": "nope", "anthropic-beta": "oauth-2025-04-20" }, body: "{}" });
  assert.deepEqual(ok, { status: 200, body: "ok" });
  assert.equal(seen[0]!.path, "/v1/messages?beta=true");
  assert.equal(seen[0]!.headers.authorization, "Bearer sk-ant-oat01-real");
  assert.equal(seen[0]!.headers["x-api-key"], undefined);
  assert.equal(seen[0]!.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(seen[0]!.body, "{}");
  // The token reaches nothing but a known run's model call.
  for (const [method, path] of [["POST", "/v1/messages"], ["POST", `/r/${KEY_B}/v1/messages`], ["GET", `/r/${KEY_A}/v1/messages`], ["POST", `/r/${KEY_A}/api/oauth/claude_cli/create_api_key`], ["POST", `/r/${KEY_A}/v1/messages/../../api`], ["POST", `/r/${KEY_A}/v1/files`]] as const) {
    assert.equal((await send(way.port, { method, path })).status, 403, `${method} ${path}`);
  }
  assert.equal((await send(way.port, { method: "GET", path: "http://evil.example.org/x", headers: { "proxy-authorization": basic(KEY_A) } })).status, 403);
  assert.equal(seen.length, 1);
  assert.deepEqual(denied, ["evil.example.org"]);
  // Dropped: its key gets nothing.
  way.drop(KEY_A);
  assert.equal((await send(way.port, { method: "POST", path: `/r/${KEY_A}/v1/messages` })).status, 403);
  assert.equal(seen.length, 1);
});

test("the proxy: CONNECT only to the run's allowed hosts on 443; the rest refused and told to that run, once each", async (t) => {
  // An "internet" that echoes, reached through the tunnel stub.
  const echo = createServer((s) => s.pipe(s)).listen(0, "127.0.0.1");
  await new Promise((r) => echo.once("listening", r));
  const ePort = (echo.address() as { port: number }).port;
  const dialled: string[] = [];
  const deniedA: string[] = [];
  const deniedB: string[] = [];
  const way = await openEgress({ subnet: "127.0.0.0/8", listen: "127.0.0.1", upstream: { tunnel: (host, port) => (dialled.push(`${host}:${port}`), connect({ host: "127.0.0.1", port: ePort })) } });
  t.after(() => (way.close(), echo.close()));
  way.add(KEY_A, { token: "t", allow: ["registry.npmjs.org", "*.example.com"], onDeny: (h) => deniedA.push(h) });
  way.add(KEY_B, { token: "t", allow: [], onDeny: (h) => deniedB.push(h) });
  const open = await tunnelTo(way.port, "registry.npmjs.org:443", KEY_A);
  assert.equal(open.status, 200);
  open.sock.write("ping");
  const back = await new Promise<string>((r) => open.sock.once("data", (b) => r(String(b))));
  assert.equal(back, "ping");
  open.sock.destroy();
  const sub = await tunnelTo(way.port, "a.example.com:443", KEY_A);
  assert.equal(sub.status, 200);
  sub.sock.destroy();
  for (const [target, key] of [["api.anthropic.com:443", KEY_A], ["evil.io:443", KEY_A], ["registry.npmjs.org:22", KEY_A], ["api.anthropic.com:443", KEY_A], ["registry.npmjs.org:443", KEY_B], ["registry.npmjs.org:443", undefined]] as const) {
    const r = await tunnelTo(way.port, target, key);
    assert.equal(r.status, 403, `${target} as ${key}`);
    r.sock.destroy();
  }
  assert.deepEqual(dialled, ["registry.npmjs.org:443", "a.example.com:443"]);
  assert.deepEqual(deniedA, ["api.anthropic.com", "evil.io", "registry.npmjs.org"]);
  assert.deepEqual(deniedB, ["registry.npmjs.org"]);
});

test("the proxy: a connection from outside the sandbox subnet is dropped", async (t) => {
  const { model, seen } = fakeModel();
  const way = await openEgress({ subnet: "192.168.128.0/24", listen: "127.0.0.1", upstream: { model } });
  t.after(() => way.close());
  way.add(KEY_A, { token: "t", allow: ["registry.npmjs.org"] });
  await assert.rejects(send(way.port, { method: "POST", path: `/r/${KEY_A}/v1/messages` }));
  await assert.rejects(tunnelTo(way.port, "registry.npmjs.org:443", KEY_A));
  assert.equal(seen.length, 0);
});
