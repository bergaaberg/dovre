/** The first run, the climb (#417): one step at a time, the scan, the kit, the summit, and what's kept. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Found, loadConfig, panesOf } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { fixedKeys } from "../src/env.ts";
import { onboardingOf, onboardingStore } from "../src/onboarding.ts";
import { scanCheckouts } from "../src/packs/scan.ts";
import { climbPage } from "../src/pages/welcome.ts";
import { along, flagAt, STEPS } from "../src/ui/climb.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const all: Found = { claude: true, omp: true, pwsh: true, db: true, terminals: true };

/** A code folder: `web` with Dependabot's file and a Storybook folder, `api` with nothing, and a stray folder. */
function codeDir() {
  const dir = mkdtempSync(join(tmpdir(), "dovre-climb-"));
  mkdirSync(join(dir, "web", ".git"), { recursive: true });
  mkdirSync(join(dir, "web", ".github"), { recursive: true });
  writeFileSync(join(dir, "web", ".github", "dependabot.yml"), "secret: never read");
  mkdirSync(join(dir, "web", ".storybook"));
  mkdirSync(join(dir, "api", ".git"), { recursive: true });
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "Dockerfile"), "");
  return dir;
}

const layoutOf = async (db: ReturnType<typeof openDb>) => JSON.parse((await db.DB.prepare("SELECT value FROM settings WHERE key = 'layout'").first<{ value: string }>())?.value ?? "{}");

test("the scan: marker names in checkouts only, folders by a trailing /, never through a symlink", () => {
  const dir = codeDir();
  mkdirSync(join(dir, "linked", ".git"), { recursive: true });
  symlinkSync(join(dir, "web", ".github"), join(dir, "linked", ".github"));
  const r = scanCheckouts(dir, [".github/dependabot.yml", ".storybook/", ".storybook", "Dockerfile", "compose.y*"]);
  assert.equal(r.checkouts, 3, "web, api, linked: notes has no .git");
  assert.deepEqual([...r.found], [[".github/dependabot.yml", 1], [".storybook/", 1]]);
  assert.deepEqual(scanCheckouts(join(dir, "nowhere"), ["Dockerfile"]), { checkouts: 0, found: new Map() });
});

test("flags stand on the ridge, spread out", () => {
  assert.deepEqual(along(0), { x: 0, y: 560 });
  assert.deepEqual(along(1), { x: 1280, y: 420 });
  const xs = Array.from({ length: 8 }, (_, i) => flagAt(i).x);
  assert.equal(new Set(xs).size, 8);
  for (const x of xs) assert.ok(x > 0 && x < 1280);
});

test("the climb, locally: role, scan, two questions, the kit, the summit; what's kept", async () => {
  const dir = codeDir();
  const config = { panes: panesOf({}, all), stored: {} as Record<string, string> };
  const { get, post, db } = signedIn(snapshot(), {}, { config, env: { CODE_DIR: dir } });
  const first = await get("/");
  assert.equal(first.headers.get("location"), "/welcome");
  const start = await (await get("/welcome")).text();
  assertInert("welcome", start);
  assert.match(start, /Let's climb/);
  assert.match(start, /action="\/welcome\/skip"/);
  assert.doesNotMatch(start, /class="side"/, "no menu on the climb");
  assert.match(await (await get("/welcome?at=packs")).text(), /What's your day like\?/, "no role yet: the role first");

  assert.equal((await post("/welcome/role", { role: "boss" })).headers.get("location"), "/welcome?at=role", "a role it doesn't know");
  const r = await post("/welcome/role", { role: "dev", forge: "github", REPO_OWNERS: "acme, me" });
  assert.equal(r.headers.get("location"), "/welcome?at=machine");

  const machine = await (await get("/welcome?at=machine")).text();
  assert.match(machine, /2 checkouts in /);
  assert.match(machine, /<code>\.github\/dependabot\.yml<\/code>/);
  assert.doesNotMatch(machine, /never read/, "names only");
  assert.match(machine, /cl-from-role/, "the scene climbs from the step before");

  assert.equal((await post("/welcome/q0", { a: "lots" })).headers.get("location"), "/welcome?at=q0", "an answer it doesn't offer");
  assert.equal((await post("/welcome/q0", { a: "many" })).headers.get("location"), "/welcome?at=q1");
  const q1 = await (await get("/welcome?at=q1")).text();
  assert.match(q1, /Where do tasks live\?/);
  assert.equal((await post("/welcome/q1", "a=github&a=head&a=trello&multi=1")).headers.get("location"), "/welcome?at=packs");

  const kit = await (await get("/welcome?at=packs")).text();
  assertInert("kit", kit);
  assert.match(kit, /Your kit\./);
  assert.match(kit, /value="dependabot" checked><b>Dependabot<\/b>.*found \.github\/dependabot\.yml/s);
  assert.match(kit, /value="agents" checked><b>Agents<\/b>.*All day/s);
  assert.match(kit, /value="todo" checked>/, "In my head: My list");

  assert.equal((await post("/welcome/packs", "kit=1&pack=prs&pack=dependabot&pack=nope")).headers.get("location"), "/welcome?at=summit");
  const top = await (await get("/welcome?at=summit")).text();
  assertInert("summit", top);
  assert.match(top, /You made it\./);
  assert.match(top, /2 flags on the ridge/);
  assert.match(top, /A little more[\s\S]*href="\/setup\/dependabot"><b>Dependabot<\/b><\/a> · pick what merges on green/, "Dependabot's setup waits for later (#426)");
  assert.match(top, /cl-summit/);

  assert.equal((await post("/welcome/done", {})).headers.get("location"), "/", "no supervisor in a test: straight to Today");
  const kept = await loadConfig(db.DB);
  assert.equal(kept.SETUP_DONE, "1");
  // A key .dev.vars sets is that file's, whatever the climb was told.
  if (!fixedKeys().has("REPO_OWNERS")) assert.equal(kept.REPO_OWNERS, "acme, me");
  const off = (await layoutOf(db)).packsOff as string[];
  assert.ok(off.includes("todo") && off.includes("agents"), "what wasn't picked is off");
  assert.ok(!off.includes("prs") && !off.includes("dependabot"));
  const saved = onboardingStore(db.DB);
  await saved.ready;
  assert.deepEqual(saved.get(), { role: "dev", forge: "github", answers: { agents: "many", tasks: ["github", "head"] }, picked: ["prs", "dependabot"], done: true });
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/welcome?at=role")).status, 200, "Climb again: still there");
});

test("a product owner skips the machine; a new role forgets the old answers", async () => {
  const config = { panes: panesOf({}, all), stored: {} as Record<string, string> };
  const { get, post } = signedIn(snapshot(), {}, { config });
  assert.equal((await post("/welcome/role", { role: "po" })).headers.get("location"), "/welcome?at=q0");
  assert.match(await (await get("/welcome?at=machine")).text(), /Let's climb/, "no machine step for a product owner");
  await post("/welcome/q0", { a: "linear", multi: "1" });
  await post("/welcome/role", { role: "op" });
  const q0 = await (await get("/welcome?at=q0")).text();
  assert.match(q0, /What do you run\?/);
  assert.doesNotMatch(q0, /checked/);
});

test("a refused folder or owner isn't kept, and says so", async () => {
  const config = { panes: panesOf({}, all), stored: {} as Record<string, string> };
  const { get, post, db } = signedIn(snapshot(), {}, { config });
  // Only where .dev.vars doesn't set them (it wins, and the climb shows it as set there).
  const fixed = fixedKeys();
  if (!fixed.has("REPO_OWNERS")) {
    assert.equal((await post("/welcome/role", { role: "dev", REPO_OWNERS: "a; rm -rf" })).headers.get("location"), "/welcome?at=role");
    assert.match(await (await get("/welcome?at=role")).text(), /Not kept: Owners to track/);
  } else await post("/welcome/role", { role: "dev" });
  if (!fixed.has("CODE_DIR")) {
    await post("/welcome/machine", { CODE_DIR: "no<angles" });
    assert.match(await (await get("/welcome?at=machine")).text(), /Not kept: Code folder/);
  }
  await post("/welcome/skip", {});
  assert.deepEqual(await loadConfig(db.DB), { SETUP_DONE: "1" });
  assert.equal((await get("/")).status, 200);
});

test("a write from another site is refused", async () => {
  const config = { panes: panesOf({}, all), stored: {} as Record<string, string> };
  const { post } = signedIn(snapshot(), {}, { config });
  for (const path of ["/welcome/role", "/welcome/q0", "/welcome/packs", "/welcome/done", "/welcome/skip"]) assert.equal((await post(path, { role: "dev" }, { origin: "https://evil.example" })).status, 403, path);
});

test("hosted: the bridge's commands while it listens, and Hi once a machine is on", () => {
  const base = { step: "machine" as const, flags: [{ name: H, fresh: true }], role: "dev" as const };
  const waiting = climbPage({ ...base, machine: { kind: "hosted", handle: "jdoe" } }, [...STEPS], { refresh: 5 }).toString();
  assertInert("hosted machine", waiting);
  assert.match(waiting, /<code>dovre bridge login jdoe<\/code>/);
  assert.match(waiting, /Listening for it…/);
  assert.match(waiting, /http-equiv="refresh" content="5"/);
  assert.match(waiting, />Later <span/, "it never blocks");
  const on = climbPage({ ...base, machine: { kind: "hosted", handle: "jdoe", online: H } }, [...STEPS]).toString();
  assertInert("hosted machine on", on);
  assert.doesNotMatch(on, /bridge login/);
});

test("the store reads strictly", () => {
  assert.deepEqual(onboardingOf({ role: "boss", forge: "svn", answers: { agents: ["many"], tasks: "github", nope: "x", catch: ["red", H] }, picked: ["prs", H, 3], done: "yes" }), { answers: { catch: ["red"] }, picked: ["prs"] });
  assert.deepEqual(onboardingOf(null), { answers: {} });
  assert.deepEqual(onboardingOf({ setup: { tracker: ["triage", "triage", 3, H], [H]: ["a"], agents: "all" } }).setup, { tracker: ["triage"] }, "each pack's steps done, ids only");
});
