/**
 * `pnpm instance new <folder> [--domain <host>] [--name <name>]`: a new instance repo from
 * templates/instance (WP-N6): packs.ts, worker.ts, wrangler.jsonc, package.json, a test, a README
 * that walks from here to a deployed Dovre. Never overwrites a file; installs and deploys nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { cfApi, TOKEN_SCOPES, tokenLink } from "./cfaccess.ts";
import { provisionInstance } from "./instance-provision.ts";

const TEMPLATE = join(import.meta.dirname, "..", "templates", "instance");
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

/** The instance's files by path, the placeholders filled in. */
export function instanceFiles(o: { name: string; domain?: string }): Record<string, string> {
  if (!NAME.test(o.name)) throw new Error(`"${o.name}" isn't a name: lowercase letters, digits and dashes`);
  const domain = o.domain ?? `dovre.${o.name}.example`;
  if (!HOST.test(domain)) throw new Error(`"${domain}" isn't a host name`);
  const vars: Record<string, string> = { name: o.name, worker: o.name, db: `${o.name}-db`, domain };
  const out: Record<string, string> = {};
  for (const file of walk(TEMPLATE)) {
    const rel = relative(TEMPLATE, file).split(sep).join("/").replace(/^gitignore$/, ".gitignore");
    out[rel] = readFileSync(file, "utf8").replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
  }
  return out;
}

export function writeInstance(into: string, files: Record<string, string>): string[] {
  const there = Object.keys(files).filter((p) => existsSync(join(into, p)));
  if (there.length) throw new Error(`already there: ${there.join(", ")}`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(into, p)), { recursive: true });
    writeFileSync(join(into, p), body, { flag: "wx" });
  }
  return Object.keys(files);
}

/** The Access token, pasted (never saved), after the link that makes one with the scopes filled in. */
async function askToken(): Promise<string> {
  const how = `Provision needs a Cloudflare API token for Access (wrangler's login can't reach it), with:\n${TOKEN_SCOPES.map((s) => `  - ${s}`).join("\n")}\nMake one here (most scopes are filled in; add "Access: Service Tokens — Edit" if it's missing):\n  ${tokenLink()}\nThen set DOVRE_CF_API_TOKEN, or paste it below. It isn't saved.`;
  if (!process.stdin.isTTY) throw new Error(how);
  console.log(how);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const t = (await rl.question("Token: ")).trim();
  rl.close();
  if (!t) throw new Error("no token");
  return t;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const hasFlag = (k: string) => args.includes(k);
  const bare = new Set(["--deploy", "--plan", "--no-bridge", "--access", "--login-link", "--github"]);
  const rest = args.filter((a, i) => !a.startsWith("--") && (!args[i - 1]?.startsWith("--") || bare.has(args[i - 1])));
  if (rest[0] === "provision" && rest[1]) {
    try {
      // Behind Cloudflare Access only when asked (--access, or a DOVRE_CF_API_TOKEN for it); else the
      // built-in passkey login, which needs nothing but `wrangler login`.
      const access = hasFlag("--access") || !!process.env.DOVRE_CF_API_TOKEN?.trim();
      const token = access ? process.env.DOVRE_CF_API_TOKEN?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim() || (await askToken()) : undefined;
      await provisionInstance({
        dir: resolve(rest[1]),
        coreVarsFile: flag("--vars") && resolve(flag("--vars")!),
        domain: flag("--domain"),
        repoOwners: flag("--owners"),
        githubUser: flag("--github-user"),
        allowedEmails: flag("--email"),
        account: flag("--account"),
        team: flag("--team"),
        subdomain: flag("--subdomain"),
        plan: hasFlag("--plan"),
        deploy: hasFlag("--deploy"),
        bridge: !hasFlag("--no-bridge"),
        api: token ? cfApi(token) : undefined,
        loginLink: hasFlag("--login-link"),
        github: hasFlag("--github"),
        githubOrg: flag("--github-org"),
      });
      process.exit(0);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    }
  }
  if (rest[0] !== "new" || !rest[1]) {
    console.error("usage:\n  pnpm instance new <folder> [--domain <host>] [--name <name>]\n  pnpm instance provision <folder> [--plan] [--deploy] [--domain <host>] [--email <list>] [--owners <list>]\n      [--account <id>] [--subdomain <name>] [--vars <file>] [--no-bridge] [--login-link]\n      [--github [--github-org <org>]]   (Sign in with GitHub too, through the instance's own GitHub App)\n      [--access [--team <name>]]   (behind Cloudflare Access instead of the built-in passkey login)");
    process.exit(2);
  }
  try {
    const into = resolve(rest[1]);
    for (const p of writeInstance(into, instanceFiles({ name: flag("--name") ?? basename(into), domain: flag("--domain") }))) console.log(`wrote ${join(into, p)}`);
    console.log(`\nNext: run \`pnpm instance provision ${into} --plan\` to see what it'll do, then without --plan and with --deploy (or see ${join(into, "README.md")}).`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
