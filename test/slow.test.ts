import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { slowLog } from "../src/slow.ts";

const app = (lines: string[]) => {
  const a = new Hono();
  a.use(slowLog((l) => lines.push(l), { ms: 100, skip: (p) => p.startsWith("/poll/") }));
  a.get("/slow/:id", async (c) => {
    await new Promise((r) => setTimeout(r, 150));
    return c.text("ok");
  });
  a.get("/busy", (c) => {
    const until = Date.now() + 200;
    while (Date.now() < until);
    return c.text("ok");
  });
  a.get("/fast", (c) => c.text("ok"));
  a.get("/poll/:id", async (c) => {
    await new Promise((r) => setTimeout(r, 150));
    return c.json({});
  });
  a.get("/events", (c) =>
    streamSSE(c, async (s) => {
      await new Promise((r) => setTimeout(r, 150));
      await s.writeSSE({ data: "x" });
    }),
  );
  return a;
};

test("slow requests are logged with method, path (no query), status and how long the loop was blocked; fast ones, streams and long polls aren't", async () => {
  const lines: string[] = [];
  const a = app(lines);
  await (await a.request("/slow/1?q=secret%20words")).text();
  await (await a.request("/fast?q=x")).text();
  await (await a.request("/poll/1")).text();
  await (await a.request("/events")).text();
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /^\S+Z server GET \/slow\/1 200 total=\d+ blocked=\d+$/);
  assert.doesNotMatch(lines[0]!, /secret|q=/);
  const waited = Number(/blocked=(\d+)/.exec(lines[0]!)![1]);
  assert.ok(waited < 100, `waiting isn't blocking: ${lines[0]}`);
});

test("a handler that holds the event loop shows as blocked", async () => {
  const lines: string[] = [];
  await (await app(lines).request("/busy")).text();
  assert.equal(lines.length, 1);
  const [, total, blocked] = /total=(\d+) blocked=(\d+)/.exec(lines[0]!)!.map(Number);
  assert.ok(blocked! >= 120 && blocked! <= total!, lines[0]);
});

test("a path can't break the line", async () => {
  const lines: string[] = [];
  const a = new Hono();
  a.use(slowLog((l) => lines.push(l), { ms: 0 }));
  a.get("*", (c) => c.text("ok"));
  await a.request("/a%20b%3Cx%3E%22");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\S+ server GET \S+ 200 total=\d+ blocked=\d+$/);
  assert.doesNotMatch(lines[0]!, /[<>"]/);
});
