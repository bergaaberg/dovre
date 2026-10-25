/** Panes switched on Settings (WP-A23): what runs, what's kept, and an off pane gone from every page. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromForm, type Found, loadConfig, PANE_IDS, panesOf, runningOf, saveConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { pagesOf } from "../src/search/search.ts";
import { H, assertInert, signedIn, snapshot } from "./helpers.ts";

const all: Found = { claude: true, omp: true, terminals: true };
const none: Found = { claude: false, omp: false, terminals: false };

test("with everything here, every pane runs; Bino and summaries take Claude Code", () => {
  const p = panesOf({}, all);
  for (const id of PANE_IDS) assert.equal(p[id].on, true, id);
  assert.equal(p.bino.via, "claude");
  assert.equal(p.summaries.via, "claude");
});

test("Settings offers every route Bino and summaries can take", () => {
  const form = (pane: string, via: string) => configFromForm({ [`on.${pane}`]: "on", [`via.${pane}`]: via }, {}, new Set(), { panes: true });
  for (const via of ["claude", "omp", "copilot", "agy", "codex", "cf-gateway"]) assert.equal(form("bino", via).config.BINO_VIA, via, via);
  for (const via of ["claude", "omp", "copilot", "agy", "codex"]) assert.equal(form("summaries", via).config.SUMMARIES, via, via);
});

test("without Claude Code: Bino and summaries go to Copilot through omp", () => {
  const p = panesOf({}, { ...all, claude: false });
  assert.equal(p.bino.via, "omp");
  assert.equal(p.summaries.via, "omp");
  assert.equal(p.reviews.on, true, "omp reviews");
});

test("a pane that can't run here says why; one switched off doesn't", () => {
  const p = panesOf({ STATS: "off" }, none);
  assert.equal(p.stats.on, false);
  assert.equal(p.stats.why, undefined);
  assert.match(p.reviews.why ?? "", /agent CLI/);
  assert.equal(p.docker.on, true, "unknown: as before");
  const mac = panesOf({}, { ...none, windows: false });
  assert.match(mac.docker.why ?? "", /No Docker Engine socket found/);
  const macWithDocker = panesOf({}, { ...none, windows: false, dockerSocket: "/var/run/docker.sock" });
  assert.equal(macWithDocker.docker.on, true);
  assert.equal(macWithDocker.docker.why, undefined);
  assert.equal(p.bino.wanted, false, "no model at all: off");
  const on = runningOf(p);
  assert.equal(on.stats, false);
});

test("the form: a switch, a route, options; bad values refused; fixed keys left alone", () => {
  const form = { "on.bino": "on", "via.bino": "omp" };
  const { config, bad } = configFromForm(form, { STATS: "on" }, new Set(["LAB"]), { panes: true });
  assert.deepEqual(bad, []);
  assert.equal(config.BINO_VIA, "omp");
  assert.equal(config.STATS, "off", "unticked is off");
  assert.equal(config.LAB, undefined, "set in .dev.vars: not touched");
  const worse = configFromForm({ "on.bino": "on", "via.bino": "gpt-at-home", JIRA_PROJECTS: "JSD; rm -rf" }, {}, new Set(), { panes: true });
  assert.deepEqual(worse.bad, ["Bino"]);
  assert.equal(worse.config.JIRA_PROJECTS, undefined, "a key no pane has isn't kept");
  const work = configFromForm({ CODE_DIR: "C:\\Users\\x\\Code", TEAM: "my-team", FORM_REPOS: "FORMS" }, {}, new Set(), { general: true });
  assert.deepEqual(work.config, { CODE_DIR: "C:\\Users\\x\\Code", TEAM: "my-team", FORM_REPOS: "FORMS" }, "the work form leaves the switches alone");
  assert.deepEqual(configFromForm({ TEAM: "a/b" }, {}, new Set(), { general: true }).bad, ["Your team on GHE"]);
});

test("kept in the settings table: known keys only, as strings", async () => {
  const db = openDb();
  assert.deepEqual(await loadConfig(db.DB), {});
  await saveConfig(db.DB, { STATS: "off", PATH: "C:\\evil", GHE_TOKEN: "x" } as Record<string, string>);
  assert.deepEqual(await loadConfig(db.DB), { STATS: "off" });
  await db.DB.prepare("UPDATE settings SET value = ? WHERE key = 'config'").bind(JSON.stringify({ DATA: 1, STATS: "off", GHE_HOST: "evil.example" })).run();
  assert.deepEqual(await loadConfig(db.DB), { STATS: "off" });
});

test("what Settings keeps sits under the environment and .dev.vars", () => {
  const saved = { ...process.env };
  try {
    process.env.GHE_TOKEN = "t";
    process.env.LAB = "off";
    const env = loadEnv({ LAB: "on", STATS: "off" });
    assert.equal(env.LAB, "off", "the environment wins");
    assert.equal(env.STATS, "off");
  } finally {
    process.env = saved;
  }
});

test("an off pane is gone from the menu, search, Today and its pages", async () => {
  const off = { stats: false, jira: false, reviews: false, lab: false };
  const { get } = signedIn(snapshot(), {}, { panes: off });
  const today = await (await get("/")).text();
  assert.doesNotMatch(today, /href="\/stats"/);
  for (const path of ["/stats", "/jira", "/prs/agent?kind=review", "/prs/draft", "/lab"]) assert.equal((await get(path)).status, 404, path);
  assert.ok(!pagesOf({ stats: false }).some((p) => p.href === "/stats" || p.href === "/jira"));
  assert.ok(pagesOf().some((p) => p.href === "/stats"), "unset is on");
  const on = signedIn(snapshot());
  assert.match(await (await on.get("/")).text(), /href="\/stats"/);
});

test("Settings shows each pane and saves the form; what can't run says why", async () => {
  const panes = panesOf({ BINO_VIA: "omp" }, { ...all });
  const config = { panes, stored: { BINO_VIA: "omp" } };
  const { get, post, db } = signedIn(snapshot(), {}, { config });
  const page = await (await get("/settings")).text();
  assertInert("settings", page);
  assert.match(page, /<option value="omp" selected>/);
  const r = await post("/settings/panes", { "on.bino": "on", "via.bino": "claude", "on.stats": "on" });
  assert.equal(r.status, 303);
  const kept = await loadConfig(db.DB);
  assert.equal(kept.BINO_VIA, "claude");
  assert.equal(kept.STATS, "on");
  assert.match(await (await get("/settings")).text(), /Saved\./);
  await post("/settings/panes", { "on.bino": "on", "via.bino": "nope" });
  assert.match(await (await get("/settings")).text(), /Not saved: Bino/);
  assert.equal((await loadConfig(db.DB)).BINO_VIA, "claude", "a refused form keeps nothing");
});

test("the first run: Today sends to the first-run page until it's answered or skipped", async () => {
  const config = { panes: panesOf({}, all), stored: {} as Record<string, string> };
  const teams = [
    { slug: "my-team", name: "Skreddersøm", organization: { login: "ACME" } },
    { slug: "other", name: "Elsewhere", organization: { login: "SomeoneElse" } },
    { slug: "x", name: H, organization: { login: "ACME" } },
    { slug: "bad slug<", name: "Bad", organization: { login: "ACME" } },
  ];
  const { get, post, db } = signedIn(snapshot(), { "GET /user/teams?per_page=100": teams }, { config });
  const first = await get("/");
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/welcome");
  const splash = await (await get("/welcome")).text();
  assert.match(splash, /class="splash-page"/);
  assert.match(splash, /href="\/welcome\?go=1">Get started/);
  assert.doesNotMatch(splash, /class="side"/, "no menu on the splash");
  const page = await (await get("/welcome?go=1")).text();
  assertInert("welcome", page);
  assert.match(page, /Found here/);
  assert.match(page, /<option value="my-team">Skreddersøm \(my-team\)<\/option>/);
  assert.doesNotMatch(page, /Elsewhere|bad slug/, "only the org's teams, with plain slugs");
  const bad = await post("/welcome", { TEAM: "no/slashes" });
  assert.equal(bad.headers.get("location"), "/welcome?go=1");
  assert.match(await (await get("/welcome?go=1")).text(), /Not saved: Your team on GHE/);
  const r = await post("/welcome", { TEAM: "my-team", "on.jira": "on", "via.jira": "mcp" });
  assert.equal(r.headers.get("location"), "/", "no supervisor in a test: straight to Today");
  const kept = await loadConfig(db.DB);
  assert.equal(kept.SETUP_DONE, "1");
  assert.equal(kept.TEAM, "my-team");
  assert.equal(kept.STATS, "off", "unticked");
  assert.equal((await get("/")).status, 200);
});

test("skipping the first run keeps nothing but that it was seen", async () => {
  const config = { panes: panesOf({}, all), stored: {} as Record<string, string> };
  const { get, post, db } = signedIn(snapshot(), {}, { config });
  assert.equal((await get("/welcome")).status, 200, "the teams list failing doesn't stop the page");
  await post("/welcome/skip", {});
  assert.deepEqual(await loadConfig(db.DB), { SETUP_DONE: "1" });
  assert.equal((await get("/")).status, 200);
  assert.match(await (await get("/settings/started")).text(), /^\d+$/);
});

test("without Claude Code, Bino and summaries talk to Copilot through omp: no tools, the system prompt as omp's", async () => {
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ompCopilot } = await import("../src/ai/omp.ts");
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
  const copilot = ompCopilot({ omp: { bin: "omp", pre: [] }, profile: "dovre-copilot", model: "github-copilot/gpt-6-luna:medium", cwd: home, home, run: async (_b, args, o) => (seen.push([...args, `<stdin>${o.input}`]), { code: 0, stdout: said(" Hei. "), stderr: "" }) });
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
