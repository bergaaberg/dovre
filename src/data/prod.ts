/**
 * The Data tab's production databases, through `db mcp` (src/data/mcp.ts). db itself asks before
 * it opens each production database, and the question goes to the bar on every page: only I can
 * answer it, with two clicks, and Allow is never the default. A yes holds for that one database
 * until db's process ends (30 quiet minutes, or Close); a no holds until then too.
 *
 * Nothing here opens a database by itself: open(t) is called only from my "Ask to open" button,
 * and until it's open every other call is refused before it reaches db. What comes back goes to
 * the response that asked: never kept, logged, put in the snapshot, or given to a model.
 */
import { colsOf, db2Name, foundOf, MAX_ROWS, MAX_SQL, type Rows, TABLE, tablesOf, type Column, type Found, type TableInfo } from "./db.ts";
import { type DbMcp, tableOf } from "./mcp.ts";

/** A production database the tab may ask for: an app's prod, or the DB2 database's (DATA_DB2). */
export function prodOk(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const db2 = db2Name();
  if (db2 && t === `${db2}:prod`) return true;
  const m = t.match(/^([a-z][a-z0-9-]{0,40}):prod$/);
  return !!m && m[1] !== "pre" && m[1] !== "prod" && m[1] !== db2;
}

export type ProdState = { state: "closed" | "asking" | "open" | "refused"; said?: string };

export type Prod = {
  state(t: string): ProdState;
  /** Asks db to open the database (db asks me first). Returns at once; the state changes when it's done. */
  open(t: string): void;
  /** Ends db: every database it opened closes, and it asks again next time. */
  close(): void;
  opened(): string[];
  /** The databases db is asking me about now. */
  asking(): string[];
  tables(t: string): Promise<TableInfo[]>;
  cols(t: string, table: string): Promise<Column[]>;
  find(t: string, text: string): Promise<Found[]>;
  peek(t: string, table: string, n?: number): Promise<Rows>;
  query(t: string, sql: string): Promise<Rows>;
};

/** db's words for a no: the question was declined, or couldn't be asked. */
const REFUSED = /declin|denied|deny|refus|not approved|without approval|cancel/i;

export function createProd(o: { mcp: (onClose: () => void) => DbMcp; now?: () => number; onChange?: () => void }): Prod {
  const now = o.now ?? Date.now;
  const states = new Map<string, ProdState>();
  const mcp = o.mcp(() => {
    // db ended: whatever it had opened is closed again.
    if (states.size) {
      states.clear();
      o.onChange?.();
    }
  });
  const set = (t: string, s: ProdState) => {
    states.set(t, s);
    o.onChange?.();
  };
  const isOpen = (t: string) => {
    if (!prodOk(t)) throw new Error("That isn't a production database.");
    if (states.get(t)?.state !== "open") throw new Error(`${t} isn't open: ask to open it first.`);
  };
  const rows = async (tool: string, args: Record<string, unknown>): Promise<Rows> => {
    const t0 = now();
    const r = tableOf(await mcp.call(tool, args));
    const capped = r.truncated || r.rows.length > MAX_ROWS;
    const list = r.rows.slice(0, MAX_ROWS);
    return { rows: list, columns: r.columns, capped, ms: now() - t0 };
  };
  const listed = async (tool: string, args: Record<string, unknown>) => tableOf(await mcp.call(tool, args)).rows;
  return {
    state: (t) => states.get(t) ?? { state: "closed" },
    open(t) {
      if (!prodOk(t)) return;
      const s = states.get(t)?.state;
      if (s === "asking" || s === "open") return;
      set(t, { state: "asking" });
      // The smallest thing that makes db ask: its schemas. What it lists is dropped.
      mcp.call("schemas", { target: t }).then(
        () => set(t, { state: "open" }),
        (e) => {
          const said = String((e as Error)?.message ?? "").slice(0, 400);
          if (REFUSED.test(said)) set(t, { state: "refused", said });
          else {
            states.delete(t);
            set(t, { state: "closed", said: said || "db couldn't open it." });
          }
        },
      );
    },
    close() {
      mcp.close();
      states.clear();
      o.onChange?.();
    },
    opened: () => [...states].filter(([, s]) => s.state === "open").map(([t]) => t),
    asking: () => [...states].filter(([, s]) => s.state === "asking").map(([t]) => t),
    async tables(t) {
      isOpen(t);
      return tablesOf(await listed("tables", { target: t }));
    },
    async cols(t, table) {
      isOpen(t);
      if (!TABLE.test(table)) throw new Error("Name a table as schema.table.");
      return colsOf(await listed("columns", { target: t, table }));
    },
    async find(t, text) {
      isOpen(t);
      const s = text.trim();
      if (!/^[\w$#@ -]{1,64}$/.test(s)) throw new Error("Search for part of a table or column name: letters, digits, _ and -.");
      return foundOf(await listed("find", { target: t, substring: s }));
    },
    async peek(t, table, n = 50) {
      isOpen(t);
      if (!TABLE.test(table)) throw new Error("Name a table as schema.table.");
      return rows("peek", { target: t, table, page_size: Math.max(1, Math.min(MAX_ROWS, Math.floor(n))) });
    },
    async query(t, sql) {
      isOpen(t);
      const q = sql.trim();
      if (!q) throw new Error("Write a query first.");
      if (q.length > MAX_SQL) throw new Error(`Keep a query under ${MAX_SQL} characters.`);
      return rows("query", { target: t, sql: q, max_rows: MAX_ROWS + 1 });
    },
  };
}
