/**
 * What's moving: everything going on, newest first, as one log for the panel docked at the right of
 * Today. People's work in the org (bots only when they release) and deploys waiting for prod here;
 * the packs' events (agents among them) through packFeedOf. Pure: the snapshot in, events out.
 * Each event has a key that stays the same while it's the same event, so the page can tell what's new.
 */
import type { Snapshot } from "../gather.ts";

export type FeedTone = "ok" | "warn" | "bad" | "acc" | "mute";
export type FeedEvent = {
  key: string;
  at: number;
  tone: FeedTone;
  /** Who did it: a login, "Agent", or "You". */
  who: string;
  /** What they did, in a few words ("merged", "waits for prod approval"). */
  what: string;
  /** What it was about (a PR's title, a session's title), shown as a link when there's an href. */
  title?: string;
  href?: string;
  repo?: string;
  /** I did it (my own moves are quieter: I know about them). */
  mine?: boolean;
};

const DAY = 24 * 3600e3;

function moveTone(verb: string): FeedTone {
  if (verb === "merged" || verb === "released") return "ok";
  if (verb.startsWith("reviewed")) return verb.includes("changes") ? "bad" : verb.includes("approved") ? "ok" : "acc";
  if (verb === "opened" || verb === "reopened" || verb === "ready_for_review") return "acc";
  return "mute";
}

export function feedOf(s: Pick<Snapshot, "moves" | "deploys" | "login">, now: number, max = 60): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const m of s.moves.ok ? s.moves.value : []) {
    if (m.bot && m.verb !== "released") continue;
    const at = Date.parse(m.at);
    out.push({ key: `m:${m.at}:${m.actor}:${m.type}:${m.url}`, at, tone: moveTone(m.verb), who: m.actor.replace(/\[bot\]$/, ""), what: m.verb.replace(/_/g, " "), title: m.title, href: m.url, repo: m.repo, mine: m.actor === s.login });
  }
  for (const d of s.deploys.ok ? s.deploys.value : []) {
    out.push({ key: `d:${d.repo}:${d.id}`, at: Date.parse(d.createdAt), tone: "warn", who: d.actor, what: `waits for ${d.envs.map((e) => e.name).join(", ") || "prod"} approval`, title: d.title, href: "/deploys", repo: d.repo, mine: d.actor === s.login });
  }
  return out
    .filter((e) => Number.isFinite(e.at) && e.at > 0 && now - e.at < DAY)
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

const TONES: readonly FeedTone[] = ["ok", "warn", "bad", "acc", "mute"];
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * The packs' events (FeedItem, src/packs/types.ts) as the feed's: who did it is the pack's `who`,
 * else the app (or the pack),
 * keys are the pack's own under its id, and anything malformed is left out rather than drawn.
 * `windowMs`: how far back (a personal app is quiet; a week says more than a day).
 */
export function packFeedOf(items: { pack: { id: string; name: string }; item: unknown }[], now: number, windowMs = 7 * DAY, max = 60): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const { pack, item } of items) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const key = text(i.key, 200);
    const what = text(i.what, 120);
    const at = typeof i.at === "number" ? i.at : NaN;
    if (!key || !what || !Number.isFinite(at) || at <= 0 || at > now + 60_000 || now - at >= windowMs) continue;
    out.push({
      key: `c:${pack.id}:${key}`,
      at,
      tone: TONES.includes(i.tone as FeedTone) ? (i.tone as FeedTone) : "mute",
      who: text(i.who, 60) ?? text(i.app, 60) ?? pack.name,
      what,
      title: text(i.title, 200),
      href: text(i.href, 2000),
      repo: text(i.repo, 200),
      mine: i.mine === true,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

/** The org's events and the packs' together, newest first. */
export function mergeFeeds(a: FeedEvent[], b: FeedEvent[], max = 60): FeedEvent[] {
  return [...a, ...b].sort((x, y) => y.at - x.at).slice(0, max);
}
