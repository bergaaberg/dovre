/**
 * Timezone and greeting language settings.
 *
 * Configured via TZ_NAME and GREETING. Validated with Intl.DateTimeFormat;
 * an invalid timezone falls back to UTC with a log warning.
 */

export type GreetingLang = "en" | "no";

let state = {
  tz: "UTC",
  lang: "en" as GreetingLang,
};

/** Validates an IANA timezone name; invalid falls back to UTC with a log line. */
export function validZone(raw: unknown, log: (msg: string) => void = console.warn): string {
  if (typeof raw !== "string" || !raw.trim()) return "UTC";
  const name = raw.trim();
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return name;
  } catch {
    log(`invalid timezone ${JSON.stringify(raw)}, falling back to UTC`);
    return "UTC";
  }
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

/** Resets back to defaults ("UTC", "en"). */
export function resetWhen(): void {
  state = { tz: "UTC", lang: "en" };
}

/** The currently configured timezone (UTC by default). */
export function currentTz(): string {
  return state.tz;
}

/** The currently configured greeting language ("en" by default). */
export function currentGreeting(): GreetingLang {
  return state.lang;
}
