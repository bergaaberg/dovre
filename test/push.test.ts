/** Web Push from a pack: the service worker shows it, and a click opens only a path on this app. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVICE_WORKER } from "../src/pwa.ts";
import { SCRIPT } from "../src/ui/app.js.ts";

type Handler = (e: Record<string, unknown>) => void;

/** Runs the service worker against a stand-in `self` and returns its handlers and what they did. */
function worker() {
  const on: Record<string, Handler> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (k: string, f: Handler) => (on[k] = f),
    registration: { showNotification: async (title: string, opts: Record<string, unknown>) => void shown.push({ title, opts }) },
    clients: { matchAll: async () => [], openWindow: async (u: string) => void opened.push(u), claim: async () => {} },
  };
  new Function("self", "caches", SERVICE_WORKER)(self, {});
  const waits: Promise<unknown>[] = [];
  const fire = async (k: string, e: Record<string, unknown>) => {
    on[k]!({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, shown, opened };
}

const push = (data: unknown) => ({ data: { json: () => data, text: () => String(data) } });
const click = (href: unknown) => ({ notification: { close() {}, data: { href } } });

test("a pack's push shows its title, body and tag with the app icon", async () => {
  const w = worker();
  await w.fire("push", push({ title: "Quill is down", body: "5xx for 3 min", href: "/signals", tag: "s1", tone: "bad" }));
  assert.equal(w.shown[0]?.title, "Quill is down");
  assert.equal(w.shown[0]?.opts.body, "5xx for 3 min");
  assert.equal(w.shown[0]?.opts.tag, "s1");
  assert.equal(w.shown[0]?.opts.icon, "/assets/icon-192.png");
  assert.deepEqual(w.shown[0]?.opts.data, { href: "/signals" });
});

test("a push that isn't JSON still shows, as its text", async () => {
  const w = worker();
  await w.fire("push", { data: { json: () => { throw new Error("no"); }, text: () => "plain words" } });
  assert.equal(w.shown[0]?.title, "Dovre");
  assert.equal(w.shown[0]?.opts.body, "plain words");
});

test("a click opens only a path on this app; anything else opens home", async () => {
  for (const [href, want] of [["/signals", "/signals"], ["https://evil.example/", "/"], ["//evil.example", "/"], ["/\\evil.example", "/"], ["javascript:alert(1)", "/"], [42, "/"]] as const) {
    const w = worker();
    await w.fire("notificationclick", click(href));
    assert.deepEqual(w.opened, [want], String(href));
  }
});

test("the page script subscribes a pack's push button to its own path only", () => {
  assert.match(SCRIPT, /button\[data-push-subscribe\]/);
  assert.match(SCRIPT, /pushManager\.subscribe/);
  new Function(SCRIPT.replace(/^/, "return;\n"));
});
