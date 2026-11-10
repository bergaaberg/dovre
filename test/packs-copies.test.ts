/** Settings → Packs' copied packs (#152 step 2): state against the checkout, Update as a job, rolled back when the checks fail. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addPack } from "../src/packs/cli.ts";
import { type Check, createCopies, foldersOf } from "../src/packs/copies.ts";
import { readMeta } from "../src/packs/update.ts";

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "packs-copies-"));
  const repo = join(root, "dovre-packs");
  const into = join(root, "instance");
  mkdirSync(join(repo, "packs", "foo"), { recursive: true });
  writeFileSync(join(repo, "packs", "foo", "index.ts"), "export const fooPack = {};\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://github.com/bergaaberg/dovre-packs.git");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "foo");
  mkdirSync(into);
  writeFileSync(join(into, "packs.ts"), "export default [];\n");
  addPack({ id: "foo", into, from: repo, allowClone: false });
  writeFileSync(join(repo, "packs", "foo", "index.ts"), "export const fooPack = { v: 2 };\n");
  writeFileSync(join(repo, "packs", "foo", "view.ts"), "// view\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "v2");
  return { repo, into, pack: join(into, "packs", "foo"), done: () => rmSync(root, { recursive: true, force: true }) };
}

const settle = async (copies: ReturnType<typeof createCopies>, id: string) => {
  for (let i = 0; i < 100 && copies.get().get(id)?.job?.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  return copies.get().get(id)!;
};

test("PACKS folders: ~ expands, a file entry means its folder, each once", () => {
  assert.deepEqual(foldersOf("~/a, /b/packs.ts, /b/ ,", "/home/me"), ["/home/me/a", "/b"]);
  assert.deepEqual(foldersOf(undefined), []);
});

test("Update takes upstream, runs the checks, and says to restart", async () => {
  const s = setup();
  try {
    const ran: string[] = [];
    const logged: [boolean, string][] = [];
    const check: Check = async (into) => (ran.push(into), { ok: true, step: "checked", out: "" });
    const copies = createCopies({ packs: s.into, repo: () => s.repo, fetch: false, check });
    const before = copies.refresh().get("foo")!;
    assert.deepEqual(before.state.upstream, ["index.ts", "view.ts"]);
    assert.equal(before.source, "bergaaberg/dovre-packs");
    assert.deepEqual(copies.update("foo", (ok, d) => logged.push([ok, d])), { ok: true });
    const after = await settle(copies, "foo");
    assert.equal(after.job?.state, "done");
    assert.match(after.job!.step, /restart/);
    assert.deepEqual(ran, [s.into]);
    assert.deepEqual(logged, [[true, "2 files"]]);
    assert.deepEqual(after.state.upstream, []);
    assert.equal(readFileSync(join(s.pack, "view.ts"), "utf8"), "// view\n");
    assert.deepEqual(copies.update("foo"), { ok: false, why: "already up to date" });
    assert.deepEqual(copies.update("nope"), { ok: false, why: "not a pack copied from dovre-packs here" });
  } finally {
    s.done();
  }
});

test("a failing check puts every file back, .pack.json too", async () => {
  const s = setup();
  try {
    const meta = readFileSync(join(s.pack, ".pack.json"), "utf8");
    const copies = createCopies({ packs: s.into, repo: () => s.repo, fetch: false, check: async () => ({ ok: false, step: "test", out: "1 failing" }) });
    copies.update("foo");
    const after = await settle(copies, "foo");
    assert.equal(after.job?.state, "failed");
    assert.match(after.job!.step, /test failed, so the update was undone/);
    assert.equal(after.job!.out, "1 failing");
    assert.equal(readFileSync(join(s.pack, "index.ts"), "utf8"), "export const fooPack = {};\n");
    assert.ok(!existsSync(join(s.pack, "view.ts")));
    assert.equal(readFileSync(join(s.pack, ".pack.json"), "utf8"), meta);
    assert.ok(readMeta(s.pack));
    assert.deepEqual(after.state.upstream, ["index.ts", "view.ts"], "still newer upstream");
  } finally {
    s.done();
  }
});

test("no dovre-packs checkout: nothing to show, nothing thrown", () => {
  const copies = createCopies({ packs: "/nowhere", repo: () => { throw new Error("no checkout"); } });
  assert.equal(copies.refresh().size, 0);
});

/** A checkout with pack `bar` released as bar@1.0.0 (and `big`, which needs a core from the future), and an instance without either. */
function addSetup() {
  const root = mkdtempSync(join(tmpdir(), "packs-add-"));
  const repo = join(root, "dovre-packs");
  const into = join(root, "instance");
  mkdirSync(join(repo, "packs", "bar"), { recursive: true });
  mkdirSync(join(repo, "packs", "big"), { recursive: true });
  writeFileSync(join(repo, "packs", "bar", "index.ts"), 'export const barPack = { manifest: { api: "2.0", version: "1.0.0", id: "bar", name: "Bar", description: "Bars \\"quoted\\".", domain: "work", execution: "any" } };\n');
  writeFileSync(join(repo, "packs", "bar", "view.ts"), "// view\n");
  writeFileSync(join(repo, "packs", "big", "index.ts"), 'export const bigPack = { manifest: { api: "99.0", id: "big", name: "Big" } };\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://github.com/bergaaberg/dovre-packs.git");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "bar");
  git(repo, "tag", "bar@1.0.0");
  writeFileSync(join(repo, "packs", "bar", "index.ts"), 'export const barPack = { manifest: { api: "2.0", version: "1.1.0-wip", id: "bar", name: "Bar next" } };\n');
  git(repo, "commit", "-qam", "wip");
  mkdirSync(into);
  writeFileSync(join(into, "packs.ts"), "export default [];\n");
  return { repo, into, pack: join(into, "packs", "bar"), done: () => rmSync(root, { recursive: true, force: true }) };
}

const settleAdd = async (copies: ReturnType<typeof createCopies>, id: string) => {
  for (let i = 0; i < 100 && copies.listed().find((l) => l.id === id)?.job?.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  return copies.listed().find((l) => l.id === id)!;
};

test("Add (#88): the newest release, wired into packs.ts, checked, then restart", async () => {
  const s = addSetup();
  try {
    const logged: [boolean, string][] = [];
    const copies = createCopies({ packs: s.into, repo: () => s.repo, fetch: false, check: async () => ({ ok: true, step: "checked", out: "" }) });
    copies.get();
    await new Promise((r) => setTimeout(r, 20));
    const bar = copies.listed().find((l) => l.id === "bar")!;
    assert.equal(bar.name, "Bar", "read at the release, not HEAD");
    assert.equal(bar.description, 'Bars "quoted".');
    assert.equal(bar.version, "1.0.0");
    assert.equal(copies.listed().find((l) => l.id === "big")?.needsCore, true);
    assert.equal(copies.target(), s.into);
    assert.deepEqual(copies.add("big"), { ok: false, why: "needs core API 99.0: update Dovre first" });
    assert.deepEqual(copies.add("nope"), { ok: false, why: "not a pack in dovre-packs" });
    assert.deepEqual(copies.add("bar", (ok, d) => logged.push([ok, d])), { ok: true });
    const after = await settleAdd(copies, "bar");
    assert.equal(after.job?.state, "done");
    assert.match(after.job!.step, /added 1\.0\.0; restart/);
    assert.deepEqual(logged, [[true, "1.0.0"]]);
    assert.match(readFileSync(join(s.pack, "index.ts"), "utf8"), /name: "Bar"/);
    assert.equal(readMeta(s.pack)?.tag, "bar@1.0.0");
    assert.match(readFileSync(join(s.into, "packs.ts"), "utf8"), /import \{ barPack \} from "\.\/packs\/bar\/index\.ts";/);
    assert.deepEqual(copies.add("bar"), { ok: false, why: "already in the instance" });
  } finally {
    s.done();
  }
});

test("Add: a failing check takes the pack out and puts packs.ts back", async () => {
  const s = addSetup();
  try {
    const listing = readFileSync(join(s.into, "packs.ts"), "utf8");
    const copies = createCopies({ packs: s.into, repo: () => s.repo, fetch: false, check: async () => ({ ok: false, step: "typecheck", out: "TS2304" }) });
    copies.add("bar");
    const after = await settleAdd(copies, "bar");
    assert.equal(after.job?.state, "failed");
    assert.match(after.job!.step, /typecheck failed, so the pack was taken out again/);
    assert.equal(after.job!.out, "TS2304");
    assert.ok(!existsSync(s.pack));
    assert.equal(readFileSync(join(s.into, "packs.ts"), "utf8"), listing);
  } finally {
    s.done();
  }
});

test("Add: nowhere to add without a packs.ts, and a checkout from outside REPO_OWNERS is refused", () => {
  const s = addSetup();
  try {
    assert.deepEqual(createCopies({ packs: join(s.into, "missing"), repo: () => s.repo, fetch: false }).add("bar"), { ok: false, why: "PACKS has no instance folder with a packs.ts" });
    git(s.repo, "remote", "set-url", "origin", "https://github.com/stranger/dovre-packs.git");
    assert.deepEqual(createCopies({ packs: s.into, repo: () => s.repo, fetch: false, env: { REPO_OWNERS: "acme" } }).add("bar"), { ok: false, why: "the dovre-packs checkout comes from a repo outside REPO_OWNERS" });
  } finally {
    s.done();
  }
});
