/**
 * What createApp (src/app.ts) shares with its route modules (src/routes/): the app's state and
 * helpers, made once in createApp. Each module takes the part it uses (`Pick<AppScope, …>`).
 */
import type { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import type { Env } from "../env.ts";
import type { Snapshot } from "../gather.ts";
import type { Frame } from "../html.ts";
import type { keyPrefsStore } from "../keys.ts";
import type { LayoutStore } from "../layout.ts";
import type { OnboardingStore } from "../onboarding.ts";
import type { Off, refresher, Refreshes, ringsOf, statsFrom } from "../packs/registry.ts";
import type { createReleases, GetJson } from "../packs/releases.ts";
import type { onboardOf } from "../packs/suggest.ts";
import type { Pack, PackContext, TodayCard } from "../packs/types.ts";
import type { Asks } from "../relay/asks.ts";
import type { Ghe } from "../sources/ghe.ts";
import type { Speed } from "../speed.ts";
import type { writeClicksStore } from "../writes.ts";

type AppDeps = Parameters<typeof createApp>[1];
type Onboard = NonNullable<ReturnType<typeof onboardOf>>;

export type AppScope = {
  env: Env;
  deps: AppDeps;
  hosted: boolean;
  /** The packs: those on, those off and why, and their settings. */
  packs: Omit<NonNullable<AppDeps["packs"]>, "env" | "on" | "off"> & { env: Record<string, string | undefined>; on: Pack[]; off: Off[] };
  ctxOf(c: Pack): PackContext;
  packLog(id: string): (line: string) => void;
  /** The packs on and not hidden here. */
  shown(): Pack[];
  layout: LayoutStore;
  onboarding: OnboardingStore;
  /** The snapshot and frame a page is drawn with. */
  page(o?: { wait?: boolean; path?: string }): Promise<{ s: Snapshot; frame: Frame }>;
  noStore(res: Response): Response;
  /** Keeps Settings' config; true when Dovre starts again with it. */
  keep(config: Config): Promise<boolean>;
  /** When the server that's starting again started, while it is. */
  restarting(): number | undefined;
  /** A pack's own setup page, when it draws one. */
  setupOf(c: Pack): Onboard | undefined;
  /** The steps of a pack's setup not done yet. */
  setupLeft(c: Pack): Onboard["steps"];
  /** MCP servers' questions waiting for an answer here. */
  asks: Asks;
  /** Page speed's counts. */
  speed: Speed;
  /** Local: data/perf.log. */
  perfLog(line: string): void;
  ghe: Ghe;
  forge: NonNullable<AppDeps["forge"]>;
  /** Local, PUBLIC_ORIGIN when set. */
  publicOrigin: string | undefined;
  /** Each pack's refreshes lately (the Packs page). */
  refreshes: Refreshes;
  /** Which writes ask twice (Settings → Writes). */
  clicks: ReturnType<typeof writeClicksStore>;
  /** Keyboard shortcuts (Settings → Keys). */
  keyPrefs: ReturnType<typeof keyPrefsStore>;
  /** Local: opens a link in the default browser. */
  openUrl: AppDeps["openUrl"];
  /** The packs switched off on the Packs page, or off because one they require is. */
  held(): Map<string, string>;
  hidden(id: string): boolean;
  /** Every pack id this instance lists, on or off, Dovre's own too. */
  packIds(): string[];
  packCards(): Promise<{ cards: TodayCard[]; failed: Off[] }>;
  packRings: ReturnType<typeof ringsOf>;
  packStats(): ReturnType<typeof statsFrom>;
  runPackRefresh: ReturnType<typeof refresher>;
  /** Hosted: the instance repo Add opens its PR on. */
  instanceRepo(): string | null;
  /** Hosted Adds started in this isolate and not logged yet. */
  opening: Set<string>;
  /** Hosted: dovre-packs' releases. */
  releases: ReturnType<typeof createReleases> | undefined;
  packsGet: GetJson;
};
