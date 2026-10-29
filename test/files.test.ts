/** Packs read the owners' repos (#139): which repos there are and one file's text, checked against the owners and kept a few minutes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ghe } from "../src/sources/ghe.ts";
import { loadEveryRepo, loadFile, loadRepos, MAX_FILE, ownedRepo, packReads, repoPath } from "../src/sources/files.ts";
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

test("files: every repo's files in one GraphQL call per owner (#294): missing, binary or too-big files left out, other owners dropped", async () => {
  const asked: string[] = [];
  const g = ghe(() => assert.fail("no REST"), (q) => {
    asked.push(q);
    return {
      repositoryOwner: {
        repositories: {
          nodes: [
            { nameWithOwner: "acme/site", pushedAt: "2026-10-29T10:00:00Z", f0: { text: "name: site\n", byteSize: 11, isBinary: false }, f1: null },
            { nameWithOwner: "acme/bare", pushedAt: "2026-10-28T10:00:00Z", f0: null, f1: null },
            { nameWithOwner: "acme/bin", f0: { text: null, byteSize: 9, isBinary: true }, f1: { text: "x", byteSize: MAX_FILE + 1, isBinary: false } },
            { nameWithOwner: "evil/x", f0: { text: "no", byteSize: 2 } },
          ],
        },
      },
    };
  });
  const got = await loadEveryRepo(g, "acme", ["peak.yaml", "peak.yml", "../etc/passwd"]);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /f0: object\(expression: "HEAD:peak\.yaml"\)/);
  assert.match(asked[0]!, /f1: object\(expression: "HEAD:peak\.yml"\)/);
  assert.doesNotMatch(asked[0]!, /passwd/, "a path that isn't plain isn't asked");
  assert.deepEqual(got, [
    { repo: "acme/site", pushedAt: "2026-10-29T10:00:00Z", files: { "peak.yaml": "name: site\n" } },
    { repo: "acme/bare", pushedAt: "2026-10-28T10:00:00Z", files: {} },
    { repo: "acme/bin", files: {} },
  ]);
});

/** forge_reads as a map, standing in for D1. */
const sharedMap = () => {
  const m = new Map<string, { at: number; value: string }>();
  return { m, get: async (k: string) => m.get(k), put: async (k: string, at: number, value: string) => void m.set(k, { at, value }) };
};

test("files: an every-repo read is kept for every isolate up to the age the pack takes (#294); 0 reads it now", async () => {
  let t = 1000;
  const shared = sharedMap();
  let n = 0;
  const src = { everyRepo: async (o: string, ps: string[]) => (n++, [{ repo: `${o}/site`, files: { [ps[0]!]: `read ${n}` } }]) };
  const a = packReads(src, () => "acme", { now: () => t, shared });
  const b = packReads(src, () => "acme", { now: () => t, shared });
  const day = 24 * 3600_000;
  const first = await a.everyRepo!(["peak.yml", "peak.yaml"], { maxAgeMs: day });
  assert.deepEqual(first, { at: 1000, repos: [{ repo: "acme/site", files: { "peak.yaml": "read 1" } }] }, "paths sorted: one key whatever the order");
  t += 3 * 3600_000;
  assert.deepEqual(await b.everyRepo!(["peak.yaml", "peak.yml"], { maxAgeMs: day }), first, "another isolate gets the same read, with when it was read");
  assert.equal(n, 1);
  assert.equal((await b.everyRepo!(["peak.yaml", "peak.yml"], { maxAgeMs: 3600_000 })).repos[0]!.files["peak.yaml"], "read 2", "too old for this asker: read again");
  assert.equal((await a.everyRepo!(["peak.yaml", "peak.yml"], { maxAgeMs: 0 })).repos[0]!.files["peak.yaml"], "read 3", "0: now");
  assert.equal((await a.everyRepo!(["peak.yaml", "peak.yml"], { maxAgeMs: 10 * day })).at, t, "older than 24 h is never asked for");
  assert.equal(n, 3);
  await assert.rejects(a.everyRepo!(["../x"]), /Not paths to read/);
  await assert.rejects(a.everyRepo!([]), /Not paths to read/);
  await assert.rejects(a.everyRepo!(["a", "b", "c", "d", "e", "f", "g"]), /Not paths to read/);
});

test("files: a file read is shared through D1 too, and one D1 can't answer is read from the forge", async () => {
  let t = 0;
  const shared = sharedMap();
  let n = 0;
  const src = { file: async () => (n++, undefined) };
  await packReads(src, () => "acme", { now: () => t, shared }).file!("acme/site", "peak.yaml");
  assert.equal(await packReads(src, () => "acme", { now: () => t, shared }).file!("acme/site", "peak.yaml"), undefined, "none is kept as none");
  assert.equal(n, 1);
  const broken = { get: async () => Promise.reject(new Error("D1 down")), put: async () => Promise.reject(new Error("D1 down")) };
  assert.equal(await packReads({ file: async () => "x" }, () => "acme", { shared: broken }).file!("acme/site", "a"), "x");
});

test("files: a pack reads every repo through ctx.forge(), kept in the instance's D1", async () => {
  let n = 0;
  const reader = pack(
    { id: "reader" },
    {
      routes: (app, ctx) => {
        app.get("/reader", async (c) => c.json((await ctx.forge()?.everyRepo?.(["peak.yaml"], { maxAgeMs: 3600_000 }))?.repos));
      },
    },
  );
  const { get, db } = signedIn(snapshot(), {}, { packs: [reader], forge: { id: "github", name: "GitHub", can: [], host: "github.com", everyRepo: async (o, ps) => (n++, [{ repo: `${o}/site`, files: { [ps[0]!]: "x" } }]) } });
  assert.deepEqual(await (await get("/reader")).json(), [{ repo: "ACME/site", files: { "peak.yaml": "x" } }]);
  const row = await db.DB.prepare("SELECT key FROM forge_reads").first<{ key: string }>();
  assert.equal(row?.key, "every:ACME:peak.yaml");
  assert.equal(n, 1);
});
