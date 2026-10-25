/**
 * WP-M4: crates -> packs, once. Moves every tracked path with "crate" in it and rewrites
 * crate/Crate/CRATE to pack/Pack/PACK in tracked text files. History (PLAN.md, CHANGELOG.md),
 * migrations and the lockfile keep their words. It refuses to run twice (src/packs/registry.ts).
 *
 * A branch made before the rename runs this, commits, then merges main: both sides then hold the
 * same text, and only lines changed on both sides still conflict. The bridges for what lives
 * outside the repo (dovre/crates/types.ts, CRATES, cratesOff, an instance's crates.ts) are written
 * by hand on main after this ran, not here.
 *
 *   node scripts/rename-packs.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
if (existsSync("src/packs/registry.ts")) {
  console.error("Already renamed (src/packs/registry.ts is there).");
  process.exit(1);
}

const KEEP = [/^migrations\//, /^pnpm-lock\.yaml$/, /^PLAN\.md$/, /^CHANGELOG\.md$/, /^scripts\/rename-packs\.ts$/, /(^|\/)node_modules\//];
const TEXT = /\.(ts|js|mjs|json|jsonc|md|html|css|go|yaml|yml|toml|txt|sh|ps1|example)$|^\.dev\.vars\.example$/;
const sub = (s: string) => s.replace(/crate/g, "pack").replace(/Crate/g, "Pack").replace(/CRATE/g, "PACK");

// A branch's own stand-ins for the rename (re-exports of ../crates/, Pack = Crate aliases) go first.
for (const f of ["src/packs/types.ts", "src/packs/testing.ts"]) {
  if (existsSync(f) && /from "\.\.\/crates\//.test(readFileSync(f, "utf8"))) git("rm", "-q", "-f", f);
}
if (existsSync("src/crates/types.ts")) {
  const t = readFileSync("src/crates/types.ts", "utf8");
  const at = t.indexOf("/** Pluggable Pack terminology aliases");
  if (at >= 0) writeFileSync("src/crates/types.ts", t.slice(0, at).trimEnd() + "\n");
}

// Paths: each tracked file whose path says crate moves to the path saying pack.
const files = git("ls-files", "-z").split("\0").filter(Boolean);
let moved = 0;
for (const f of files) {
  if (!/crate/i.test(f) || KEEP.some((k) => k.test(f))) continue;
  const to = sub(f);
  if (existsSync(to)) throw new Error(`${to} is in the way of ${f}`);
  mkdirSync(dirname(to), { recursive: true });
  git("mv", f, to);
  moved++;
}
if (existsSync("src/crates")) rmSync("src/crates", { recursive: true, force: true });

// Words: every tracked text file but history.
let changed = 0;
for (const f of git("ls-files", "-z").split("\0").filter(Boolean)) {
  if (KEEP.some((k) => k.test(f)) || !TEXT.test(f) || !existsSync(f)) continue;
  const was = readFileSync(f, "utf8");
  // "pnpm pack" is pnpm's own command (it packs a tarball): ours is "pnpm packs".
  let now = sub(was).replace(/pnpm pack(?=[\s`"'])/g, "pnpm packs");
  if (/(^|\/)package\.json$/.test(f)) {
    // "pnpm pack" is pnpm's own command: the script is "packs". A branch with its own packs CLI keeps it.
    now = now.replace(/"pack":/g, '"packs":');
    if (/"packs": "node src\/packs\/cli\.ts"/.test(now)) now = now.replace(/\n\s*"packs": "node src\/packs\/new\.ts",?/, "");
  }
  if (now !== was) {
    writeFileSync(f, now);
    changed++;
  }
}
console.log(`moved ${moved} files, rewrote ${changed}. Next: pnpm typecheck && pnpm test, then commit.`);
