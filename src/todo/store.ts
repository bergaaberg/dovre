/**
 * My list: the small things and small initiatives that live nowhere else. Kept in the local
 * database (migrations/0005_todo.sql), never sent anywhere. An item with items under it is an
 * initiative; that's one level deep, on purpose: this is a list, not a project tool.
 *
 * The quick-add parser and the date helpers are pure and tested; the rest is plain SQL.
 */
import type { D1 } from "../db.ts";
import { currentTz, dtf } from "../when.ts";

export const STATES = ["doing", "next", "waiting", "done"] as const;
export type State = (typeof STATES)[number];
export const isState = (s: unknown): s is State => typeof s === "string" && (STATES as readonly string[]).includes(s);

export type Todo = {
  id: number;
  parent: number | null;
  title: string;
  notes: string;
  state: State;
  /** YYYY-MM-DD, Oslo time. */
  due: string | null;
  pos: number;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
};

export const MAX_TITLE = 300;
export const MAX_NOTES = 20_000;

type Row = { id: number; parent: number | null; title: string; notes: string; state: string; due: string | null; pos: number; created_at: number; updated_at: number; done_at: number | null };
const fromRow = (r: Row): Todo => ({
  id: r.id,
  parent: r.parent,
  title: r.title,
  notes: r.notes,
  state: isState(r.state) ? r.state : "next",
  due: r.due,
  pos: r.pos,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  doneAt: r.done_at,
});

// ── Dates ─────────────────────────────────────────────────────────────

const DAY = 86_400_000;
/** The date in the instance timezone, as YYYY-MM-DD. */
export const osloDate = (at: number, tz = currentTz()) => dtf("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** Days from `today` to `date` (negative: past). */
export const daysUntil = (date: string, today: string) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);
const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d);

const DAYS: Record<string, number> = {
  søn: 0, son: 0, sun: 0, man: 1, mon: 1, tir: 2, tue: 2, ons: 3, wed: 3, tor: 4, thu: 4, fre: 5, fri: 5, lør: 6, lor: 6, sat: 6,
};

/**
 * Quick add: the title, and a due date from what it ends with — `!` or `i dag`/`today` (today),
 * `i morgen`/`tomorrow`, a weekday (`fre`, `fri`: the next one, today counts), `30.10` (the next
 * 30 October) or `2026-10-30`. Only a trailing word counts, so a title like "Fix man page" stays.
 */
export function parseQuick(text: string, today: string): { title: string; due: string | null } {
  let words = text.replace(/[\r\n]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const take = (n: number) => {
    words = words.slice(0, -n);
  };
  let due: string | null = null;
  const last = (words.at(-1) ?? "").toLowerCase();
  const two = words.slice(-2).join(" ").toLowerCase();
  if (words.length > 1 && (two === "i dag" || two === "i morgen")) {
    due = two === "i dag" ? today : addDays(today, 1);
    take(2);
  } else if (words.length > 1 || last === "!") {
    if (last === "!" || last === "today" || last === "idag") due = today;
    else if (last === "tomorrow" || last === "imorgen") due = addDays(today, 1);
    else if (last in DAYS) due = addDays(today, (DAYS[last]! - weekday(today) + 7) % 7);
    else if (validDate(last)) due = last;
    else {
      const m = last.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
      if (m) {
        const year = Number(today.slice(0, 4));
        const at = (y: number) => `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
        const d = validDate(at(year)) && at(year) >= today ? at(year) : at(year + 1);
        if (validDate(d)) due = d;
      }
    }
    if (due) take(1);
  }
  // A trailing "!" glued to the last word (`Ring Kari!`) is punctuation, not a date.
  return { title: words.join(" ").slice(0, MAX_TITLE), due };
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function listTodos(db: D1): Promise<Todo[]> {
  const { results } = await db.prepare("SELECT * FROM todo ORDER BY pos, id").all<Row>();
  return results.map(fromRow);
}

export async function getTodo(db: D1, id: number): Promise<Todo | undefined> {
  const r = await db.prepare("SELECT * FROM todo WHERE id = ?").bind(id).first<Row>();
  return r ? fromRow(r) : undefined;
}

/** Adds an item at the end of its list. Under a sub-item it goes under that item's initiative: one level. */
export async function addTodo(db: D1, t: { title: string; parent?: number | null; due?: string | null; notes?: string; state?: State }, now = Date.now()): Promise<Todo | undefined> {
  const title = t.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title) return undefined;
  let parent = t.parent ?? null;
  if (parent !== null) {
    const p = await getTodo(db, parent);
    parent = p ? (p.parent ?? p.id) : null;
  }
  const last = await db.prepare("SELECT MAX(pos) AS pos FROM todo WHERE parent IS ?").bind(parent).first<{ pos: number | null }>();
  const r = await db
    .prepare("INSERT INTO todo (parent, title, notes, state, due, pos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(parent, title, (t.notes ?? "").slice(0, MAX_NOTES), t.state ?? "next", t.due && validDate(t.due) ? t.due : null, (last?.pos ?? 0) + 1, now, now)
    .run();
  return fromRow(r.results[0] as Row);
}

/** Changes what's given; done sets when (and leaving done clears it). */
export async function updateTodo(db: D1, id: number, ch: { title?: string; notes?: string; state?: State; due?: string | null }, now = Date.now()): Promise<Todo | undefined> {
  const t = await getTodo(db, id);
  if (!t) return undefined;
  const title = ch.title !== undefined ? ch.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TITLE) || t.title : t.title;
  const notes = ch.notes !== undefined ? ch.notes.replace(/\r\n?/g, "\n").slice(0, MAX_NOTES) : t.notes;
  const state = ch.state ?? t.state;
  const due = ch.due === undefined ? t.due : ch.due && validDate(ch.due) ? ch.due : null;
  const doneAt = state === "done" ? (t.state === "done" ? t.doneAt : now) : null;
  await db.prepare("UPDATE todo SET title = ?, notes = ?, state = ?, due = ?, done_at = ?, updated_at = ? WHERE id = ?").bind(title, notes, state, due, doneAt, now, id).run();
  return getTodo(db, id);
}

/** Done ↔ back to what's next. */
export async function toggleDone(db: D1, id: number, now = Date.now()): Promise<Todo | undefined> {
  const t = await getTodo(db, id);
  return t ? updateTodo(db, id, { state: t.state === "done" ? "next" : "done" }, now) : undefined;
}

/** One place up or down among its siblings. */
export async function moveTodo(db: D1, id: number, dir: "up" | "down"): Promise<void> {
  const t = await getTodo(db, id);
  if (!t) return;
  const other = await db
    .prepare(`SELECT * FROM todo WHERE parent IS ? AND id != ? AND pos ${dir === "up" ? "<" : ">"} ? ORDER BY pos ${dir === "up" ? "DESC" : "ASC"} LIMIT 1`)
    .bind(t.parent, t.id, t.pos)
    .first<Row>();
  if (!other) return;
  await db.batch([db.prepare("UPDATE todo SET pos = ? WHERE id = ?").bind(other.pos, t.id), db.prepare("UPDATE todo SET pos = ? WHERE id = ?").bind(t.pos, other.id)]);
}

/** Deletes an item and what's under it. */
export async function deleteTodo(db: D1, id: number): Promise<void> {
  await db.batch([db.prepare("DELETE FROM todo WHERE parent = ?").bind(id), db.prepare("DELETE FROM todo WHERE id = ?").bind(id)]);
}

/** Items with their sub-items, top level in order. */
export type Tree = { item: Todo; children: Todo[] };
export function treeOf(all: Todo[]): Tree[] {
  const kids = new Map<number, Todo[]>();
  for (const t of all) if (t.parent !== null) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);
  return all.filter((t) => t.parent === null).map((item) => ({ item, children: kids.get(item.id) ?? [] }));
}
