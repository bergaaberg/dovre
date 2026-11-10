/**
 * The pack SDK (#473): dovre/pack.ts and dovre/pack-testing.ts export exactly the names listed
 * here, so the contract can't change by accident; and the one-door rule a packs repo holds its
 * imports to (src/packs/imports.ts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { assertDoors, reachIns } from "../src/pack-testing.ts";

const src = resolve(import.meta.dirname, "..", "src");
const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** dovre/pack.ts at PACK_API 1.31, types and values. A name added: bump PACK_API's minor, add it here and a row in docs/ARCHITECTURE.md. */
const PACK = words(`
  ActDone ActField ActKind AgentShare Ago AiSummary AutoFixAsk AutoFixLanded AutoLimits AutoPr AutoRunResult AutoShare Bit BulkBar Card CheckRows
  Child Confirm ConfirmSubmit Crumb Defer Delta Dock Dot Empty ExecutionAffinity FIX_TURNS FeedItem FindItem Found Gauge Glance Grid2 Grid3 Html
  IngestInput IngestReply IngestSpec Investigate Item KeyValues Lane Link List ListItem ListShare ListState LookupField LookupKind Notice OnboardStep
  PACK_API Pack PackAgent PackAgentAsk PackAgentCan PackAgentRun PackAgentStart PackAgentWhere PackAi PackAiAsk PackCompleteAsk PackContext PackDomain
  PackFile PackForge PackLogged PackManifest PackNeed PackNote PackRan PackRunOpts PackSetting PackSetup PackShares PackStat PackTool PackWrite PacksModule PageHeader PageOpts Panel
  Pick Pill Post PrSlotArg Pulse PulseFeed Read Ref RefRule RingDecl Role ScheduledEvent SetupStep SlotMap SlotName Slots SpanSlotArg Spark Stat
  StatUnit Stats Tab Tabs TodayCard Tone ToolCall ToolResult WasmFile Wrote assignAct commentAct createAct failed fieldInputs html icon
  investigateHref isExternal markdown newTab refused safeUrl statusAct trunc writeAct
  App AppEnv Changelog D1 D1Statement Deploy EveryRepo Forge ForgeCan ForgeDecl ForgeWork Issue IssueSets Move Need Note PackProposal Pr PrRef Proposal Proposed
  Reading Snapshot byPerson deploySummaryKey hashOf hourAt inFiles later needsOf prSummaryKey strictOrigin throttle format
  ColumnChart D1Value FunnelDiagram HBars Heatmap IconName Page SankeyChart StackedBar chart within
`);

/** dovre/pack-testing.ts. */
const TESTING = words(`
  HOSTILE ON_JS PACK_DOOR PACK_TEST_DOOR activePacks apiGap assertDoors assertFragment assertInert assertScoped assertStyled createWorker ingestToken keptLookups openDb
  packApp reachIns resetWhen setWhen testAgentLinks testAgentsPack testContext testDeploy testForge testList testPage testPr testSession testSnapshot
`);

/** Every name a file exports, types too (which only its text has), following `export * from`. */
function namesOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:type|interface|const|let|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]!);
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm))
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!;
      if (name) out.add(name);
    }
  for (const m of text.matchAll(/^export\s+\*\s+from\s+"([^"]+)"/gm)) for (const name of namesOf(join(dirname(file), m[1]!))) out.add(name);
  return [...out].sort();
}

const diff = (now: string[], listed: string[]) => ({ added: now.filter((x) => !listed.includes(x)), removed: listed.filter((x) => !now.includes(x)) });

test("dovre/pack.ts exports the listed names: one added is a PACK_API minor, one removed a major", async () => {
  assert.deepEqual(diff(namesOf(join(src, "pack.ts")), PACK), { added: [], removed: [] });
  const values = Object.keys(await import("../src/pack.ts"));
  assert.deepEqual(values.filter((v) => !PACK.includes(v)), [], "a value the text scan missed");
  for (const v of ["PACK_API", "html", "safeUrl", "Panel", "Pulse", "writeAct", "markdown"]) assert.ok(values.includes(v), v);
  const { format } = await import("../src/pack.ts");
  assert.deepEqual(Object.keys(format).sort(), ["ago", "bytes", "count", "duration", "hourOf", "percent", "shortDay", "since", "stamp", "when"], "a formatter added is a minor too");
  assert.equal(format.shortDay("2026-10-07"), "7 Oct");
  const { chart, within } = await import("../src/pack.ts");
  assert.deepEqual(Object.keys(chart), ["columns"], "a chart added is a minor too");
  assert.deepEqual(await within(1000, () => 7), { ok: true, value: 7 });
  const slow = await within(5, () => new Promise((res) => setTimeout(res, 200)));
  assert.equal(slow.ok, false);
  assert.equal(format.count(1234567).replace(/\D/g, ""), "1234567");
});

test("dovre/pack-testing.ts exports the listed names", async () => {
  assert.deepEqual(diff(namesOf(join(src, "pack-testing.ts")), TESTING), { added: [], removed: [] });
  assert.deepEqual(Object.keys(await import("../src/pack-testing.ts")).sort(), [...TESTING].sort(), "all of them are values");
});

test("one door: imports of core that go around dovre/pack.ts are counted per module, and the list can only shrink", () => {
  const dir = mkdtempSync(join(tmpdir(), "dovre-doors-"));
  const file = (p: string, body: string) => (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), body));
  file("a/index.ts", `import { type Pack, html } from "dovre/pack.ts";\nimport { Panel } from "hono/html";\n`);
  file("a/test/a.test.ts", `import { testContext } from "dovre/pack-testing.ts";\nimport { aPack } from "../index.ts";\n`);
  assert.deepEqual(reachIns(dir), {});
  assertDoors(dir);
  assert.deepEqual(reachIns(join(dir, "none")), {}, "no packs folder yet");

  file("a/view.ts", `import { strictOrigin } from "dovre/strict.ts";\nimport type {\n  D1,\n} from 'dovre/db.ts';\nexport * from "dovre/ui/kit.ts";\n`);
  file("b/index.ts", `const { runOff } = await import("dovre/spawn.ts");\nimport "dovre/strict.ts";\nimport { testContext } from "dovre/pack-testing.ts";\n`);
  file("b/node_modules/x/index.ts", `import "dovre/app.ts";\n`);
  file("b/notes.md", `from "dovre/app.ts"\n`);
  const now = { "dovre/db.ts": 1, "dovre/pack-testing.ts": 1, "dovre/spawn.ts": 1, "dovre/strict.ts": 2, "dovre/ui/kit.ts": 1 };
  assert.deepEqual(reachIns(dir), now, "the testing door isn't for a pack's own files");
  assertDoors(dir, now);
  assert.throws(() => assertDoors(dir), /go around it/);
  assert.throws(() => assertDoors(dir, { ...now, "dovre/strict.ts": 1 }), /dovre\/strict\.ts: 2 \(allowed 1\)/, "one more import of a listed module");
  assert.throws(() => assertDoors(dir, { ...now, "dovre/strict.ts": 3 }), /lower the list/, "the list is out of date");
  assert.throws(() => assertDoors(dir, { ...now, "dovre/gone.ts": 1 }), /dovre\/gone\.ts: 0 \(listed 1\)/);
});

test("the testing door's stand-ins: a page in core's shell, My list in memory, a pack's forge, styled classes, a code folder's checkouts", async () => {
  const { Hono } = await import("hono");
  const { html } = await import("hono/html");
  const t = await import("../src/pack-testing.ts");

  const app = new Hono<import("../src/env.ts").AppEnv>();
  app.get("/x", (c) => t.testPage({ operator: "kari" })(c, { title: t.HOSTILE, body: html`<p class="t2">${t.HOSTILE}</p>` }));
  const page = await (await app.request("http://localhost/x")).text();
  assert.match(page, /<html[\s>]/);
  assert.match(page, /kari/);
  t.assertInert("testPage", page);

  const list = t.testList();
  const added = await list.add({ title: "Call back", notes: "DEV-1" });
  assert.deepEqual([added?.id, added?.state, added?.parent], [1, "next", null]);
  assert.deepEqual((await list.items()).map((i) => i.title), ["Call back"]);
  assert.equal((await list.get(1))?.notes, "DEV-1");
  assert.equal(list.href(1), "/todo#t-1");

  const manifest = { api: t.testAgentsPack().manifest.api, id: "glab", name: "Glab", description: "x", domain: "general" as const };
  assert.throws(() => t.testForge({ manifest }), /brings no forge/);
  const brings = { manifest, forge: { id: "glab", name: "Glab", create: (env: Record<string, string | undefined>) => { if (!env.TOKEN) throw new Error("TOKEN isn't set"); return { host: "g.test" } as never; } } };
  assert.equal(t.testForge(brings, { TOKEN: "x" }).host, "g.test");
  await assert.rejects(t.testForge(brings).viewer(), /TOKEN isn't set/);

  t.assertStyled("ok", `<p class="t2 mine-\${x} mine">`, ".mine { color: red }");
  t.assertStyled("a quoted choice", `<p class="t2 \${lost === worst ? "bad" : "t2"}">`);
  assert.throws(() => t.assertStyled("bad", `<p class="nobody-styles-this">`), /nobody-styles-this|no stylesheet/);

  const dir = mkdtempSync(join(tmpdir(), "dovre-code-"));
  mkdirSync(join(dir, "shop", ".git"), { recursive: true });
  mkdirSync(join(dir, "notes"));
  const ctx = t.testContext({ codeDir: dir });
  assert.deepEqual(ctx.checkouts!(), ["shop"]);
  assert.equal(ctx.checkout!("shop"), join(dir, "shop"));
  assert.equal(ctx.checkout!("notes"), null);
  assert.equal(t.testContext().checkouts, undefined);
  assert.equal(t.testContext().viewer(), undefined, "no one, as locally");

  const look = (kind: string) => ({ kind, when: "When asked.", fields: [], run: () => "x" });
  const looks = { manifest: { api: t.testAgentsPack().manifest.api, id: "looks", name: "Looks", description: "x", domain: "general" as const }, lookups: () => [look("one"), look("Not A Word"), look("two")] };
  const kept = t.keptLookups(looks);
  assert.deepEqual(kept.kinds, ["looks.one", "looks.two"]);
  assert.equal(kept.left.length, 1, kept.left.join(" | "));
});
