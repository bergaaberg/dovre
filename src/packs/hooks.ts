/**
 * Every hook a pack can have, as one table (#481): what the Packs page calls it, where it lands
 * (its row in docs/ARCHITECTURE.md's hooks table), how core calls it, and core's side of the call.
 * `hooksOf` reads its labels from here; test/hooks.test.ts holds the table to the `Pack` type and
 * to the doc, and runs one test over every hook that has a `from`.
 *
 * Hidden packs (Settings → Layout) are skipped for every hook: callers pass `shown()` packs.
 */
import { actsFrom, bannersFrom, BEFORE_PAGE_MS, beforePages, briefingFrom, docksFrom, fillOf, linkedFrom, LOOKUP_MS, lookupsFrom, needsFrom, pulseFrom, settingsFrom, statsFrom, TODAY_MS, todayCards } from "./registry.ts";
import type { Pack, PackContext } from "./types.ts";

/**
 * How core calls a hook.
 * - `memory`: on a page's way out, so it answers from what the pack already has.
 * - `ms`: it may wait, this long at most (`all`: for every pack together, not each).
 * - `special`: its own caller with its own rules (routes, setup, the lifecycle, outside callers), or read once at load.
 */
export type HookCall = "memory" | { ms: number; all?: boolean } | "special";

/** Core's side of a hook for these packs, with plain arguments: isolated, the answer checked, failures logged. */
export type HookFrom = (on: Pack[], ctxOf: (c: Pack) => PackContext, log: (id: string, line: string) => void) => unknown;

export type Hook = {
  name: keyof Pack;
  /** What a pack with it "answers" on the Packs page; hooks with one label show once. None: not listed there. */
  label?: string;
  /** Its row in ARCHITECTURE's hooks table. */
  where: string;
  call: HookCall;
  /** Called only locally, or only hosted. */
  only?: "local" | "hosted";
  /** Its `…From` in registry.ts. None: `special`, or still called inline (src/app.ts). */
  from?: HookFrom;
};

const briefing: HookFrom = (on, ctxOf, log) => briefingFrom(on, ctxOf, log);

/** In the order the Packs page lists what a pack answers. */
export const HOOKS: Hook[] = [
  { name: "routes", label: "pages", where: "Own pages", call: "special" },
  { name: "nav", label: "menu", where: "Own pages", call: "memory" },
  { name: "today", label: "Today cards", where: "Today", call: { ms: TODAY_MS, all: true }, from: (on, ctxOf, log) => todayCards(on, ctxOf, TODAY_MS, log) },
  { name: "glance", label: "Today's briefing", where: "Today", call: "memory", from: briefing },
  { name: "brief", label: "Today's briefing", where: "Today", call: "memory", from: briefing },
  { name: "lane", label: "Today's briefing", where: "Today", call: "memory", from: briefing },
  { name: "feed", label: "feed", where: "Today", call: "memory" },
  { name: "finds", label: "search", where: "Search", call: "memory" },
  { name: "pages", label: "search", where: "Search", call: "memory" },
  { name: "refs", label: "links", where: "Links", call: "memory" },
  { name: "linked", label: "links", where: "Links", call: "memory", from: (on, ctxOf, log) => linkedFrom(on, ctxOf, log) },
  { name: "bino", label: "Bino", where: "Bino", call: "memory" },
  { name: "about", label: "Bino", where: "Bino", call: { ms: 2000 } },
  { name: "slots", label: "core pages", where: "Core pages", call: "memory", from: (on, ctxOf, log) => fillOf(() => on, ctxOf, log)("pr.lead", { repo: "acme/app", number: 1, branch: "b", title: "t", url: "https://example.dev/1" }) },
  { name: "acts", label: "Bino's proposals", where: "Bino", call: "memory", only: "local", from: (on, ctxOf, log) => actsFrom(on, ctxOf, log) },
  { name: "settings", label: "Settings", where: "Settings", call: "memory", from: (on, ctxOf, log) => settingsFrom(on, ctxOf, log) },
  { name: "needs", label: "needs", where: "Attention", call: "memory", from: (on, ctxOf, log) => needsFrom(on, ctxOf, [], log) },
  { name: "banner", label: "bar", where: "Attention", call: "memory", from: (on, ctxOf, log) => bannersFrom(on, ctxOf, "/", log) },
  { name: "dock", label: "dock", where: "Attention", call: "memory", from: (on, ctxOf, log) => docksFrom(on, ctxOf, log) },
  { name: "callback", label: "sign-in return", where: "Outside callers", call: "special" },
  { name: "ingest", label: "ingest", where: "Outside callers", call: "special" },
  { name: "pulse", label: "pulse", where: "Pulse", call: "memory", from: (on, ctxOf, log) => pulseFrom(on, ctxOf, log) },
  { name: "refresh", label: "refresh", where: "Lifecycle", call: "special" },
  { name: "beforePage", label: "refresh", where: "Lifecycle", call: { ms: BEFORE_PAGE_MS, all: true }, from: (on, ctxOf, log) => beforePages(on, ctxOf, log) },
  { name: "scheduled", label: "cron", where: "Outside callers", call: "special", only: "hosted" },
  { name: "email", label: "mail", where: "Outside callers", call: "special", only: "hosted" },
  { name: "forge", label: "forge", where: "Forge", call: "special" },
  // Not listed on the Packs page.
  { name: "manifest", where: "Declared", call: "special" },
  { name: "writes", where: "Declared", call: "special" },
  { name: "shares", where: "Declared", call: "memory" },
  { name: "styles", where: "Own pages", call: "special" },
  { name: "script", where: "Own pages", call: "special" },
  { name: "wasm", where: "Own pages", call: "special" },
  { name: "files", where: "Own pages", call: "special" },
  { name: "stats", where: "Stats", call: "memory", from: (on, ctxOf, log) => statsFrom(on, ctxOf, 4, log) },
  { name: "lookups", where: "Bino", call: { ms: LOOKUP_MS }, from: (on, ctxOf, log) => lookupsFrom(on, ctxOf, log) },
  { name: "frames", where: "Framing", call: "memory" },
  { name: "setup", where: "Setup", call: "special" },
  { name: "available", where: "Lifecycle", call: "special" },
  { name: "migrations", where: "Lifecycle", call: "special" },
  { name: "init", where: "Lifecycle", call: "special" },
  { name: "dispose", where: "Lifecycle", call: "special" },
  { name: "tools", where: "Outside callers", call: "special" },
];

/** What a pack answers, in words, for the Packs page. */
export function hooksOf(c: Pack): string[] {
  return [...new Set(HOOKS.filter((h) => h.label && c[h.name]).map((h) => h.label!))];
}
