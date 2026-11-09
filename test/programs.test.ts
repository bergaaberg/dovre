/** ctx.run, ctx.onPath, ctx.dir (#474): a pack runs only the programs it names, in a checkout or its own folder, never an agent. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { type Pack, PACK_API, type PackContext } from "../src/pack.ts";
import { HOSTILE, packApp } from "../src/pack-testing.ts";
import { packDirOf, programsFor, programsOf } from "../src/packs/programs.ts";
import { activePacks } from "../src/packs/registry.ts";
import { fakeGhe, fixedGatherer, snapshot } from "./helpers.ts";

function folders(t: { after: (f: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dovre-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = join(root, "code");
  for (const d of ["code/shop/.git", "code/shop/web", "elsewhere"]) mkdirSync(join(root, d), { recursive: true });
  return { root, code, shop: join(code, "shop"), own: join(root, "data", "packs", "books") };
}

test("ctx.run: only what the manifest names, by name, never an agent CLI; a missing program says so", async (t) => {
  const f = folders(t);
  const ran: { bin: string; args: string[]; cwd?: string; input?: string }[] = [];
  const p = programsFor(
    { id: "books", requiredBinaries: ["git"], binaries: ["pnpm", "npm", "claude", "../sh"] },
    {
      dir: f.own,
      checkouts: () => [f.shop],
      find: (name) => (name === "npm" ? undefined : name === "pnpm" ? { bin: "/bin/node", pre: ["/opt/pnpm.cjs"], path: "/opt/pnpm.cmd" } : { bin: `/bin/${name}`, pre: [], path: `/bin/${name}` }),
      runOff: async (bin, args, opts) => (ran.push({ bin, args, cwd: opts?.cwd, input: opts?.input }), { code: 3, stdout: "out", stderr: "" }),
    },
  );
  assert.deepEqual(programsOf({ requiredBinaries: ["git", "git"], binaries: ["pnpm", "Claude.exe", "codex", "a/b", "", 3 as unknown as string] }), ["git", "pnpm"]);
  assert.deepEqual(await p.run("git", ["status"], { cwd: f.shop, input: "in" }), { code: 3, stdout: "out", stderr: "" }, "a non-zero exit is a result");
  await p.run("pnpm", ["install"], { cwd: join(f.shop, "web") });
  await p.run("git", ["init"]);
  assert.deepEqual(ran, [
    { bin: "/bin/git", args: ["status"], cwd: f.shop, input: "in" },
    { bin: "/bin/node", args: ["/opt/pnpm.cjs", "install"], cwd: join(f.shop, "web"), input: undefined },
    { bin: "/bin/git", args: ["init"], cwd: f.own, input: undefined },
  ]);
  assert.equal(p.onPath("git"), true);
  assert.equal(p.onPath("npm"), false);
  await assert.rejects(p.run("npm", ["ci"]), /^Error: npm isn't on PATH$/);
  await assert.rejects(p.run("curl", []), /doesn't name curl/);
  for (const agent of ["claude", "codex", "Claude.EXE", "omp"]) await assert.rejects(p.run(agent, ["-p"]), /agents don't start here/, agent);
  assert.throws(() => p.onPath("claude"), /agents don't start here/);
  for (const bad of ["/bin/git", "../sh", "git status", "", HOSTILE, undefined, 3]) await assert.rejects(p.run(bad as string, []), TypeError, String(bad));
  await assert.rejects(p.run("git", ["ok", 3 as unknown as string]), TypeError);
  assert.equal(ran.length, 3, "nothing refused was started");
});

test("ctx.run: starts in a checkout or the pack's own folder, symlinks followed, nowhere else", async (t) => {
  const f = folders(t);
  const cwds: (string | undefined)[] = [];
  const p = programsFor({ id: "books", binaries: ["git"] }, { dir: f.own, checkouts: () => [f.shop], find: () => ({ bin: "/bin/git", pre: [], path: "/bin/git" }), runOff: async (_b, _a, o) => (cwds.push(o?.cwd), { code: 0, stdout: "", stderr: "" }) });
  assert.equal(p.dir(), f.own, "made when asked for");
  mkdirSync(join(f.own, "trees", "shop"), { recursive: true });
  symlinkSync(join(f.root, "elsewhere"), join(f.own, "out"));
  await p.run("git", [], { cwd: join(f.own, "trees", "shop") });
  await p.run("git", [], { cwd: `${f.shop}/web/../web` });
  assert.deepEqual(cwds, [join(f.own, "trees", "shop"), join(f.shop, "web")]);
  for (const cwd of [f.root, f.code, join(f.root, "elsewhere"), join(f.own, "out"), join(f.own, "..", "other"), `${f.shop}-2`, join(f.shop, "nope"), "", "/", HOSTILE]) await assert.rejects(p.run("git", [], { cwd }), /isn't in a checkout or in books's own folder/, cwd);
  assert.equal(cwds.length, 2);
  assert.equal(packDirOf("/srv/d/dovre.sqlite", "books"), join("/srv/d", "packs", "books"));
});

test("ctx.run: local packs get it, hosted ones don't; the Packs page says what a pack may run, inert", async (t) => {
  const f = folders(t);
  const seen: PackContext[] = [];
  const pack = (id: string): Pack => ({
    manifest: { api: PACK_API, id, name: id, description: "", domain: "personal", binaries: ["node", HOSTILE] },
    routes: (_app, c) => void seen.push(c),
  });
  const local = packApp([pack("books")], { codeDir: f.code, dataDir: join(f.root, "data") });
  const db = openDb();
  createApp({ GHE_HOST: "github.com", GITHUB_USER: "me", IS_HOSTED: "1", ALLOWED_EMAILS: "me@example.com", PUBLIC_ORIGIN: "https://dovre.example", DB: db.DB } as never, {
    gatherer: fixedGatherer(snapshot()),
    ghe: fakeGhe({}).ghe,
    access: async () => ({ email: "me@example.com" }),
    packs: { ...activePacks([pack("cloud")], { env: {}, bindings: {}, hosted: true }), env: {}, bindings: {} },
  });
  const [here, there] = seen as [PackContext, PackContext];
  assert.equal(here.dir!(), f.own);
  assert.equal(here.onPath!("node"), true);
  const r = await here.run!("node", ["-e", "process.stdout.write(process.cwd())"], { cwd: f.shop, timeoutMs: 20_000 });
  assert.deepEqual([r.code, realpathSync(r.stdout)], [0, f.shop], "started for real, in the checkout");
  await assert.rejects(here.run!("node", [], { cwd: join(f.root, "elsewhere") }), /isn't in a checkout/);
  assert.deepEqual([there.hosted, there.run, there.onPath, there.dir], [true, undefined, undefined, undefined]);
  const page = await (await local.get("/packs")).text();
  assert.match(page, /May run/);
  assert.ok(!page.includes("<script>x</script>") && !page.includes("<img src=x"), "hostile text got through");
});
