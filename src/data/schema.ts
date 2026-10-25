/**
 * A database's schema, for the query box's autocomplete and the query agent: every table and its
 * columns with their types. Names only, never a row. Read from the test copy: `<app>:at` (or a
 * local database) through the db CLI, so a production database's schema comes from its app's at,
 * which has the same tables, and no production connection is ever needed for it.
 *
 * Kept in memory and in data/schemas/ for a day: table and column names aren't data, and the box
 * shouldn't wait on db each time.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db2Name, rowsOf, targetOk } from "./db.ts";
export { SCHEMA_SQL } from "./db.ts";

export type SchemaTable = { name: string; cols: [string, string][] };
export type Schema = { from: string; at: number; tables: SchemaTable[] };

const MAX_COLUMNS = 60_000;
const DAY = 24 * 3600_000;

/** Where a database's schema is read from: itself for local and at, its app's at for production; none for the DB2 database (no test copy). */
export function schemaSource(t: string): string | undefined {
  if (targetOk(t)) return t;
  const m = /^([a-z][a-z0-9-]{0,40}):prod$/.exec(t);
  return m && m[1] !== "pre" && m[1] !== db2Name() && targetOk(`${m[1]}:at`) ? `${m[1]}:at` : undefined;
}

/** db's rows as tables with their columns, in order. */
export function schemaOf(rows: Record<string, unknown>[], from: string, at: number): Schema {
  const by = new Map<string, [string, string][]>();
  for (const r of rows.slice(0, MAX_COLUMNS)) {
    const s = typeof r.s === "string" ? r.s : "";
    const t = typeof r.t === "string" ? r.t : "";
    const c = typeof r.c === "string" ? r.c : "";
    if (!s || !t || !c) continue;
    const name = `${s}.${t}`;
    by.set(name, [...(by.get(name) ?? []), [c.slice(0, 128), typeof r.ty === "string" ? r.ty.slice(0, 40) : ""]]);
  }
  return { from, at, tables: [...by].map(([name, cols]) => ({ name: name.slice(0, 260), cols })) };
}

export type Schemas = { get(t: string): Promise<Schema> };

export function createSchemas(o: {
  /** The whole schema of a local or at database, as db's JSON (Data.schemaText). */
  read: (t: string) => Promise<string>;
  dir?: string;
  now?: () => number;
}): Schemas {
  const now = o.now ?? Date.now;
  const kept = new Map<string, Schema>();
  const loading = new Map<string, Promise<Schema>>();
  const file = (from: string) => (o.dir ? join(o.dir, `${from.replace(/[^\w.-]/g, "_")}.json`) : undefined);
  const fromDisk = (from: string): Schema | undefined => {
    const f = file(from);
    if (!f) return undefined;
    try {
      const s = JSON.parse(readFileSync(f, "utf8")) as Schema;
      return s && s.from === from && Array.isArray(s.tables) && typeof s.at === "number" ? s : undefined;
    } catch {
      return undefined;
    }
  };
  const toDisk = (s: Schema) => {
    const f = file(s.from);
    if (!f || !o.dir) return;
    try {
      mkdirSync(o.dir, { recursive: true });
      writeFileSync(`${f}.tmp`, JSON.stringify(s));
      renameSync(`${f}.tmp`, f);
    } catch {}
  };
  return {
    async get(t) {
      const from = schemaSource(t);
      if (!from) throw new Error("No test copy to read this database's tables from.");
      const have = kept.get(from) ?? fromDisk(from);
      if (have && now() - have.at < DAY) {
        kept.set(from, have);
        return have;
      }
      const busy = loading.get(from);
      if (busy) return busy;
      const job = o
        .read(from)
        .then((text) => {
          const s = schemaOf(rowsOf(text), from, now());
          kept.set(from, s);
          toDisk(s);
          return s;
        })
        .catch((e) => {
          // An old copy beats none.
          if (have) return have;
          throw e;
        })
        .finally(() => loading.delete(from));
      loading.set(from, job);
      return job;
    },
  };
}
