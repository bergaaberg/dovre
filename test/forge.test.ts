/** Forges (src/forge/): FORGE picks one a pack brings, GitHub otherwise; what a forge can't do isn't there. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubForge } from "../src/forge/github.ts";
import { forgeIdOf, pickForge } from "../src/forge/pick.ts";
import type { Forge } from "../src/forge/types.ts";
import { createGatherer } from "../src/gather.ts";
import { PACK_API, type Pack } from "../src/packs/types.ts";
import { deploy, fakeGhe, pr, signedIn, snapshot } from "./helpers.ts";

/** A forge with only the gather's must-haves: no deploys, changelogs or red branches, nothing beyond. */
function bareForge(o: Partial<Forge> = {}): Forge {
  return {
    id: "lab",
    name: "Lab",
    host: "git.example.com",
    can: [],
    viewer: async () => ({ login: "kari", name: "Kari Nordmann" }),
    prs: async () => ({ mine: [pr({ repo: "northwind/shop", number: 3, url: "https://git.example.com/northwind/shop/-/merge_requests/3" })], review: [] }),
    notes: async () => [],
    moves: async () => [],
    prRefs: async () => new Map(),
    prKeyOfUrl: (url) => {
      const m = url.match(/^https:\/\/git\.example\.com\/(.+?)\/-\/merge_requests\/(\d+)/);
      return m ? `${m[1]}#${m[2]}` : undefined;
    },
    ...o,
  };
}

const packWith = (forge: Pack["forge"]): Pack => ({ manifest: { api: PACK_API, id: "lab-forge", name: "Lab forge", description: "A forge for tests.", domain: "work" }, forge });

test("FORGE: unset or github is GitHub; another id is the pack's forge, made from the pack env", () => {
  const github = githubForge(fakeGhe({}).ghe);
  assert.equal(forgeIdOf(undefined), "github");
  assert.equal(forgeIdOf("  GitLab "), "gitlab");
  assert.equal(pickForge(undefined, [], () => github, {}), github);
  assert.equal(pickForge("GitHub", [packWith({ id: "github", name: "Fake", create: () => bareForge() })], () => github, {}), github);

  let seen: Record<string, string | undefined> = {};
  const lab = pickForge("LAB", [packWith({ id: "lab", name: "Lab", create: (env) => ((seen = env), bareForge()) })], () => github, { LAB_TOKEN: "t" });
  assert.equal(lab.id, "lab");
  assert.equal(seen.LAB_TOKEN, "t");
});

test("FORGE naming a forge no pack brings, or one that won't start, fails every call saying why (never falls back to GitHub)", async () => {
  const github = () => assert.fail("must not fall back to GitHub");
  const missing = pickForge("gitlab", [], github, {});
  assert.deepEqual(missing.can, []);
  await assert.rejects(missing.prs("me", "acme"), /No pack brings the forge "gitlab"/);
  await assert.rejects(missing.viewer(), /PACKS/);

  const broken = pickForge("lab", [packWith({ id: "lab", name: "Lab", create: () => { throw new Error("no LAB_TOKEN"); } })], github, {});
  await assert.rejects(broken.notes(), /The Lab forge didn't start: no LAB_TOKEN/);
});

test("GitHub as a forge: every ability, its host, and GitHub's PR links", () => {
  const f = githubForge(fakeGhe({}).ghe);
  assert.equal(f.id, "github");
  assert.equal(f.can.length, 7);
  assert.equal(f.prKeyOfUrl("https://acme.ghe.com/ACME/shop-api/pull/5"), "ACME/shop-api#5");
  assert.equal(f.prKeyOfUrl("https://git.example.com/northwind/shop/-/merge_requests/3"), undefined);
});

test("the gather on a forge with no deploys, changelogs or red branches: those are empty, not failed", async () => {
  const g = createGatherer({ env: { GHE_ORG: "northwind" }, forge: bareForge(), login: "kari", linked: () => ["https://git.example.com/northwind/shop/-/merge_requests/3"] });
  const s = await g.get();
  assert.ok(s.prs.ok && s.prs.value.mine.length === 1);
  assert.deepEqual(s.deploys, { ok: true, value: [] });
  assert.equal(s.changelogs.size, 0);
  assert.deepEqual(s.red, []);
  // The forge's own PR links key the refs: the open MR is known from the gather itself.
  assert.equal(s.refs.get("northwind/shop#3")?.state, "OPEN");
});

test("a forge that can't serve issues, the viewer, stacks, deploy approval, stats or reviews: those pages aren't there", async () => {
  const s = snapshot();
  const { get, post } = signedIn(s, {}, { forge: { id: "lab", name: "Lab", can: [] } });
  for (const path of ["/issues/new", "/prs/ACME/shop-api/2", "/prs/ACME/shop-api/2/files", "/prs/stacks", "/stats", "/prs/agent", "/prs/draft"])
    assert.equal((await get(path)).status, 404, path);
  assert.equal((await post("/deploys/approve", { repo: "ACME/shop-api", run: "1" })).status, 404);
  // The rest is still here.
  for (const path of ["/", "/prs", "/deploys"]) assert.equal((await get(path)).status, 200, path);

  const home = await (await get("/")).text();
  assert.doesNotMatch(home, /href="\/issues\/new"/);
  assert.doesNotMatch(home, /href="\/stats"/);
  const found = await (await get("/search?q=stacks")).text();
  assert.doesNotMatch(found, /href="\/prs\/stacks"/);
  const task = await (await get("/search?q=dev%20task")).text();
  assert.doesNotMatch(task, /href="\/issues\/new/);
});

test("GitHub (the default) keeps every page", async () => {
  const { get } = signedIn(snapshot());
  for (const path of ["/issues/new", "/prs/stacks"]) assert.notEqual((await get(path)).status, 404, path);
  assert.match(await (await get("/")).text(), /href="\/issues\/new"/);
  assert.match(await (await get("/search?q=stacks")).text(), /href="\/prs\/stacks"/);
  assert.match(await (await get("/search?q=dev%20task")).text(), /href="\/issues\/new/);
});

test("a forge without the viewer or deploy approval: PRs open on the forge, deploys are listed without buttons", async () => {
  const mr = pr({ repo: "ACME/shop", number: 3, title: "Faster checkout", url: "https://git.example.com/ACME/shop/-/merge_requests/3" });
  const s = snapshot({ prs: { ok: true, value: { mine: [mr], review: [] } }, deploys: { ok: true, value: [deploy()] } });
  const lab = signedIn(s, {}, { forge: { id: "lab", name: "Lab", can: [] } });
  const gh = signedIn(s);

  const prs = await (await lab.get("/prs")).text();
  assert.match(prs, /href="https:\/\/git\.example\.com\/ACME\/shop\/-\/merge_requests\/3"[^>]*>Open on Lab ↗/);
  assert.doesNotMatch(prs, /href="\/prs\/ACME\/shop\/3/);
  assert.doesNotMatch(prs, /href="\/prs\/stacks"/);
  const ghPrs = await (await gh.get("/prs")).text();
  assert.match(ghPrs, /href="\/prs\/ACME\/shop\/3"/);
  assert.match(ghPrs, /href="\/prs\/stacks"/);

  for (const path of ["/", "/deploys"]) {
    assert.doesNotMatch(await (await lab.get(path)).text(), /action="\/deploys\/approve"/, path);
    assert.match(await (await gh.get(path)).text(), /action="\/deploys\/approve"/, path);
  }
  assert.match(await (await lab.get("/")).text(), /href="\/prs\/ACME\/shop\/3"|merge_requests\/3/);
  assert.doesNotMatch(await (await lab.get("/")).text(), /href="\/prs\/ACME\/shop\/3"/);

  const found = await (await lab.get("/search?q=checkout")).text();
  assert.match(found, /merge_requests\/3/);
  assert.doesNotMatch(found, /href="\/prs\/ACME\/shop\/3"/);
  assert.match(await (await gh.get("/search?q=checkout")).text(), /href="\/prs\/ACME\/shop\/3"/);
});
