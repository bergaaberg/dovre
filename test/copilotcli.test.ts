/** Bino and summaries through Copilot CLI: no tools, a home of its own per call that's gone after, the prompt on stdin. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copilotCli, copilotCliArgs, parseCopilotJsonl } from "../src/ai/copilotcli.ts";
import { routeOf, viaOf } from "../src/packs/core/assistant/bino/route.ts";
import { type Found, panesOf } from "../src/config.ts";
import { envFor } from "../src/spawn-worker.ts";
import { summariesVia } from "../src/tools.ts";

const ev = (type: string, data: object) => JSON.stringify({ type, data, id: "x", timestamp: "2026-10-23T10:50:35.896Z", parentId: null });
const out = (text: string) =>
  [ev("session.info", { infoType: "configuration", message: "Disabled tools: powershell" }), ev("assistant.message_delta", { deltaContent: "po" }), ev("assistant.message", { content: text, model: "gpt-6-luna", toolRequests: [] }), JSON.stringify({ type: "result", sessionId: "de30a237-8074-4db0-b95c-89648e414bd6", exitCode: 0, usage: { premiumRequests: 1 } })].join("\n");

test("the arguments turn every tool, built-in MCP server and instruction off; a model only when it's a plain name", () => {
  const a = copilotCliArgs("C:\\tmp\\w");
  for (const f of ["--available-tools=__none__", "--disable-builtin-mcps", "--no-custom-instructions", "--no-ask-user", "--no-auto-update"]) assert.ok(a.includes(f), f);
  assert.ok(!a.includes("-p") && !a.some((x) => /allow-all/.test(x)), "no prompt on the command line, nothing allowed");
  assert.equal(a[a.indexOf("-C") + 1], "C:\\tmp\\w");
  assert.ok(!a.includes("--model"));
  assert.deepEqual(copilotCliArgs("w", "gpt-6-luna").slice(-2), ["--model", "gpt-6-luna"]);
  assert.ok(!copilotCliArgs("w", "--allow-all-tools").includes("--allow-all-tools"));
});

test("the reply is the last assistant message; an error or an empty run says so", () => {
  assert.deepEqual(parseCopilotJsonl(out(" pong ")), { text: "pong", sessionId: "de30a237-8074-4db0-b95c-89648e414bd6", premiumRequests: 1, model: "gpt-6-luna", error: undefined });
  assert.equal(parseCopilotJsonl(ev("session.error", { message: "Model not allowed" })).error, "Model not allowed");
  assert.equal(parseCopilotJsonl(JSON.stringify({ type: "result", exitCode: 1 })).error, "Copilot CLI exited 1");
  assert.equal(parseCopilotJsonl("not json\n").text, "");
});

test("each call runs in a fresh Copilot home that's deleted after, with COPILOT_ALLOW_ALL removed and the system text leading the prompt on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "dovre-cli-"));
  // A home a crash left behind is swept before the next call.
  mkdirSync(join(root, "h-left"));
  writeFileSync(join(root, "h-left", "session-store.db"), "Bino's prompt");
  const seen: { args: string[]; cwd?: string; input?: string; env?: Record<string, string | null>; home?: string[] }[] = [];
  const ask = copilotCli({ bin: "copilot", pre: [] }, {
    model: "gpt-6-luna",
    root,
    run: async (_b, args, o) => {
      const home = o.env!.COPILOT_HOME!;
      writeFileSync(join(home, "session-store.db"), o.input!);
      seen.push({ args, cwd: o.cwd, input: o.input, env: o.env, home: readdirSync(home) });
      return { code: 0, stdout: out("Hei."), stderr: "" };
    },
  });
  assert.deepEqual(await ask({ system: "Be Bino.", user: "Hva nå?", model: "sonnet" }), { text: "Hei.", cost: 0 });
  const s = seen[0]!;
  assert.equal(s.env!.COPILOT_ALLOW_ALL, null);
  assert.equal(s.env!.COPILOT_AUTO_UPDATE, "false");
  assert.ok(s.env!.COPILOT_HOME!.startsWith(join(root, "h-")));
  assert.equal(s.cwd, join(s.env!.COPILOT_HOME!, "work"), "an empty folder inside it");
  assert.equal(s.input, "<instructions>\nBe Bino.\n</instructions>\n\nHva nå?");
  assert.equal(s.args[s.args.indexOf("--model") + 1], "gpt-6-luna", "Copilot's model, never the Claude one asked for");
  assert.deepEqual(readdirSync(root), [], "the home, with the prompt Copilot kept, is gone; so is the one left behind");
  // It's gone after a failure too.
  const failing = copilotCli({ bin: "copilot", pre: [] }, { root, run: async () => ({ code: 1, stdout: ev("session.error", { message: "Not signed in" }), stderr: "" }) });
  await assert.rejects(failing({ system: "s", user: "u" }), /Not signed in/);
  assert.deepEqual(readdirSync(root), []);
});

test("a job's environment: changes over this one, a null removes a variable whatever its case", () => {
  const env = envFor({ COPILOT_HOME: "C:\\h", COPILOT_ALLOW_ALL: null }, { Path: "C:\\bin", copilot_allow_all: "true", COPILOT_HOME: "C:\\old" })!;
  assert.deepEqual(env, { Path: "C:\\bin", COPILOT_HOME: "C:\\h" });
  assert.equal(envFor(undefined), undefined, "no changes: the program gets this process's environment");
});

test("Bino and summaries pick Copilot CLI when it's the only way in, or when asked; it says what's missing", async () => {
  const base: Found = { claude: false, omp: false, pwsh: true, db: true, terminals: true };
  assert.equal(viaOf(undefined, false, false, true), "copilot");
  assert.equal(viaOf(undefined, false, true, true), "omp", "omp first, as before");
  assert.equal(viaOf("copilot", true, true, true), "copilot");
  assert.equal(summariesVia(undefined, false, false, true), "copilot");
  assert.equal(summariesVia("copilot", true, false, false), "copilot");
  const p = panesOf({}, { ...base, copilotCli: true });
  assert.equal(p.bino.via, "copilot");
  assert.equal(p.bino.on, true);
  assert.equal(p.summaries.via, "copilot");
  assert.equal(p.summaries.on, true);
  const missing = panesOf({ BINO_VIA: "copilot", SUMMARIES: "copilot" }, { ...base, claude: true });
  assert.match(missing.bino.why ?? "", /Copilot CLI/);
  assert.match(missing.summaries.why ?? "", /Copilot CLI/);
  const route = routeOf({ via: "copilot", copilotCli: async ({ user }) => ({ text: `> ${user}`, cost: 0 }), copilotCliModel: "gpt-6-luna" });
  assert.equal(route.ready, true);
  assert.equal(route.model, "gpt-6-luna");
  assert.deepEqual(await route.ask!({ system: "s", user: "hei" }), { text: "> hei", cost: 0 });
  assert.equal(routeOf({ via: "copilot" }).ready, false);
  assert.equal(routeOf({ via: "copilot", copilotCli: route.ask }).model, "auto");
  assert.ok(!existsSync(join(tmpdir(), "dovre-cli-never")));
});
