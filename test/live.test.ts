/**
 * Hosted live pages over the hub's socket (H5): /live lets in only a person, from this app's own
 * pages, and the shell tells the page script to use it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { liveIn } from "../src/worker.ts";
import { shell } from "../src/html.ts";
import type { HubClient } from "../src/hosted/client.ts";
import type { AccessVerifier } from "../src/access.ts";

const ORIGIN = "https://dovre.example.dev";
const up = (headers: Record<string, string> = {}, method = "GET") =>
  new Request(`${ORIGIN}/live`, { method, headers: { upgrade: "websocket", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers } });

function fakes(who: Awaited<ReturnType<AccessVerifier>>) {
  const handed: Request[] = [];
  const hub = { live: async (r: Request) => (handed.push(r), new Response("socket", { status: 200 })) } as unknown as HubClient;
  const verify: AccessVerifier = async () => who;
  return { handed, h: { hub, verify } };
}

test("/live: a person from this app's own page gets the hub's socket", async () => {
  const { handed, h } = fakes({ email: "me@example.dev" });
  const res = await liveIn(up(), h);
  assert.equal(await res.text(), "socket");
  assert.equal(handed.length, 1);
});

test("/live: anything else is a 404 and never reaches the hub", async () => {
  const person = { email: "me@example.dev" } as const;
  const cases: [string, Request, Awaited<ReturnType<AccessVerifier>>][] = [
    ["no upgrade", new Request(`${ORIGIN}/live`, { headers: { origin: ORIGIN } }), person],
    ["a POST", up({}, "POST"), person],
    ["another site's page", up({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }), person],
    ["a sibling subdomain", up({ origin: "https://x.example.dev", "sec-fetch-site": "same-site" }), person],
    ["a forged origin, same-site", up({ "sec-fetch-site": "same-site" }), person],
    ["no origin", new Request(`${ORIGIN}/live`, { headers: { upgrade: "websocket" } }), person],
    ["not signed in", up(), undefined],
    ["the bridge's service token", up(), { service: "id.access" }],
  ];
  for (const [what, req, who] of cases) {
    const { handed, h } = fakes(who);
    assert.equal((await liveIn(req, h)).status, 404, what);
    assert.equal(handed.length, 0, what);
  }
  assert.equal((await liveIn(up(), { verify: async () => person })).status, 404, "no hub");
});

test("shell: the page listens on /live only when the frame says so", () => {
  const page = (live?: "ws") => String(shell({ title: "t", frame: { operator: "me", nav: [], live }, body: "" }));
  assert.match(page("ws"), /<meta name="u-live" content="ws">/);
  assert.doesNotMatch(page(), /u-live/);
});
