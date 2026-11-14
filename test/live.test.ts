/**
 * Hosted live pages over the hub's socket (H5): /live lets in only a person, from this app's own
 * pages, and the shell tells the page script to use it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { liveIn, syncTeller } from "../src/worker.ts";
import { shell } from "../src/html.ts";
import { type HubClient, hubClient } from "../src/hosted/client.ts";
import { OWN_HEADER, VIEWER_HEADER } from "../src/hosted/hub.ts";
import type { AccessVerifier } from "../src/access.ts";

const ORIGIN = "https://dovre.example.dev";
const up = (headers: Record<string, string> = {}, method = "GET") =>
  new Request(`${ORIGIN}/live`, { method, headers: { upgrade: "websocket", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers } });

function fakes(who: Awaited<ReturnType<AccessVerifier>>) {
  const handed: Request[] = [];
  const named: unknown[] = [];
  const hub = { live: async (r: Request, v: unknown) => (handed.push(r), named.push(v), new Response("socket", { status: 200 })) } as unknown as HubClient;
  const verify: AccessVerifier = async () => who;
  return { handed, named, h: { hub, verify } };
}

test("/live: a person from this app's own page gets the hub's socket", async () => {
  const { handed, h } = fakes({ email: "me@example.dev" });
  const res = await liveIn(up(), h);
  assert.equal(await res.text(), "socket");
  assert.equal(handed.length, 1);
});

test("/live: the socket is named for the verified person, and reads their own snapshot only when the page drew one (#539)", async () => {
  const own = (as: string | null | undefined) => !!as && as.toLowerCase() !== "op";
  const ask = async (query: string, headers: Record<string, string> = {}) => {
    const { named, h } = fakes({ email: "Me@Example.dev" });
    await liveIn(new Request(`${ORIGIN}/live${query}`, { headers: { upgrade: "websocket", origin: ORIGIN, "sec-fetch-site": "same-origin", ...headers } }), { ...h, own });
    return named[0];
  };
  assert.deepEqual(await ask("?as=me"), { who: "Me@Example.dev", own: true });
  assert.deepEqual(await ask("?as=OP"), { who: "Me@Example.dev", own: false }, "the instance's login: its snapshot");
  assert.deepEqual(await ask(""), { who: "Me@Example.dev", own: false }, "a page that didn't say");
  // What the request claims about who it is counts for nothing.
  assert.deepEqual(await ask("?as=op", { [VIEWER_HEADER]: "boss@example.dev", [OWN_HEADER]: "1" }), { who: "Me@Example.dev", own: false });
  // An instance with one snapshot for all: nobody's page is its own.
  const { named, h } = fakes({ email: "me@example.dev" });
  await liveIn(up(), h);
  assert.deepEqual(named[0], { who: "me@example.dev", own: false });
});

test("hub client: only it names a listener's person to the object; a gather says whose it was (#539)", async () => {
  const seen: { path: string; headers: Headers; body?: unknown }[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        const req = typeof input === "string" ? new Request(input, init) : input;
        seen.push({ path: new URL(req.url).pathname, headers: req.headers, body: req.method === "POST" ? await req.json() : undefined });
        return new Response("{}");
      },
    }),
  };
  const hub = hubClient(ns);
  const forged = new Request(`${ORIGIN}/live?as=x`, { headers: { [VIEWER_HEADER]: "boss@example.dev", [OWN_HEADER]: "1", origin: ORIGIN } });
  await hub.live(forged, { who: " Me@Example.dev ", own: false });
  await hub.live(forged, { who: "me@example.dev", own: true });
  await hub.live(forged);
  await hub.events({ who: "me@example.dev", own: true });
  await hub.events();
  assert.deepEqual(
    seen.map((s) => [s.path, s.headers.get(VIEWER_HEADER), s.headers.get(OWN_HEADER)]),
    [["/live", "me@example.dev", null], ["/live", "me@example.dev", "1"], ["/live", null, null], ["/events", "me@example.dev", "1"], ["/events", null, null]],
  );
  assert.equal(seen[0]!.headers.get("origin"), ORIGIN, "the rest of the upgrade goes as it came");

  seen.length = 0;
  hub.gathered(5, true, " Ola@X.dev ");
  hub.gathered(6, false);
  await hub.drain();
  assert.deepEqual(seen.map((s) => s.body), [{ topics: ["snapshot"], synced: 5, for: "ola@x.dev" }, { topics: [], synced: 6, shared: true }]);
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
  assert.match(page("ws"), /<meta name="u-as" content="me">/, "and says whose snapshot it drew (#539)");
  assert.doesNotMatch(page(), /u-live|u-as/);
  const hostile = String(shell({ title: "t", frame: { operator: `"><script>alert(1)</script>`, nav: [], live: "ws" }, body: "" }));
  assert.doesNotMatch(hostile, /<script>alert/);
  assert.match(hostile, /<meta name="u-as" content="&quot;&gt;&lt;script&gt;/);
});

test("syncTeller: pages hear a gather that changed something, one asked for, and otherwise one in a while", () => {
  const told: [number, boolean][] = [];
  const t = syncTeller((at, changed) => told.push([at, changed]), 1000);
  t.gathered(100, "a"); // first: changed
  t.gathered(200, "a"); // same, too soon
  t.gathered(300, "b"); // changed
  t.gathered(400, "b");
  t.asked();
  t.gathered(500, "b"); // asked for: told though unchanged
  t.gathered(600, "b"); // the ask is used up
  t.gathered(1500, "b"); // a while since the last: told
  assert.deepEqual(told, [[100, true], [300, true], [500, false], [1500, false]]);
});
