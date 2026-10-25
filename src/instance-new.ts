/**
 * `pnpm instance new <folder> [--domain <host>] [--name <name>]`: a new instance repo from
 * templates/instance (WP-N6): packs.ts, worker.ts, wrangler.jsonc, package.json, a test, a README
 * that walks from here to a deployed Dovre. Never overwrites a file; installs and deploys nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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
    const rel = relative(TEMPLATE, file).replace(/^gitignore$/, ".gitignore");
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const hasFlag = (k: string) => args.includes(k);
  const rest = args.filter((a, i) => !a.startsWith("--") && (!args[i - 1]?.startsWith("--") || args[i - 1] === "--deploy"));
  if (rest[0] === "provision" && rest[1]) {
    try {
      provisionInstance({
        dir: resolve(rest[1]),
        domain: flag("--domain"),
        repoOwners: flag("--owners"),
        githubUser: flag("--github-user"),
        allowedEmails: flag("--email"),
        cfAccessTeam: flag("--access-team"),
        cfAccessAud: flag("--access-aud"),
        deploy: hasFlag("--deploy"),
      });
      process.exit(0);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    }
  }
  if (rest[0] !== "new" || !rest[1]) {
    console.error("usage:\n  pnpm instance new <folder> [--domain <host>] [--name <name>]\n  pnpm instance provision <folder> [--domain <host>] [--owners <list>] [--email <email>] [--deploy]");
    process.exit(2);
  }
  try {
    const into = resolve(rest[1]);
    for (const p of writeInstance(into, instanceFiles({ name: flag("--name") ?? basename(into), domain: flag("--domain") }))) console.log(`wrote ${join(into, p)}`);
    console.log(`\nNext: run \`pnpm instance provision ${into} --deploy\` (or see ${join(into, "README.md")}).`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
