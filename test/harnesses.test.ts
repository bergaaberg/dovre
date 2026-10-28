/** Agent harnesses, one folder each (#107): the list, each one's agent-host filter, and the on/off switch per CLI in Settings. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexModelsIn, foundModels, ompModelsIn } from "../src/agents/harnesses/found.ts";
import { HARNESS_DEFS, harnessDef, harnessesFor, modelsOf, useFoundModels } from "../src/agents/harnesses/index.ts";
import { modelOf } from "../src/agents/desk.ts";
import { modelSelect } from "../src/pages/models.ts";
import { HARNESSES } from "../src/agents/runner.ts";
import { configFromForm, GENERAL } from "../src/config.ts";
import { fieldInput } from "../src/pages/settings.ts";
import { harnessesOn } from "../src/tools.ts";

const root = new URL("../", import.meta.url);
const tool = (bin: string) => ({ bin, pre: ["/x/cli.js"], path: bin });

test("harnesses: each one core runs has a folder, and a filter in the agent host that Keep sends its lines to", () => {
  assert.deepEqual(HARNESS_DEFS.map((d) => d.id).sort(), [...HARNESSES].sort());
  const keep = readFileSync(new URL("launcher/agenthost.go", root), "utf8");
  for (const d of HARNESS_DEFS) {
    assert.ok(existsSync(new URL(`src/agents/harnesses/${d.id}/harness.ts`, root)), d.id);
    assert.equal(d.keep, `launcher/keep_${d.id}.go`);
    const fn = `keep${d.id[0]!.toUpperCase()}${d.id.slice(1)}`;
    assert.match(readFileSync(new URL(d.keep, root), "utf8"), new RegExp(`func ${fn}\\(j map\\[string\\]any\\) \\[\\]byte`), d.keep);
    assert.match(keep, new RegExp(`return ${fn}\\(j\\)`), `Keep dispatches to ${fn}`);
    assert.equal(modelsOf(d.id)[0]?.value, "", `${d.id}: the first model is the CLI's own default`);
  }
});

test("harnesses: the runner gets only those this machine has and the settings leave on, started as found", () => {
  const tools = { claude: tool("/bin/claude"), codex: tool("/bin/codex"), agy: tool("/bin/agy") };
  const hs = harnessesFor(tools, harnessesOn("claude, codex, omp"));
  assert.deepEqual(Object.keys(hs).sort(), ["claude", "codex"]);
  for (const [id, h] of Object.entries(hs)) {
    assert.equal(h!.id, id);
    assert.equal(h!.bin, `/bin/${id}`);
    assert.deepEqual(h!.pre, ["/x/cli.js"]);
  }
  assert.deepEqual(Object.keys(harnessesFor(tools, harnessesOn("none"))), [], "none ticked: none on");
});

test("Settings: one box per agent CLI, kept as the list; all ticked is the default, none is none, unknown boxes ignored", () => {
  const save = (form: Record<string, string>) => configFromForm({ AGENT_HARNESSES: "", ...form }, { AGENT_HARNESSES: "claude" }, new Set(), { general: true });
  const all = Object.fromEntries(["claude", "omp", "copilot", "agy", "codex"].map((h) => [`AGENT_HARNESSES.${h}`, "on"]));
  assert.equal(save(all).config.AGENT_HARNESSES, undefined, "all ticked: back to the default");
  assert.equal(save({}).config.AGENT_HARNESSES, "none");
  assert.equal(save({ "AGENT_HARNESSES.omp": "on", "AGENT_HARNESSES.rm -rf": "on" }).config.AGENT_HARNESSES, "omp");
  // Left off the form (another area's save): unchanged.
  assert.equal(configFromForm({}, { AGENT_HARNESSES: "claude" }, new Set(), { general: true }).config.AGENT_HARNESSES, "claude");

  const field = GENERAL.find((g) => g.key === "AGENT_HARNESSES")!;
  const drawn = String(fieldInput(field, "claude, codex", false));
  assert.match(drawn, /name="AGENT_HARNESSES\.claude" value="on" checked/);
  assert.match(drawn, /name="AGENT_HARNESSES\.codex" value="on" checked/);
  assert.match(drawn, /name="AGENT_HARNESSES\.omp" value="on">/);
  assert.match(String(fieldInput(field, undefined, false)), /name="AGENT_HARNESSES\.agy" value="on" checked/, "unset: every one ticked");
  assert.match(String(fieldInput(field, "codex", true)), /name="AGENT_HARNESSES\.codex" value="on" checked disabled/, "set in .dev.vars: fixed");
});

test("found models: omp's roles (default first, each once, no thinking level) and Codex's model and profiles; broken or hostile configs give none", () => {
  const omp = "modelRoles:\n  smol: zai/glm-5.3-flash:low\n  task: zai/glm-5.3-flash:xhigh\n  default: google-antigravity/gemini-3.8-flash:high\n  web: --exec\n  bad: '<img src=x>'\ntheme:\n  dark: titanium\n";
  assert.deepEqual(ompModelsIn(omp), [
    { value: "google-antigravity/gemini-3.8-flash", label: "gemini-3.8-flash (google-antigravity)" },
    { value: "zai/glm-5.3-flash", label: "glm-5.3-flash (zai)" },
  ]);
  assert.deepEqual(ompModelsIn("modelRoles: [oops\n  : :"), []);
  assert.deepEqual(ompModelsIn("theme: x\n"), []);
  const codex = 'model = "gpt-5-codex" # mine\nmodel_provider = "openai"\n[mcp_servers.x]\nmodel = "not-this"\n[profiles.fast]\nmodel = \'gpt-5-mini\'\n[profiles.evil]\nmodel = "a b; rm -rf"\n[profiles.again]\nmodel = "gpt-5-codex"\n';
  assert.deepEqual(codexModelsIn(codex).map((m) => m.value), ["gpt-5-codex", "gpt-5-mini"]);
  assert.deepEqual(codexModelsIn("model = [\n"), []);
});

test("found models: read from this machine's configs when the local server turns them on, re-read once changed; else the fixed list", () => {
  const home = mkdtempSync(join(tmpdir(), "dovre-models-"));
  let t = 0;
  const read = foundModels({ home, env: {}, now: () => t });
  assert.deepEqual(read("omp"), [], "no config: none");
  assert.deepEqual(read("claude"), []);
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "modelRoles:\n  default: zai/glm-5.3-flash:high\n");
  assert.deepEqual(read("omp"), [], "cached for a while");
  t += 31_000;
  assert.deepEqual(read("omp").map((m) => m.value), ["zai/glm-5.3-flash"]);

  const fixed = modelsOf("omp");
  try {
    useFoundModels(read);
    assert.deepEqual(modelsOf("omp").map((m) => m.value), ["", "zai/glm-5.3-flash"], "the CLI's default, then its config's");
    assert.deepEqual(modelsOf("codex"), harnessDef("codex").models, "none found: the fixed list");
    assert.equal(modelOf("zai/glm-5.3-flash", "omp"), "zai/glm-5.3-flash");
    assert.match(String(modelSelect("", ["omp"])), /glm-5\.3-flash \(zai\)/);
  } finally {
    useFoundModels(undefined);
  }
  assert.deepEqual(modelsOf("omp"), fixed);
});
