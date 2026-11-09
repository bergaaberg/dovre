/**
 * `pnpm packs new <id> [--into <instance folder>]`: a new pack in an instance repo, in the one shape
 * every pack has (README "A pack's shape"):
 *
 *   packs/<id>/index.ts  the manifest and its hooks, nothing else
 *   packs/<id>/data.ts   what it reads from its app, into memory (no HTML)
 *   packs/<id>/view.ts   its pages and cards (html`` only, every link through safeUrl)
 *   packs/<id>/test/<id>.test.ts  its tests, a hostile-input case among them (they live with the pack)
 *
 * and, once per instance, test/imports.test.ts: packs import core only as dovre/pack.ts (#473).
 *
 * Never overwrites a file. The instance's packs.ts gets the pack added by hand (the line to add is printed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addPack, listAvailablePacks, resolvePacksRepo } from "./cli.ts";
import { PACK_API } from "./types.ts";
import { describe, fetchTags, outdated, trackPack, updatePack } from "./update.ts";

const ID = /^[a-z][a-z0-9-]{0,31}$/;

const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const title = (id: string) => id.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** The files a new pack starts with, by path under the instance folder. */
export function scaffold(id: string, named?: string): Record<string, string> {
  if (!ID.test(id)) throw new Error(`"${id}" isn't a pack id: lowercase letters, digits and dashes, starting with a letter`);
  const name = named ?? title(id);
  const c = camel(id);
  const n = JSON.stringify(name);
  return {
    [`packs/${id}/index.ts`]: `/**
 * ${name}: what this app is, in a line. Its page is /${id}; Today gets a card once it has read something.
 */
import type { Pack } from "dovre/pack.ts";
import { type Kept, read } from "./data.ts";
import { ${c}Card, ${c}Page } from "./view.ts";

let kept: Kept | undefined;

export const ${c}Pack: Pack = {
  manifest: {
    // The oldest core API it works with (docs/ARCHITECTURE.md lists each minor) and its own release.
    api: "${PACK_API}",
    version: "0.1.0",
    id: ${JSON.stringify(id)},
    name: ${n},
    description: "What it shows, in a sentence.",
    domain: "personal",
    execution: "any",
    settings: [],
    everyMs: 5 * 60_000,
  },
  async refresh(ctx) {
    kept = await read(ctx);
    ctx.publish([${JSON.stringify(id)}]);
  },
  nav: () => [{ href: "/${id}", title: ${n}, icon: "layers", group: "Ops" }],
  pages: () => [{ title: ${n}, href: "/${id}", icon: "▦", about: "What it shows", also: [] }],
  routes(app, ctx) {
    app.get("/${id}", (c) => ctx.page(c, { title: ${n}, body: ${c}Page(kept) }));
  },
  today: () => (kept ? [{ id: "now", render: ${c}Card(kept) }] : []),
};
`,
    [`packs/${id}/data.ts`]: `/** What ${name} says, read into memory by refresh(); pages and cards only ever read this. */
import type { PackContext } from "dovre/pack.ts";

export type Kept = { at: number; items: { title: string; href?: string }[] };

export async function read(ctx: PackContext, now = Date.now()): Promise<Kept> {
  void ctx; // ctx.env for its settings, ctx.bindings hosted.
  return { at: now, items: [] };
}
`,
    [`packs/${id}/view.ts`]: `/** ${name}'s page and Today card. Text goes in through html\`\`, which escapes it; links through safeUrl. */
import { Card, Empty, html, Item, List, PageHeader, Panel, safeUrl } from "dovre/pack.ts";
import type { Kept } from "./data.ts";

const items = (k: Kept) => List(k.items.map((i) => Item({ href: i.href ? safeUrl(i.href) : undefined, title: i.title })));

export function ${c}Page(k: Kept | undefined) {
  return html\`\${PageHeader({ title: ${n} })}
<div data-live id="${id}">
\${Panel({ flush: true, children: k?.items.length ? items(k) : Empty({ title: k ? "Nothing yet" : "Not read yet" }) })}
</div>\`;
}

export const ${c}Card = (k: Kept) => Card({ id: "${id}-now", title: ${n}, children: k.items.length ? items(k) : html\`<p class="t2">Nothing yet</p>\` });
`,
    [`packs/${id}/test/${id}.test.ts`]: `/** ${name}: its page from what it read, and hostile text inert. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFragment, assertScoped, testContext } from "dovre/pack-testing.ts";
import { ${c}Pack } from "../index.ts";
import { ${c}Page } from "../view.ts";

const H = \`<script>alert(1)</script><img src=x onerror=alert(1)>\`;

test("${id}: a manifest the core takes, and styles only for its own markup", () => {
  assert.equal(${c}Pack.manifest.id, ${JSON.stringify(id)});
  assertScoped(${c}Pack);
});

test("${id}: the page draws what it read; hostile text stays text, a javascript: link goes nowhere", async () => {
  const out = String(await ${c}Page({ at: 0, items: [{ title: H, href: "javascript:alert(1)" }] }));
  assert.ok(!out.includes("<script>") && !out.includes("<img"), "markup got through");
  assert.ok(!out.includes('href="javascript:'), "a javascript: link got through");
  assertFragment("page", out);
  assert.match(String(await ${c}Page(undefined)), /Not read yet/);
});

test("${id}: a refresh reads, then tells its pages", async () => {
  const topics: string[] = [];
  await ${c}Pack.refresh!(testContext({ publish: (t) => void topics.push(...t) }));
  assert.deepEqual(topics, [${JSON.stringify(id)}]);
});
`,
  };
}

/** The instance's one-door test (templates/instance has the same file): written with its first pack, then left alone. */
export const DOORS_TEST = "test/imports.test.ts";
export function writeDoorsTest(into: string): string | null {
  if (existsSync(join(into, DOORS_TEST))) return null;
  mkdirSync(dirname(join(into, DOORS_TEST)), { recursive: true });
  writeFileSync(join(into, DOORS_TEST), readFileSync(join(import.meta.dirname, "..", "..", "templates", "instance", DOORS_TEST), "utf8"), { flag: "wx" });
  return DOORS_TEST;
}

/** Writes the files into `into`; refuses to touch one that's there. */
export function writeScaffold(into: string, files: Record<string, string>): string[] {
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
  const into = resolve(flag("--into") ?? ".");
  const from = flag("--from");
  const rest = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (rest[0] === "list") {
    try {
      for (const p of listAvailablePacks(resolvePacksRepo(from))) console.log(p);
      process.exit(0);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    }
  }
  if (rest[0] === "add" && rest[1]) {
    try {
      const res = addPack({ id: rest[1], into, from, to: flag("--to") });
      for (const p of res.wrote) console.log(`wrote ${join(into, p)}`);
      console.log(`${rest[1]} ${res.version ?? "(no release yet: HEAD)"}`);
      if (res.wired) console.log(`wired ${res.exportName} into ${res.wired}`);
      else console.log(`\nAdd ${res.exportName} to ${join(into, "packs.ts")}.`);
      process.exit(0);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    }
  }
  if (rest[0] === "outdated" || rest[0] === "update" || rest[0] === "track") {
    try {
      // A checkout of yours: its tags are fetched, its branch left alone. None: the CLI's own clone, made or synced.
      const repo = resolvePacksRepo(from);
      if (rest[0] !== "track") fetchTags(repo);
      const states = outdated(into, repo);
      if (rest[0] === "outdated") {
        for (const st of states) {
          console.log(describe(st));
          for (const n of st.notes ?? []) for (const l of n.lines) console.log(`  ${n.version}  ${l}`);
        }
        if (!states.length) console.log("No packs from dovre-packs here.");
      } else if (rest[0] === "track" && rest[1]) {
        const m = trackPack({ id: rest[1], into, repo, at: flag("--at") });
        console.log(`${rest[1]}: tracked at ${m.commit?.slice(0, 7)} of ${m.source}`);
      } else if (rest[0] === "update" && (rest[1] || args.includes("--all"))) {
        const ids = rest[1] ? [rest[1]] : states.filter((st) => st.tracked && !st.gone && st.upstream.length).map((st) => st.id);
        if (!ids.length) console.log("Every tracked pack is up to date.");
        for (const id of ids) {
          const r = updatePack({ id, into, repo, to: rest[1] ? flag("--to") : undefined });
          const at = (v: string | null, c: string | null) => v ?? c?.slice(0, 7) ?? "?";
          console.log(`${id}: ${at(r.fromVersion, r.from)} → ${at(r.toVersion, r.to)}${r.changes.length ? "" : " (no file changes)"}`);
          for (const c of r.changes) console.log(`  ${c.how.padEnd(7)} ${c.file}`);
          if (r.kept.length) console.log(`  kept your edits to ${r.kept.join(", ")}`);
        }
        if (ids.length) console.log("\nReview with git diff, then pnpm typecheck && pnpm test.");
      } else throw new Error(`usage: pnpm packs ${rest[0]} <id>${rest[0] === "update" ? "|--all" : ""}`);
      process.exit(0);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    }
  }
  if (rest[0] !== "new" || !rest[1]) {
    console.error(
      "usage:\n  pnpm packs new <id> [--into <instance folder>]\n  pnpm packs add <id> [--to x.y.z] [--into <instance folder>] [--from <dovre-packs folder>]\n  pnpm packs list [--from <dovre-packs folder>]\n  pnpm packs outdated [--into …] [--from …]\n  pnpm packs update <id> [--to x.y.z]|--all [--into …] [--from …]\n  pnpm packs track <id> [--at <commit>] [--into …] [--from …]",
    );
    process.exit(2);
  }
  try {
    const id = rest[1];
    for (const p of writeScaffold(into, scaffold(id))) console.log(`wrote ${join(into, p)}`);
    const doors = writeDoorsTest(into);
    if (doors) console.log(`wrote ${join(into, doors)} (packs import core only as dovre/pack.ts; list what can't move yet)`);
    console.log(`\nAdd it to ${join(into, "packs.ts")}:\n  import { ${camel(id)}Pack } from "./packs/${id}/index.ts";\n  …and ${camel(id)}Pack in its list.`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
