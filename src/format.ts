/** Times and sizes as the pages show them, in the instance timezone. */
import { currentTz, dtf } from "./when.ts";

const dayOf = (at: number, zone = currentTz()) => dtf("en-CA", { timeZone: zone }).format(at);

/** Short, for a list: the time today, the date this year, the date with its year before that. */
export function when(at: number, now = Date.now(), zone = currentTz()): string {
  if (dayOf(at, zone) === dayOf(now, zone)) return dtf("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(at);
  const sameYear = dayOf(at, zone).slice(0, 4) === dayOf(now, zone).slice(0, 4);
  return dtf("en-GB", { timeZone: zone, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}

/** The hour, in the instance timezone: "14:00". */
export function hourOf(at: number, zone = currentTz()): string {
  return dtf("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(at);
}

/** In full, for a message. */
export function stamp(at: number, zone = currentTz()): string {
  return dtf("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(at);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function count(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}

/** A share as a percentage: "0.4 %", "12 %"; small ones aren't rounded to nothing. */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return "<0.1 %";
  return `${p < 10 ? Math.round(p * 10) / 10 : Math.round(p)} %`;
}

/** How long ago, roughly: "4 min ago", "3 h ago", "2 d ago". */
export function ago(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (24 * 60))} d ago`;
}

/** How long since, compactly, for a list's right edge: "now", "12 min", "3 h", "2 d". */
export function since(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / (24 * 60))} d`;
}

/** A duration in milliseconds, compactly: "340 ms", "4.2 s", "3.5 min"; nothing measured is "—". */
export function duration(ms: number): string {
  if (!(ms > 0)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s * 10) / 10} s`;
  return `${Math.round((s / 60) * 10) / 10} min`;
}

/** Extracts the repository or folder name from a POSIX or Windows file path. */
export function repoOf(p: string | undefined | null): string | undefined {
  if (!p) return undefined;
  const clean = p.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts.pop() || undefined;
}
