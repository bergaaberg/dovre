/**
 * Dovre's state as the avatar's signals (./mood.ts): counts only, read from what the pages
 * already have (the snapshot and its needs, what the packs say works, waits and is wrong, and
 * whether one says I'm on duty, My list). Pure.
 */
import type { AvatarFeeds } from "../../registry.ts";
import type { Snapshot } from "../../../gather.ts";
import type { Need } from "../../../home/needs.ts";
import type { Signals } from "./mood.ts";

export function signalsFrom(o: { snap: Snapshot; needs: Need[]; /** What the packs tell it (src/packs/registry.ts avatarFrom): agents working and waiting, troubles, on duty. */ feeds: AvatarFeeds; doing: number; mergedToday: number; hour: number }): Signals {
  const s = o.snap;
  return {
    redBuilds: s.red.length,
    deploysWaiting: o.needs.filter((n) => n.kind === "deploy").length,
    agentsWorking: o.feeds.working,
    agentsAsking: o.feeds.asking,
    reviewsAsked: s.prs.ok ? s.prs.value.review.length : 0,
    mergedToday: o.mergedToday,
    doing: o.doing,
    hour: o.hour,
    ...(o.feeds.trouble.length ? { trouble: o.feeds.trouble } : {}),
    ...(o.feeds.onDuty ? { onCall: true } : {}),
  };
}
