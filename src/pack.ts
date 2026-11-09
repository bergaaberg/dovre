/**
 * The pack SDK (#473): what a pack imports from core, as `dovre/pack.ts`. This file is the
 * contract. What it exports is what `PACK_API` versions: a name added here is a minor, one taken
 * away or changed is a major (`test/sdk.test.ts` holds the list). Any other path under `dovre/…`
 * may move without notice.
 *
 * A flat barrel: nothing is defined here but `Pulse`, which is both a contract type and a kit part.
 * A pack's tests also get `dovre/pack-testing.ts`.
 */
import type { Pulse as PulseState } from "./packs/types.ts";
import { Pulse as PulseChart } from "./ui/kit.ts";
import { ago, bytes, count, duration, hourOf, percent, since, stamp, when } from "./format.ts";
import { columns } from "./ui/chart.ts";
import { shortDay } from "./ui/charts.ts";

/** The contract: `Pack`, `PackContext`, `PACK_API` and every type they name. */
export * from "./packs/types.ts";
/** The kit: every page and card is built from these, and `html` escapes what goes in. */
export * from "./ui/kit.ts";
/** Acts for Bino that check, confirm and log before they write. */
export * from "./packs/acts.ts";
/** Links and small parts: every `href` built from data goes through `safeUrl`. */
export { Ago, failed, Link, safeUrl, trunc } from "./pages/parts.ts";
/** Core's Markdown, as inert HTML. */
export { markdown } from "./ui/markdown.ts";

// ── API 1.27 (#474): what packs reached into core for, by its own name ──

/** What a pack's routes and its `ctx.db` are typed with. */
export type { App, AppEnv } from "./env.ts";
export type { D1, D1Statement } from "./db.ts";
/** What's gathered (`ctx.snapshot()`), and what it says needs me. `needsOf` is pure. */
export type { Snapshot } from "./gather.ts";
export { type Need, needsOf } from "./home/needs.ts";
/** The forge contract: what a pack that brings a forge (`manifest.forge`) implements, and what a forge hands out. */
export type { Changelog, Deploy, Forge, ForgeCan, ForgeDecl, ForgeWork, Issue, IssueSets, Move, Note, Pr, PrRef } from "./forge/types.ts";
export type { EveryRepo } from "./sources/files.ts";
/** What `ctx.forge().propose` takes and answers. */
export type { PackProposal, Proposal, Proposed } from "./actions/propose.ts";
/** The guard for a pack's routes that run things as me: every write says it comes from this app's own origin. */
export { strictOrigin } from "./strict.ts";
/** Slow loads by key, each answered within a budget, and what the page shows meanwhile. */
export { later, Reading } from "./pages/later.ts";
/** The keys the `ai.summary` slot is asked by. */
export { deploySummaryKey, prSummaryKey } from "./gather.ts";
/** Pure helpers: moves per person, a PR's "in N files", the hour in my time zone, a short content hash, at most one call per `ms`. */
export { byPerson, inFiles } from "./sources/ghe.ts";
export { hourAt } from "./when.ts";
export { hashOf } from "./ui/style.ts";
export { throttle } from "./live.ts";

/** The kit's requests-and-errors chart; as a type, what the header's pulse shows (`PulseFeed` is what a pack reports). */
export const Pulse = PulseChart;
export type Pulse = PulseState;

/**
 * API 1.29 (#474): core's formatters for numbers and times, under one name so plain words like
 * `count` and `when` don't each become a name of the contract's top level. Times are in my zone
 * (`shortDay`, 1.30, reads a UTC day: «2026-10-07» → «7 Oct»).
 * `const { count, percent } = format;` reads as before.
 */
export const format = { ago, bytes, count, duration, hourOf, percent, shortDay, since, stamp, when };

// ── API 1.30 (#474): the charts, a budget for a slow call, and three types packs name ──

/** Server-rendered SVG charts, each with its table: no script, the categorical slots for more than one series. */
export { ColumnChart, FunnelDiagram, HBars, Heatmap, SankeyChart, StackedBar } from "./ui/charts.view.ts";
/** The series charts with tips and a legend, under one name like `format`: `chart.columns` (side by side or stacked). */
export const chart = { columns };
/** `run`'s answer within `ms`, or why not (it threw, or took longer): `{ ok, value }` or `{ ok: false, why }`. */
export { within } from "./packs/registry.ts";
/** A kit icon's name, a value `ctx.db` binds, and what `pack.pages` lists for search. */
export type { IconName } from "./ui/icons.ts";
export type { D1Value } from "./db.ts";
export type { Page } from "./search/search.ts";
