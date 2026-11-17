/**
 * Quiet hours (#272), one idea for all of Dovre: from one hour up to another (0–23, in the
 * instance's timezone, across midnight when `from` > `to`), and all weekend when `weekends`.
 * Notifications hold what would ring then; auto runs start nothing then, unless they keep their own.
 */
import { dtf } from "./when.ts";

export type Quiet = { from: number; to: number; weekends?: boolean };

const hour = (v: unknown): number | undefined => {
  if (v === "" || v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : undefined;
};

/** Quiet hours from anything (stored JSON or a form's from/to/weekends), or null for none. Weekends alone count. */
export function quietOf(from: unknown, to: unknown, weekends?: unknown): Quiet | null {
  const f = hour(from);
  const t = hour(to);
  const w = weekends === true || weekends === "on";
  if (f !== undefined && t !== undefined && f !== t) return w ? { from: f, to: t, weekends: true } : { from: f, to: t };
  return w ? { from: 0, to: 0, weekends: true } : null;
}

/** The hour and weekday at `at` in `tz` (this machine's zone when it's unknown). */
function local(at: number, tz?: string): { hour: number; weekend: boolean } {
  const fmt = (zone?: string) => dtf("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  let f: Intl.DateTimeFormat;
  try {
    f = fmt(tz || undefined);
  } catch {
    f = fmt();
  }
  const parts = f.formatToParts(new Date(at));
  const day = parts.find((p) => p.type === "weekday")?.value ?? "";
  return { hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24, weekend: day === "Sat" || day === "Sun" };
}

/** Inside quiet hours at `at`. */
export function quietAt(q: Quiet | null | undefined, at: number, tz?: string): boolean {
  if (!q) return false;
  const l = local(at, tz);
  if (q.weekends && l.weekend) return true;
  if (q.from === q.to) return false;
  return q.from < q.to ? l.hour >= q.from && l.hour < q.to : l.hour >= q.from || l.hour < q.to;
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
/** "17:00–08:00 and weekends", "all weekend", or "none". */
export function quietLabel(q: Quiet | null | undefined): string {
  if (!q) return "none";
  const hours = q.from !== q.to ? `${hh(q.from)}–${hh(q.to)}` : "";
  return hours && q.weekends ? `${hours} and weekends` : hours || (q.weekends ? "all weekend" : "none");
}

/**
 * Quiet hours' span as a setting card takes it (#185): "22-7", or "" for none. Read from "22-7",
 * "22:00–07:00", "22 to 7", "none" or "off"; anything else (an hour past 23, from and to the same) is null.
 */
export function spanOf(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (t === "" || t === "none" || t === "off") return "";
  const m = /^(\d{1,2})(?::00)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::00)?$/.exec(t);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from <= 23 && to <= 23 && from !== to ? `${from}-${to}` : null;
}

/** A span's two hours, or none. */
export function spanHours(v: string): { from: number; to: number } | undefined {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : undefined;
}

/** A span as Settings words it: "22:00–07:00", or "None". */
export function spanLabel(v: string): string {
  const h = spanHours(v);
  return h ? `${hh(h.from)}–${hh(h.to)}` : "None";
}

/** Quiet hours' span now: "" when there are none, or only weekends. */
export const spanNow = (q: Quiet | null | undefined): string => (q && q.from !== q.to ? `${q.from}-${q.to}` : "");
