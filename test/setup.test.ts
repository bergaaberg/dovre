/** A pack's own setup page (#418): the pack draws each step, core draws the frame, Today lists what's left. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { html } from "hono/html";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { CheckRows } from "../src/ui/kit.ts";
import { signedIn, snapshot } from "./helpers.ts";

/** A pack with two steps: a form step (repos to tick), then one that waits on a write. */
function kitPack(o: { name?: string; title?: string } = {}) {
  const saved: Record<string, string | string[]>[] = [];
  let written = false;
  const pack: Pack = {
    manifest: { api: PACK_API, id: "kit", name: o.name ?? "Kit", description: "", domain: "work", onboard: { steps: [{ id: "pick", title: o.title ?? "Pick repos" }, { id: "write", title: "Open the PR" }] } },
    setup: {
      draw: (_c, step) =>
        step === "pick"
          ? { form: true, body: CheckRows({ name: "repo", label: "Repos", rows: [{ value: "a/web", label: "a/web", checked: true }, { value: "a/api", label: "a/api" }] }) }
          : { body: html`<p>${written ? "Opened." : "Not yet."}</p>`, ...(written ? {} : { wait: "Open the PR first." }) },
      save: async (_c, _step, form) => (saved.push(form), form.repo === "none" ? { ok: false, error: "Pick one." } : { ok: true }),
    },
  };
  return { pack, saved, write: () => (written = true) };
}

test("a pack's setup: one step at a time, Next saves a form step, a write holds its step, Today lists it until it's done", async () => {
  const k = kitPack();
  const { get, post, app } = signedIn(snapshot(), {}, { packs: [k.pack] });
  const { packsOf } = await import("../src/app.ts");
  const ctx = packsOf(app)!.ctxOf(k.pack);

  const today = await (await get("/")).text();
  assert.match(today, /A pack wants a minute|A few packs want a minute each/, "Agents is there too (#425)");
  assert.match(today, /href="\/setup\/kit"/);
  assert.match(today, />2 steps</);

  const first = await (await get("/setup/kit")).text();
  assert.match(first, /Setting up Kit/);
  assert.match(first, /Kit · 1 of 2/);
  assert.match(first, /<h2>Pick repos<\/h2>/);
  assert.match(first, /href="\/">Later</);
  assert.match(first, /<form method="post" action="\/setup\/kit\/next"><input type="hidden" name="step" value="pick"><div class="su-body"><div class="pack-box" data-pack="kit">.*name="repo" value="a\/web" checked/s, "a form step's inputs go with Next");
  assert.match(first, /cl-flag cl-focus/, "its flag stands out");
  assert.equal(ctx.setupDone(), false);

  const refused = await post("/setup/kit/next", "step=pick&repo=none");
  assert.equal(refused.status, 422, "refused: the step again, in this answer (#446)");
  assert.equal(refused.headers.get("location"), null);
  const again = await refused.text();
  assert.match(again, /role="alert">Pick one\.</);
  assert.match(again, /<h2>Pick repos<\/h2>.*action="\/setup\/kit\/next"/s, "with its form, to try again");
  assert.doesNotMatch(await (await get("/setup/kit?at=pick")).text(), /role="alert"/, "nothing kept for the next request: on hosted it may be another isolate");
  assert.equal((await post("/setup/kit/next", "step=pick&repo=a/web&repo=a/api")).headers.get("location"), "/setup/kit?at=write");
  assert.deepEqual(k.saved.at(-1), { repo: ["a/web", "a/api"] });
  assert.match(await (await get("/")).text(), />1 of 2 left</);

  const second = await (await get("/setup/kit")).text();
  assert.match(second, /Kit · 2 of 2/, "it opens where it's left");
  assert.match(second, /<button type="submit" class="climb-go" disabled>Done/);
  assert.match(second, /Open the PR first\./);
  assert.match(second, /<\/div><p class="su-note">Open the PR first\.<\/p><form method="post" action="\/setup\/kit\/next">/, "a step with its own writes keeps Next's form apart");
  assert.equal((await post("/setup/kit/next", "step=write")).headers.get("location"), "/setup/kit?at=write", "the write hasn't finished");
  k.write();
  assert.equal((await post("/setup/kit/next", "step=write")).headers.get("location"), "/setup/kit?at=done");
  assert.match(await (await get("/setup/kit?at=done")).text(), /That's it\..*Run it again/s);
  assert.equal(ctx.setupDone(), true);

  assert.doesNotMatch(await (await get("/")).text(), /href="\/setup\/kit"/, "done: off Today");
  assert.match(await (await get("/packs")).text(), /href="\/setup\/kit">Set up again</);
  assert.equal((await get("/setup/kit?at=pick")).status, 200, "it can run again");
});

test("setup pages: only for a pack that draws them, writes from this site only, and a broken step is that pack's", async () => {
  const plain: Pack = { manifest: { api: PACK_API, id: "plain", name: "Plain", description: "", domain: "work", onboard: { steps: [{ id: "one", title: "One" }] } } };
  const nested: Pack = { manifest: { api: PACK_API, id: "nested", name: "Nested", description: "", domain: "work", onboard: { steps: [{ id: "one", title: "One" }] } }, setup: { draw: () => ({ form: true, body: html`<form method="post" action="/nested/x"><button>Go</button></form>` }) } };
  const throws: Pack = { manifest: { api: PACK_API, id: "throws", name: "Throws", description: "", domain: "work", onboard: { steps: [{ id: "one", title: "One" }] } }, setup: { draw: () => { throw new Error("boom"); } } };
  const k = kitPack();
  const { get, post } = signedIn(snapshot(), {}, { packs: [plain, nested, throws, k.pack] });
  assert.equal((await get("/setup/plain")).status, 404, "onboard without setup: no page");
  assert.equal((await get("/setup/nope")).status, 404);
  assert.doesNotMatch(await (await get("/")).text(), /setup\/plain/);
  for (const id of ["nested", "throws"]) {
    const res = await get(`/setup/${id}`);
    assert.equal(res.status, 500, id);
    const out = await res.text();
    assert.match(out, /broke on this step/, id);
    assert.doesNotMatch(out, /action="\/nested\/x"/, "a form in a form step is refused");
    assert.equal((await post(`/setup/${id}/next`, "step=one")).headers.get("location"), `/setup/${id}?at=one`, `${id}: Next waits`);
  }
  assert.equal((await post("/setup/kit/next", "step=pick&repo=a/web", { origin: "https://evil.example" })).status, 403);
  assert.deepEqual(k.saved, []);
  assert.equal((await post("/setup/kit/next", "step=nope")).headers.get("location"), "/setup/kit", "a step it doesn't have");
});

test("a step's main button (#441): where Next goes, posting only here, with a kind of its own pack's", async () => {
  const { setupGo } = await import("../src/pages/setup.ts");
  for (const action of ["//evil.example/x", "https://evil.example/x", "javascript:alert(1)", "/\\evil.example", "/x\"><b>", "", "x"]) assert.equal(setupGo("kit", { action, label: "Go" }), undefined, action);
  assert.equal(setupGo("kit", { action: "/kit/go" }), undefined, "no label, no button");
  assert.deepEqual(setupGo("kit", { action: "/kit/go", label: " Go ", kind: "other.write" }), { action: "/kit/go", label: "Go", question: "Go?" }, "another pack's kind asks twice");
  assert.deepEqual(setupGo("kit", { action: "/kit/go", label: "Go", question: "Sure?", kind: "kit.write" }), { action: "/kit/go", label: "Go", question: "Sure?", kind: "kit.write" });

  const steps = { steps: [{ id: "one", title: "One" }, { id: "two", title: "Two" }] };
  const goes: Pack = { manifest: { api: PACK_API, id: "goes", name: "Goes", description: "", domain: "work", onboard: steps }, setup: { draw: (_c, step) => (step === "one" ? { body: html`<p>Hi</p>`, go: { action: "/goes/run", label: "Run it", question: "Run it now?" }, carry: true, refresh: 1 } : { body: "" }) } };
  const both: Pack = { manifest: { api: PACK_API, id: "both", name: "Both", description: "", domain: "work", onboard: steps }, setup: { draw: () => ({ form: true, body: "", go: { action: "/both/run", label: "Run" } }) } };
  const { get, post } = signedIn(snapshot(), {}, { packs: [goes, both] });
  const one = await (await get("/setup/goes?at=one")).text();
  assert.match(one, /class="climb-col" data-refresh="2">/, "redraws in place, 2 s at the least");
  assert.match(one, /<div class="su-foot">.*<div class="su-go" data-carry="Run it">.*action="\/goes\/run"/s);
  assert.doesNotMatch(one, />Next <span|action="\/setup\/goes\/next"/, "one main button: no Next, nor its form");
  assert.equal((await post("/setup/goes/next", "step=one")).headers.get("location"), "/setup/goes?at=one", "Next posted anyway waits for it");
  const two = await (await get("/setup/goes?at=two")).text();
  assert.match(two, />Done <span/);
  assert.doesNotMatch(two, /su-go|data-refresh|<noscript>/);
  const res = await get("/setup/both");
  assert.equal(res.status, 500, "a form step with a button of its own is broken");

  const src = one.match(/<script src="(\/assets\/setup\.[0-9a-z]+\.js)"/)![1]!;
  const js = await get(src);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  const text = await js.text();
  assert.doesNotThrow(() => new Function(text), "the script parses");
});

test("a setup's end offers the next pack's (#445), and the summit starts there", async () => {
  const one = (id: string, name: string): Pack => ({ manifest: { api: PACK_API, id, name, description: "", domain: "work", onboard: { steps: [{ id: "one", title: "One" }] } }, setup: { draw: () => ({ body: "" }) } });
  const { get, post } = signedIn(snapshot(), {}, { packs: [one("first", "First"), one("second", "Second")] });
  await post("/setup/first/next", "step=one");
  const done = await (await get("/setup/first?at=done")).text();
  assert.match(done, /<a class="climb-go" href="\/setup\/agents">Next: Agents .*<a class="climb-link" href="\/">Today<\/a>/s, "in Today's order: core's Agents first");
  assert.doesNotMatch(done, /flag's back/);
  const { setupPage } = await import("../src/pages/setup.ts");
  const last = String(setupPage({ flags: [], pack: { id: "second", name: "Second" }, steps: [{ id: "one", title: "One" }], at: 1 }));
  assert.match(last, /class="climb-go" href="\/">Back to Today/, "none left: Today");
  assert.match(last, /<body class="climb-page su-page">/, "the ground closes a setup page, under it (#444)");
  assert.equal((await post("/welcome/done", "setup=nope")).headers.get("location"), "/", "not a pack with a setup: Today");
});
