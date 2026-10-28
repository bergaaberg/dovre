/**
 * Timezone and greeting language settings.
 *
 * Configured via TZ_NAME and GREETING. The timezone is this machine's own unless TZ_NAME
 * names another (on a Worker, the machine's zone is UTC). TZ_NAME is validated with
 * Intl.DateTimeFormat; an invalid one falls back to the machine's zone with a log warning.
 */

export type GreetingLang = "en" | "no";

const formats = new Map<string, Intl.DateTimeFormat>();
/** A date format, made once per locale and options: making one costs far more than using it (a page of dates froze the server for seconds). */
export function dtf(locale: string, opts: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}

const zoneOk = (name: string) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

/** This machine's timezone (the process's `TZ`, else the system's), or UTC when it has none. */
export function hostZone(): string {
  const name = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return name && zoneOk(name) ? name : "UTC";
}

let state = {
  tz: hostZone(),
  lang: "en" as GreetingLang,
};

/** Validates an IANA timezone name. Empty: this machine's zone. Invalid: the same, with a log line. */
export function validZone(raw: unknown, log: (msg: string) => void = console.warn): string {
  if (typeof raw !== "string" || !raw.trim()) return hostZone();
  const name = raw.trim();
  if (zoneOk(name)) return name;
  const fallback = hostZone();
  log(`invalid timezone ${JSON.stringify(raw)}, falling back to ${fallback}`);
  return fallback;
}

/** Parses greeting language: "no" for Norwegian, "en" (default) for English. */
export function greetingLang(raw: unknown): GreetingLang {
  return raw === "no" ? "no" : "en";
}

/** Sets the default instance timezone and greeting language (used at startup and by tests). */
export function setWhen(opts: { tz?: unknown; lang?: unknown; log?: (msg: string) => void }): void {
  if (opts.tz !== undefined) state.tz = validZone(opts.tz, opts.log);
  if (opts.lang !== undefined) state.lang = greetingLang(opts.lang);
}

/** Resets back to defaults (this machine's zone, "en"). */
export function resetWhen(): void {
  state = { tz: hostZone(), lang: "en" };
}

/** The configured timezone (this machine's by default). */
export function currentTz(): string {
  return state.tz;
}

/** The hour (0–23) of a time in the configured timezone, or in `tz`. */
export function hourAt(at: number, tz = currentTz()): number {
  return Number(dtf("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));
}

/** The currently configured greeting language ("en" by default). */
export function currentGreeting(): GreetingLang {
  return state.lang;
}
