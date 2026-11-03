/** Hosted Add (#88): a PR on the instance repo with the release's files, its .pack.json and the packs.ts line. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { proposeAdd } from "../src/actions/addpack.ts";
import type { GetJson } from "../src/packs/releases.ts";
import { PACK_API } from "../src/packs/types.ts";
import type { Ghe } from "../src/sources/ghe.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { activePacks } from "../src/packs/registry.ts";
import { recentActions } from "../src/actions/deploys.ts";
import { fixedGatherer, snapshot } from "./helpers.ts";

const b64 = (b: string | Uint8Array) => Buffer.from(b).toString("base64");
const INDEX = `export const fooBarPack = { manifest: { api: "${PACK_API}", version: "1.2.0", id: "foo-bar", name: "Foo bar" } };\n`;
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** dovre-packs at foo-bar@1.2.0 (an annotated tag), with a text file, a wasm file and a node_modules file left out. */
function packsRepo(index = INDEX): { get: GetJson; asked: string[] } {
  const blobs: Record<string, string> = { b1: b64(index), b2: b64("## 1.2.0\n\n- Draws foo\n"), b3: b64(WASM), b4: b64("junk") };
  const asked: string[] = [];
  const get: GetJson = async (path) => {
    asked.push(path);
    const S = "/repos/bergaaberg/dovre-packs";
    if (path === `${S}/git/matching-refs/tags/`) return [{ ref: "refs/tags/foo-bar@1.0.0" }, { ref: "refs/tags/foo-bar@1.2.0" }];
    if (path === `${S}/git/ref/tags/foo-bar%401.2.0`) return { object: { type: "tag", sha: "tagobj" } };
    if (path === `${S}/git/tags/tagobj`) return { object: { type: "commit", sha: "c120" } };
    if (path === `${S}/git/commits/c120`) return { tree: { sha: "t120" } };
    if (path === `${S}/git/trees/t120?recursive=1`)
      return {
        tree: [
          { path: "packs/foo-bar", type: "tree", mode: "040000", sha: "x" },
          { path: "packs/foo-bar/index.ts", type: "blob", mode: "100644", sha: "b1", size: 10 },
          { path: "packs/foo-bar/CHANGELOG.md", type: "blob", mode: "100644", sha: "b2", size: 10 },
          { path: "packs/foo-bar/grammar.wasm", type: "blob", mode: "100644", sha: "b3", size: 8 },
          { path: "packs/foo-bar/node_modules/x.js", type: "blob", mode: "100644", sha: "b4", size: 4 },
          { path: "packs/foo-bar/.pack.json", type: "blob", mode: "100644", sha: "b4", size: 4 },
          { path: "packs/other/index.ts", type: "blob", mode: "100644", sha: "b4", size: 4 },
        ],
      };
    if (path === `${S}/contents/packs/foo-bar/index.ts?ref=foo-bar%401.2.0`) return { content: blobs.b1, encoding: "base64" };
    const blob = path.match(/\/git\/blobs\/(\w+)$/);
    if (blob && blobs[blob[1]!]) return { content: blobs[blob[1]!], encoding: "base64" };
    throw new Error(`GitHub 404 for ${path}`);
  };
  return { get, asked };
}

/** The instance repo: main with a packs.ts; records every write. */
function instance(o: { has?: boolean; prFails?: boolean } = {}) {
  const writes: { method: string; path: string; body: any }[] = [];
  const ghe: Ghe = {
    host: "github.com",
    graphql: async () => ({}) as never,
    rest: async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      const method = init?.method ?? "GET";
      const R = "/repos/me/home";
      if (method !== "GET") {
        writes.push({ method, path, body: init?.body });
        if (path === `${R}/git/blobs`) return { sha: "upl1" } as T;
        if (path === `${R}/git/trees`) return { sha: "newtree" } as T;
        if (path === `${R}/git/commits`) return { sha: "newcommit" } as T;
        if (path === `${R}/git/refs`) return {} as T;
        if (path === `${R}/pulls`) {
          if (o.prFails) throw new Error("GHE POST /pulls: 422 Validation Failed");
          return { number: 7, html_url: "https://github.com/me/home/pull/7" } as T;
        }
        return {} as T;
      }
      if (path === R) return { default_branch: "main" } as T;
      if (path === `${R}/contents/packs.ts?ref=main`) return { type: "file", content: b64('import { aPack } from "./packs/a/index.ts";\nexport default [aPack];\n') } as T;
      if (path === `${R}/contents/packs/foo-bar?ref=main` && o.has) return [] as T;
      if (path === `${R}/git/ref/heads/main`) return { object: { sha: "head" } } as T;
      if (path === `${R}/git/commits/head`) return { tree: { sha: "basetree" } } as T;
      throw new Error(`GHE GET ${path}: 404 Not Found`);
    },
  };
  return { ghe, writes };
}

test("proposeAdd: one commit with the release's files, .pack.json and packs.ts wired, on a branch, then the PR", async () => {
  const { get } = packsRepo();
  const { ghe, writes } = instance();
  const pr = await proposeAdd(ghe, get, { repo: "me/home", id: "foo-bar" });
  assert.deepEqual(pr, { number: 7, url: "https://github.com/me/home/pull/7", version: "1.2.0" });
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path.replace("/repos/me/home", "")}`), ["POST /git/blobs", "POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
  assert.equal(writes[0]!.body.content, b64(WASM), "only the binary file is uploaded as a blob");
  const tree = writes[1]!.body as { base_tree: string; tree: { path: string; content?: string; sha?: string }[] };
  assert.equal(tree.base_tree, "basetree");
  const byPath = new Map(tree.tree.map((t) => [t.path, t]));
  assert.deepEqual([...byPath.keys()].sort(), ["packs.ts", "packs/foo-bar/.pack.json", "packs/foo-bar/CHANGELOG.md", "packs/foo-bar/grammar.wasm", "packs/foo-bar/index.ts"]);
  assert.equal(byPath.get("packs/foo-bar/index.ts")!.content, INDEX);
  assert.equal(byPath.get("packs/foo-bar/grammar.wasm")!.sha, "upl1");
  assert.match(byPath.get("packs.ts")!.content!, /import \{ fooBarPack \} from "\.\/packs\/foo-bar\/index\.ts";\nexport default \[aPack, fooBarPack\];/);
  const meta = JSON.parse(byPath.get("packs/foo-bar/.pack.json")!.content!);
  const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
  assert.deepEqual(meta, {
    source: "bergaaberg/dovre-packs",
    commit: "c120",
    tag: "foo-bar@1.2.0",
    version: "1.2.0",
    api: PACK_API,
    files: { "CHANGELOG.md": sha("## 1.2.0\n\n- Draws foo\n"), "grammar.wasm": sha(WASM), "index.ts": sha(INDEX) },
  });
  assert.deepEqual(writes[2]!.body.parents, ["head"]);
  assert.deepEqual(writes[3]!.body, { ref: "refs/heads/dovre/add-foo-bar", sha: "newcommit" });
  assert.equal(writes[4]!.body.head, "dovre/add-foo-bar");
  assert.match(writes[4]!.body.body, /- Draws foo/);
});

test("proposeAdd writes nothing for a pack already there, one needing a newer core, or a bad id; a failed PR deletes its branch", async () => {
  const has = instance({ has: true });
  await assert.rejects(proposeAdd(has.ghe, packsRepo().get, { repo: "me/home", id: "foo-bar" }), /packs\/foo-bar is in me\/home already/);
  assert.deepEqual(has.writes, []);
  const future = instance();
  await assert.rejects(proposeAdd(future.ghe, packsRepo(INDEX.replace(PACK_API, "99.0")).get, { repo: "me/home", id: "foo-bar" }), /needs core API 99\.0/);
  assert.deepEqual(future.writes, []);
  const bad = instance();
  await assert.rejects(proposeAdd(bad.ghe, packsRepo().get, { repo: "me/home", id: "../x" }), /isn't a pack id/);
  await assert.rejects(proposeAdd(bad.ghe, packsRepo().get, { repo: "me/home", id: "nope" }), /nope has no release/);
  assert.deepEqual(bad.writes, []);
  const fails = instance({ prFails: true });
  await assert.rejects(proposeAdd(fails.ghe, packsRepo().get, { repo: "me/home", id: "foo-bar" }), /422/);
  assert.deepEqual(fails.writes.at(-1), { method: "DELETE", path: "/repos/me/home/git/refs/heads/dovre%2Fadd-foo-bar", body: undefined });
});

test("hosted Packs page: Add opens the PR in the background, logs it, then links it; refused without INSTANCE_REPO or outside the owners", async () => {
  const S = "/repos/bergaaberg/dovre-packs";
  const app = (INSTANCE_REPO?: string) => {
    const packs = packsRepo();
    const inst = instance();
    const ghe: Ghe = { host: "github.com", graphql: inst.ghe.graphql, rest: <T>(path: string, init?: { method?: string; body?: unknown }) => (path.startsWith(S) ? (packs.get(path) as Promise<T>) : inst.ghe.rest<T>(path, init)) };
    const db = openDb();
    const a = createApp({ GHE_HOST: "github.com", GHE_ORG: "me", GITHUB_USER: "me", IS_HOSTED: "1", ALLOWED_EMAILS: "me@example.com", PUBLIC_ORIGIN: "https://dovre.example", INSTANCE_REPO, DB: db.DB } as never, {
      gatherer: fixedGatherer(snapshot()),
      ghe,
      access: async () => ({ email: "me@example.com" }),
      packs: { ...activePacks([], { env: {}, bindings: {}, hosted: true }), env: {} },
    });
    const get = async (path: string) => (await a.request(`https://dovre.example${path}`)).text();
    const post = (path: string) => a.request(`https://dovre.example${path}`, { method: "POST", headers: { origin: "https://dovre.example", "content-type": "application/x-www-form-urlencoded" }, body: "" });
    return { get, post, db, writes: inst.writes };
  };
  const settle = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 5));
  };

  const h = app("me/home");
  await h.get("/packs");
  await settle(async () => /id="add-foo-bar"/.test(await h.get("/packs")));
  const before = await h.get("/packs");
  assert.match(before, /Add opens a PR on <code>me\/home<\/code>/);
  assert.match(before, /action="\/packs\/foo-bar\/add"/);
  const res = await h.post("/packs/foo-bar/add");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/packs#add-foo-bar");
  await settle(async () => (await recentActions(h.db.DB)).length > 0);
  const log = await recentActions(h.db.DB);
  assert.deepEqual(log.map((x) => [x.kind, x.target, x.ok, x.detail]), [["packs.add", "foo-bar", 1, "https://github.com/me/home/pull/7"]]);
  const after = await h.get("/packs");
  assert.match(after, /PR opened/);
  assert.match(after, /href="https:\/\/github.com\/me\/home\/pull\/7"/);
  assert.doesNotMatch(after, /action="\/packs\/foo-bar\/add"/);

  for (const repo of [undefined, "stranger/home"]) {
    const n = app(repo);
    await n.get("/packs");
    await settle(async () => /id="add-foo-bar"/.test(await n.get("/packs")));
    const page = await n.get("/packs");
    assert.match(page, /pnpm packs add foo-bar/);
    assert.match(page, /Set the var <code>INSTANCE_REPO<\/code>/);
    assert.equal((await n.post("/packs/foo-bar/add")).status, 404);
    assert.deepEqual(n.writes, []);
  }
});
