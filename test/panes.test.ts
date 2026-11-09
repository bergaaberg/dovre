/** Panes switched on Settings (WP-A23): what runs, what's kept, and an off pane gone from every page. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromForm, type Found, legacyOff, loadConfig, PANE_IDS, panesOf, runningOf, saveConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { pagesOf } from "../src/search/search.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const all: Found = { claude: true, omp: true, pwsh: true, db: true, terminals: true };
const none: Found = { claude: false, omp: false, pwsh: false, db: false, terminals: false };

test("with everything here, every pane runs; Bino takes Claude Code", () => {
  const p = panesOf({}, all);
  for (const id of PANE_IDS) assert.equal(p[id].on, true, id);
  assert.equal(p.bino.via, "claude");
});

test("the assistant pack's setting offers every route Bino can take but off (#417)", async () => {
  const { assistantPack } = await import("../src/packs/core/assistant/index.ts");
  const { VIAS } = await import("../src/packs/core/assistant/bino/route.ts");
  const s = assistantPack().manifest.settings?.find((x) => x.key === "ASSISTANT_VIA");
  assert.deepEqual(s?.choices?.map((c) => c.value), VIAS.filter((v) => v !== "off"));
});

test("without Claude Code: Bino goes to Copilot through omp", () => {
  const p = panesOf({}, { ...all, claude: false });
  assert.equal(p.bino.via, "omp");
});

test("a pane that can't run here says why; one switched off doesn't", () => {
  const p = panesOf({}, none);
  assert.match(p.terminal.why ?? "", /launcher/);
  assert.equal(p.bino.wanted, false, "no model at all: off");
  const on = runningOf(p);
  assert.equal("summaries" in on, false, "AI summaries are the summaries pack's now (#390)");
  assert.equal("reviews" in on, false, "Agent reviews are the reviews pack's now (#389)");
  assert.equal("stats" in on, false, "Stats is the history pack's now (#387)");
  assert.equal("lab" in on, false, "the Lab is gone");
});

test("the form: bad values refused; fixed keys left alone; keys it doesn't have aren't kept", () => {
  assert.deepEqual(configFromForm({ TZ_NAME: "Europe/Oslo" }, {}, new Set(), { general: true }), { config: { TZ_NAME: "Europe/Oslo" }, bad: [] });
  assert.equal(configFromForm({ TZ_NAME: "Europe/Oslo" }, {}, new Set(["TZ_NAME"]), { general: true }).config.TZ_NAME, undefined, "set in .dev.vars: not touched");
  const worse = configFromForm({ TZ_NAME: "no where", JIRA_PROJECTS: "JSD; rm -rf", "via.bino": "omp" }, {}, new Set(), { general: true });
  assert.deepEqual(worse.bad, ["Timezone"]);
  assert.equal(worse.config.JIRA_PROJECTS, undefined, "a key Settings doesn't have isn't kept");
  assert.equal(worse.config.BINO_VIA, undefined, "Bino's route is the assistant pack's setting now (#417)");
  const empty = configFromForm({ TZ_NAME: "" }, { TZ_NAME: "Europe/Oslo" }, new Set(), { general: true });
  assert.equal(empty.config.TZ_NAME, undefined, "empty is the default");
  const work = configFromForm({ CODE_DIR: "C:\\Users\\x\\Code", TZ_NAME: "Europe/Oslo", "via.bino": "omp" }, {}, new Set(), { general: true });
  assert.deepEqual(work.config, { CODE_DIR: "C:\\Users\\x\\Code", TZ_NAME: "Europe/Oslo" }, "the work form leaves the switches alone");
  assert.deepEqual(configFromForm({ CODE_DIR: "a<b" }, {}, new Set(), { general: true }).bad, ["Code folder"]);
});

test("kept in the settings table: known keys only, as strings", async () => {
  const db = openDb();
  assert.deepEqual(await loadConfig(db.DB), {});
  await saveConfig(db.DB, { REVIEWS: "off", PATH: "C:\\evil", GHE_TOKEN: "x" } as Record<string, string>);
  assert.deepEqual(await loadConfig(db.DB), { REVIEWS: "off" });
  await db.DB.prepare("UPDATE settings SET value = ? WHERE key = 'config'").bind(JSON.stringify({ REVIEWS: 1, STATS: "off", GHE_HOST: "evil.example" })).run();
  assert.deepEqual(await loadConfig(db.DB), { STATS: "off" });
});

test("what Settings keeps sits under the environment and .dev.vars", () => {
  const saved = { ...process.env };
  try {
    process.env.GHE_TOKEN = "t";
    process.env.REVIEWS = "on";
    const env = loadEnv({ REVIEWS: "off", STATS: "off" });
    assert.equal(env.REVIEWS, "on", "the environment wins");
    assert.equal(env.STATS, "off");
  } finally {
    process.env = saved;
  }
});

test("an off pane is gone from the menu, search, Today and its pages", async () => {
  const { get } = signedIn(snapshot(), {}, { panes: { bino: false } });
  for (const path of ["/jira", "/bino", "/prs/agent?kind=review", "/prs/draft", "/lab"]) assert.equal((await get(path)).status, 404, path);
  // Stats is the packs' (#387): offered only while one draws there.
  assert.ok(!pagesOf().some((p) => p.href === "/stats" || p.href === "/jira"));
  assert.ok(pagesOf({ stats: true }).some((p) => p.href === "/stats"));
});

test("without Claude Code, Bino and summaries talk to Copilot through omp: no tools, the system prompt as omp's", async () => {
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ompAsker } = await import("../src/ai/omp.ts");
  const { copilotComplete } = await import("../src/ai/llm.ts");
  const { routeOf, viaOf } = await import("../src/packs/core/assistant/bino/route.ts");
  const { summariesVia } = await import("../src/tools.ts");
  assert.equal(viaOf(undefined, false, true), "omp");
  assert.equal(viaOf(undefined, true, true), "claude");
  assert.equal(summariesVia(undefined, false, true), "omp");
  assert.equal(summariesVia("on", true, true), "claude");
  assert.equal(summariesVia("off", true, true), "off");
  const home = mkdtempSync(join(tmpdir(), "dovre-copilot-"));
  const seen: string[][] = [];
  const said = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "github-copilot", content: [{ type: "text", text }] } });
  const copilot = ompAsker({ omp: { bin: "omp", pre: [] }, profile: "dovre-copilot", model: "github-copilot/gpt-6-luna:medium", cwd: home, home, who: { name: "Copilot through omp", profileVar: "TEAMS_CRAWL_PROFILE", modelVar: "TEAMS_CRAWL_MODEL" }, run: async (_b, args, o) => (seen.push([...args, `<stdin>${o.input}`]), { code: 0, stdout: said(" Hei. "), stderr: "" }) });
  const notYet = routeOf({ via: "omp", copilot });
  assert.equal(notYet.ready, false);
  assert.match(notYet.why ?? "", /omp --profile dovre-copilot/, "says how to set the profile up");
  assert.match(panesOf({}, { ...all, claude: false, copilot: false }).bino.why ?? "", /isn't set up/);
  mkdirSync(join(home, ".omp", "profiles", "dovre-copilot", "agent"), { recursive: true });
  const route = routeOf({ via: "omp", copilot });
  assert.equal(route.ready, true);
  assert.equal(route.model, "github-copilot/gpt-6-luna:medium");
  assert.deepEqual(await route.ask!({ system: "Be Bino.", user: "Hva nå?", model: "sonnet" }), { text: "Hei.", cost: 0 });
  const args = seen[0]!;
  for (const flag of ["--no-tools", "--no-session", "--no-extensions"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--system-prompt") + 1], "Be Bino.");
  assert.equal(args[args.indexOf("--model") + 1], "github-copilot/gpt-6-luna:medium", "never the Claude model asked for");
  assert.equal(args.at(-1), "<stdin>Hva nå?");
  assert.deepEqual(await copilotComplete(copilot)({ system: "Summarise.", user: "PR text" }), { text: "Hei.", cost: 0 });
  assert.equal(routeOf({ via: "omp" }).ready, false, "no omp at all");
});

test("the old Terminal, Docker and Bino switches turn their packs off; Bino's route stays (#271)", () => {
  assert.deepEqual(legacyOff({ TERMINAL: "off", DOCKER: "on", BINO_VIA: "omp" }), ["terminal"]);
  assert.deepEqual(legacyOff({ DOCKER: "no", BINO_VIA: "off", ASSISTANT_VIA: "off" }), ["docker", "assistant"]);
  const p = panesOf({ BINO_VIA: "off", TERMINAL: "off", DOCKER: "off" }, all);
  assert.equal(p.bino.via, "claude", "an old off is the pack's now: the route is the default");
  assert.equal(p.terminal.on, true, "can run: on or off is the pack's");
});
