/**
 * The Data tab's source: test databases through the `db` CLI (db-cli), which only ever reads
 * (it refuses writes itself, and production without a person at a terminal). Phase 1 is test
 * targets only, checked here before `db` starts: `local` (the docker SQL Server) and `<app>:at`.
 * Never pre or prod (pre may hold production data), and not the DB2 database (DATA_DB2).
 *
 * What a query returns goes to the page that asked and nowhere else: never kept, logged, put in
 * the snapshot, or handed to a model. Errors are `db`'s own message, cut short.
 */
import type { Ran } from "../spawn.ts";

export type Run = (bin: string, args: string[], opts: { timeoutMs?: number; input?: string; maxBuffer?: number }) => Promise<Ran>;

export type Row = Record<string, unknown>;
export type Target = { id: string; label: string; kind: "local" | "at" };
export type TableInfo = { schema: string; table: string; rows?: number };
export type Column = { pos?: number; column: string; type?: string; nullable?: string; key?: string | null };
export type Found = { schema: string; table: string; column?: string; type?: string };
export type Rows = { rows: Row[]; columns: string[]; capped: boolean; ms: number };

/** At most this many rows reach a page; more says so. */
export const MAX_ROWS = 500;
export const MAX_SQL = 20_000;
/** Every table's columns and types (names only), for src/data/schema.ts: INFORMATION_SCHEMA, the same on every SQL Server. */
export const SCHEMA_SQL = "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS ty FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION";

/** How `db ls at` names a test database (DATA_PREFIX, before `<app>-at`) and the DB2 production database with no test copy (DATA_DB2): set once at start. */
const names = { prefix: "", db2: "" };
export function setDataNames(o: { prefix?: string; db2?: string }): void {
  names.prefix = /^[\w.-]{0,64}$/.test(o.prefix ?? "") ? (o.prefix ?? "") : "";
  names.db2 = /^[a-z][a-z0-9-]{0,40}$/.test(o.db2 ?? "") ? o.db2! : "";
}
/** The DB2 database's name, or "" when there's none. */
export const db2Name = () => names.db2;
/** Whether a target is the DB2 database (any environment). */
export const isDb2 = (t: string) => !!names.db2 && t.split(":")[0] === names.db2;

const LOCAL = /^local(?::[A-Za-z0-9_.-]{1,64})?$/;
const APP_AT = /^[a-z][a-z0-9-]{0,40}:at$/;
/** A target phase 1 may open: local, or an app in at. Anything naming another environment is refused. */
export function targetOk(t: unknown): t is string {
  if (typeof t !== "string") return false;
  if (/\b(pre|prod)\b/i.test(t) || isDb2(t)) return false;
  return LOCAL.test(t) || APP_AT.test(t);
}

/** schema.table, as db wants it (brackets allowed for names with odd characters). */
export const TABLE = /^[\w$#@ \[\]-]{1,128}\.[\w$#@ \[\]-]{1,128}$/;

/** The short app names in at, from `db ls at` (<DATA_PREFIX><app>-at). */
export function appsOf(lines: string): string[] {
  const out = new Set<string>();
  for (const l of lines.split(/\r?\n/)) {
    const m = l.trim().match(new RegExp(`^${names.prefix.replace(/[.-]/g, (c) => `\\${c}`)}([a-z0-9-]+)-at$`));
    if (m && targetOk(`${m[1]}:at`)) out.add(m[1]!);
  }
  return [...out].sort();
}

/** db's -f json: an array, or nothing for an empty result. */
export function rowsOf(text: string): Row[] {
  const t = text.trim();
  if (!t) return [];
  const v = JSON.parse(t);
  if (!Array.isArray(v)) throw new Error("db answered something other than rows.");
  return v.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
}

/** db's own complaint, without the noise: its first lines, short. */
export function problemOf(r: Ran): string {
  const text = (r.stderr || r.stdout || "").replace(/^db:\s*/gm, "").trim();
  return text.split(/\r?\n/).slice(0, 4).join(" ").slice(0, 400) || `db stopped (exit ${r.code}).`;
}

/** A count, from db's JSON (a number) or its MCP answer (a string). */
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
/** A value by any of its names, ignoring case (the CLI and the MCP server name columns alike, but not always in the same case). */
const pick = (r: Row, ...names: string[]) => {
  for (const n of names) for (const k of Object.keys(r)) if (k.toLowerCase() === n) return r[k];
  return undefined;
};
const str = (v: unknown) => (v == null ? undefined : String(v));
export const tablesOf = (rows: Row[]): TableInfo[] => rows.map((r) => ({ schema: String(pick(r, "schema") ?? ""), table: String(pick(r, "table", "name", "view") ?? ""), rows: num(pick(r, "rows", "row_count", "rowcount")) }));
export const colsOf = (rows: Row[]): Column[] => rows.map((r) => ({ pos: num(pick(r, "pos", "ordinal")), column: String(pick(r, "column", "name") ?? ""), type: str(pick(r, "type")), nullable: str(pick(r, "nullable", "null")), key: str(pick(r, "key", "pk")) ?? null }));
export const foundOf = (rows: Row[]): Found[] => rows.map((r) => ({ schema: String(pick(r, "schema") ?? ""), table: String(pick(r, "table", "view") ?? ""), column: str(pick(r, "column")), type: str(pick(r, "type")) }));

export type Data = {
  targets(): Promise<{ targets: Target[]; problem?: string }>;
  tables(t: string): Promise<TableInfo[]>;
  cols(t: string, table: string): Promise<Column[]>;
  find(t: string, text: string): Promise<Found[]>;
  peek(t: string, table: string, n?: number): Promise<Rows>;
  query(t: string, sql: string): Promise<Rows>;
  /** The whole schema (SCHEMA_SQL, every row: names, not data), as db's JSON. */
  schemaText(t: string): Promise<string>;
};

export function createData(o: { bin: string; pre?: string[]; run: Run; now?: () => number }): Data {
  const now = o.now ?? Date.now;
  const call = async (args: string[], input?: string): Promise<string> => {
    if (!targetOk(args[0])) throw new Error("Only local and at databases open here.");
    let r: Ran;
    try {
      r = await o.run(o.bin, [...(o.pre ?? []), ...args], { timeoutMs: 90_000, input, maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      // Never the error's own text: it can carry the command line.
      throw new Error(/maxBuffer/i.test(String((e as Error)?.message)) ? "The answer was too big: ask for fewer rows or columns." : /timed? ?out|ETIMEDOUT|killed/i.test(String((e as Error)?.message)) ? "db took longer than 90 seconds." : "db couldn't be started.");
    }
    if (r.code !== 0) throw new Error(problemOf(r));
    return r.stdout;
  };
  const rows = async (args: string[], input?: string): Promise<Rows> => {
    const t0 = now();
    const all = rowsOf(await call(args, input));
    const capped = all.length > MAX_ROWS;
    const list = all.slice(0, MAX_ROWS);
    const columns = [...new Set(list.flatMap((r) => Object.keys(r)))];
    return { rows: list, columns, capped, ms: now() - t0 };
  };
  let kept: { at: number; targets: Target[] } | undefined;
  return {
    async targets() {
      if (kept && now() - kept.at < 3600_000) return { targets: kept.targets };
      const out: Target[] = [];
      const problems: string[] = [];
      try {
        const r = await o.run(o.bin, [...(o.pre ?? []), "ls", "at"], { timeoutMs: 60_000 });
        if (r.code === 0) for (const a of appsOf(r.stdout)) out.push({ id: `${a}:at`, label: a, kind: "at" });
        else problems.push(problemOf(r));
      } catch {
        problems.push("db couldn't be started.");
      }
      try {
        for (const d of rowsOf(await call(["local", "dbs", "-f", "json"]))) if (typeof d.name === "string" && targetOk(`local:${d.name}`)) out.push({ id: `local:${d.name}`, label: d.name, kind: "local" });
      } catch {
        // The docker SQL Server is often off: local just isn't offered.
      }
      if (out.some((t) => t.kind === "at")) kept = { at: now(), targets: out };
      return { targets: out, problem: problems[0] };
    },
    async tables(t) {
      return tablesOf(rowsOf(await call([t, "tables", "-f", "json"])));
    },
    async cols(t, table) {
      if (!TABLE.test(table)) throw new Error("Name a table as schema.table.");
      return colsOf(rowsOf(await call([t, "cols", table, "-f", "json"])));
    },
    async find(t, text) {
      const s = text.trim();
      if (!/^[\w$#@ -]{1,64}$/.test(s)) throw new Error("Search for part of a table or column name: letters, digits, _ and -.");
      return foundOf(rowsOf(await call([t, "find", s, "-f", "json"])));
    },
    async peek(t, table, n = 50) {
      if (!TABLE.test(table)) throw new Error("Name a table as schema.table.");
      return rows([t, "peek", table, "-n", String(Math.max(1, Math.min(MAX_ROWS, Math.floor(n)))), "-f", "json"]);
    },
    async query(t, sql) {
      const q = sql.trim();
      if (!q) throw new Error("Write a query first.");
      if (q.length > MAX_SQL) throw new Error(`Keep a query under ${MAX_SQL} characters.`);
      // The SQL goes in on stdin (no quoting to get wrong); DuckDB over the result stops at one row past the cap.
      return rows([t, "q", "-", `SELECT * FROM t LIMIT ${MAX_ROWS + 1}`, "-f", "json"], q);
    },
    async schemaText(t) {
      return call([t, "q", "-", "SELECT * FROM t LIMIT 60001", "-f", "json"], SCHEMA_SQL);
    },
  };
}
