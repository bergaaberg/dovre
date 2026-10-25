/**
 * The atlas pack (PLAN D18, WP-G6, WP-H9b): range.yaml parsing and scanning, its page, and what
 * it puts in core pages through slots (PR cards, New work, /agents/new) and Bino's lines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRange } from "../bino/range.ts";
import { AtlasScanner, type AtlasEntry } from "../bino/scan.ts";
import { atlasPage, binoLines } from "../bino/atlas.view.ts";
import { assistantPack } from "../index.ts";
import { prBody, prCard, type PrSlots } from "../../../../pages/inline.ts";
import { entryPage } from "../../../../pages/work.ts";
import { contextOf } from "../bino/context.ts";
import type { PackContext, Slots } from "../../../types.ts";
import type { Pr } from "../../../../sources/ghe.ts";
import type { Ctx } from "../../../../pages/work.ts";
import { H, assertInert, fakeGhe, fixedGatherer, signedIn, snapshot } from "../../../../../test/helpers.ts";
import { createApp } from "../../../../app.ts";
import { openDb } from "../../../../db.ts";
import { activePacks } from "../../../registry.ts";
import { noMemory } from "../bino/memory.ts";
import type { Route } from "../bino/route.ts";

/** A code folder with these manifests (folder → range.yaml text). */
function codeDir(manifests: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dovre-atlas-"));
  for (const [name, yaml] of Object.entries(manifests)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "range.yaml"), yaml);
  }
  return dir;
}

const QUILL = `name: Quill
description: Newsletter platform for writers
url: https://quill.example
tier: active
docs:
  plan: docs/PLAN.md
  arch: ARCHITECTURE.md
components:
  - name: web
    owns: [apps/web]
  - name: db
    owns: [packages/db]
    rules: .claude/rules/db.md
`;

/** The pack's slots, as core's fill would call them. */
const slotsOf = (dir: string): Slots => assistantPack({ codeDir: dir }).slots!({} as PackContext);
const prSlots = (sl: Slots): PrSlots => ({ lead: (p) => [sl["pr.lead"]!(p)], facts: (p) => sl["pr.facts"]!(p) });

function fakePr(repo: string, number = 101): Pr {
  return {
    repo,
    number,
    title: "Add Toolkit support",
    branch: "feat/toolkit",
    headSha: "abcdef123456",
    author: "andreasberg",
    url: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    openThreads: 0,
    checks: "SUCCESS",
    review: "APPROVED",
    updatedAt: "2026-10-23T20:00:00Z",
    additions: 120,
    deletions: 15,
    files: [
      { path: "src/atlas/range.ts", additions: 100, deletions: 10 },
      { path: "README.md", additions: 20, deletions: 5 },
    ],
    reviews: [{ state: "APPROVED", login: "reviewer" }],
    requested: [],
    labels: ["enhancement"],
    runs: [{ name: "build", state: "ok", url: "https://ci.example.com/build" }],
    body: "Implements range.yaml support.",
  };
}

test("parseRange: parses valid range.yaml manifest", () => {
  const raw = {
    name: "Quill",
    description: "Websites and paid newsletters for writers",
    url: "https://quill.example",
    tier: "active",
    components: [
      { name: "web", owns: ["apps/web/src"] },
      { name: "db", owns: ["packages/db/src"], rules: ".claude/rules/db.md" },
    ],
    docs: {
      architecture: "ARCHITECTURE.md",
      backlog: "BACKLOG.md",
    },
    health: {
      workers: ["quill-web", "quill-dispatcher"],
      links: ["https://quill.example"],
    },
  };

  const parsed = parseRange(raw);
  assert.ok("range" in parsed, "should parse successfully");
  const r = parsed.range;
  assert.equal(r.name, "Quill");
  assert.equal(r.tier, "active");
  assert.equal(r.url, "https://quill.example");
  assert.equal(r.components.length, 2);
  assert.equal(r.components[1].rules, ".claude/rules/db.md");
  assert.equal(r.docs.architecture, "ARCHITECTURE.md");
  assert.deepEqual(r.health?.workers, ["quill-web", "quill-dispatcher"]);
});

test("parseRange: detects validation problems", () => {
  assert.ok("problems" in parseRange(null));
  assert.ok("problems" in parseRange("not an object"));

  const missingName = parseRange({ tier: "active" });
  assert.ok("problems" in missingName);
  assert.ok(missingName.problems.some((p) => p.includes("name is required")));

  const invalidUrl = parseRange({ name: "Foo", url: "ftp://example.com" });
  assert.ok("problems" in invalidUrl);
});

test("AtlasScanner: scans directory and resolves checkouts with range.yaml", () => {
  const testDir = join(tmpdir(), `dovre-atlas-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  try {
    // Repo 1: Quill (has range.yaml)
    const quillDir = join(testDir, "quill");
    mkdirSync(quillDir, { recursive: true });
    writeFileSync(
      join(quillDir, "range.yaml"),
      `name: Quill
description: Newsletter platform
tier: active
docs:
  plan: docs/PLAN.md
health:
  workers: [quill-web]
`,
    );

    // Repo 2: Harbor (has range.yml)
    const harborDir = join(testDir, "harbor");
    mkdirSync(harborDir, { recursive: true });
    writeFileSync(
      join(harborDir, "range.yml"),
      `name: Harbor
tier: active
url: https://creaharbor.com
docs:
  plan: docs/PLAN.md
`,
    );

    // Repo 3: plain repo (no range.yaml)
    const plainDir = join(testDir, "plain-repo");
    mkdirSync(plainDir, { recursive: true });

    const scanner = new AtlasScanner(testDir);
    const map = scanner.scan();

    assert.equal(map.size, 2);
    assert.ok(map.has("quill"));
    assert.ok(map.has("harbor"));
    assert.ok(!map.has("plain-repo"));

    const quill = scanner.get("bergaaberg/quill");
    assert.ok(quill);
    assert.equal(quill.name, "Quill");
    assert.equal(quill.tier, "active");

    const list = scanner.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].repo, "harbor"); // sorted by name
    assert.equal(list[1].repo, "quill");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("AtlasScanner: a folder with capitals keeps its name in links; lookups ignore case", () => {
  const testDir = join(tmpdir(), `dovre-atlas-case-${Date.now()}`);
  mkdirSync(join(testDir, "Arena"), { recursive: true });
  try {
    writeFileSync(join(testDir, "Arena", "range.yaml"), "name: Arena\ntier: active\n");
    const scanner = new AtlasScanner(testDir);
    const [entry] = scanner.list();
    assert.equal(entry!.repo, "Arena", "/code/Arena and /agents/new need the folder's own name");
    assert.equal(entry!.dir, join(testDir, "Arena"));
    assert.equal(scanner.get("bergaaberg/arena")?.name, "Arena");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("AtlasScanner: an empty folder is cached too — no rescan inside the TTL, a reread after it", () => {
  const testDir = join(tmpdir(), `dovre-atlas-ttl-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  try {
    let clock = 1_000_000;
    const scanner = new AtlasScanner(testDir, { ttlMs: 30_000, now: () => clock });
    // A folder with no manifests: the (empty) scan is still cached — this used to rescan on
    // every call, synchronously, because the TTL only applied to a non-empty cache.
    assert.equal(scanner.scan().size, 0);
    mkdirSync(join(testDir, "late"), { recursive: true });
    writeFileSync(join(testDir, "late", "range.yaml"), "name: Late\ntier: active\n");
    assert.equal(scanner.list().length, 0, "inside the TTL the empty result stands");
    clock += 30_001;
    assert.equal(scanner.list().length, 1, "after the TTL the folder is read again");
    assert.equal(scanner.get("late")?.name, "Late");
    rmSync(join(testDir, "late"), { recursive: true, force: true });
    clock += 30_001;
    assert.equal(scanner.list().length, 0, "a manifest gone is gone after the TTL");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("PR slots: a cataloged repo's PR shows its tier, site and docs; others show nothing", () => {
  const sl = slotsOf(codeDir({ quill: QUILL }));
  const summary = () => undefined;
  const card = String(prCard(fakePr("bergaaberg/quill", 42), { org: "bergaaberg", summary, slots: prSlots(sl) }));
  assert.match(card, /tier: active/);
  assert.match(card, /Quill/);
  assert.match(card, /docs%2FPLAN\.md/);
  assert.match(card, /ARCHITECTURE\.md/);
  const body = String(prBody(fakePr("bergaaberg/quill", 42), { summary, slots: prSlots(sl) }));
  assert.match(body, /Atlas/);
  const other = String(prBody(fakePr("bergaaberg/plain", 7), { summary, slots: prSlots(sl) }));
  assert.doesNotMatch(other, /Atlas/);
});

test("work.new slot: New work lists the cataloged projects", () => {
  const sl = slotsOf(codeDir({ quill: QUILL, harbor: "name: Harbor\ndescription: Laid-back Roman city builder\ntier: active\ndocs:\n  design: docs/DESIGN.md\n" }));
  const ctx: Ctx = { sortingRepos: [], formRepos: [], frame: { operator: "andreasberg", nav: [] }, org: "bergaaberg", ghe: "github.com", extra: [sl["work.new"]!({})] };
  const out = String(entryPage(ctx));
  assert.match(out, /Projects/);
  assert.match(out, /Quill/);
  assert.match(out, /Harbor/);
  assert.match(out, /Start agent/);
  const empty = String(slotsOf(codeDir({}))["work.new"]!({}));
  assert.equal(empty, "");
});

test("agents.new slot: a checkout's components set the prompt", () => {
  const sl = slotsOf(codeDir({ quill: QUILL }));
  // What the slot puts under "Runs in" on /agents/new (the agents pack draws the page around it).
  const out = String(sl["agents.new"]!({ repo: "quill" }));
  assert.match(out, /Component/);
  assert.match(out, />web<\/a>/);
  assert.match(out, />db<\/a>/);
  assert.match(out, /Focus%20on%20component%20%22web%22/);
  assert.match(out, /\.claude%2Frules%2Fdb\.md/);
});

test("atlasPage: repo panels, components, docs, focus links, bare checkouts and the tier filter", () => {
  const entries: AtlasEntry[] = [
    {
      repo: "quill",
      dir: "/x/quill",
      range: {
        name: "Quill",
        description: "Newsletter platform for writers",
        url: "https://quill.example",
        tier: "active",
        components: [
          { name: "web", owns: ["apps/web/src"] },
          { name: "db", owns: ["packages/db/src"], rules: ".claude/rules/db.md" },
        ],
        docs: { plan: "docs/PLAN.md", rules: "CLAUDE.md" },
        health: { workers: ["quill-web"] },
      },
    },
    { repo: "harbor", dir: "/x/harbor", range: { name: "Harbor", description: "Laid-back Roman city builder", tier: "utility", components: [], docs: { design: "docs/DESIGN.md" } } },
  ];
  const out = String(atlasPage({ entries, bare: ["plain-repo"] }));
  for (const re of [/Repo Atlas/, /Quill/, /active/, /quill\.example/, /Focus%20on%20component/, /\.claude\/rules\/db\.md/, /docs%2FPLAN\.md/, /Uncataloged Checkouts/, /plain-repo/]) assert.match(out, re);
  const filtered = String(atlasPage({ entries, filter: "active" }));
  assert.match(filtered, /Quill/);
  assert.doesNotMatch(filtered, /Harbor/);
});

test("the assistant pack: Atlas in the menu's Code group and in search; /atlas served, and 404 when off", async () => {
  const pack = assistantPack({ codeDir: codeDir({ quill: QUILL }) });
  const nav = pack.nav!({} as PackContext);
  assert.deepEqual(nav.map((n) => [n.href, n.title, n.icon, n.group]), [["/atlas", "Atlas", "atlas", "Code"]]);
  assert.ok(pack.pages!({} as PackContext).some((p) => p.href === "/atlas"));

  const { get } = signedIn(snapshot(), {}, { packs: [pack] });
  const res = await get("/atlas");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Repo Atlas/);
  assert.match(text, /Rescan/);
  assert.match(text, /Quill/);
  assert.match(text, /href="\/atlas"/, "the menu links it");
  assert.equal((await get("/atlas?refresh=1")).status, 200);

  const off = signedIn(snapshot(), {}, { packs: [pack], packEnv: { PACK_ASSISTANT: "off" } });
  assert.equal((await off.get("/atlas")).status, 404);
  // No code folder (hosted, or PACK_ATLAS=off as index.ts reads it): the pack, without Atlas.
  const bare = assistantPack();
  assert.equal(bare.manifest.id, "assistant");
  assert.ok(!bare.routes && !bare.nav && !bare.slots && !bare.bino && !bare.manifest.paths);
  assert.equal((await signedIn(snapshot(), {}, { packs: [bare] }).get("/atlas")).status, 404);
  assert.equal((await signedIn(snapshot()).get("/atlas")).status, 404, "core alone has no /atlas");
});

test("a hostile manifest stays inert on /atlas and in every slot", async () => {
  // Markup in every text field (the parser rejects non-http urls, so the url stays valid).
  const dir = codeDir({
    "shop-api": `name: ${JSON.stringify(H)}
description: ${JSON.stringify(H)}
url: https://example.com/app
tier: ${JSON.stringify(H)}
docs:
  ${JSON.stringify(H)}: README.md
components:
  - name: ${JSON.stringify(H)}
    owns: [${JSON.stringify(`src/${H}`)}]
    rules: ${JSON.stringify(H)}
`,
  });
  const scanner = new AtlasScanner(dir);
  assert.equal(scanner.list().length, 1, "the hostile manifest parses");
  const { get } = signedIn(snapshot(), {}, { packs: [assistantPack({ codeDir: dir, scanner })] });
  const res = await get("/atlas");
  assert.equal(res.status, 200);
  assertInert("/atlas", await res.text());
  const sl = slotsOf(dir);
  assertInert("agents.new", String(sl["agents.new"]!({ repo: "shop-api" })));
  assertInert("pr.lead", String(sl["pr.lead"]!({ repo: "shop-api", number: 7, branch: "feat/x", title: "x", url: "https://ghe/shop-api/pull/7" })));
  assertInert("pr.facts", sl["pr.facts"]!({ repo: "shop-api", number: 7, branch: "feat/x", title: "x", url: "https://ghe/shop-api/pull/7" }).map(([k, v]) => `${k}${v}`).join(""));
  assertInert("work.new", String(sl["work.new"]!({})));
});

test("Bino: a line per cataloged repo with its components and docs, capped, as part of Dovre", () => {
  const dir = codeDir({ quill: QUILL });
  const text = assistantPack({ codeDir: dir }).bino!({} as PackContext);
  assert.match(text, /quill \[active\]: Newsletter platform for writers/);
  assert.match(text, /web \(apps\/web\)/);
  assert.match(text, /plan: docs\/PLAN\.md/);

  const many: AtlasEntry[] = Array.from({ length: 40 }, (_, i) => ({ repo: `r${i}`, dir: "", range: { name: `R${i}`, tier: "active", description: "x".repeat(90), components: [], docs: {} } }));
  const capped = binoLines(many);
  assert.ok(capped.length <= 1500, `capped at what a pack may say (${capped.length})`);
  assert.match(capped, /and \d+ more cataloged repositories/);

  const ctx = contextOf({ todos: [], apps: [{ name: "Atlas", text, own: true }] });
  assert.match(ctx, /## Atlas \(part of Dovre\)/);
  assert.doesNotMatch(ctx, /Atlas \(one of the user's apps\)/);
});

const ENV = { GHE_HOST: "acme.ghe.com", GHE_ORG: "ACME", LAUNCH_TOKEN: "test-token", CODE_DIR: "x", CLAUDE_DIR: "x" };
test("the assistant pack is Bino's switch: PACK_ASSISTANT=off and there's no Bino, nor its menu entry", async () => {
  const route: Route = { via: "claude", ready: true, model: "sonnet", reflectModel: "haiku", ask: async () => ({ text: "Ok.", cost: 0 }) };
  const appWith = (env: Record<string, string>) =>
    createApp({ ...ENV, DB: openDb().DB }, { gatherer: fixedGatherer(snapshot()), ghe: fakeGhe({}).ghe, bino: { route, memory: noMemory("no") }, packs: { ...activePacks([assistantPack()], { env, hosted: false }), env, core: ["assistant"] } });
  const get = (app: ReturnType<typeof appWith>, path: string) => app.request(`http://localhost${path}`, { headers: { cookie: "u_tk=test-token" } });
  const on = appWith({});
  assert.equal((await get(on, "/bino")).status, 200);
  assert.match(await (await get(on, "/")).text(), /href="\/bino"/);
  const off = appWith({ PACK_ASSISTANT: "off" });
  assert.equal((await get(off, "/bino")).status, 404);
  assert.doesNotMatch(await (await get(off, "/")).text(), /href="\/bino"/);
});
