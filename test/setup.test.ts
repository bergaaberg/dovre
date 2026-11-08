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

  assert.equal((await post("/setup/kit/next", "step=pick&repo=none")).headers.get("location"), "/setup/kit?at=pick", "refused: it stays");
  assert.match(await (await get("/setup/kit?at=pick")).text(), /role="alert">Pick one\.</);
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
