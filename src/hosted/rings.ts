/**
 * Rings on a hosted cockpit (#551). Locally one process remembers what it rang; hosted, each gather
 * may run in another isolate, so what each stream of needs has rung is kept in the hub (src/hosted/
 * hub.ts, POST /ring), and its notes go through the hub to the pages they're for:
 *
 * - "core": the needs in the instance's snapshot, to the pages drawn from it.
 * - "own:<email>": the needs in a person's own snapshot (#538), to their pages.
 * - "packs": the packs' needs that name no one, to every page.
 * - "packs:<email>": a pack's needs that name that person (#542), read as them, to their pages only.
 *   Only people ALLOWED_EMAILS names are read for: a need named for anyone else rings nobody.
 *
 * The policy is the cockpit's, in D1 as locally (src/notify.ts), read again before every ring and
 * before Settings shows it. Quiet hours hold what's new (it's logged, not sent); several new at
 * once go as one note when bundling is on. A page shows a note only when it may notify and
 * nobody is looking at it; with no page open, nothing rings (no Web Push).
 */
import type { D1 } from "../db.ts";
import type { Snapshot } from "../gather.ts";
import { type Need, needsOf } from "../home/needs.ts";
import { DEFAULT_POLICY, loadPolicy, type Note, noteOf, type Policy, rings, type Rung, savePolicy } from "../notify.ts";
import { quietAt } from "../quiet.ts";
import { currentViewer, viewingAs } from "../viewer.ts";
import type { HubClient } from "./client.ts";
import type { Audience, RingCall } from "./hub.ts";

/** What the mounted packs give for ringing (src/app.ts packsOf). */
export type RingPacks = { needs(): Need[]; startsOff: ReadonlySet<string>; pageOn(href: string): boolean };

/** At most this many people's named needs are read on each gather. */
const MAX_PEOPLE = 50;

/** The people a cockpit lets in, as their named needs are read for. */
export const teamOf = (allowed: string | undefined): string[] => [...new Set((allowed ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))].slice(0, MAX_PEOPLE);

export function hostedRings(o: { db: D1; hub: Pick<HubClient, "ring" | "notes" | "rung">; team: string[]; tz: () => string; now?: () => number }) {
  const now = o.now ?? Date.now;
  let policy: Policy = DEFAULT_POLICY;
  let log: Rung[] = [];
  let packs: RingPacks | undefined;
  const reload = async () => {
    policy = await loadPolicy(o.db).catch(() => policy);
  };
  /** A pack's needs read as `who` (none: nobody's named ones), each pack that throws adding nothing. */
  const packNeeds = (who: string | undefined) => {
    try {
      return viewingAs(who, () => packs!.needs());
    } catch {
      return [];
    }
  };
  const callsOf = async (s: Snapshot, who?: string): Promise<RingCall[]> => {
    await reload();
    const held = quietAt(policy.quiet, now(), o.tz());
    const bundle = policy.bundleSec > 0;
    const startsOff = packs?.startsOff;
    const call = (stream: string, to: Audience | undefined, needs: Need[]): RingCall => ({
      stream,
      ...to,
      keys: needs.map((n) => n.key),
      notes: needs.filter((n) => rings(policy, n.ring, startsOff)).map((n) => ({ ...noteOf(n), key: n.key })),
      ...(held ? { held } : {}),
      ...(bundle ? { bundle } : {}),
    });
    const core = needsOf(s, { deploys: packs?.pageOn("/deploys") ?? true });
    if (who) return [call(`own:${who}`, { for: who }, core)];
    const out = [call("core", { shared: true }, core)];
    // Before the packs are mounted, their streams wait: an empty one would say nothing's there.
    if (packs) {
      out.push(call("packs", undefined, packNeeds(undefined).filter((n) => !n.person)));
      for (const p of o.team) out.push(call(`packs:${p}`, { for: p }, packNeeds(p).filter((n) => n.person === p)));
    }
    return out;
  };
  /** Whom a ring made in this request is for: its viewer, or (the cron, nobody's) everyone. */
  const here = (): Audience | undefined => {
    const who = currentViewer();
    return who ? { for: who } : undefined;
  };
  return {
    /** The policy as saved, for an isolate that's starting. */
    load: reload,
    /** Once the app is built. */
    mount(p: RingPacks) {
      packs = p;
    },
    /** A gather finished: the instance's, or `who`'s own. What's new in it rings. */
    gathered(s: Snapshot, who?: string) {
      o.hub.ring(callsOf(s, who).catch((e) => (console.error(`rings: ${(e as Error)?.message ?? e}`), [])));
    },
    /** The app's `notify` (Settings → Notifications, a pack's ring). */
    notify: {
      policy: () => policy,
      async setPolicy(p: Policy) {
        policy = p;
        await savePolicy(o.db, p);
      },
      log: () => log,
      test() {
        o.hub.notes([{ title: "Dovre notifications work", body: "This is how something that needs you will look.", url: "/settings", tag: "test", kind: "test" }], here());
      },
      ring(notes: Note[]) {
        if (quietAt(policy.quiet, now(), o.tz())) return;
        o.hub.notes(notes, here());
      },
      /** The policy as saved (another isolate may have changed it), and what rang lately. */
      async fresh() {
        await reload();
        log = await o.hub.rung().catch(() => log);
      },
    },
  };
}
