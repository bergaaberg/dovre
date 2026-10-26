/**
 * Go-Live verification suite (WP-M4, WP-M5, WP-M6):
 * - WP-M4: Pluggable Packs (`PACK_API`, `PACK_<ID>=off`, `packs.ts`) & Assistant routes (`api-key`, `openrouter`, `cf-gateway`, `ASSISTANT_VIA`).
 * - WP-M5: Interactive `/setup` actions (`POST /setup/owners`, `/setup/token`, `/setup/gh-login`, origin guard) & 1-command Cloudflare provisioner (`provisionInstance`).
 * - WP-M6: Pre-built packs installation (`addPack`, `wirePackIntoFile`, `listAvailablePacks`) from `dovre-packs`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { routeOf } from "../src/packs/core/assistant/bino/route.ts";
import { panesOf } from "../src/config.ts";
import { loadPacks } from "../src/packs/load.ts";
import { activePacks } from "../src/packs/registry.ts";
import { loadEnv } from "../src/env.ts";
import { hostedBinoRoute } from "../src/hosted/hub.ts";
import { instanceFiles, writeInstance } from "../src/instance-new.ts";
import { extractD1Uuid, patchWranglerConfig, provisionInstance, readWranglerInfo } from "../src/instance-provision.ts";
import { addPack, listAvailablePacks, wirePackIntoFile } from "../src/packs/cli.ts";
import { PACK_API, type Pack } from "../src/packs/types.ts";
import { setupApp, type SetupState } from "../src/setup.ts";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test("WP-M4: Pack contract aliases, PACK_<ID>=off, and loadPacks with packs.ts", async () => {
  const p: Pack = {
    manifest: {
      api: PACK_API,
      id: "demo-pack",
      name: "Demo Pack",
      description: "Test pack",
      domain: "personal",
    },
  };
  const off = activePacks([p], { env: { PACK_DEMO_PACK: "off" }, hosted: false });
  assert.equal(off.on.length, 0);
  assert.equal(off.off[0]?.why, "switched off");

  const dir = tmp("dovre-packs-load-");
  writeFileSync(
    join(dir, "packs.ts"),
    `export default [{ manifest: { api: ${PACK_API}, id: "from-packs-ts", name: "From Packs", description: "", domain: "personal" } }];\n`,
  );
  const loaded = await loadPacks(dir, {});
  assert.equal(loaded.packs.length, 1);
  assert.equal(loaded.packs[0]?.manifest.id, "from-packs-ts");
});

test("WP-M4: Assistant Direct API Key (cheap model recommended) and OpenRouter routes work locally and hosted", async () => {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, headers, body });
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: "Direct Anthropic reply." }],
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "OpenAI / OpenRouter reply." } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
      { status: 200 },
    );
  };

  // 1. Direct Anthropic API Key (defaults to cheap claude-haiku-5-5)
  const directAnthropic = routeOf({
    via: "api-key",
    apiKey: { apiKey: "sk-ant-test-123", fetchFn: fakeFetch },
  });
  assert.equal(directAnthropic.ready, true);
  assert.equal(directAnthropic.model, "claude-haiku-5-5");
  const r1 = await directAnthropic.ask!({ system: "Sys", user: "Hello" });
  assert.equal(r1.text, "Direct Anthropic reply.");
  assert.match(calls.at(-1)!.url, /api\.anthropic\.com\/v1\/messages/);
  assert.equal(calls.at(-1)!.headers["x-api-key"], "sk-ant-test-123");

  // 2. Direct OpenAI API Key (auto-detects sk-proj-... -> gpt-4o-mini)
  const directOpenAi = routeOf({
    via: "api-key",
    apiKey: { apiKey: "sk-proj-openai-123", fetchFn: fakeFetch },
  });
  assert.equal(directOpenAi.ready, true);
  assert.equal(directOpenAi.model, "gpt-4o-mini");
  const r2 = await directOpenAi.ask!({ system: "Sys", user: "Hello" });
  assert.equal(r2.text, "OpenAI / OpenRouter reply.");
  assert.match(calls.at(-1)!.url, /api\.openai\.com\/v1\/chat\/completions/);

  // 3. OpenRouter route (hostedBinoRoute + ASSISTANT_VIA alias)
  const hostedOr = hostedBinoRoute(
    {
      DB: {} as never,
      ASSISTANT_VIA: "openrouter",
      OPENROUTER_API_KEY: "sk-or-v1-test",
    },
    fakeFetch,
  );
  assert.equal(hostedOr.ready, true);
  assert.equal(hostedOr.model, "anthropic/claude-3.5-haiku");
  const r3 = await hostedOr.ask!({ system: "Sys", user: "Hello" });
  assert.equal(r3.text, "OpenAI / OpenRouter reply.");
  assert.match(calls.at(-1)!.url, /openrouter\.ai\/api\/v1\/chat\/completions/);

  // 4. Env & Panes support ASSISTANT_VIA and api-key / openrouter
  const env = loadEnv({ ASSISTANT_VIA: "api-key", ASSISTANT_API_KEY: "sk-ant-123", PACKS: "~/src/my-packs" });
  assert.equal(env.BINO_VIA, "api-key");
  assert.equal(env.CRATES, "~/src/my-packs");
  const panes = panesOf(env, { claude: false, omp: false, pwsh: false, db: false, terminals: false });
  assert.equal(panes.bino.on, true);
  assert.equal(panes.bino.via, "api-key");
});

test("WP-M5: interactive /setup routes save owners, tokens, and start gh web login while blocking foreign origins", async () => {
  const dir = tmp("dovre-setup-interactive-");
  const varsFile = join(dir, ".dev.vars");
  const state: SetupState = { discoveredOwners: ["andreasberg", "acme-org"] };
  let woke = 0;

  const app = setupApp({
    problem: { kind: "org", host: "github.com" },
    token: "tok-1234567890abcdef",
    info: { version: "0.2.0", startedAt: 1 },
    state: () => state,
    varsFile,
    onStartGhLogin: () => ({ deviceCode: "ABCD-1234", deviceUrl: "https://github.com/login/device" }),
    onWake: () => {
      woke++;
    },
  });

  // Pre-fills discoveredOwners on /setup
  const html = await (await app.request("http://127.0.0.1:4848/")).text();
  assert.match(html, /andreasberg, acme-org/);

  // Rejects cross-origin POST
  const evil = await app.request("http://127.0.0.1:4848/setup/owners", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: "owners=evil",
  });
  assert.equal(evil.status, 404);

  // Saves valid owners to .dev.vars and triggers wake
  const okOwners = await app.request("http://127.0.0.1:4848/setup/owners", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4848", "content-type": "application/x-www-form-urlencoded" },
    body: "owners=andreasberg%2C+acme-org",
  });
  assert.equal(okOwners.status, 303);
  assert.match(readFileSync(varsFile, "utf8"), /REPO_OWNERS=andreasberg, acme-org/);
  assert.equal(woke, 1);

  // Saves token via /setup/token
  const okToken = await app.request("http://127.0.0.1:4848/setup/token", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4848", "content-type": "application/x-www-form-urlencoded" },
    body: "token=ghp_1234567890abcdef1234567890",
  });
  assert.equal(okToken.status, 303);
  assert.match(readFileSync(varsFile, "utf8"), /GITHUB_TOKEN=ghp_1234567890abcdef1234567890/);

  // Triggers device code via /setup/gh-login
  const ghLogin = await app.request("http://127.0.0.1:4848/setup/gh-login", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4848" },
  });
  assert.equal(ghLogin.status, 303);
  assert.equal(state.deviceCode, "ABCD-1234");
});

test("WP-M5: provisionInstance auto-creates D1, patches wrangler.jsonc, applies migrations, and sets BRIDGE_KEY", () => {
  const dir = tmp("dovre-prov-");
  writeInstance(dir, instanceFiles({ name: "my-cockpit", domain: "dovre.acme.dev" }));
  const varsFile = join(dir, ".dev.vars");
  const fakeUuid = "5077de88-85f6-4678-96f5-00e2d0cb3850";
  const ran: string[] = [];

  const res = provisionInstance({
    dir,
    coreVarsFile: varsFile,
    allowedEmails: "dev@acme.dev",
    cfAccessTeam: "acme-team",
    cfAccessAud: "aud-tag-123",
    deploy: true,
    log: () => {},
    run: (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`;
      ran.push(line);
      if (line.includes("wrangler d1 create")) {
        return { status: 0, stdout: `Created D1 database 'my-cockpit-db' with database_id = "${fakeUuid}"`, stderr: "" };
      }
      if (line.includes("gh api user")) {
        return { status: 0, stdout: "octocat\n", stderr: "" };
      }
      if (line.includes("gh auth token")) {
        return { status: 0, stdout: "gho_testtoken123456\n", stderr: "" };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    },
  });

  assert.equal(res.dbId, fakeUuid);
  assert.ok(res.bridgeKey.length >= 24);
  const patched = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  const info = readWranglerInfo(patched);
  assert.equal(info.dbId, fakeUuid);
  assert.match(patched, /"GITHUB_USER": "octocat"/);
  assert.match(patched, /"ALLOWED_EMAILS": "dev@acme.dev"/);
  assert.match(patched, /"CF_ACCESS_TEAM": "acme-team"/);
  assert.match(patched, /"CF_ACCESS_AUD": "aud-tag-123"/);
  assert.match(readFileSync(varsFile, "utf8"), /BRIDGE_KEY=/);
  assert.match(readFileSync(varsFile, "utf8"), /BRIDGE_URL=wss:\/\/dovre\.acme\.dev\/bridge/);
  assert.ok(ran.some((c) => c.includes("migrations apply my-cockpit-db --remote")));
  assert.ok(ran.some((c) => c.includes("secret put BRIDGE_KEY")));
  assert.ok(ran.some((c) => c.includes("secret put GITHUB_TOKEN")));
  assert.ok(ran.some((c) => c.includes("wrangler deploy")));
  assert.equal(extractD1Uuid("id: 5077de88-85f6-4678-96f5-00e2d0cb3850"), fakeUuid);
  assert.match(patchWranglerConfig(patched, { domain: "new.acme.dev" }), /"pattern": "new\.acme\.dev"/);
});

test("WP-M6: listAvailablePacks and addPack copy pre-built packs from dovre-packs and wire them into crates.ts", () => {
  const packsRepo = resolve(import.meta.dirname, "..", "..", "dovre-packs");
  const avail = listAvailablePacks(packsRepo);
  // At least these, sorted: a new pack in dovre-packs mustn't fail core's tests.
  for (const id of ["cf-health", "custom-app", "docker", "http-otel", "jira"]) assert.ok(avail.includes(id), id);
  assert.deepEqual(avail, [...avail].sort());

  const dir = tmp("dovre-inst-pack-");
  writeInstance(dir, instanceFiles({ name: "pack-test", domain: "dovre.pack.dev" }));

  const r1 = addPack({ id: "cf-health", into: dir, from: packsRepo, allowClone: false });
  assert.ok(r1.wrote.some((p) => p.replaceAll("\\", "/").endsWith("packs/cf-health/index.ts")));
  assert.equal(r1.exportName, "cfHealthPack");

  const r2 = addPack({ id: "custom-app", into: dir, from: packsRepo, allowClone: false });
  assert.equal(r2.exportName, "customAppPack");

  const packsTs = readFileSync(join(dir, "packs.ts"), "utf8");
  assert.match(packsTs, /import \{ cfHealthPack \} from "\.\/packs\/cf-health\/index\.ts";/);
  assert.match(packsTs, /import \{ customAppPack \} from "\.\/packs\/custom-app\/index\.ts";/);
  assert.match(packsTs, /\[cfHealthPack, customAppPack\]/);

  // Idempotent wiring check
  assert.equal(wirePackIntoFile(packsTs, "./packs/cf-health/index.ts", "cfHealthPack"), packsTs);
});
