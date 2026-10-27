/** Packs read the owners' repos (#139): which repos there are and one file's text, checked against the owners and kept a few minutes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ghe } from "../src/sources/ghe.ts";
import { loadFile, loadRepos, MAX_FILE, ownedRepo, packReads, repoPath } from "../src/sources/files.ts";
import { type Pack, PACK_API, type PackManifest } from "../src/packs/types.ts";
import { signedIn, snapshot } from "./helpers.ts";

const pack = (o: Partial<PackManifest> & { id: string }, hooks: Partial<Pack> = {}): Pack => ({ manifest: { api: PACK_API, name: o.id, description: "", domain: "personal", ...o }, ...hooks });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const ghe = (rest: (path: string) => unknown, graphql: (q: string) => unknown = () => ({})): Ghe & { paths: string[] } => {
  const paths: string[] = [];
  return {
    host: "github.com",
    paths,
    rest: async <T>(path: string) => (paths.push(path), (await rest(path)) as T),
    graphql: async <T>(q: string) => (await graphql(q)) as T,
  };
};

test("files: only the owners' repos, and plain relative paths", () => {
  assert.equal(ownedRepo("acme, me", "Acme/site"), "Acme/site");
  for (const r of ["other/site", "acme/..", "acme", "acme/a/b", "acme/si te", 7]) assert.equal(ownedRepo("acme", r), undefined, String(r));
  assert.equal(repoPath("peak.yaml"), "peak.yaml");
  assert.equal(repoPath(".github/peak.yaml"), ".github/peak.yaml");
  for (const p of ["/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "a/", "a?b", "a%2e", "x".repeat(301), ""]) assert.equal(repoPath(p), undefined, p);
});

test("files: a file's text decoded (UTF-8); none, a folder, or one too big is undefined; other failures throw", async () => {
  const g = ghe((path) => {
    if (path.endsWith("/peak.yaml")) return { type: "file", encoding: "base64", content: b64("name: blåbær\n").replace(/(.{4})/g, "$1\n"), size: 14 };
    if (path.endsWith("/dir")) return [{ type: "file" }];
    if (path.endsWith("/big")) return { type: "file", encoding: "base64", content: "", size: MAX_FILE + 1 };
    if (path.endsWith("/down")) throw new Error(`GHE GET ${path}: 502 bad gateway`);
    throw new Error(`GHE GET ${path}: 404 {"message":"Not Found"}`);
  });
  assert.equal(await loadFile(g, "acme/site", "peak.yaml"), "name: blåbær\n");
  assert.equal(await loadFile(g, "acme/site", "nope.yaml"), undefined);
  assert.equal(await loadFile(g, "acme/site", "dir"), undefined);
  assert.equal(await loadFile(g, "acme/site", "big"), undefined);
  await assert.rejects(loadFile(g, "acme/site", "down"), /502/);
  assert.equal(g.paths[0], "/repos/acme/site/contents/peak.yaml");
});

test("files: the repos of each owner, archived ones left out by the query, anything outside the owners dropped", async () => {
  const asked: string[] = [];
  const g = ghe(() => ({}), (q) => {
    asked.push(q);
    return { repositoryOwner: { repositories: { nodes: [{ nameWithOwner: q.includes('"acme"') ? "acme/site" : "me/dots" }, { nameWithOwner: "evil/x" }] } } };
  });
  assert.deepEqual(await loadRepos(g, "acme, me, bad\"owner"), ["acme/site", "me/dots"]);
  assert.equal(asked.length, 2, "an owner that isn't a plain login isn't asked");
  assert.match(asked[0]!, /isArchived: false/);
});

test("files: packs' reads are checked before asking, kept a few minutes, and a failure isn't kept", async () => {
  let t = 0;
  const calls: string[] = [];
  let fail = true;
  const reads = packReads(
    {
      repos: async (o) => (calls.push(`repos ${o}`), ["acme/site"]),
      file: async (r, p) => {
        calls.push(`file ${r} ${p}`);
        if (p === "flaky" && fail) throw new Error("502");
        return "x";
      },
    },
    () => "acme",
    { ttlMs: 1000, now: () => t },
  );
  await reads.repos!();
  await reads.repos!();
  assert.equal(await reads.file!("acme/site", "peak.yaml"), "x");
  assert.equal(await reads.file!("ACME/site", "peak.yaml"), "x", "same repo, other case: kept");
  t = 1001;
  await reads.file!("acme/site", "peak.yaml");
  await assert.rejects(reads.file!("other/site", "peak.yaml"), /Not a file in your repos/);
  await assert.rejects(reads.file!("acme/site", "../secrets"), /Not a file in your repos/);
  await assert.rejects(reads.file!("acme/site", "flaky"), /502/);
  fail = false;
  assert.equal(await reads.file!("acme/site", "flaky"), "x", "asked again after a failure");
  assert.deepEqual(calls, ["repos acme", "file acme/site peak.yaml", "file acme/site peak.yaml", "file acme/site flaky", "file acme/site flaky"]);
});

test("files: a pack reads them through ctx.forge(), in the instance's owners only", async () => {
  const reader = pack(
    { id: "reader" },
    {
      routes: (app, ctx) => {
        app.get("/reader", async (c) => {
          const f = ctx.forge();
          const refused = await f?.file?.("other/x", "peak.yaml").then(() => "read", (e: Error) => e.message);
          return c.json({ repos: await f?.repos?.(), peak: await f?.file?.("ACME/site", "peak.yaml"), refused });
        });
      },
    },
  );
  const { get } = signedIn(snapshot(), {}, { packs: [reader], forge: { id: "github", name: "GitHub", can: [], host: "github.com", repos: async (o) => [`${o}/site`], file: async (r, p) => `${r}:${p}` } });
  assert.deepEqual(await (await get("/reader")).json(), { repos: ["ACME/site"], peak: "ACME/site:peak.yaml", refused: "Not a file in your repos: other/x/peak.yaml" });
});
