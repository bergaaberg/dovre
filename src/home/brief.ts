/**
 * The briefing at the top of Today: a greeting by the hour, the date line, one or two
 * sentences on what needs me (the packs add theirs), and two numbers for the last 24 hours (the
 * packs add theirs). Pure: snapshot in, parts out.
 */
import type { Bit } from "../packs/types.ts";
import type { Snapshot } from "../gather.ts";

import { currentGreeting, currentTz, type GreetingLang } from "../when.ts";

export type GreetingOpts = { tz?: string; lang?: GreetingLang };
export type { Bit };

const DAY = 86400e3;
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const word = (n: number) => (n < WORDS.length ? WORDS[n]! : String(n));
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function greeting(at: number, opts: GreetingOpts = {}): string {
  const tz = opts.tz ?? currentTz();
  const lang = opts.lang ?? currentGreeting();
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));
  if (lang === "no") {
    if (h < 5) return "God natt";
    if (h < 10) return "God morgen";
    if (h < 17) return "God dag";
    if (h < 23) return "God kveld";
    return "God natt";
  }
  if (h < 5) return "Good night";
  if (h < 10) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 23) return "Good evening";
  return "Good night";
}

/** "Thursday 22 October · Week 43 · 09:42" */
export function eyebrow(at: number, tz: string = currentTz()): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(at).replace(",", "");
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);
  return `${day} · Week ${isoWeek(at, tz)} · ${time}`;
}

export function isoWeek(at: number, tz: string = currentTz()): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at).split("-").map(Number);
  const d = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - jan1.getTime()) / DAY + 1) / 7);
}

/**
 * What needs me, as sentences made of bits: deploys waiting, then what the packs say (`briefs`,
 * one sentence each), then red builds. Empty days say so.
 */
export function lede(s: Snapshot, briefs: Bit[][] = []): Bit[][] {
  const deploys = s.deploys.ok ? s.deploys.value.filter((d) => {
    const log = s.changelogs.get(d.id);
    return !(log?.ok && log.value.prodSha && !log.value.changes.length);
  }) : [];
  const red = s.prs.ok ? s.prs.value.mine.filter((p) => p.checks === "FAILURE" || p.checks === "ERROR") : [];
  const reviews = s.prs.ok ? s.prs.value.review.length : 0;
  const sentences: Bit[][] = [];

  if (deploys.length) sentences.push([{ text: `${word(deploys.length)} ${deploys.length === 1 ? "deploy" : "deploys"}`, href: "/#ship", tone: "warn" }, ` ${deploys.length === 1 ? "waits" : "wait"} for your approval.`]);
  for (const b of briefs) if (b.length) sentences.push([...b]);

  const second: Bit[] = [];
  // A branch with several failing workflows is named once.
  const branches = [...new Map(s.red.map((r) => [`${r.repo} ${r.branch}`, r])).values()];
  if (branches.length) {
    second.push(branches.length === 1 ? "The build is red on " : "Builds are red on ");
    branches.slice(0, 3).forEach((r, i) => second.push(i ? (i === Math.min(3, branches.length) - 1 ? " and " : ", ") : "", { text: `${r.repo.split("/").pop()} ${r.branch}`, href: r.url, tone: "bad" }));
    second.push(".");
  }
  if (red.length) second.push(second.length ? " " : "", { text: `${cap(word(red.length))} ${red.length === 1 ? "PR" : "PRs"}`, href: "/#prs", tone: "bad" }, ` ${red.length === 1 ? "has a" : "have"} red ${red.length === 1 ? "build" : "builds"}.`);
  if (second.length) sentences.push(second);

  if (!sentences.length) sentences.push(["Nothing needs you."]);
  sentences.push(reviews ? [{ text: `${cap(word(reviews))} ${reviews === 1 ? "review waits" : "reviews wait"}`, href: "/prs" }, " on you."] : ["No reviews waiting."]);
  // Each sentence starts with a capital, even when it starts with a link.
  for (const sentence of sentences) {
    const i = sentence.findIndex((b) => (typeof b === "string" ? b.length > 0 : true));
    const b = sentence[i];
    if (typeof b === "string") sentence[i] = cap(b);
    else if (b) sentence[i] = { ...b, text: cap(b.text) };
  }
  return sentences;
}

/** The core's two numbers beside the greeting (the packs add theirs). */
export function glance(s: Snapshot) {
  const moves = s.moves.ok ? s.moves.value : [];
  return {
    merged: moves.filter((m) => m.verb === "merged").length,
    released: moves.filter((m) => m.verb === "released").length,
  };
}
