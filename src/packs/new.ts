/**
 * `pnpm packs new <id> [--into <instance folder>]`: a new pack in an instance repo, in the one shape
 * every pack has (README "A pack's shape"):
 *
 *   packs/<id>/index.ts  the manifest and its hooks, nothing else
 *   packs/<id>/data.ts   what it reads from its app, into memory (no HTML)
 *   packs/<id>/view.ts   its pages and cards (html`` only, every link through safeUrl)
 *   packs/<id>/test/<id>.test.ts  its tests, a hostile-input case among them (they live with the pack)
 *
 * Never overwrites a file. The instance's packs.ts gets the pack added by hand (the line to add is printed).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addPack, listAvailablePacks, resolvePacksRepo } from "./cli.ts";
import { describe, outdated, trackPack, updatePack } from "./update.ts";

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
import { type Pack, PACK_API } from "dovre/packs/types.ts";
import { type Kept, read } from "./data.ts";
import { ${c}Card, ${c}Page } from "./view.ts";

let kept: Kept | undefined;

export const ${c}Pack: Pack = {
  manifest: {
    api: PACK_API,
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
import type { PackContext } from "dovre/packs/types.ts";

export type Kept = { at: number; items: { title: string; href?: string }[] };

export async function read(ctx: PackContext, now = Date.now()): Promise<Kept> {
  void ctx; // ctx.env for its settings, ctx.bindings hosted.
  return { at: now, items: [] };
}
`,
    [`packs/${id}/view.ts`]: `/** ${name}'s page and Today card. Text goes in through html\`\`, which escapes it; links through safeUrl. */
import { html } from "hono/html";
import { safeUrl } from "dovre/pages/parts.ts";
import { Card, Empty, Item, List, PageHeader, Panel } from "dovre/ui/kit.ts";
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
import { testContext } from "dovre/packs/testing.ts";
import { ${c}Pack } from "../index.ts";
import { ${c}Page } from "../view.ts";

const H = \`<script>alert(1)</script><img src=x onerror=alert(1)>\`;

test("${id}: a manifest the core takes", () => {
  assert.equal(${c}Pack.manifest.id, ${JSON.stringify(id)});
});

test("${id}: the page draws what it read; hostile text stays text, a javascript: link goes nowhere", async () => {
  const out = String(await ${c}Page({ at: 0, items: [{ title: H, href: "javascript:alert(1)" }] }));
  assert.ok(!out.includes("<script>") && !out.includes("<img"), "markup got through");
  assert.ok(!out.includes('href="javascript:'), "a javascript: link got through");
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
      const res = addPack({ id: rest[1], into, from });
      for (const p of res.wrote) console.log(`wrote ${join(into, p)}`);
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
      const repo = resolvePacksRepo(from, undefined, false);
      const states = outdated(into, repo);
      if (rest[0] === "outdated") {
        for (const st of states) console.log(describe(st));
        if (!states.length) console.log("No packs from dovre-packs here.");
      } else if (rest[0] === "track" && rest[1]) {
        const m = trackPack({ id: rest[1], into, repo, at: flag("--at") });
        console.log(`${rest[1]}: tracked at ${m.commit?.slice(0, 7)} of ${m.source}`);
      } else if (rest[0] === "update" && (rest[1] || args.includes("--all"))) {
        const ids = rest[1] ? [rest[1]] : states.filter((st) => st.tracked && !st.gone && st.upstream.length).map((st) => st.id);
        if (!ids.length) console.log("Every tracked pack is up to date.");
        for (const id of ids) {
          const r = updatePack({ id, into, repo });
          console.log(`${id}: ${r.from?.slice(0, 7) ?? "?"} → ${r.to?.slice(0, 7) ?? "?"}${r.changes.length ? "" : " (no file changes)"}`);
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
      "usage:\n  pnpm packs new <id> [--into <instance folder>]\n  pnpm packs add <id> [--into <instance folder>] [--from <dovre-packs folder>]\n  pnpm packs list [--from <dovre-packs folder>]\n  pnpm packs outdated [--into …] [--from …]\n  pnpm packs update <id>|--all [--into …] [--from …]\n  pnpm packs track <id> [--at <commit>] [--into …] [--from …]",
    );
    process.exit(2);
  }
  try {
    const id = rest[1];
    for (const p of writeScaffold(into, scaffold(id))) console.log(`wrote ${join(into, p)}`);
    console.log(`\nAdd it to ${join(into, "packs.ts")}:\n  import { ${camel(id)}Pack } from "./packs/${id}/index.ts";\n  …and ${camel(id)}Pack in its list.`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
