/**
 * What a hosted instance still needs (WP-N6), from its bindings: names and what to run, never a
 * value. Without the essentials (D1, its tables, Cloudflare Access) the Worker answers every
 * request with a plain setup page instead of failing; the rest shows signed in, on Settings.
 */
import { accessConfigOf } from "../access.ts";
import type { Off } from "../packs/registry.ts";
import type { D1 } from "../db.ts";
import type { SetupLine } from "../pages/settings.ts";

/** The bindings this reads: the same names as the Worker's (src/worker.ts). */
export type SetupBindings = { DB?: unknown; CF_ACCESS_TEAM?: unknown; CF_ACCESS_AUD?: unknown; AUTH_ISSUER?: unknown; AUTH_AUD?: unknown; AUTH_JWKS_URL?: unknown; ALLOWED_EMAILS?: unknown; HUB?: unknown; ASSETS?: unknown; GITHUB_TOKEN?: unknown; CF_AIG_TOKEN?: unknown; BRIDGE_CLIENT_ID?: unknown; BRIDGE_KEY?: unknown };

const set = (v: unknown) => typeof v === "string" && v.trim() !== "";
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const isDb = (v: unknown): v is D1 => !!v && typeof (v as D1).prepare === "function";

/** Each line: on or off, what it gives, and how to turn it on. `needed`: nothing works without it. */
export type HostedLine = SetupLine & { needed?: boolean };

/** What the instance has and lacks. `tables`: whether D1's migrations are applied (checked by tablesOk). */
export function hostedSetup(b: SetupBindings, o: { tables?: boolean; off?: Off[] } = {}): HostedLine[] {
  // The same check the verifier makes (src/access.ts): Access, or another issuer, fully and validly set.
  const access = !!accessConfigOf({ CF_ACCESS_TEAM: str(b.CF_ACCESS_TEAM), CF_ACCESS_AUD: str(b.CF_ACCESS_AUD), AUTH_ISSUER: str(b.AUTH_ISSUER), AUTH_AUD: str(b.AUTH_AUD), AUTH_JWKS_URL: str(b.AUTH_JWKS_URL) });
  const bridge = [set(b.BRIDGE_CLIENT_ID), set(b.BRIDGE_KEY)];
  const lines: HostedLine[] = [
    { name: "Database (D1)", on: isDb(b.DB), needed: true, what: "Dovre's own tables: settings, My list, the snapshot", fix: "Create one (`wrangler d1 create <name>`) and bind it as DB in wrangler.jsonc, with migrations_dir pointing at core's migrations/." },
    { name: "Its tables", on: isDb(b.DB) && o.tables !== false, needed: true, what: "D1's migrations applied", fix: "`wrangler d1 migrations apply <name> --remote` (the template's deploy script does it first)." },
    { name: "Who gets in", on: access, needed: true, what: "Every request carries a signed token from Cloudflare Access or your own issuer, and is checked against it", fix: "Make a self-hosted Access application for the domain, then set the vars CF_ACCESS_TEAM (the team name) and CF_ACCESS_AUD (its AUD tag). Or, for another issuer: AUTH_ISSUER (https), AUTH_AUD, and AUTH_JWKS_URL if its keys aren't at /.well-known/jwks.json." },
    { name: "Allowed emails", on: set(b.ALLOWED_EMAILS), what: "Only these people, even if the Access policy lets more through", fix: "Set the var ALLOWED_EMAILS (comma-separated)." },
    { name: "Live pages and Bino (HUB)", on: !!b.HUB, what: "Pages update by themselves; Bino answers", fix: "Bind the Durable Object: durable_objects HUB → DovreHub, a new_sqlite_classes migration, and `export { DovreHub } from \"dovre/hosted/hub.ts\"` in worker.ts." },
    { name: "Icons and fonts (ASSETS)", on: !!b.ASSETS, what: "The app icon and Nordwand Mono", fix: "assets: { directory: \"../dovre/assets\", binding: \"ASSETS\", run_worker_first: true } in wrangler.jsonc." },
    { name: "GitHub", on: set(b.GITHUB_TOKEN), what: "Pull requests and deploys on Today", fix: "`wrangler secret put GITHUB_TOKEN` (a fine-grained token, read-only on the repos you track)." },
    { name: "Bino's model (AI Gateway)", on: set(b.CF_AIG_TOKEN), what: "Bino's answers, through Cloudflare AI Gateway", fix: "Make a gateway (AI_GATEWAY, default dovre) with your Anthropic key in it, then `wrangler secret put CF_AIG_TOKEN`." },
    {
      name: "The Mac's agents (bridge)",
      on: bridge[0]! && bridge[1]!,
      what: bridge[0] !== bridge[1] ? "Half set up: it needs both, so /bridge stays closed" : "Your Mac's agent sessions, from here",
      fix: "An Access service token with a Service Auth policy: its client id as the var BRIDGE_CLIENT_ID, and `wrangler secret put BRIDGE_KEY` (the same key as the Mac's .dev.vars). README: Hosted, with the Mac's agents.",
    },
  ];
  for (const c of o.off ?? []) lines.push({ name: `Pack: ${c.name}`, on: false, what: c.why, fix: "Packs (under You) says what it needs." });
  return lines;
}

/** Whether D1's migrations are applied (the settings table answers). */
export async function tablesOk(db: unknown): Promise<boolean> {
  if (!isDb(db)) return false;
  try {
    await db.prepare("SELECT key FROM settings LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const code = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

/** The page shown to anyone before the essentials are there: what's missing and how to add it, nothing else. */
export function setupPage(lines: HostedLine[]): string {
  const missing = lines.filter((l) => l.needed && !l.on);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Dovre · not set up yet</title>
<style>body{margin:0 auto;max-width:42rem;padding:2rem 1rem;font:15px/1.55 ui-monospace,Menlo,Consolas,monospace}h1{font-size:1.4rem}li{margin:0 0 1rem}code{padding:0 .2em;border-radius:4px;background:color-mix(in srgb,currentColor 10%,transparent)}.t2{opacity:.75}</style></head>
<body><h1>Dovre isn't set up yet</h1>
<p class="t2">This Worker runs, but it needs these before it shows anything. Nobody gets in until Access is set up.</p>
<ol>${missing.map((l) => `<li><strong>${esc(l.name)}</strong>: ${esc(l.what)}.<br><span class="t2">${code(l.fix ?? "")}</span></li>`).join("")}</ol>
<p class="t2">The instance template and its README: core's templates/instance.</p>
</body></html>`;
}
