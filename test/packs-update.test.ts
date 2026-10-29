/** Copied packs: .pack.json on add, outdated, update with a 3-way merge, track (#152). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addPack } from "../src/packs/cli.ts";
import { describe, outdated, readMeta, sourceAllowed, sourceOfUrl, trackPack, updatePack } from "../src/packs/update.ts";

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

const INDEX = `export const fooPack = {\n  id: "foo",\n  api: PACK_API,\n};\n`;
const DATA = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n") + "\n";

/** A dovre-packs checkout with packs/foo, and an instance with packs.ts. */
function setup(remote = "https://github.com/bergaaberg/dovre-packs.git") {
  const root = mkdtempSync(join(tmpdir(), "packs-update-"));
  const repo = join(root, "dovre-packs");
  const into = join(root, "instance");
  mkdirSync(join(repo, "packs", "foo", "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `{"name":"dovre-packs","version":"0.2.0"}\n`);
  writeFileSync(join(repo, "packs", "foo", "index.ts"), INDEX);
  writeFileSync(join(repo, "packs", "foo", "data.ts"), DATA);
  writeFileSync(join(repo, "packs", "foo", "test", "foo.test.ts"), "// test\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "foo");
  mkdirSync(into);
  writeFileSync(join(into, "packs.ts"), "export default [];\n");
  const commit = (msg: string) => {
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", msg);
  };
  return { root, repo, into, commit, pack: join(into, "packs", "foo"), up: join(repo, "packs", "foo"), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("add writes .pack.json: source, commit, version, api, a hash per file", () => {
  const s = setup();
  try {
    const r = addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    assert.ok(r.wrote.includes("packs/foo/.pack.json"));
    const m = readMeta(s.pack)!;
    assert.equal(m.source, "bergaaberg/dovre-packs");
    assert.equal(m.commit, git(s.repo, "rev-parse", "HEAD"));
    assert.equal(m.version, "0.2.0");
    assert.equal(m.api, 1);
    assert.deepEqual(Object.keys(m.files).sort(), ["data.ts", "index.ts", "test/foo.test.ts"]);
    assert.match(m.files["index.ts"]!, /^[0-9a-f]{64}$/);
    assert.deepEqual(outdated(s.into, s.repo).map(describe), ["foo: up to date"]);
  } finally {
    s.done();
  }
});

test("add skips what git ignores (a Rust target/) and wires the pack, not the first export", () => {
  const s = setup();
  try {
    writeFileSync(join(s.up, "index.ts"), `export const fooWasm = () => new Uint8Array();\n${INDEX}`);
    writeFileSync(join(s.repo, ".gitignore"), "target/\n");
    mkdirSync(join(s.up, "rust", "target", "release"), { recursive: true });
    writeFileSync(join(s.up, "rust", "Cargo.toml"), "[package]\n");
    writeFileSync(join(s.up, "rust", "target", "release", "foo.wasm"), "built");
    s.commit("rust");
    const r = addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    assert.equal(r.exportName, "fooPack");
    assert.match(readFileSync(join(s.into, "packs.ts"), "utf8"), /import \{ fooPack \}/);
    assert.ok(existsSync(join(s.pack, "rust", "Cargo.toml")));
    assert.ok(!existsSync(join(s.pack, "rust", "target")));
    assert.ok(!r.wrote.some((f) => f.includes("target")));
  } finally {
    s.done();
  }
});

test("outdated tells newer upstream from edited here; update takes upstream and merges both sides' edits", () => {
  const s = setup();
  try {
    addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    // Upstream: edits line 1 of data.ts, adds a file, removes the test.
    writeFileSync(join(s.up, "data.ts"), DATA.replace("one", "ONE"));
    writeFileSync(join(s.up, "view.ts"), "// view\n");
    rmSync(join(s.up, "test", "foo.test.ts"));
    s.commit("upstream");
    // Here: edits line 8 of data.ts, and a file of its own.
    writeFileSync(join(s.pack, "data.ts"), DATA.replace("eight", "EIGHT"));
    writeFileSync(join(s.pack, "mine.ts"), "// mine\n");

    const [st] = outdated(s.into, s.repo);
    assert.equal(st!.behind, 1);
    assert.deepEqual(st!.upstream, ["data.ts", "test/foo.test.ts", "view.ts"]);
    assert.deepEqual(st!.edited, ["data.ts", "mine.ts"]);
    assert.match(describe(st!), /newer upstream \(1 commit\).*edited here: data\.ts, mine\.ts/);

    const r = updatePack({ id: "foo", into: s.into, repo: s.repo });
    assert.deepEqual(r.changes, [
      { file: "data.ts", how: "merged" },
      { file: "test/foo.test.ts", how: "removed" },
      { file: "view.ts", how: "added" },
    ]);
    assert.deepEqual(r.kept, ["mine.ts"]);
    assert.equal(readFileSync(join(s.pack, "data.ts"), "utf8"), DATA.replace("one", "ONE").replace("eight", "EIGHT"));
    assert.ok(!existsSync(join(s.pack, "test", "foo.test.ts")));
    assert.equal(readFileSync(join(s.pack, "view.ts"), "utf8"), "// view\n");
    assert.equal(readMeta(s.pack)!.commit, git(s.repo, "rev-parse", "HEAD"));
    // Upstream is now the base: only this instance's own edits remain.
    const [after] = outdated(s.into, s.repo);
    assert.deepEqual(after!.upstream, []);
    assert.deepEqual(after!.edited, ["data.ts", "mine.ts"]);
  } finally {
    s.done();
  }
});

test("a conflict stops the update with nothing written", () => {
  const s = setup();
  try {
    addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    writeFileSync(join(s.up, "data.ts"), DATA.replace("four", "upstream four"));
    writeFileSync(join(s.up, "view.ts"), "// view\n");
    s.commit("upstream");
    writeFileSync(join(s.pack, "data.ts"), DATA.replace("four", "my four"));
    const before = readFileSync(join(s.pack, ".pack.json"), "utf8");
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo }), /can't merge: data\.ts\. Nothing was changed/);
    assert.equal(readFileSync(join(s.pack, "data.ts"), "utf8"), DATA.replace("four", "my four"));
    assert.ok(!existsSync(join(s.pack, "view.ts")));
    assert.equal(readFileSync(join(s.pack, ".pack.json"), "utf8"), before);
  } finally {
    s.done();
  }
});

test("update refuses a newer PACK_API, uncommitted upstream changes, and a source outside REPO_OWNERS", () => {
  const s = setup();
  try {
    addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    writeFileSync(join(s.up, "data.ts"), "dirty\n");
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo }), /uncommitted changes/);
    writeFileSync(join(s.up, "index.ts"), INDEX.replace("PACK_API", "99"));
    s.commit("api 99");
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo }), /needs PACK_API 99/);
    assert.equal(readFileSync(join(s.pack, "index.ts"), "utf8"), INDEX);
  } finally {
    s.done();
  }
  const f = setup("git@github.com:stranger/dovre-packs.git");
  try {
    addPack({ id: "foo", into: f.into, from: f.repo, allowClone: false });
    assert.equal(readMeta(f.pack)!.source, "stranger/dovre-packs");
    assert.throws(() => updatePack({ id: "foo", into: f.into, repo: f.repo, env: { REPO_OWNERS: "me" } }), /isn't dovre-packs or an owner in REPO_OWNERS/);
    assert.doesNotThrow(() => updatePack({ id: "foo", into: f.into, repo: f.repo, env: { REPO_OWNERS: "me, Stranger" } }));
  } finally {
    f.done();
  }
});

test("track finds the commit a pre-.pack.json copy came from, or asks for --at", () => {
  const s = setup();
  try {
    const first = git(s.repo, "rev-parse", "HEAD");
    mkdirSync(join(s.pack, "test"), { recursive: true });
    for (const f of ["index.ts", "data.ts", "test/foo.test.ts"]) writeFileSync(join(s.pack, f), readFileSync(join(s.up, f)));
    writeFileSync(join(s.up, "data.ts"), DATA.replace("two", "TWO"));
    s.commit("later");
    assert.deepEqual(outdated(s.into, s.repo).map(describe), ["foo: copied before .pack.json (pnpm packs track foo)"]);
    assert.equal(trackPack({ id: "foo", into: s.into, repo: s.repo }).commit, first);
    assert.deepEqual(outdated(s.into, s.repo)[0]!.upstream, ["data.ts"]);
    assert.throws(() => trackPack({ id: "foo", into: s.into, repo: s.repo }), /already has/);

    rmSync(join(s.pack, ".pack.json"));
    writeFileSync(join(s.pack, "data.ts"), "edited\n");
    assert.throws(() => trackPack({ id: "foo", into: s.into, repo: s.repo }), /pass --at/);
    trackPack({ id: "foo", into: s.into, repo: s.repo, at: first });
    assert.deepEqual(outdated(s.into, s.repo)[0]!.edited, ["data.ts"]);
  } finally {
    s.done();
  }
});

test("sources: GitHub remotes parse; only dovre-packs and REPO_OWNERS are allowed", () => {
  assert.equal(sourceOfUrl("https://github.com/bergaaberg/dovre-packs.git"), "bergaaberg/dovre-packs");
  assert.equal(sourceOfUrl("git@github.com:me/my-packs"), "me/my-packs");
  assert.equal(sourceOfUrl("https://gitlab.com/me/packs.git"), null);
  assert.ok(sourceAllowed("bergaaberg/dovre-packs", {}));
  assert.ok(!sourceAllowed("me/my-packs", {}));
  assert.ok(sourceAllowed("me/my-packs", { GITHUB_USER: "me" }));
  assert.ok(!sourceAllowed(null, { REPO_OWNERS: "me" }));
});
