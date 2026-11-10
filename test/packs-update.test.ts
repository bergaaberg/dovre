/** Copied packs: .pack.json on add, outdated, update with a 3-way merge, track (#152). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addPack } from "../src/packs/cli.ts";
import { PACK_API } from "../src/packs/types.ts";
import { describe, notesOf, outdated, readMeta, sourceAllowed, sourceOfUrl, trackPack, updatePack, writeMeta } from "../src/packs/update.ts";

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
    assert.equal(m.version, null, "no release, no version: it followed HEAD");
    assert.equal(m.tag, null);
    assert.equal(m.api, PACK_API);
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
    const BIN = new Uint8Array([0, 0x61, 0x73, 0x6d, 0xff, 0xfe, 0x80, 0xc3]);
    writeFileSync(join(s.up, "foo.wasm"), BIN);
    s.commit("rust");
    const r = addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    assert.equal(r.exportName, "fooPack");
    assert.match(readFileSync(join(s.into, "packs.ts"), "utf8"), /import \{ fooPack \}/);
    assert.ok(existsSync(join(s.pack, "rust", "Cargo.toml")));
    assert.ok(!existsSync(join(s.pack, "rust", "target")));
    assert.ok(!r.wrote.some((f) => f.includes("target")));
    assert.deepEqual(new Uint8Array(readFileSync(join(s.pack, "foo.wasm"))), BIN, "a binary file is copied byte for byte");
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
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo }), /needs PACK_API 99\.0/);
    writeFileSync(join(s.up, "index.ts"), INDEX.replace("PACK_API", '"2.999"'));
    s.commit("api 2.999");
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo }), /needs PACK_API 2\.999; this core has/, "a newer minor is refused too");
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

const released = (version: string, api = "2.0") => `export const fooPack = {\n  id: "foo",\n  api: "${api}",\n  version: "${version}",\n};\n`;

test("releases: add takes the newest tag; outdated names the next release and its changelog; update takes it, not HEAD; --to picks one", () => {
  const s = setup();
  try {
    writeFileSync(join(s.up, "index.ts"), released("1.0.0"));
    writeFileSync(join(s.up, "CHANGELOG.md"), "# foo\n\n## 1.0.0 — 2026-11-01\n\n- First.\n");
    s.commit("foo 1.0.0");
    git(s.repo, "tag", "foo@1.0.0");
    writeFileSync(join(s.up, "data.ts"), DATA.replace("two", "TWO"));
    s.commit("unreleased work");

    const added = addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    assert.equal(added.version, "1.0.0");
    assert.equal(readFileSync(join(s.pack, "data.ts"), "utf8"), DATA, "the release, not HEAD's unreleased work");
    const m = readMeta(s.pack)!;
    assert.equal(m.tag, "foo@1.0.0");
    assert.equal(m.commit, git(s.repo, "rev-parse", "foo@1.0.0"));
    assert.deepEqual(outdated(s.into, s.repo).map(describe), ["foo 1.0.0: up to date"], "HEAD past the tag isn't a release");

    writeFileSync(join(s.up, "index.ts"), released("1.1.0"));
    writeFileSync(join(s.up, "CHANGELOG.md"), "# foo\n\n## 1.1.0 — 2026-11-02\n\n- Shouts <b>two</b>.\n\n## 1.0.0 — 2026-11-01\n\n- First.\n");
    s.commit("foo 1.1.0");
    git(s.repo, "tag", "foo@1.1.0");
    writeFileSync(join(s.up, "data.ts"), DATA.replace("three", "THREE"));
    s.commit("more unreleased work");

    const [st] = outdated(s.into, s.repo);
    assert.equal(st!.newest, "1.1.0");
    assert.deepEqual(st!.notes, [{ version: "1.1.0", lines: ["Shouts <b>two</b>."] }]);
    assert.match(describe(st!), /^foo 1\.0\.0: newer release 1\.1\.0 \(2 commits\): CHANGELOG\.md, data\.ts, index\.ts$/);

    const r = updatePack({ id: "foo", into: s.into, repo: s.repo });
    assert.equal(r.fromVersion, "1.0.0");
    assert.equal(r.toVersion, "1.1.0");
    assert.equal(readFileSync(join(s.pack, "data.ts"), "utf8"), DATA.replace("two", "TWO"), "1.1.0's data, not HEAD's");
    assert.equal(readMeta(s.pack)!.tag, "foo@1.1.0");

    updatePack({ id: "foo", into: s.into, repo: s.repo, to: "1.0.0" });
    assert.equal(readMeta(s.pack)!.version, "1.0.0", "--to goes back as well");
    assert.equal(readFileSync(join(s.pack, "data.ts"), "utf8"), DATA);
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo, to: "9.9.9" }), /no release 9\.9\.9 .*\(it has 1\.1\.0, 1\.0\.0\)/);

    writeFileSync(join(s.up, "index.ts"), released("2.0.0", "2.999"));
    s.commit("foo 2.0.0 needs a newer core");
    git(s.repo, "tag", "foo@2.0.0");
    assert.throws(() => updatePack({ id: "foo", into: s.into, repo: s.repo }), /foo@2\.0\.0 needs PACK_API 2\.999; this core has/);
    assert.equal(readMeta(s.pack)!.version, "1.0.0", "nothing written");
  } finally {
    s.done();
  }
});

test("a copy recorded before releases has no version; at the newest release it says so, and an update records it", () => {
  const s = setup();
  try {
    writeFileSync(join(s.up, "index.ts"), released("1.0.0"));
    s.commit("foo 1.0.0");
    git(s.repo, "tag", "foo@1.0.0");
    addPack({ id: "foo", into: s.into, from: s.repo, allowClone: false });
    const { tag: _, ...old } = readMeta(s.pack)!;
    writeMeta(s.pack, { ...old, version: "0.2.0" });
    const [st] = outdated(s.into, s.repo);
    assert.equal(st!.version, null, "an old record's version is the repo's, not the pack's");
    assert.match(describe(st!), /^foo: at 1\.0\.0, not recorded yet/);
    updatePack({ id: "foo", into: s.into, repo: s.repo });
    assert.deepEqual(outdated(s.into, s.repo).map(describe), ["foo 1.0.0: up to date"]);
  } finally {
    s.done();
  }
});

test("notesOf: releases newer than a version, newest first; all of them without one", () => {
  const log = "# foo\n\n## 1.2.0 — 2026-11-03\n\n- C.\n* D.\n\n## 1.1.0\n\n- B.\n\n## 1.0.0\n\n- A.\n";
  assert.deepEqual(notesOf(log, "1.0.0"), [{ version: "1.2.0", lines: ["C.", "D."] }, { version: "1.1.0", lines: ["B."] }]);
  assert.deepEqual(notesOf(log, "1.2.0"), []);
  assert.equal(notesOf(log, null).length, 3);
});
