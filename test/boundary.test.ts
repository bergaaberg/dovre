/**
 * What moved out of core stays out (WP-H9f). Teams (with mail and the channels it follows) and Data
 * (databases through a CLI, production after a question in the bar) are packs in an instance now:
 * core has none of their code, panes, settings, routes or styles, and Bino isn't told it can send a
 * Teams message. A pack brings all of that back through the Pack API.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PANE_IDS, PANES } from "../src/config.ts";
import { loadEnv } from "../src/env.ts";
import { ACTS } from "../src/packs/core/assistant/bino/context.ts";
import { STYLE } from "../src/ui/style.ts";
import { signedIn, snapshot } from "./helpers.ts";

const root = join(import.meta.dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

test("Teams is a pack: core has none of its code, panes, settings, routes, styles or Bino act", async () => {
  for (const gone of ["src/teams", "src/pages/teams.ts", "src/pages/outlook.ts", "scripts/teams.ps1"]) assert.ok(!existsSync(join(root, gone)), gone);
  const imports = sources(join(root, "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!).filter((p) => /(^|\/)teams\/|pages\/(teams|outlook)\.ts$/.test(p)).map((p) => `${file}: ${p}`),
  );
  assert.deepEqual(imports, []);

  assert.ok(!PANE_IDS.some((id) => id === ("teams" as string) || id === ("outlook" as string)));
  for (const p of PANES) for (const key of [p.key, ...p.options.map((o) => o.key)]) assert.doesNotMatch(key, /^(TEAMS|OUTLOOK)/, key);
  const env = loadEnv({ TEAMS: "on", TEAMS_CRAWL: "on", OUTLOOK: "on" }) as Record<string, unknown>;
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /^(TEAMS|OUTLOOK)/, key);

  const { app } = signedIn(snapshot());
  const paths = app.routes.map((r) => r.path);
  assert.deepEqual(paths.filter((p) => /^\/(teams|outlook)(\/|$)/.test(p)), [], "no Teams or Outlook route");
  const { get } = signedIn(snapshot());
  for (const path of ["/teams", "/teams/dock", "/outlook"]) assert.equal((await get(path)).status, 404, path);

  for (const cls of ["tchat", "tmsg", "treact", "tdl", "cposts", "teams-proposals"]) assert.doesNotMatch(STYLE, new RegExp(`\\.${cls}(?![a-z0-9-])`), cls);
  assert.doesNotMatch(ACTS, /"kind": "teams"|Teams message/);
});

test("Data is a pack: core has none of its code, panes, settings, routes or styles", async () => {
  for (const gone of ["src/data", "src/pages/data.ts"]) assert.ok(!existsSync(join(root, gone)), gone);
  const imports = sources(join(root, "src")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!).filter((p) => /(^|\/)data\/|pages\/data\.ts$/.test(p)).map((p) => `${file}: ${p}`),
  );
  assert.deepEqual(imports, []);
  assert.ok(!PANE_IDS.some((id) => id === ("data" as string)));
  for (const p of PANES) for (const key of [p.key, ...p.options.map((o) => o.key)]) assert.doesNotMatch(key, /^DATA/, key);
  const env = loadEnv({ DATA: "on", DATA_AGENT: "on", DATA_PREFIX: "x-", DATA_DB2: "y" }) as Record<string, unknown>;
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /^DATA/, key);
  const { app, get } = signedIn(snapshot());
  assert.deepEqual(app.routes.map((r) => r.path).filter((p) => /^\/data(\/|$)/.test(p)), [], "no Data route");
  assert.equal((await get("/data")).status, 404);
  for (const cls of ["tgrid", "ask-review"]) assert.doesNotMatch(STYLE, new RegExp(`\\.${cls}(?![a-z0-9-])`), cls);
});
