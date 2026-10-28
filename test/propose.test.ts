/** Packs propose a change to one file as a PR (#203): re-checked first, the owners' repos only, logged under the pack's kind. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { type Proposal, packProposals, proposeFile } from "../src/actions/propose.ts";
import { type Pack, PACK_API } from "../src/packs/types.ts";
import { fakeGhe, signedIn, snapshot } from "./helpers.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const BRANCH = "dovre/topo-peak-pr-20261028-100000";
const P: Proposal = { repo: "ACME/site", path: "peak.yaml", text: "name: site\nworkers: [web]\n", expect: "name: site\n", title: "Add web to peak.yaml", body: "Why.", branch: BRANCH };
const routes = (file: string | undefined, more: Record<string, unknown> = {}) => ({
  "GET /repos/ACME/site": { default_branch: "main" },
  ...(file === undefined ? {} : { "GET /repos/ACME/site/contents/peak.yaml?ref=main": { type: "file", sha: "f1", content: b64(file) } }),
  "GET /repos/ACME/site/git/ref/heads/main": { object: { sha: "c0" } },
  "POST /repos/ACME/site/git/refs": {},
  "PUT /repos/ACME/site/contents/peak.yaml": {},
  "POST /repos/ACME/site/pulls": { number: 9, html_url: "https://acme.ghe.com/ACME/site/pull/9" },
  ...more,
});

test("proposeFile: a branch off the default branch, the file written over the sha it read, one PR", async () => {
  const { ghe, calls } = fakeGhe(routes("name: site\n"));
  assert.deepEqual(await proposeFile(ghe, P), { number: 9, url: "https://acme.ghe.com/ACME/site/pull/9" });
  assert.deepEqual(calls.find((c) => c.path.endsWith("/git/refs"))!.body, { ref: `refs/heads/${BRANCH}`, sha: "c0" });
  const put = calls.find((c) => c.method === "PUT")!.body as { content: string; sha: string; branch: string; message: string };
  assert.equal(Buffer.from(put.content, "base64").toString("utf8"), P.text);
  assert.deepEqual([put.sha, put.branch, put.message], ["f1", BRANCH, P.title]);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/pulls"))!.body, { title: P.title, head: BRANCH, base: "main", body: "Why." });
});

test("proposeFile: a new file is written without a sha", async () => {
  const { ghe, calls } = fakeGhe(routes(undefined));
  await proposeFile(ghe, { ...P, expect: null });
  assert.equal((calls.find((c) => c.method === "PUT")!.body as { sha?: string }).sha, undefined);
});

test("proposeFile: nothing is written when the file isn't what the pack saw, or already says it", async () => {
  for (const [file, expect, why] of [
    ["name: other\n", "name: site\n", /changed since/],
    [undefined, "name: site\n", /is gone/],
    ["name: site\n", null, /exists now/],
    [P.text, P.text, /already says that/],
  ] as const) {
    const { ghe, calls } = fakeGhe(routes(file));
    await assert.rejects(proposeFile(ghe, { ...P, expect }), why);
    assert.ok(!calls.some((c) => c.method !== "GET"), String(why));
  }
});

test("proposeFile: a failure after the branch was made deletes the branch", async () => {
  const { ghe, calls } = fakeGhe(routes("name: site\n", { "POST /repos/ACME/site/pulls": () => { throw new Error("GHE POST: 422 nope"); }, [`DELETE /repos/ACME/site/git/refs/heads/${encodeURIComponent(BRANCH)}`]: null }));
  await assert.rejects(proposeFile(ghe, P), /422/);
  assert.ok(calls.some((c) => c.method === "DELETE"));
});

test("packProposals: refused before the forge is asked, logged under <pack>.<kind>; a success logs the PR", async () => {
  const db = openDb();
  const asked: Proposal[] = [];
  const propose = packProposals({ pack: { id: "topo", name: "Topo" }, kinds: ["peak-pr"], owners: () => "ACME", db: db.DB, now: () => new Date("2026-10-28T10:00:00Z"), propose: async (p) => (asked.push(p), { number: 9, url: "u" }) });
  const ok = { kind: "peak-pr", repo: "ACME/site", path: "peak.yaml", text: "x", expect: null, title: "Start\npeak.yaml" };
  assert.deepEqual(await propose({ ...ok, kind: "other" }), { ok: false, error: 'Topo didn\'t declare the write kind "other".' });
  for (const bad of [{ repo: "evil/site" }, { path: "../x" }, { path: "/etc/passwd" }, { text: "x".repeat(512 * 1024 + 1) }, { title: " " }, { expect: undefined as unknown as null }]) {
    const r = await propose({ ...ok, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(asked.length, 0, "nothing reached the forge");
  assert.deepEqual(await propose(ok), { ok: true, number: 9, url: "u" });
  assert.equal(asked[0]!.branch, BRANCH);
  assert.equal(asked[0]!.title, "Start peak.yaml", "one line");
  assert.match(asked[0]!.body, /Opened by Dovre \(Topo\)\.$/);
  const logged = db.raw.prepare("SELECT kind, target, ok, detail FROM actions ORDER BY id").all().map((l) => ({ ...l }));
  assert.equal(logged.length, 7, "each refusal and the success, not the undeclared kind");
  assert.ok(logged.every((l) => l.kind === "topo.peak-pr"));
  assert.deepEqual(logged.at(-1), { kind: "topo.peak-pr", target: "ACME/site:peak.yaml", ok: 1, detail: "#9" });
});

test("packProposals: a forge failure is the pack's answer, logged", async () => {
  const db = openDb();
  const propose = packProposals({ pack: { id: "topo", name: "Topo" }, kinds: ["peak-pr"], owners: () => "ACME", db: db.DB, propose: async () => { throw new Error("peak.yaml changed since it was read."); } });
  assert.deepEqual(await propose({ kind: "peak-pr", repo: "ACME/site", path: "peak.yaml", text: "x", expect: "y", title: "t" }), { ok: false, error: "peak.yaml changed since it was read." });
  assert.equal((db.raw.prepare("SELECT ok FROM actions").get() as { ok: number }).ok, 0);
});

test("propose: a pack reaches it through ctx.forge() with its own kinds", async () => {
  const seen: Proposal[] = [];
  const topo: Pack = {
    manifest: { api: PACK_API, id: "topo", name: "Topo", description: "", domain: "personal" },
    writes: [{ kind: "peak-pr", label: "Open a PR fixing peak.yaml" }],
    routes: (app, ctx) => {
      app.get("/topo/try", async (c) => c.json(await ctx.forge()!.propose!({ kind: "peak-pr", repo: "ACME/site", path: "peak.yaml", text: "x", expect: null, title: "t" })));
    },
  };
  const { get } = signedIn(snapshot(), {}, { packs: [topo], forge: { id: "github", name: "GitHub", can: [], host: "github.com", propose: async (p) => (seen.push(p), { number: 3, url: "https://github.com/ACME/site/pull/3" }) } });
  assert.deepEqual(await (await get("/topo/try")).json(), { ok: true, number: 3, url: "https://github.com/ACME/site/pull/3" });
  assert.match(seen[0]!.branch, /^dovre\/topo-peak-pr-\d{8}-\d{6}$/);
});
