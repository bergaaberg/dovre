/**
 * `Pack.migrations` (API 1.35, #476): a pack's own tables, as a list of SQL core runs. Append-only:
 * each entry is one statement, run once, in order, before the pack's `init`, and remembered in
 * `_migrations` as `pack:<id>:<n>` (n from 1). One that fails keeps the pack off, saying which and
 * why; the ones before it stay applied. Core doesn't read the SQL: that a pack's tables carry its
 * own name is checked in its tests (`assertTables`, src/packs/testing.ts).
 */
import type { D1 } from "../db.ts";
import type { Pack } from "./types.ts";

/** The most a pack lists, and the most characters one is. */
export const MIGRATIONS_MAX = 200;
export const MIGRATION_MAX = 20_000;

/** How `_migrations` names a pack's nth (from 1). */
export const migrationName = (id: string, n: number) => `pack:${id}:${n}`;

/** The SQL with its strings, quoted names and comments blanked, so what's left is only statements. */
export function bareSql(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);
    let end = -1;
    if (two === "--") end = sql.indexOf("\n", i) < 0 ? sql.length : sql.indexOf("\n", i);
    else if (two === "/*") end = sql.indexOf("*/", i + 2) < 0 ? sql.length : sql.indexOf("*/", i + 2) + 2;
    else if (c === "'" || c === '"' || c === "`") {
      // A doubled quote inside is the quote itself.
      end = i + 1;
      while (end < sql.length && (sql[end] !== c || sql[end + 1] === c)) end += sql[end] === c ? 2 : 1;
      end = Math.min(sql.length, end + 1);
      // A quoted name keeps its text (it may be a table's); a string or a comment is blanked.
      if (c !== "'") {
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (end < 0) {
      out += c;
      i++;
    } else {
      out += " ".repeat(end - i);
      i = end;
    }
  }
  return out;
}

/** What's wrong with a pack's list as it's written, or nothing: read before the pack is on. */
export function migrationsGap(c: Pack): string | undefined {
  const list: unknown = c.migrations;
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) return "its migrations aren't a list";
  if (list.length > MIGRATIONS_MAX) return `it lists ${list.length} migrations (${MIGRATIONS_MAX} is the most)`;
  for (const [i, sql] of list.entries()) {
    const n = i + 1;
    if (typeof sql !== "string" || !sql.trim()) return `its migration ${n} isn't SQL`;
    if (sql.length > MIGRATION_MAX) return `its migration ${n} is ${sql.length} characters (${MIGRATION_MAX} is the most)`;
    // D1 prepares one statement; SQLite would run the first and drop the rest without a word.
    if (/;\s*\S/.test(bareSql(sql))) return `its migration ${n} is more than one statement (one each)`;
  }
  return undefined;
}

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * Runs what the pack lists and this database hasn't had, in order. Each goes in one transaction
 * with its row in `_migrations`. Hosted, another isolate may have run one first: a failure whose
 * row is there after all counts as done. Returns why it stopped, or nothing.
 */
export async function migratePack(c: Pack, db: D1, o: { now?: () => number; log?: (line: string) => void } = {}): Promise<string | undefined> {
  const list = c.migrations;
  if (!Array.isArray(list) || !list.length) return undefined;
  const id = c.manifest.id;
  const prefix = migrationName(id, 0).slice(0, -1);
  const had = async () => new Set((await db.prepare("SELECT name FROM _migrations WHERE substr(name, 1, ?) = ?").bind(prefix.length, prefix).all<{ name: string }>()).results.map((r) => r.name));
  let done: Set<string>;
  try {
    done = await had();
  } catch {
    // Hosted, core's own migrations are wrangler's (d1_migrations): the table is made here the first time.
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)").run();
      done = await had();
    } catch (e) {
      return `its migrations couldn't be read: ${short(e)}`;
    }
  }
  const ran: number[] = [];
  for (const [i, sql] of list.entries()) {
    const name = migrationName(id, i + 1);
    if (done.has(name)) continue;
    try {
      await db.batch([db.prepare(sql), db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").bind(name, new Date((o.now ?? Date.now)()).toISOString())]);
      ran.push(i + 1);
    } catch (e) {
      const now = await had().catch(() => done);
      if (now.has(name)) continue;
      if (ran.length) o.log?.(`pack ${id}: migrations applied: ${ran.join(", ")}`);
      return `migration ${i + 1} failed: ${short(e)}`;
    }
  }
  if (ran.length) o.log?.(`pack ${id}: migrations applied: ${ran.join(", ")}`);
  return undefined;
}

/**
 * A pack's name as its tables start: its id with dashes as underscores. A table (or index) is the
 * pack's when it's that name or starts with it and an underscore.
 */
export const tablePrefix = (id: string) => id.replace(/-/g, "_");

/**
 * The tables and indexes a pack's migrations make, change or drop that aren't its own by name
 * (`<prefix>` or `<prefix>_…`), as "migration n: name". By pattern, not a parser: what a test reads.
 */
export function foreignTables(c: Pack): string[] {
  const prefix = tablePrefix(c.manifest.id);
  const own = (name: string) => name === prefix || name.startsWith(`${prefix}_`);
  const NAME = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([\w$]+))`;
  const patterns = [
    new RegExp(String.raw`\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, "gi"),
    new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, "gi"),
    new RegExp(String.raw`\b(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?${NAME}`, "gi"),
    new RegExp(String.raw`\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?${NAME}`, "gi"),
    new RegExp(String.raw`\bRENAME\s+TO\s+${NAME}`, "gi"),
    new RegExp(String.raw`\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+${NAME}`, "gi"),
    new RegExp(String.raw`\bON\s+${NAME}\s*\(`, "gi"),
  ];
  const out: string[] = [];
  for (const [i, sql] of (Array.isArray(c.migrations) ? c.migrations : []).entries()) {
    if (typeof sql !== "string") continue;
    const bare = bareSql(sql);
    const names = new Set<string>();
    for (const p of patterns) for (const m of bare.matchAll(p)) names.add((m[1] ?? m[2] ?? m[3] ?? m[4])!);
    // "ON CONFLICT (…)" and "DO UPDATE SET" read like a table to the patterns above.
    for (const name of names) if (!/^(conflict|set)$/i.test(name) && !own(name.toLowerCase())) out.push(`migration ${i + 1}: ${name}`);
  }
  return out;
}
