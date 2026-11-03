/** Hosted: newer pack releases read from dovre-packs' tags on GitHub (#362), and the CLI's own clone. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePacksRepo } from "../src/packs/cli.ts";
import { availableFor, createReleases, type GetJson, listedFor, listedOf, newestOf } from "../src/packs/releases.ts";
import { PACK_API } from "../src/packs/types.ts";
import { packsPage } from "../src/pages/packs.ts";
import type { ToAdd } from "../src/packs/copies.ts";
import { assertInert, H } from "./helpers.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** A fake GitHub holding dovre-packs' tags and, at each tag, the files given. */
function fakeGithub(tags: string[], files: Record<string, string>) {
  const asked: string[] = [];
  const get: GetJson = async (path) => {
    asked.push(path);
    if (path === "/repos/bergaaberg/dovre-packs/git/matching-refs/tags/") return tags.map((t) => ({ ref: `refs/tags/${t}` }));
    const m = path.match(/^\/repos\/bergaaberg\/dovre-packs\/contents\/(.+)\?ref=(.+)$/);
    const body = m ? files[`${decodeURIComponent(m[2]!)}:${m[1]}`] : undefined;
    if (body === undefined) throw new Error(`GitHub 404 ${path}`);
    return { content: b64(body), encoding: "base64" };
  };
  return { get, asked };
}

test("newestOf picks each pack's newest x.y.z tag and ignores the rest", () => {
  const n = newestOf(["refs/tags/foo@1.0.0", "foo@1.10.0", "foo@1.9.3", "bar@0.1.0", "foo@latest", "v1.2.3", "Bad@1.0.0"]);
  assert.deepEqual([...n], [
    ["foo", { tag: "foo@1.10.0", version: "1.10.0" }],
    ["bar", { tag: "bar@0.1.0", version: "0.1.0" }],
  ]);
});

test("availableFor: only packs behind their newest release, with what changed since and the core it needs", async () => {
  const changelog = "# foo\n\n## Unreleased\n\n## 1.2.0\n\n- Draws the <b>chart</b>\n\n## 1.1.0\n\n- Faster\n\n## 1.0.0\n\n- First\n";
  const { get, asked } = fakeGithub(["foo@1.0.0", "foo@1.2.0", "bar@2.0.0", "baz@1.0.0"], {
    "foo@1.2.0:packs/foo/CHANGELOG.md": changelog,
    "foo@1.2.0:packs/foo/index.ts": `export const fooPack = { id: "foo", api: "1.0", version: "1.2.0" };`,
    "bar@2.0.0:packs/bar/index.ts": `export const barPack = { id: "bar", api: "99.0" };`,
  });
  const out = await availableFor(get, [
    { id: "foo", version: "1.0.0" },
    { id: "bar", version: "1.0.0" },
    { id: "baz", version: "1.0.0" },
    { id: "mine", version: "1.0.0" },
  ]);
  assert.deepEqual([...out.keys()].sort(), ["bar", "foo"], "baz is current; mine has no release");
  const foo = out.get("foo")!;
  assert.equal(foo.version, "1.2.0");
  assert.deepEqual(foo.notes.map((n) => n.version), ["1.2.0", "1.1.0"]);
  assert.equal(foo.notes[0]!.lines[0], "Draws the <b>chart</b>");
  assert.equal(foo.needsCore, false);
  const bar = out.get("bar")!;
  assert.deepEqual(bar.notes, [], "no changelog: no notes, still listed");
  assert.equal(bar.api, "99.0");
  assert.equal(bar.needsCore, true);
  assert.equal(asked.filter((p) => p.includes("/contents/packs/baz")).length, 0, "a current pack costs no more calls");
});

test("createReleases reads once an hour in the background, keeps the last answer when GitHub fails", async () => {
  let t = 0;
  let fail = false;
  let changes = 0;
  const { get } = fakeGithub(["foo@2.0.0"], {});
  const r = createReleases({
    get: (p) => (fail ? Promise.reject(new Error("GitHub 502")) : get(p)),
    packs: () => [{ id: "foo", version: "1.0.0" }, { id: "nover" }],
    now: () => t,
    onChange: () => changes++,
  });
  assert.equal(r.get(), undefined);
  await r.refresh();
  assert.equal(r.get()!.available.get("foo")?.version, "2.0.0");
  assert.equal(changes, 1);
  t += 60_000;
  assert.equal(r.refresh(), undefined, "not due yet");
  t += 3600_000;
  fail = true;
  await r.refresh();
  assert.match(r.get()!.error ?? "", /502/);
  assert.equal(r.get()!.available.get("foo")?.version, "2.0.0", "the last answer stays");
});

test("the hosted Packs page says what's available, keeps release notes inert, and says how to take it", () => {
  const manifest = { api: PACK_API, id: "foo", name: "Foo", description: "d", version: "1.0.0", domain: "personal" as const };
  const frame = { operator: "me", nav: [] };
  const available = new Map([["foo", { version: "1.2.0", tag: "foo@1.2.0", api: "99.0", needsCore: true, notes: [{ version: "1.2.0", lines: [H] }] }]]);
  const out = String(packsPage(frame, { on: [{ manifest }], off: [], env: {}, hosted: true, releases: { at: Date.now(), available } }));
  assertInert("/packs hosted", out);
  assert.match(out, /1\.2\.0 available/);
  assert.match(out, /needs core API 99\.0: update Dovre first/);
  assert.match(out, /What changed in 1\.2\.0/);
  assert.match(out, /<code>pnpm packs update foo<\/code>, then deploy/);
  assert.match(out, /Checked dovre-packs for newer releases/);
  const failed = String(packsPage(frame, { on: [{ manifest }], off: [], env: {}, hosted: true, releases: { at: Date.now(), available: new Map(), error: H } }));
  assertInert("/packs hosted error", failed);
  assert.match(failed, /Couldn't read dovre-packs' releases/);
});

test("with no checkout, the CLI clones dovre-packs into its cache with every tag, and syncs it next time", () => {
  const git = (dir: string, ...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const root = mkdtempSync(join(tmpdir(), "packs-cache-"));
  const upstream = join(root, "upstream");
  mkdirSync(join(upstream, "packs", "foo"), { recursive: true });
  writeFileSync(join(upstream, "packs", "foo", "index.ts"), "export const fooPack = {};\n");
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "foo");
  git(upstream, "tag", "foo@1.0.0");
  const core = join(root, "core");
  mkdirSync(core);
  const cache = join(root, "cache", "dovre-packs");
  const was = { repo: process.env.DOVRE_PACKS_REPO, dir: process.env.DOVRE_PACKS_DIR };
  process.env.DOVRE_PACKS_REPO = `file://${upstream}`;
  delete process.env.DOVRE_PACKS_DIR;
  try {
    assert.throws(() => resolvePacksRepo(undefined, core, false, cache), /Could not find dovre-packs/, "no cloning when not allowed");
    assert.equal(resolvePacksRepo(undefined, core, true, cache), cache);
    assert.equal(git(cache, "tag", "--list"), "foo@1.0.0");
    writeFileSync(join(upstream, "packs", "foo", "index.ts"), "export const fooPack = { version: \"1.1.0\" };\n");
    git(upstream, "commit", "-qam", "1.1.0");
    git(upstream, "tag", "foo@1.1.0");
    assert.equal(resolvePacksRepo(undefined, core, false, cache), cache, "found without syncing");
    assert.equal(git(cache, "tag", "--list", "foo@1.1.0"), "");
    resolvePacksRepo(undefined, core, true, cache);
    assert.equal(git(cache, "tag", "--list", "foo@1.1.0"), "foo@1.1.0");
    assert.equal(git(cache, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"), "the cache follows origin");
    assert.ok(!existsSync(join(root, "dovre-packs")), "nothing cloned beside core");
  } finally {
    if (was.repo === undefined) delete process.env.DOVRE_PACKS_REPO;
    else process.env.DOVRE_PACKS_REPO = was.repo;
    if (was.dir !== undefined) process.env.DOVRE_PACKS_DIR = was.dir;
  }
});

test("listedOf reads a manifest's literals as text, the ones after its own id (#88)", () => {
  const index = `const forge = { id: "gitlab", name: "Forge name" };\nexport const p = { manifest: { api: "1.6", version: "1.2.0", id: "gitlab", name: "GitLab", description: 'It\\'s a "forge"', domain: "work", execution: "local-only" } };`;
  const l = listedOf("gitlab", index, { tag: "gitlab@1.2.0", version: "1.2.0" });
  assert.equal(l.name, "Forge name", "the first object naming its id wins");
  const own = listedOf("x", `export const p = { manifest: { api: "99.1", id: "x", description: "Draws the <b>chart</b>", execution: "nowhere" } };`);
  assert.deepEqual([own.name, own.version, own.needsCore, own.execution, own.domain], ["x", null, true, "any", "general"]);
  assert.equal(listedOf("gitlab", index.replace("const forge = { id: \"gitlab\", name: \"Forge name\" };", "")).description, `It's a "forge"`);
});

test("listedFor: each released pack not here, read at its newest tag; hosted shows the command, or Add once INSTANCE_REPO is set", async () => {
  const { get } = fakeGithub(["foo@1.0.0", "new@1.0.0", "new@1.1.0", "mac@1.0.0", "gone@1.0.0"], {
    "new@1.1.0:packs/new/index.ts": `export const p = { manifest: { api: "${PACK_API}", version: "1.1.0", id: "new", name: "${H}", description: "${H}" } };`,
    "mac@1.0.0:packs/mac/index.ts": `export const p = { manifest: { api: "${PACK_API}", id: "mac", name: "Mac", execution: "local-only" } };`,
  });
  const listed = await listedFor(get, ["foo"]);
  assert.deepEqual(listed.map((l) => [l.id, l.version, l.tag]), [["mac", "1.0.0", "mac@1.0.0"], ["new", "1.1.0", "new@1.1.0"]], "foo is here; gone has no index.ts at its tag");
  const page = (into?: string, packs: ToAdd[] = listed) => String(packsPage({ user: "me", nav: [] } as never, { on: [], off: [], env: {}, hosted: true, toAdd: { packs, into } }));
  const out = page();
  assertInert("/packs", out);
  assert.match(out, /pnpm packs add new/);
  assert.doesNotMatch(out, /pnpm packs add mac/, "nothing to run for a pack that can't run hosted");
  assert.match(out, /runs on a machine only/);
  assert.match(out, /Set the var <code>INSTANCE_REPO<\/code>/);
  assert.doesNotMatch(out, /\/packs\/new\/add/);
  const set = page(H);
  assertInert("/packs", set);
  assert.match(set, /action="\/packs\/new\/add"/);
  assert.doesNotMatch(set, /\/packs\/mac\/add/);
  const opened = page(H, [{ ...listed[1]!, job: { at: 0, state: "done", step: "PR opened; merge it, then deploy", url: "javascript:alert(1)" } }]);
  assertInert("/packs", opened);
  assert.doesNotMatch(opened, /href="javascript:/, "the logged PR link goes through safeUrl");
  assert.doesNotMatch(opened, /\/packs\/new\/add/, "no second PR while one is open");
});
