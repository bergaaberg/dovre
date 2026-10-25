/**
 * The database: SQLite (node:sqlite) behind the slice of D1's API the app uses
 * (prepare/bind/first/all/run, batch). Promoted from ops's test fake — locally
 * it is the engine; on Cloudflare one day, the real binding answers the same
 * calls and no call site changes. Applies migrations/*.sql once each, additively.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** What D1 binds: undefined is not among them (D1 throws D1_TYPE_ERROR; use null). */
export type D1Value = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array;

export type D1Statement = {
  bind(...params: D1Value[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
};

export type D1 = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ results: unknown[]; success: true }[]>;
};

export type Db = { DB: D1; raw: DatabaseSync; applied: string[] };

class Statement implements D1Statement {
  db: DatabaseSync;
  sql: string;
  params: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params: D1Value[]) {
    // D1 refuses undefined rather than storing NULL: fail here the same way, so local runs catch it.
    const at = (params as unknown[]).indexOf(undefined);
    if (at >= 0) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${at + 1})`);
    return new Statement(this.db, this.sql, params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as SQLInputValue[]);
  }
  async first<T>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null) as T | null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true as const, meta: {} };
  }
  async run() {
    const stmt = this.db.prepare(this.sql);
    // RETURNING turns a write into rows; D1's run() still runs it.
    if (/\breturning\b/i.test(this.sql)) {
      const results = stmt.all(...this.params);
      return { results, success: true as const, meta: { changes: results.length } };
    }
    const r = stmt.run(...this.params);
    return { results: [], success: true as const, meta: { changes: Number(r.changes) } };
  }
  /** What batch() runs: rows for a read (or RETURNING), changes for a write. */
  exec() {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) {
      return { results: stmt.all(...this.params), success: true as const, meta: {} };
    }
    const r = stmt.run(...this.params);
    return { results: [], success: true as const, meta: { changes: Number(r.changes) } };
  }
}

function d1Of(db: DatabaseSync): D1 {
  return {
    prepare: (sql: string) => {
      // D1's own limit, which SQLite's default doesn't have: a LIKE or GLOB pattern over 50 bytes fails there.
      for (const m of sql.matchAll(/\b(?:LIKE|GLOB)\s+'([^']*)'/gi)) {
        if (Buffer.byteLength(m[1] as string) > 50) throw new Error(`D1_ERROR: LIKE or GLOB pattern too complex: ${m[1]}`);
      }
      return new Statement(db, sql);
    },
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

/** Applies every migration not applied yet, each in one transaction, and remembers in _migrations. */
function migrate(db: DatabaseSync, dir: URL): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set((db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(new URL(f, dir), "utf8"));
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied.push(f);
  }
  return applied;
}

/** Opens the database (a file at `path`, or memory), applies migrations, and hands back the D1-shaped API. */
export function openDb(opts: { path?: string; dir?: URL } = {}): Db {
  const db = new DatabaseSync(opts.path ?? ":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const applied = migrate(db, opts.dir ?? new URL("../migrations/", import.meta.url));
  return { DB: d1Of(db), raw: db, applied };
}
