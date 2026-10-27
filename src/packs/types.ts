/**
 * Dovre Packs (PLAN D15, D22, D23): every app Dovre works with beyond the core comes as a pack,
 * kept in the instance's own packs repo and listed in that machine's config (PACKS). Core never
 * names a pack. A pack imports core as `dovre/…` (a pnpm `link:` to this checkout) and gets
 * everything that belongs to the running instance through its context.
 */
import type { Context, Hono } from "hono";
import type { D1 } from "../db.ts";
import type { AppEnv } from "../env.ts";
import type { Snapshot } from "../gather.ts";
import type { ForgeDecl, ForgeWork } from "../forge/types.ts";
import type { NavItem } from "../html.ts";
import type { Page } from "../search/search.ts";
import type { Session } from "../sources/claude.ts";
import type { Html } from "../ui/kit.ts";
import type { Answer } from "../relay/asks.ts";

/** The contract's version: a pack built for another is off, saying so. Bump on a breaking change. */
export const PACK_API = 1;

/** "fun": for the fun of it, nothing Dovre needs (the avatar); the Packs page lists them apart. */
export type PackDomain = "general" | "personal" | "work" | "fun";
/**
 * Where it can run: "local-only" needs this machine (CLIs, files), "hosted-only" needs the
 * Worker's bindings (service bindings, D1, R2, email), "any" runs in both.
 */
export type ExecutionAffinity = "any" | "local-only" | "hosted-only";

/** A setting the pack reads from the instance's config (.dev.vars locally, wrangler vars/secrets hosted). */
export type PackSetting = { key: string; label: string; secret?: boolean; required?: boolean; help?: string };

export type PackManifest = {
  /** The PACK_API it was written for. */
  api: number;
  /** Unique id: lowercase, used for its routes' prefix check, its styles' path and PACK_<ID>=off. */
  id: string;
  name: string;
  description: string;
  domain: PackDomain;
  execution?: ExecutionAffinity;
  /** CLIs it needs on PATH (local). */
  requiredBinaries?: string[];
  /** Worker bindings it needs (hosted): without them it's off. */
  requiredBindings?: string[];
  settings?: PackSetting[];
  /** How often the core calls refresh() (default 5 min): an interval locally, cron and stale pages hosted. */
  everyMs?: number;
  /**
   * The cron triggers its scheduled() acts on (hosted), as wrangler writes them ("0 5 * * *"). The
   * instance's wrangler config lists the triggers; this says which are this pack's, for the Packs page.
   */
  crons?: string[];
  /**
   * Top-level paths it owns besides /<id> (agents: "worktrees"), each a lowercase word. One that's a
   * core path or another pack's keeps the pack off, as a route outside them does.
   */
  paths?: string[];
  /**
   * Kinds of notification its needs ring as (`PackNeed.ring`), each a line on Settings → Notifications
   * that I can switch off. A kind is this Dovre's alone: one the core or another pack has is refused.
   */
  rings?: RingDecl[];
  /**
   * What its pages show never reaches Bino: asked from one, Bino hears only the pack's name (chats,
   * mail, query results). Its `about` isn't asked.
   */
  private?: boolean;
};

/** A kind of notification: its id (lowercase), and how Settings says it. On unless I switch it off. */
export type RingDecl = { kind: string; label: string; hint?: string };

/**
 * Something in this app that needs me now, from memory: a row in what needs me, and with `ring`, a
 * notification the first time its key is seen. `key` stays the same while it's in the same state.
 * `title` says it whole ("Agent in shop needs your OK: Bash(npm test)"): a notification shows it as it is.
 */
/** How a stat's numbers read: a count (default), money in dollars, hours, days or a percentage. */
export type StatUnit = "count" | "money" | "hours" | "days" | "percent";

/**
 * A panel on /stats, from memory (`Pack.stats`): either a chart over time (`labels` along the
 * bottom, one or two `series` with a value per label) or one headline number (`value`, with a note
 * and a trend). Its `id` is the pack's own; Settings → Layout shows or hides it and sets
 * its order. Nothing to show yet: leave out the values and say what to connect in `empty`.
 */
export type PackStat = {
  id: string;
  title: string;
  /** A few words beside the title ("median, by week"). */
  meta?: string;
  unit?: StatUnit;
  /** What to connect or wait for when there's nothing to draw. */
  empty?: string;
} & (
  | { /** Default "columns". */ chart?: "columns" | "lines"; /** Stack the two series (columns only). */ stacked?: boolean; labels: string[]; /** One tip per label, for hover and the table (default: the label). */ tips?: string[]; series: { name: string; values: (number | null | undefined)[] }[] }
  | { value: number | null | undefined; note?: string; trend?: (number | null | undefined)[] }
);

export type PackNeed = {
  key: string;
  title: string;
  line?: string;
  /** A path on this app or an http(s) link (it goes through safeUrl). */
  href: string;
  tone: "bad" | "warn" | "accent" | "ok" | "neutral";
  /** 0 drop everything … 4 when there's time; default 2. */
  rank?: number;
  at: number;
  /** One of this pack's manifest rings; any other is dropped. */
  ring?: string;
  /** Its label in a list (default the pack's name). */
  label?: string;
};

export type TodayCard = {
  id: string;
  column?: "left" | "right";
  order?: number;
  render: Html;
};

/**
 * Something that happened in one of my apps, for Today's feed (What's happening): a signup, a
 * deploy, a mail in. `key` stays the same while it's the same event (the page marks new ones);
 * `href` is a path on this app or an http(s) link (it goes through safeUrl).
 */
export type FeedItem = {
  key: string;
  at: number;
  tone: "ok" | "warn" | "bad" | "acc" | "mute";
  /** What happened, in a few words ("signed up", "deployed", "mail from"). */
  what: string;
  /** What it was about (a name, a subject), shown as a link when there's an href. */
  title?: string;
  href?: string;
  /** The app it happened in, when the pack covers several (health, inbox). */
  app?: string;
  /** Who did it, when that's more to the point than the app ("Agent", "You"). */
  who?: string;
  /** The repo it was in. */
  repo?: string;
  /** I did it (quieter in the feed: I know about it). */
  mine?: boolean;
};

/** A number beside Today's greeting ("Agents live 3"). */
export type Glance = { label: string; value: string | number };

/** A piece of Today's opening line: text, or a link with the status it points at (a `code` bit is a command). */
export type Bit = string | { text: string; href: string; tone?: "bad" | "warn"; code?: string };

/** A row on Today's horizon (the last 24 hours): marks at times, sized, a live one at the right edge. */
export type Lane = { label: string; /** Its line in the horizon's legend ("Agent session, by cost"). */ legend?: string; marks: { at: number; /** 2–9; default 3. */ size?: number; live?: boolean; title: string }[] };

/**
 * A row for Ctrl K search, from memory: something in this app a person might look for. `kind`
 * puts it in one of search's own groups (and its prefix: a: agents, w: code, >: actions, the "Do"
 * group of things to start); otherwise it's under "In your apps", named after the pack.
 */
export type FindItem = { title: string; sub?: string; href: string; also?: string[]; kind?: "agents" | "code" | "actions"; icon?: string };

/**
 * What this app's references look like in text, and where one points: a ticket key `DEV-12`, say.
 * My list and what a deploy ships link them. `pattern` is matched as it is (made global);
 * `href` gets the matched text.
 */
export type RefRule = { pattern: RegExp; href(match: string): string };


export type PageOpts = { title: string; body: Html | string; current?: string; head?: Html | string };
/** The PR the "pr.*" slots are drawn on: which repo, and which PR of it (a pack can link a ticket named in its branch or title). */
export type PrSlotArg = { repo: string; number: number; branch: string; title: string; url: string };

/**
 * Named places on core pages a pack can fill (PLAN WP-H9), each with what the page knows there
 * (`arg`) and what goes in (`out`). A pack answers from memory, never awaited; one that throws
 * fills nothing. One pack reaching another's page goes through a slot, never an import.
 */
export type SlotMap = {
  /** /agents/new with a checkout picked: a field under "Runs in" (a catalog pack: the component picker). */
  "agents.new": { arg: { repo: string }; out: Html | "" };
  /** A PR's row on /prs, beside its repo: a pill or two (a catalog pack: its repo's tier). */
  "pr.lead": { arg: PrSlotArg; out: Html | "" };
  /** A PR opened in place (the /prs list or the viewer): rows for its facts (label, value). */
  "pr.facts": { arg: PrSlotArg; out: [string, Html][] };
  /** New work (/issues/new): a panel above "What is it?". */
  "work.new": { arg: Record<string, never>; out: Html | "" };
  /** /agents, after "Started here": a panel (terminal: the terminals open here). */
  "agents.panel": { arg: Record<string, never>; out: Html | "" };
  /** A worktree's row on /worktrees: a button or two (terminal: open one in it). */
  "worktree.actions": { arg: { name: string }; out: Html | "" };
  /** An ended session in a checkout (not Dovre's own folder): a way to pick it up again (terminal: resume it here). */
  "session.resume": { arg: { session: Session }; out: Html | "" };
  /** A deploy's row on /deploys: what's in production for its repo (the version an ops pack sees running there). */
  "deploy.prod": { arg: { repo: string }; out: Html | "" };
  /** My list, above the list: items proposed from elsewhere, each to add or let go (Teams' crawler). */
  "todo.proposals": { arg: Record<string, never>; out: Html | "" };
  /**
   * What an entry on the actions log was, in words ("Sent a Teams message"), for kinds the pack
   * logged. The first pack that answers names it, cut to a line; undefined: as logged.
   */
  "actions.what": { arg: { kind: string }; out: string | undefined };
  /** Today's header, before the glance (a picture of how things are). The first pack that answers fills it. */
  "today.hero": { arg: Record<string, never>; out: Html | "" };
  /**
   * The Bino button at the bottom right (`dock`) and beside Bino's header (`mini`): what it looks
   * like instead of the word (a face, at work while Bino answers). The first pack that answers.
   */
  "bino.face": { arg: { place: "dock" | "mini"; thinking?: boolean }; out: Html | "" };
  /**
   * An entry on the actions log (Today's card and /actions): a name for what it logged by id (Teams:
   * a chat's name). The first pack that answers names it, cut to a line; undefined: not one of its.
   */
  "actions.where": { arg: { kind: string; target: string }; out: string | undefined };
  /**
   * An HTTP span on a pack's trace page (otel-sink's waterfall): a button or two (http: open it
   * in the HTTP client). Only what the trace kept: the method, the route and the allowlisted
   * attributes (URLs already without their query). Never a header or a body.
   */
  "span.actions": { arg: SpanSlotArg; out: Html | "" };
};
/** An HTTP span as the "span.actions" slot sees it. */
export type SpanSlotArg = { service: string; kind: "server" | "client" | "other"; method: string; route: string; attrs: Record<string, string | number | boolean> };
export type SlotName = keyof SlotMap;
export type Slots = { [K in SlotName]?: (arg: SlotMap[K]["arg"]) => SlotMap[K]["out"] };

export type PackContext = {
  /** The instance's settings (strings): this pack reads its own keys. */
  env: Record<string, string | undefined>;
  /** The Worker's bindings when hosted (D1, R2, service bindings, send_email…); empty locally. */
  bindings: Record<string, unknown>;
  hosted: boolean;
  /** Local: the folder the checkouts are in (CODE_DIR), read-only. Unset hosted. */
  codeDir?: string;
  /** Dovre's own database. */
  db: D1;
  /** Tell open pages these data-live regions changed (src/live.ts). Today listens to "snapshot" and each pack's id. */
  publish(topics: string[]): void;
  /** The newest gathered snapshot, if any. */
  snapshot(): Snapshot | undefined;
  /** The same for a page about to be drawn: with nothing gathered yet, it waits a moment for the first gather, as core pages do. */
  gathered(): Promise<Snapshot | undefined>;
  /** What the packs put in a named place (SlotMap) on one of this pack's own pages: its page can host others' slots too. */
  fill<K extends SlotName>(name: K, arg: SlotMap[K]["arg"]): SlotMap[K]["out"][];
  /** A page inside Dovre's shell (nav, docks, styles), for a route this pack mounts. */
  page(c: Context<AppEnv>, opts: PageOpts): Promise<Response>;
  /** A page for inside its dock (`dock`, under /<id>/dock): no menu or footer, the same styles and script. */
  dockPage(c: Context<AppEnv>, opts: Omit<PageOpts, "current">): Response | Promise<Response>;
  log(line: string): void;
  /**
   * Rings once now (a notification), for something that happened rather than something waiting
   * (`needs` are rung by key): an agent turn that ended. `kind` must be one of its manifest's
   * `rings`, and rings only while I have it on; `tag` is kept under the pack's id, so one with the
   * same tag replaces the last. Nothing happens where nothing rings (hosted, tests).
   */
  ring(note: PackNote): void;
  /**
   * Puts a question in the bar at the top of every page, as `from` asks it (an MCP server the pack
   * talks to: db asking before it opens a production database), and waits for my answer: ten
   * minutes at most, then it's `cancel`, which a careful asker reads as no. Only a person answers it,
   * in the bar: the safe choice in one click, any other behind a second. The schema is read as the
   * relay reads one (one field of named choices, or yes/no); anything else can only be declined.
   * Hosted, it's `cancel` at once.
   */
  ask(q: { from: string; message: string; schema: unknown }): Promise<Answer>;
  /** One of its questions is waiting in the bar now. */
  asking(): boolean;
  /** How things are across the shown packs now (their `pulse`), and whether Bino is answering. */
  pulse(): Pulse;
  /** The forge, to read: who I am there and in whose repos, and what it answers packs. Undefined before the first gather. */
  forge(): PackForge | undefined;
  /**
   * A picture for the starting page (the page that shows while Dovre starts): an SVG, 200 kB at
   * most, shown as an image. The newest wins. Local only; elsewhere nothing happens.
   */
  startPicture(svg: string): void;
};

/** The forge as a pack reads it (PackContext.forge): read-only, in the owners' repos. */
export type PackForge = {
  /** "github", "gitlab". */
  id: string;
  name: string;
  host: string;
  /** Who I am there. */
  login: string;
  /** Whose repos this instance follows (comma-separated). */
  owners: string;
  /** What I did since a day (YYYY-MM-DD). Absent: this forge doesn't say. */
  work?(since: string): Promise<ForgeWork>;
  /** How many of my PRs merged since a time (ISO). Absent: this forge doesn't say. */
  merged?(since: string): Promise<number>;
  /** The owners' repos that aren't archived (`owner/name`), kept a few minutes. Absent: this forge doesn't say. */
  repos?(): Promise<string[]>;
  /**
   * One file's text on a repo's default branch (a peak.yaml, say), kept a few minutes; undefined
   * when there's none. Only the owners' repos and plain relative paths: anything else throws.
   * Absent: this forge doesn't say.
   */
  file?(repo: string, path: string): Promise<string | undefined>;
};

/** A notification a pack rings (`PackContext.ring`): cut to size, its link made safe. */
export type PackNote = { kind: string; title: string; body?: string; href: string; tag: string };

/**
 * A pack's button beside Bino's at the bottom right of every page but its own (Teams: the chats).
 * Without script it's a link to /<id>; with it, it opens a panel holding the pack's /<id>/dock page
 * in a frame (drawn with `ctx.dockPage`), which keeps its place while I move between pages. `count`
 * is how many have something new; `hot` when one of them is for me (a mention).
 */
export type Dock = { label: string; count?: number; hot?: boolean; /** The count's tooltip ("3 with something new"). */ title?: string; /** A capital letter that opens and closes it from any page (Teams: T). One the page's own keys or an earlier dock has is ignored. */ key?: string };

/** A field of a pack's act, as Bino fills it in: its name (lowercase) and what goes in it, for Bino. */
export type ActField = { name: string; about: string; required?: boolean; /** Longest it may be (default 200, 4000 at most). */ max?: number; /** Several lines (a message), not one. */ text?: boolean };

/** How a pack's act went (`ActKind.run`): what the card says after, or why it didn't. */
export type ActDone = { ok: true; /** "Sent to Kari Nordmann". */ done: string; href?: string } | { ok: false; error: string };

/**
 * Something Bino may propose that this pack carries out (Teams: a message to someone). Bino acts on
 * nothing: it writes a block of kind `<pack id>.<kind>` with these fields, the core checks them
 * (unknown ones dropped, each cut to its max, a missing required one drops the block), and I see a
 * card I can change before I press it. Local only (hosted, Bino proposes nothing).
 */
export type ActKind = {
  /** A lowercase word. */
  kind: string;
  /** The card's heading ("A message in Teams"). */
  title: string;
  /** For Bino: when to propose it, a sentence or two, plain. Names and states only, like `bino`. */
  when: string;
  fields: ActField[];
  /** The card's button ("Send"). */
  button: string;
  hint?: string;
  /**
   * One click is enough. Otherwise the button asks again first (`question`, default the heading),
   * as every write to a pack's app does; Teams' send is one click by my call.
   */
  oneClick?: boolean;
  question?: string;
  /** The card's inputs, from memory: Bino's values (`act`), or what I typed when it was refused (`kept`). */
  inputs(act: Record<string, string>, kept: Record<string, string> | undefined, ctx: PackContext): Html;
  /**
   * Carries it out from what the card's form says (`form`: its fields, strings) and what Bino
   * proposed (`act`). Re-checks the state first and logs the write to the actions table, as every
   * write does. The core runs it in the background and shows how it went on the card.
   */
  run(form: Record<string, string>, act: Record<string, string>, ctx: PackContext): Promise<ActDone>;
};

/**
 * A pack's pulse, from memory: how many of its things work for me and wait on me, and what's
 * wrong, if anything (a storm, or a fire). `why` is a short line of counts ("2 red signals"),
 * never what a thing says; `href` one of its own pages. Core sums them (PackContext.pulse) for any
 * pack that shows how things are (a picture of me: busy while anything works, rain in a storm).
 */
export type PulseFeed = { working?: number; asking?: number; trouble?: { level: "storm" | "fire"; why: string; href?: string }; /** I'm on duty (an on-call rota). */ onDuty?: boolean };
/** @deprecated The old name of PulseFeed. */
export type AvatarFeed = PulseFeed;
/** The packs' pulses summed (PackContext.pulse): counts kept to 0–99, a line per trouble. */
export type Pulse = { working: number; asking: number; trouble: { level: "storm" | "fire"; why: string; href?: string }[]; /** A pack says I'm on duty. */ onDuty?: boolean; /** Something has me at work: a pack's thing working, or Bino answering. */ busy: boolean };

export type ScheduledEvent = { cron: string; scheduledTime: number };
/** A Worker's waitUntil, for work that finishes after the handler returns. */
export type Defer = (p: Promise<unknown>) => void;

/** A kind of write a pack makes: a lowercase word (dashes allowed), and what Settings calls it. */
export type PackWrite = { kind: string; label: string; floor?: "twice" };

export type Pack = {
  manifest: PackManifest;
  /**
   * A forge it brings (GitLab): used for PRs, notifications, movement and deploys instead of GitHub
   * when FORGE is its id. Picked at start, before the pack's own checks or init (src/forge/pick.ts).
   */
  forge?: ForgeDecl;
  /** Runs here? Called after the manifest's checks (bindings, binaries); default yes. */
  available?(ctx: PackContext): boolean;
  init?(ctx: PackContext): Promise<void> | void;
  /**
   * Re-reads what its pages show, into memory (or its own storage), then publishes what changed.
   * The core calls it on its schedule; pages and cards never wait for it.
   */
  refresh?(ctx: PackContext): Promise<void>;
  dispose?(): Promise<void> | void;
  /**
   * Its kinds of write to its own app (dovre#104), listed on Settings → Writes under its name. Its
   * Confirms pass `kind: "<pack id>.<kind>"`: those ask twice unless I set that kind to one click.
   * A `floor` of "twice" (deleting, ending things) always asks.
   */
  writes?: PackWrite[];
  /** CSS for its own classes, served beside the core's and linked from every page. */
  styles?: string;
  /**
   * Plain JS for its own pages and slots, served beside the core's script (CSP `script-src 'self'`)
   * and run on every page while the pack is on, in a block of its own. Like the core's, it's an
   * enhancement: what it adds works without it. It hears the core on `document`: `dovre:change`
   * (detail: what the hub said changed: topics, notes) and `dovre:swap` (detail: { from, to }, a
   * live region about to be swapped for a fresh one, so it can carry over what it shows).
   */
  script?: string;
  nav?(ctx: PackContext): NavItem[];
  /** Mounted after the core's guard (login or Access) and core routes: it can't shadow a core path. */
  routes?(app: Hono<AppEnv>, ctx: PackContext): void;
  today?(ctx: PackContext): TodayCard[] | Promise<TodayCard[]>;
  /** Pages for Ctrl K search. */
  pages?(ctx: PackContext): Page[];
  /** Things in this app for Ctrl K search ("In your apps"), from memory like nav. */
  finds?(ctx: PackContext): FindItem[];
  /** Its kinds of reference, linked wherever I write or a commit says them (My list, deploys). */
  refs?(ctx: PackContext): RefRule[];
  /** Its pulse now, from memory (agents: turns and sessions; signals: red ones): see PulseFeed. */
  pulse?(ctx: PackContext): PulseFeed | null | undefined;
  /** @deprecated The old name of `pulse`, read when a pack has no `pulse`. */
  avatar?(ctx: PackContext): PulseFeed | null | undefined;
  /**
   * PR links its pages show (URLs), from memory: the gather looks up each one's state and title
   * (Snapshot.refs), so a page can say it merged. Agents: the PRs their sessions opened.
   */
  linked?(ctx: PackContext): string[];
  /**
   * Before a page is drawn (not an event stream): bring what it shows up to date. The core waits for
   * all of them together, 1.5 s at most, then draws anyway. Hosted agents: what the Mac last said.
   */
  beforePage?(ctx: PackContext): Promise<void>;
  /** What happened lately, newest first or not, from memory (like nav): Today's feed, never awaited. */
  feed?(ctx: PackContext): FeedItem[];
  /**
   * What Bino may know about this app right now: a few plain lines from memory (like feed), never
   * awaited. States and counts ("3 open signals: …", "12 trials, 2 end this week"); never a
   * customer's words, an address, a token, or anything else that isn't mine to hand a model.
   */
  bino?(ctx: PackContext): string;
  /** What needs me in this app right now, from memory, never awaited (rung once per key; see PackNeed). */
  needs?(ctx: PackContext): PackNeed[];
  /**
   * Its panels on /stats, from memory, never awaited (see PackStat): gather on the pack's own
   * schedule in `refresh`. `weeks` is the range I picked on Settings (4, 12 or 26), for weekly
   * charts. `days` is set when I picked days instead (14 or 28): draw per day where you can, or
   * weekly over `weeks` (the weeks those days touch).
   */
  stats?(ctx: PackContext, o: { weeks: number; days?: number }): PackStat[];
  /**
   * A bar at the top of every page, above the page itself, from memory: something to answer wherever I
   * am (an agent waiting for my OK on a tool). Empty most of the time. It's redrawn with the page's
   * live regions, so what it shows can change.
   */
  banner?(ctx: PackContext, at: { path: string }): Html | "";
  /** Numbers beside Today's greeting, from memory (two at most are shown). */
  glance?(ctx: PackContext): Glance[];
  /** A sentence for Today's opening line when something here wants me, from memory; empty when not. */
  brief?(ctx: PackContext): Bit[];
  /** A row on Today's horizon, from memory. */
  lane?(ctx: PackContext): Lane | undefined;
  /**
   * What one of its pages is, for Bino when I ask from there: names and states only, like `bino`
   * (a session's title and status, never what was said). Undefined: "a page of <pack name>".
   */
  about?(ctx: PackContext, path: string): string | undefined;
  /** What Bino may propose that this pack carries out (see ActKind); local only. */
  acts?(ctx: PackContext): ActKind[];
  /**
   * Its panel on Settings, under its name, from memory: what isn't a key in the manifest's `settings`
   * (how it's signed in, the databases it may open). Its forms post to its own routes.
   */
  settings?(ctx: PackContext): Html | "";
  /** What it puts in core pages' named places (SlotMap), from memory. */
  slots?(ctx: PackContext): Slots;
  /**
   * Other sites its own pages (/<id>, /<id>/…) may show in a frame, from memory: `https://` origins
   * (a published Storybook), or this machine on a port of its own (`http://localhost:<port>`,
   * `http://127.0.0.1:<port>`: a build served apart from Dovre). Anything else is dropped; core
   * pages never frame them.
   */
  frames?(ctx: PackContext): string[];
  /** Its button beside Bino's (see Dock), from memory; undefined: none right now. Its /<id>/dock pages may be framed by Dovre's own. */
  dock?(ctx: PackContext): Dock | undefined;
  /**
   * GET /<id>/callback, answered before the sign-in check: where another site sends me back (an
   * OAuth return), so it arrives without Dovre's cookie. Local only, on this machine's own address.
   * The pack checks its own state (a one-time value it made, a few minutes old at most) and finishes
   * nothing it didn't start. `signedIn`: the request carries Dovre's cookie (this browser is Dovre's).
   */
  callback?(c: Context<AppEnv>, ctx: PackContext, at: { signedIn: boolean }): Response | Promise<Response>;
  /**
   * POST /<id>/ingest/<path>: an app sending data in (an OTLP exporter), answered before the sign-in
   * check, with an ingest token made on Settings (src/packs/ingest.ts). Core checks the token, the size
   * and the rate first; the pack gets the body and the token's source, never the token or other headers.
   * Write-only: what it answers is a status and a short body, never data it keeps.
   */
  ingest?: IngestSpec;
  /**
   * Tools for the agent turns Dovre starts (local mode, Claude Code), on core's MCP server (src/mcp.ts)
   * as `<id>_<name>`. Each call comes from a turn that's running, with that turn's own token; Claude
   * Code still asks before each tool as for any other. The tool enforces its own limits (what it may
   * reach, how much it answers): its arguments are the model's, so treat them as hostile.
   */
  tools?(ctx: PackContext): PackTool[];
  /** Hosted cron (wrangler triggers). */
  scheduled?(event: ScheduledEvent, ctx: PackContext, defer: Defer): Promise<void>;
  /** Hosted Email Routing: a message to an address routed to this Worker. Return true when handled. */
  email?(message: unknown, ctx: PackContext, defer: Defer): Promise<boolean>;
};

/** One tool a pack offers agent turns (see Pack.tools). */
export type PackTool = {
  /** Lowercase letters, digits and underscores (`send`); offered as `<pack id>_<name>`. */
  name: string;
  /** For the model: what it does and its limits, in a few sentences. */
  description: string;
  /** A JSON Schema object for its arguments. */
  input: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  /** `call`: the turn asking (its repo folder and run id). The text goes to the model: keep secrets out of it. */
  run(args: Record<string, unknown>, ctx: PackContext, call: ToolCall): Promise<ToolResult> | ToolResult;
};
export type ToolCall = { run: string; repo: string; cwd: string };
export type ToolResult = { text: string; error?: boolean };

/** What an ingest request brings the pack (see Pack.ingest). */
export type IngestInput = {
  /** The path after /<id>/ingest/ ("v1/traces"). */
  path: string;
  body: Uint8Array;
  contentType: string;
  /** "gzip" when the sender compressed it; the pack decompresses (and caps what it inflates). */
  contentEncoding: string;
  /** The name the token was made for on Settings. */
  source: string;
};
export type IngestSpec = {
  /** Body cap in bytes (default 4 MB); bigger is a 413. */
  maxBytes?: number;
  /** Requests per token per minute (default 600); more is a 429. */
  perMinute?: number;
  handle(input: IngestInput, ctx: PackContext): Promise<IngestReply> | IngestReply;
};
export type IngestReply = { status: number; body?: string | Uint8Array; contentType?: string };

/** A packs module's default export: its packs, given the instance's settings. */
export type PacksModule = { default: Pack[] | ((env: Record<string, string | undefined>) => Pack[]) };
