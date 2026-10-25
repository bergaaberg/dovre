/**
 * The query agent: a question in plain words becomes one read-only query, proposed as a card I run
 * myself. It runs only on a Copilot model through omp (src/teams/crawl.ts's asker: no tools, no MCP
 * servers, no session), never Claude: a question can name a customer, and a result it reviews can
 * come from production. Decided with the user 2026-10-23.
 *
 * What it's told: the question, and the database's table and column names from its test copy
 * (src/data/schema.ts). Never a row, except when I press "Review this result": then the rows of that
 * one run, read again for it and kept nowhere. Questions, proposals and reviews live in memory only:
 * never on disk, in logs (the log holds which database), the snapshot, or any other model.
 */
import { randomUUID } from "node:crypto";
import { MAX_SQL, type Rows } from "./db.ts";
import { type Schema, type Schemas, schemaSource } from "./schema.ts";

export const MAX_QUESTION = 2000;
/** How much of the schema goes in: every table's name, and the columns of those that fit the question. */
const ALL_CHARS = 50_000;
const NAMES_CHARS = 20_000;
const COLS_CHARS = 30_000;
const REVIEW_ROWS = 100;
const REVIEW_CHARS = 30_000;
const KEEP = 30;

export type Asker = { why(): string | undefined; ask(prompt: string): Promise<string>; model: string };
export type Proposal = { sql: string; says: string };
export type Review = { state: "thinking" | "ready" | "failed"; text?: string; proposal?: Proposal; error?: string };
export type Job = {
  id: string;
  t: string;
  question: string;
  at: number;
  state: "thinking" | "ready" | "asks" | "failed";
  proposal?: Proposal;
  /** The agent's question back, when it needs to know more. */
  back?: string;
  error?: string;
  review?: Review;
  /** The question across databases this card answers part of. */
  parent?: string;
};

/** An environment a question across databases may land in. Never pre (it holds production data). */
export type Env = "at" | "prod";
/** A database the agent picked for a question across databases, and the card it got (a Job of its own). */
export type Pick = { t: string; why: string; job: string };
/**
 * One question across databases: the agent picks up to MAX_PICKS from each app's table names, then
 * each pick gets the normal query card (a Job with this as its parent), run and reviewed as any.
 */
export type Across = {
  id: string;
  question: string;
  at: number;
  state: "picking" | "ready" | "asks" | "failed";
  picks: Pick[];
  back?: string;
  error?: string;
  /** Apps whose tables couldn't be read, so the agent didn't see them. */
  unread?: string[];
};

export type DataAgent = {
  why(): string | undefined;
  model: string;
  /** A new question about database `t`; answered in the background. */
  start(t: string, question: string, parent?: string): Job;
  get(id: string): Job | undefined;
  /** A question across `apps` (short names, as in `<app>:at`) in `envs`; picked and answered in the background. */
  across(question: string, o: { apps: string[]; envs: Env[] }): Across;
  getAcross(id: string): Across | undefined;
  /** Rows of a run of the proposed query, to say what they mean; answered in the background. */
  review(id: string, sql: string, rows: Rows): void;
};

/** Folded for matching: lower case, Norwegian letters spelled out, accents off. */
const fold = (s: string) => s.toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").normalize("NFD").replace(/\p{M}/gu, "");
const STOP = new Set("hva hvor hvem hvilke hvilken hvordan mange som med for fra til og eller der det den de er har alle per pa av om en et ett the how many what which who and or with from for per all are is was in on of to a an by show list find give me vis finn".split(" "));
const words = (s: string) => [...new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
/** Whether two words are the same word, near enough: "kunder" and "kunde", "brukerne" and "bruker". */
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, Math.max(4, b.length - 2))) || b.startsWith(a.slice(0, Math.max(4, a.length - 2)))));

const tableLine = (t: Schema["tables"][number]) => `${t.name}(${t.cols.map(([c, ty]) => `${c} ${ty}`).join(", ")})`;

/** The schema as the prompt shows it: all of it when it's small; else every table's name, and the columns of those that fit the question best. */
export function schemaPart(question: string, s: Schema): string {
  const all = s.tables.map(tableLine).join("\n");
  if (all.length <= ALL_CHARS) return all;
  const want = words(question);
  const scored = s.tables
    .map((t, i) => {
      const nameWords = fold(t.name).split(/[^a-z0-9]+/).filter(Boolean);
      let score = 0;
      for (const w of want) {
        if (nameWords.some((n) => near(n, w) || n.includes(w))) score += 5;
        score += Math.min(3, t.cols.filter(([c]) => fold(c).split(/[^a-z0-9]+/).some((n) => near(n, w))).length);
      }
      return { t, score, i };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const cols: string[] = [];
  let used = 0;
  for (const { t } of scored) {
    const l = tableLine(t);
    if (used + l.length > COLS_CHARS) continue;
    cols.push(l);
    used += l.length;
  }
  let names = s.tables.map((t) => t.name).join(", ");
  if (names.length > NAMES_CHARS) names = `${names.slice(0, NAMES_CHARS)}, …`;
  return `All tables: ${names}\n\nColumns of the tables that seem to fit the question:\n${cols.join("\n") || "(none matched: ask which table, or use the names above)"}`;
}

export function queryPrompt(question: string, t: string, s: Schema): string {
  return `You write SQL queries for a person looking at a Microsoft SQL Server database (${t}; T-SQL), read-only.

Their question:
<question>
${question}
</question>

The database's tables and columns (names only, from its test copy; production has the same tables):
<schema>
${schemaPart(question, s)}
</schema>

Write ONE read-only query (SELECT, or WITH … SELECT) that answers the question. Use only tables and columns from the schema. Prefer TOP 100 unless the question asks for counts or sums. Name tables as schema.table.

Answer with JSON only, one of:
{"sql": "the query", "says": "one short line, in the person's language, on what it returns"}
{"ask": "one short question back, when the question can't be answered without knowing more (which table, which period)"}`;
}

export function reviewPrompt(question: string, sql: string, rows: Rows): string {
  const cols = rows.columns.slice(0, 60);
  const lines = [cols.join("\t"), ...rows.rows.slice(0, REVIEW_ROWS).map((r) => cols.map((c) => String(r[c] ?? "NULL").replace(/\s+/g, " ").slice(0, 200)).join("\t"))];
  let table = lines.join("\n");
  if (table.length > REVIEW_CHARS) table = `${table.slice(0, REVIEW_CHARS)}\n…`;
  return `A person asked a question about a database and ran this query for it. Say briefly, in their language, what the result tells them, and whether it looks right for the question: empty, too many rows, a join that multiplies rows, a filter that's off. Plain text, a few sentences. If a better query would answer it, end with JSON on its own line: {"sql": "the query", "says": "one short line on what it returns"}.

Their question:
<question>
${question}
</question>

The query:
<sql>
${sql}
</sql>

The result: ${rows.rows.length}${rows.capped ? "+" : ""} rows${rows.rows.length > REVIEW_ROWS ? `, the first ${REVIEW_ROWS} shown` : ""}, tab-separated:
<rows>
${table}
</rows>`;
}

const WRITES = /\b(insert|update|delete|merge|drop|alter|exec|execute|create|truncate|grant|revoke|deny|into|openrowset|opendatasource|bulk|backup|restore|shutdown|dbcc|waitfor)\b/i;

/** A query the agent proposed, if it's one this tab would run: one SELECT (or WITH), nothing that writes. */
export function sqlOk(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const sql = v.replace(/\r\n?/g, "\n").trim().replace(/;\s*$/, "");
  // Judged without what's inside quotes: a ; or a word in a string is text.
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (!sql || sql.length > MAX_SQL || !/^(select|with)\b/i.test(sql) || bare.includes(";") || WRITES.test(bare)) return undefined;
  return sql;
}

/** The JSON the agent answered with: the last object in its text that parses. */
function jsonIn(text: string): Record<string, unknown> | undefined {
  const t = text.slice(-20_000);
  const opens = [...t.matchAll(/\{/g)].map((m) => m.index!).reverse();
  const closes = [...t.matchAll(/\}/g)].map((m) => m.index!).reverse();
  for (const a of opens.slice(0, 50))
    for (const b of closes) {
      if (b < a) break;
      try {
        const j = JSON.parse(t.slice(a, b + 1));
        if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
      } catch {}
    }
  return undefined;
}

const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** What the agent proposed: a query, or a question back; null when it's neither. */
export function proposalOf(text: string): { proposal?: Proposal; back?: string } | null {
  const j = jsonIn(text);
  if (!j) return null;
  const sql = sqlOk(j.sql);
  if (sql) return { proposal: { sql, says: line(j.says, 300) } };
  const back = line(j.ask, 500);
  return back ? { back } : null;
}

// ── Across databases ──

export const MAX_PICKS = 4;
/** Table names per app, and in all, in the pick prompt. */
const APP_CHARS = 4000;
const PICK_CHARS = 80_000;
/** Schemas read at once for a question across databases (each a db call the first time in a day). */
const READ_AT_ONCE = 4;

/** Each app's table names, short: the prompt that picks databases sees nothing else. */
export function databasesPart(dbs: { app: string; tables: string[] }[]): string {
  const out: string[] = [];
  let used = 0;
  for (const d of dbs) {
    let names = d.tables.join(", ");
    if (names.length > APP_CHARS) names = `${names.slice(0, APP_CHARS).replace(/,[^,]*$/, "")}, …`;
    const l = `${d.app}: ${names || "(no tables)"}`;
    if (used + l.length > PICK_CHARS) {
      out.push(`${d.app}: (left out: too many tables in all)`);
      continue;
    }
    out.push(l);
    used += l.length;
  }
  return out.join("\n");
}

export function pickPrompt(question: string, dbs: { app: string; tables: string[] }[], envs: Env[]): string {
  const env = envs.includes("prod")
    ? `"at" (the test copy, test data) or "prod" (production, real customer data: only when the question asks about production, real customers or real numbers). The same app may come twice, once per environment.`
    : `"at" (the test copy) only.`;
  return `A person asks a question about their organisation's databases. Each app has its own Microsoft SQL Server database; below are each app's table names (from its test copy; production has the same tables).

Their question:
<question>
${question}
</question>

The databases, one line per app:
<databases>
${databasesPart(dbs)}
</databases>

Pick the databases that can answer it, best first, at most ${MAX_PICKS}. Environment: ${env} Pick only apps from the list.

Answer with JSON only, one of:
{"picks": [{"app": "the app's name as listed", "env": "at", "why": "one short line, in the person's language, on why this one"}]}
{"ask": "one short question back, when you can't tell which databases without knowing more"}`;
}

/** The agent's picks: apps from the list in allowed environments, each once, at most MAX_PICKS; or its question back; null when neither. */
/** The widest JSON object in the text: the picks hold objects of their own, so the last one that parses would be a single pick. */
function outerJsonIn(text: string): Record<string, unknown> | undefined {
  const t = text.slice(-40_000);
  const opens = [...t.matchAll(/\{/g)].map((m) => m.index!).slice(0, 50);
  const closes = [...t.matchAll(/\}/g)].map((m) => m.index!).reverse().slice(0, 50);
  for (const a of opens)
    for (const b of closes) {
      if (b < a) break;
      try {
        const j = JSON.parse(t.slice(a, b + 1));
        if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
      } catch {}
    }
  return undefined;
}

export function picksOf(text: string, apps: string[], envs: Env[]): { picks?: { t: string; why: string }[]; back?: string } | null {
  const j = outerJsonIn(text);
  if (!j) return null;
  const seen = new Set<string>();
  const picks = (Array.isArray(j.picks) ? j.picks : []).flatMap((p) => {
    const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    const app = typeof o.app === "string" ? o.app.trim().toLowerCase().replace(/:(at|prod)$/, "") : "";
    const env = (o.env === undefined ? "at" : o.env) as Env;
    const t = `${app}:${env}`;
    if (!apps.includes(app) || !envs.includes(env) || seen.has(t)) return [];
    seen.add(t);
    return [{ t, why: line(o.why, 300) }];
  });
  if (picks.length) return { picks: picks.slice(0, MAX_PICKS) };
  const back = line(j.ask, 500);
  return back ? { back } : null;
}

/** Runs `f` over `items`, `n` at a time. */
async function inBatches<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(f))));
  return out;
}

export function createDataAgent(o: { asker?: Asker; schemas?: Schemas; onChange?: (id: string) => void; now?: () => number }): DataAgent {
  const now = o.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const acrosses = new Map<string, Across>();
  // A card that's part of a question across databases changes that page too.
  const changed = (j: Job) => {
    o.onChange?.(j.id);
    if (j.parent) o.onChange?.(j.parent);
  };
  const why = () => (!o.schemas ? "The query agent needs db." : !o.asker ? "The query agent is off (DATA_AGENT=off)." : o.asker.why());
  const trim = () => {
    // A card that belongs to a question across databases stays as long as that question does.
    const keepAcross = new Set([...acrosses.values()].sort((a, b) => b.at - a.at).slice(0, KEEP).map((a) => a.id));
    for (const a of acrosses.values()) if (!keepAcross.has(a.id)) acrosses.delete(a.id);
    const own = [...jobs.values()].filter((j) => !j.parent || !acrosses.has(j.parent));
    for (const j of own.sort((a, b) => b.at - a.at).slice(KEEP)) jobs.delete(j.id);
  };
  const clean = (question: string) => question.replace(/\r\n?/g, "\n").trim().slice(0, MAX_QUESTION);
  const api: DataAgent = {
    why,
    model: o.asker?.model ?? "",
    getAcross: (id) => acrosses.get(id),
    across(question, opts) {
      const q = clean(question);
      const a: Across = { id: randomUUID(), question: q, at: now(), state: "picking", picks: [] };
      acrosses.set(a.id, a);
      trim();
      const apps = [...new Set(opts.apps)].filter((x) => schemaSource(`${x}:at`));
      const no = why() ?? (!q ? "Ask something first." : !apps.length ? "There are no test copies to read the databases' tables from." : undefined);
      if (no) {
        Object.assign(a, { state: "failed", error: no });
        return a;
      }
      const done = () => o.onChange?.(a.id);
      void (async () => {
        try {
          const read = await inBatches(apps, READ_AT_ONCE, async (app) => {
            try {
              return { app, tables: (await o.schemas!.get(`${app}:at`)).tables.map((x) => x.name) };
            } catch {
              return { app, tables: undefined };
            }
          });
          const dbs = read.filter((d): d is { app: string; tables: string[] } => !!d.tables);
          a.unread = read.filter((d) => !d.tables).map((d) => d.app);
          if (!dbs.length) throw new Error("No database's tables could be read: is db working (VPN, az login)?");
          const envs = opts.envs.filter((e) => e === "at" || e === "prod");
          const got = picksOf(await o.asker!.ask(pickPrompt(q, dbs, envs)), dbs.map((d) => d.app), envs);
          if (!got) Object.assign(a, { state: "failed", error: "The agent didn't pick any of the databases. Ask again, or name what you're after." });
          else if (got.back) Object.assign(a, { state: "asks", back: got.back });
          else {
            // Each pick is an ordinary card, written by the same agent from that database's names.
            a.picks = got.picks!.map((p) => ({ ...p, job: api.start(p.t, q, a.id).id }));
            a.state = "ready";
          }
        } catch (e) {
          Object.assign(a, { state: "failed", error: String((e as Error)?.message ?? e).slice(0, 300) });
        }
        done();
      })();
      return a;
    },
    start(t, question, parent) {
      const q = clean(question);
      const j: Job = { id: randomUUID(), t, question: q, at: now(), state: "thinking", ...(parent ? { parent } : {}) };
      jobs.set(j.id, j);
      trim();
      const no = why() ?? (!q ? "Ask something first." : !schemaSource(t) ? "There's no test copy to read this database's tables from." : undefined);
      if (no) {
        Object.assign(j, { state: "failed", error: no });
        return j;
      }
      void (async () => {
        try {
          const schema = await o.schemas!.get(t);
          const got = proposalOf(await o.asker!.ask(queryPrompt(q, t, schema)));
          if (!got) Object.assign(j, { state: "failed", error: "The agent didn't answer with a query this tab would run. Ask again, or more precisely." });
          else if (got.proposal) Object.assign(j, { state: "ready", proposal: got.proposal });
          else Object.assign(j, { state: "asks", back: got.back });
        } catch (e) {
          Object.assign(j, { state: "failed", error: String((e as Error)?.message ?? e).slice(0, 300) });
        }
        changed(j);
      })();
      return j;
    },
    get: (id) => jobs.get(id),
    review(id, sql, rows) {
      const j = jobs.get(id);
      if (!j || j.review?.state === "thinking") return;
      const no = why();
      if (no) {
        j.review = { state: "failed", error: no };
        changed(j);
        return;
      }
      j.review = { state: "thinking" };
      changed(j);
      void (async () => {
        try {
          const text = await o.asker!.ask(reviewPrompt(j.question, sql, rows));
          const got = proposalOf(text);
          const plain = text.replace(/\{[\s\S]*"sql"[\s\S]*\}\s*$/, "").replace(/```(json)?\s*```/g, "").trim().slice(0, 4000);
          j.review = { state: "ready", text: plain || "(no words, only a query)", proposal: got?.proposal };
        } catch (e) {
          j.review = { state: "failed", error: String((e as Error)?.message ?? e).slice(0, 300) };
        }
        changed(j);
      })();
    },
  };
  return api;
}
