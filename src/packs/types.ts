/**
 * Dovre Packs (PLAN D15, D22, D23): every app Dovre works with beyond the core comes as a pack,
 * kept in the instance's own packs repo and listed in that machine's config (PACKS). Core never
 * names a pack. A pack imports core as `dovre/pack.ts` (a pnpm `link:` to this checkout; the file
 * re-exports this one, the kit and a few helpers) and gets
 * everything that belongs to the running instance through its context.
 */
import type { Context, Hono } from "hono";
import type { D1 } from "../db.ts";
import type { AppEnv } from "../env.ts";
import type { Snapshot } from "../gather.ts";
import type { ForgeDecl, ForgeWork } from "../forge/types.ts";
import type { PackProposal, Proposed } from "../actions/propose.ts";
import type { NavItem } from "../html.ts";
import type { Page } from "../search/search.ts";
import type { Session } from "../sources/claude.ts";
import type { EveryRepo, ForgePr } from "../sources/files.ts";
import type { Html } from "../ui/kit.ts";
import type { Answer } from "../relay/asks.ts";
import type { ReviewDraft } from "../reviews/draft.ts";

/**
 * The contract's version, "major.minor" (#360): a breaking change bumps major (older packs are off
 * until updated), an additive one (a hook, slot, field or markup contract) bumps minor. A pack
 * needing a newer minor is off, saying so. docs/ARCHITECTURE.md lists each minor.
 */
export const PACK_API = "2.1";

/** "fun": for the fun of it, nothing Dovre needs (the avatar); the Packs page lists them apart. */
export type PackDomain = "general" | "personal" | "work" | "fun";
/**
 * Where it can run: "local-only" needs this machine (CLIs, files), "hosted-only" needs the
 * Worker's bindings (service bindings, D1, R2, email), "any" runs in both.
 */
export type ExecutionAffinity = "any" | "local-only" | "hosted-only";

/** A setting the pack reads from the instance's config (.dev.vars locally, wrangler vars/secrets hosted). */
export type PackSetting = {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
  /** The values it takes (API 1.15), shown as a picker; unset is the pack's own default. Not with `secret`. */
  choices?: { value: string; label: string }[];
  /**
   * API 1.36 (#475): its value names other settings this pack reads (`API_TOKEN@api.example.com, LOCAL_KEY`).
   * The entries are split on commas and spaces; a name is an entry up to its first `@`, `=` or `:`.
   * Those keys count as the pack's own in `ctx.env`, and the Packs page lists them. Not with `secret`.
   */
  namesKeys?: boolean;
};

export type PackManifest = {
  /** The oldest PACK_API it works with, "major.minor" ("1.5"); a plain 1 means "1.0". */
  api: string | number;
  /** Its own release, semver ("1.2.0"; API 1.6): dovre-packs tags it `<id>@1.2.0`. Shown on the Packs page. */
  version?: string;
  /** Unique id: lowercase, used for its routes' prefix check, its styles' path and PACK_<ID>=off. */
  id: string;
  name: string;
  description: string;
  domain: PackDomain;
  execution?: ExecutionAffinity;
  /** CLIs it needs on PATH (local). */
  requiredBinaries?: string[];
  /** API 1.26: programs it may run with `ctx.run` when they're on PATH (local), besides `requiredBinaries`; a missing one doesn't turn it off. Plain names, never an agent CLI. */
  binaries?: string[];
  /** Worker bindings it needs (hosted): without them it's off. They and `bindings` are all it gets in `ctx.bindings`. */
  requiredBindings?: string[];
  /** Worker bindings it reads when they're there (hosted), besides `requiredBindings`; a missing one doesn't turn it off. */
  bindings?: string[];
  /**
   * `"raw"`: it reads and writes Dovre's database through `ctx.db` with no `migrations` of its own
   * (tables it made itself before there were any, or another's). Without this line or `migrations`,
   * `ctx.db` throws when used. Its card on the Packs page says so.
   */
  db?: "raw";
  settings?: PackSetting[];
  /** How often the core calls refresh() (default 5 min): an interval locally, cron and stale pages hosted. */
  everyMs?: number;
  /**
   * What it wants to ask the model, and why (API 1.22, #466): `text` is a prompt in, text out (no
   * tools, no files). Nothing is allowed until I allow it on Settings → Packs → the pack; then
   * `ctx.complete` answers, within the size and the day's dollars I set there. `mcp` (API 1.34,
   * #488): exact calls to one MCP server through Claude Code's sign-in to it, as `ctx.mcp`.
   */
  ai?: PackAiAsk;
  /**
   * The cron triggers its scheduled() acts on (hosted), as wrangler writes them ("0 5 * * *"). The
   * instance's wrangler config lists the triggers; this says which are this pack's, for the Packs page.
   */
  crons?: string[];
  /**
   * Packs it needs, by id (#326; Auto review: ["agents"]). It's off while any of them is off,
   * missing or switched off on the Packs page, and starts and refreshes after them. It reaches
   * them only through what they share in its context, never by importing them.
   */
  requires?: string[];
  /**
   * Packs it reads when they're on (API 1.11; New work: ["todo"], for "Also put it on My list").
   * Unlike `requires`, it stays on without them: `ctx.required` answers undefined then.
   */
  uses?: string[];
  /**
   * Places on its own pages that other packs may fill (API 1.39, #477), each a lowercase name
   * ("span.actions") and what goes there, for the Packs page. Its page asks with
   * `ctx.fillOwn(name, arg)`; a pack that lists this one in `uses` or `requires` answers from
   * its `slots` under `"<this id>/<name>"`.
   */
  hosts?: { name: string; about: string }[];
  /**
   * Top-level paths it owns besides /<id> (agents: "worktrees"), each a lowercase word. One that's a
   * core path or another pack's keeps the pack off, as a route outside them does.
   */
  paths?: string[];
  /**
   * "forge" (API 1.18): it reads and writes through the instance's forge (`src/forge/`), so the
   * Packs page shows it with the others that do, under the forge's name ("GitHub").
   */
  via?: "forge";
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
  /**
   * Who it suits (API 1.14): first run suggests it to these roles outright. Roles are `dev`, `lead`,
   * `po` (product owner), `op` (operator) and `an` (analyst).
   */
  roles?: Role[];
  /**
   * Interview answers it suits (API 1.14), as `<question>:<answer>` from `INTERVIEW` in
   * src/packs/suggest.ts ("tasks:linear", "agents:many"): first run suggests it when I give one.
   */
  answers?: string[];
  /**
   * What the checkout scan looks for (API 1.14): paths inside a checkout directly under the code
   * folder, names only, never contents. A trailing `/` is a folder (".storybook/"), and a `*` in the
   * last part matches any name ("*.http"). At most 8, each at most 3 parts deep.
   */
  markers?: string[];
  /**
   * Its own setup (API 1.14), run after first run from its setup page (/setup/<id>, API 1.16, which
   * draws each step through `Pack.setup`): up to 3 steps, declared up front, so Today can say how many.
   * `required`: it doesn't work until they're done (default: it works before, and setup adds to it);
   * it reads where it stands through `ctx.setupDone()`.
   */
  onboard?: { steps: OnboardStep[]; required?: boolean };
};

/** Who a pack suits (`manifest.roles`). */
export type Role = "dev" | "lead" | "po" | "op" | "an";
/** A step of a pack's own setup: a lowercase id, and its title on the setup page. */
export type OnboardStep = { id: string; title: string };

/**
 * A step of its setup page as the pack draws it (`Pack.setup`, API 1.16). Core draws the frame
 * around `body`: the scene, "Setting up X", the title, "1 of 3", Back, the dots, Next or Done, and Later.
 * The body is kit parts only (list rows, chips, code blocks, Confirm), checked and boxed like its
 * pages, and never asks for a secret: keys are its manifest's `settings`.
 */
export type SetupStep = {
  body: Html | "";
  /**
   * The body's inputs are the step's form: Next sends them to `Pack.setup.save`. A form step holds
   * no form of its own (its markup is refused). Otherwise its writes are its own forms (a Confirm,
   * posting to its routes, which redirect back to /setup/<id>?at=<step>), and Next only moves on.
   */
  form?: boolean;
  /** Next waits, and says this: a write this step needs hasn't finished. Asked again when Next is pressed. */
  wait?: string;
  /** The step draws itself again after this many seconds (2 to 60), in place, while a job it shows runs (API 1.17; in place since 1.19). */
  refresh?: number;
  /**
   * The step's main button, in the foot where Next goes (API 1.19): a Confirm posting to one of the
   * pack's routes, which redirects back to /setup/<id>?at=<step>. Next shows once the step leaves it out.
   * `question` is plain text (it's the label with a "?" if left out); `kind` is one of the pack's `writes`, so Settings decides whether it asks twice.
   */
  go?: { action: string; label: string; question?: string; kind?: string };
  /** `go` presses itself again (API 1.19): the job it started ran out of time with work left and nothing failed. Without script, it waits for a press. */
  carry?: boolean;
};

/** A pack's setup steps (`Pack.setup`): each step drawn, and what Next on a form step saves. */
export type PackSetup = {
  /** Step `step` (one of `manifest.onboard`'s ids). It may read its app first; the page waits as for its pages. */
  draw(ctx: PackContext, step: string): SetupStep | Promise<SetupStep>;
  /** Next on a form step: its fields (strings; a ticked list is several). The pack checks and keeps them; an error stays on the step. */
  save?(ctx: PackContext, step: string, form: Record<string, string | string[]>): Promise<{ ok: true } | { ok: false; error: string }>;
};

/** A kind of notification: its id (lowercase), and how Settings says it. On unless I switch it off, or `off`: off until I switch it on. */
export type RingDecl = { kind: string; label: string; hint?: string; off?: boolean };

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
  | {
      /** Default "columns". */ chart?: "columns" | "lines";
      /** Stack the two series (columns only). */ stacked?: boolean;
      labels: string[];
      /** One tip per label, for hover and the table (default: the label). */ tips?: string[];
      series: { name: string; values: (number | null | undefined)[] }[];
      /** The last label is still going (this week so far): drawn lighter (API 1.8). */ partialLast?: boolean;
    }
  | { value: number | null | undefined; note?: string; trend?: (number | null | undefined)[] }
  /**
   * A ranked list of horizontal bars (API 1.8), longest first as given: each a `label`, an
   * optional grey `sub`, a link (a path here or http(s), through safeUrl), and a `note`. `warn`
   * marks a bar that's past where it should be.
   */
  | { bars: { label: string; sub?: string; href?: string; value: number; note?: string; warn?: boolean }[] }
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
/** A model's summary of a PR or deploy ("ai.summary" slot): written, still being written, or failed. */
/**
 * What a pack's manifest asks of the model (#466, #467). `text`: a prompt in, text out. `agent`: an
 * agent turn in one of my repos, `where` it may run (`read`: plan mode in its checkout; `sandbox`:
 * a fresh clone in a container), other packs' /mcp `tools` it would like by name (its own it gets),
 * and `lands`: the write kind (one of its `writes`) it opens a draft PR from a sandbox run under.
 */
export type PackAiAsk = { text?: { why: string }; agent?: PackAgentAsk; mcp?: PackMcpAsk };
/**
 * MCP calls a manifest asks for (API 1.34, #488): the one `server` (a plain name and its https
 * url, as Claude Code is signed in to it), the tools that only read (`reads`), and each tool that
 * changes something mapped to one of the pack's `writes` kinds (`writes`: tool → kind). Tools by
 * their bare names on the server. A tool it doesn't list can't be called.
 */
export type PackMcpAsk = { why: string; server: { name: string; url: string }; reads?: string[]; writes?: Record<string, string> };
/** Whether it may make MCP calls now, and with which tools; or not, and why. */
export type PackMcpCan = { ok: true; reads: string[]; writes: string[] } | { ok: false; why: string };
/** One call: a tool by its bare name, and exactly the arguments it's to get. */
export type PackMcpCall = { tool: string; input: Record<string, unknown> };
/**
 * A call's result: the tool's own text, as it answered; or why there's none (not made, made with
 * other arguments, or the tool failed). A result over about 45,000 characters doesn't come whole
 * (Claude Code hands on a preview): check that `text` parses as what's expected.
 */
export type PackMcpResult = { ok: true; text: string } | { ok: false; why: string };
/** On the error `call` and `write` throw when Claude Code isn't installed, or isn't signed in to the server: its `setup`. */
export type PackMcpSetup = "no-claude" | "sign-in";
export type PackMcp = {
  can(): PackMcpCan;
  /**
   * Makes these calls (1 to 20, `reads` only) in one job and hands back each one's result, in the
   * order asked, matched by tool and arguments. Throws when it isn't allowed, when today's dollars
   * are spent, and when the job itself fails (the error has `setup` when that's why).
   */
  call(calls: PackMcpCall[], opts?: { signal?: AbortSignal }): Promise<{ results: PackMcpResult[]; cost: number }>;
  /**
   * One call to a write tool, under the write `kind` its manifest maps it to. Call it only from the
   * POST of its own Confirm for that kind, after re-checking, and log it with `ctx.logged`.
   * `times`: how often the tool was called; over 1, or a result that isn't ok with `times` above 0,
   * means something may have been written: say so instead of trying again.
   */
  write(kind: string, call: PackMcpCall, opts?: { signal?: AbortSignal }): Promise<{ result: PackMcpResult; cost: number; times: number }>;
};
export type PackAgentWhere = "read" | "sandbox";
export type PackAgentAsk = { why: string; where: PackAgentWhere[]; tools?: string[]; lands?: string };
/** What it may ask now: `text` with the size and day's cap I allowed, or not, and why. */
export type PackAi = { text: true; size: "small" | "any"; dayUsd: number } | { text: false; why: string };
/** One question to the model. `size`: "small" (the default) or "large", if I allowed any. */
export type PackCompleteAsk = { system: string; user: string; size?: "small" | "large"; signal?: AbortSignal };
/** What it may start now (API 1.23): where, in which repos (`mine`: all of the owners'), the caps; or not, and why. */
export type PackAgentCan = { ok: true; where: PackAgentWhere[]; repos: "mine" | string[]; tools: string[]; runUsd: number; turns: number; minutes: number } | { ok: false; why: string };
/** One agent turn to start: in `repo` (owner/name), `where`, on the small model unless I allowed any. */
export type PackAgentStart = { repo: string; prompt: string; where: PackAgentWhere; size?: "small" | "large" };
/** A turn it started, as it stands: its final text once it has one (bounded), its cost, and a sandbox run's commits once home. */
export type PackAgentRun = {
  run: string;
  status: "running" | "done" | "failed" | "stopped";
  where: PackAgentWhere;
  repo: string;
  cost: number;
  said: string;
  /** A sandbox run that ended: commits it made (0: none), once home; `pr` once landed. */
  commits?: number;
  pr?: { number: number; url: string };
};
/**
 * A pack's agent turns (API 1.23, #467). Every one needs my OK on its Settings page, in one of
 * the repos I allowed, within the run's and day's dollars; one at a time. A turn's asks for tools
 * outside its grant are refused, as in any headless turn. Logged by cost, never the prompt or output.
 */
export type PackAgent = {
  can(): PackAgentCan;
  start(a: PackAgentStart): Promise<{ run: string } | { wait: string } | { error: string }>;
  /** One of its own turns; undefined for any other. */
  result(run: string): Promise<PackAgentRun | undefined>;
  /**
   * A sandbox run's commits as a draft PR into the default branch, logged under `<id>.<lands>`.
   * Call it only from the POST of its own Confirm for that kind. Never forced; CI config changes
   * aren't pushed.
   */
  land(run: string): Promise<{ number: number; url: string } | { error: string }>;
};

export type AiSummary = { state: "ready"; text: string } | { state: "pending" } | { state: "failed"; error: string };

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
  /** The viewer's PR, under its title (API 1.13): where it sits in a stack of PRs (the stacks pack: "2 of 3 in a stack"). */
  "pr.stack": { arg: { repo: string; number: number }; out: Html | "" };
  /** A PR's card (/prs, Today): a block under its summary (agent reviews: start one, or its report). API 1.9. */
  "pr.agent": { arg: PrSlotArg; out: Html | "" };
  /**
   * A finished agent review of someone else's PR, for my own review in the viewer to start from: the
   * commit it read and its draft. The first pack that answers; core reads the draft again. API 1.9.
   */
  "review.draft": { arg: { repo: string; number: number }; out: { sha: string; draft: ReviewDraft } | undefined };
  /**
   * A PR (at its head commit) or a deploy (prod..head), by the key core draws it under (gather.ts
   * prSummaryKey, deploySummaryKey): a model's summary of it. The first pack that answers; core
   * draws the text, escaped. API 1.10: AI summaries became the `summaries` pack (#390).
   */
  "ai.summary": { arg: { key: string }; out: AiSummary | undefined };
  /** A file on a PR's Files tab, in its header beside "Viewed": a button or two (markdown: read it rendered). `sha` is the PR's head commit. */
  "pr.file": { arg: PrSlotArg & { path: string; status: string; sha: string }; out: Html | "" };
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
};
export type SlotName = keyof SlotMap;
/** What `ctx.can` is asked about. */
export type PackCanWhat = "ask" | "ring" | "acts" | "tools" | "checkouts" | "programs" | "text" | "agent" | "mcp";
/** `ctx.can`'s answer. */
export type PackCan = { ok: true } | { ok: false; why: string };
/**
 * What a pack puts in named places: core pages' by their name in `SlotMap`, and (API 1.39) another
 * pack's by `"<host id>/<name>"`, a place that pack lists in its manifest's `hosts`. Core doesn't
 * know such a place's `arg`: it's plain data the host made (a copy), so check what you read of it.
 */
export type Slots = { [K in SlotName]?: (arg: SlotMap[K]["arg"]) => SlotMap[K]["out"] } & { [place: `${string}/${string}`]: (arg: unknown) => Html | "" };

export type PackContext = {
  /**
   * The instance's settings (strings): this pack reads its own keys (its manifest's `settings`, `PACK_<ID>`,
   * the keys a `namesKeys` setting names,
   * and `TZ_NAME`, `PORT`, `CODE_DIR`, `U_DB`). Nothing else: another key reads as unset, and asking
   * for one that is set is noted on the pack's card on the Packs page (#475). Read-only.
   */
  env: Record<string, string | undefined>;
  /**
   * The Worker's bindings when hosted (D1, R2, service bindings, send_email…); empty locally. Only
   * the ones its manifest names (`requiredBindings`, `bindings`): another reads as missing, and
   * asking for one that is there is noted on the pack's card (#484). Read-only.
   */
  bindings: Record<string, unknown>;
  hosted: boolean;
  /** Local: the folder the checkouts are in (CODE_DIR), read-only. Unset hosted. */
  codeDir?: string;
  /** The checkouts' names, git repos directly under codeDir (no symlinks). In a pack session, only its one checkout. None hosted. */
  checkouts(): string[];
  /** A checkout's folder by name, or null when it isn't one of `checkouts()` (always, hosted). */
  checkout(name: unknown): string | null;
  /**
   * Whether something works here, and why not when it doesn't: the one answer for what's local
   * only or needs my OK (#484). `ask` (the bar), `ring`, `acts` (Bino's cards), `tools` (agent
   * turns' tools), `checkouts`, `programs` (`run`, `onPath`, `dir`), and `text`, `agent`, `mcp`
   * (what `ai()`, `agent.can()` and `mcp.can()` say, without their limits). The `why` is a line for me.
   */
  can(what: PackCanWhat): PackCan;
  /** Local (API 1.26): this pack's own folder (`packs/<id>` next to the database), made when first asked for. Unset hosted. */
  dir?(): string;
  /**
   * Local (API 1.26): runs one of the programs its manifest names (`requiredBinaries`, `binaries`)
   * to the end, off the main thread. By name, found on PATH, never an agent CLI (those are
   * `ctx.agent`). `cwd` is a checkout (or a folder in one) or a folder in `dir()`, which is the
   * default. A non-zero exit is a result; a name it didn't declare, a folder elsewhere, a program
   * that isn't on PATH, a timeout and `signal` aborting all throw. Unset hosted.
   */
  run?(binary: string, args: string[], opts?: PackRunOpts): Promise<PackRan>;
  /** Local (API 1.26): whether a program its manifest names is on PATH now, to say so before it's needed. Throws like `run` on a name it didn't declare. Unset hosted. */
  onPath?(binary: string): boolean;
  /** Dovre's own database, for a pack with `migrations` (to read its own tables) or whose manifest says `db: "raw"`. For the rest (`store.kv` is theirs) every call on it throws, saying so. */
  db: D1;
  /**
   * API 1.33 (#476): this pack's own small state, kept in Dovre's database under its id: it
   * outlives a restart and, hosted, is the same in every isolate. For what doesn't warrant a table
   * (the last good answer, a job by its id).
   */
  store: PackStore;
  /**
   * API 1.25: a write this pack made, into the actions log, after the fact (`ok: false` with `error`
   * when it failed). `kind` is one word ("send"): core logs it as `<id>.<kind>`, the name its
   * `writes` go by, and adds who pressed when hosted. A log that can't be kept never fails the write.
   */
  logged(a: PackLogged): Promise<void>;
  /**
   * API 1.31: whom the current request is for, where a hook gets no request (a Today card, an act):
   * hosted, their verified email, lowercased (a route's `c.get("who")`, and in `scheduled` the
   * instance's owner). Undefined locally, and in background work that's for no one (a gather).
   * What's private to someone is shown only to them.
   */
  viewer(): string | undefined;
  /** Tell open pages these data-live regions changed (src/live.ts). Today listens to "snapshot" and each pack's id. */
  publish(topics: string[]): void;
  /** The newest gathered snapshot, if any. */
  snapshot(): Snapshot | undefined;
  /** The same for a page about to be drawn: with nothing gathered yet, it waits a moment for the first gather, as core pages do. */
  gathered(): Promise<Snapshot | undefined>;
  /** What the packs put in a named place (SlotMap) on one of this pack's own pages: its page can host others' slots too. */
  fill<K extends SlotName>(name: K, arg: SlotMap[K]["arg"]): SlotMap[K]["out"][];
  /**
   * API 1.39 (#477): what other packs put in a place of this pack's own (one its manifest lists in
   * `hosts`), from memory. `arg` is plain data (each pack gets a copy); only shown packs that list
   * this one in `uses` or `requires` are asked, and what they answer is checked as any slot's is.
   */
  fillOwn(name: string, arg: unknown): (Html | "")[];
  /**
   * API 1.40 (#479): call this pack's `refresh` again in about `ms` (10 s when left out, 5 s at
   * least, 10 minutes at most), with `{ soon: true }`, in place of a timer of its own. One pending
   * at a time (the sooner ask stands), never beside a refresh still running, and it doesn't repeat:
   * ask again from `refresh` while there's something to follow. A pack that keeps asking for 30
   * minutes on end is cut off until a refresh of it doesn't ask. Hosted it's best effort: due at
   * the next request or cron, since nothing stays up to wake it.
   */
  soon(ms?: number): void;
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
  /** Where one of its `wasm` modules is served (a hashed path, cached for good), or undefined for a name it didn't ship. */
  wasm(name: string): string | undefined;
  /** Where one of its `files` is served (a hashed path, cached for good), or undefined for a name it didn't ship. */
  file(name: string): string | undefined;
  /**
   * API 2.1 (#304): one of its `server.calls`, run apart from the app (src/packs/server.ts):
   * locally in a thread of its own, hosted in a Worker of its own over the binding `SERVER_<ID>`.
   * Plain JSON in and out, 4 MB at most each way. Never throws: a call over its time, one its
   * script throws in, or a server that isn't there answers `{ ok: false, error }`.
   */
  call(fn: string, input: unknown): Promise<PackCalled>;
  /**
   * What a pack it requires shares (`shares`), by name (#326): undefined unless `id` is in its
   * manifest's `requires`, that pack is on and shown, and it shares one by that name now.
   */
  required<K extends keyof PackShares>(id: string, name: K): PackShares[K] | undefined;
  /** A share of that pack's own (API 1.38): core doesn't know its shape, so the reader narrows it. */
  required(id: string, name: string): unknown;
  /** Every shown pack's kinds of reference (`refs`, API 1.11), for linking what I write. */
  refs(): RefRule[];
  /**
   * Whether a page answers here (API 1.13): a core path, or one a shown pack holds. A link to another
   * pack's page (a tab beside its own) is left out when this says no.
   */
  pageOn(href: string): boolean;
  /** Every step of its setup (`manifest.onboard`) is done (API 1.16); true when it has none. */
  setupDone(): boolean;
  /** What it may ask the model now (API 1.22): `text` true once I've allowed it and a model is here; else why not. */
  ai(): PackAi;
  /**
   * Asks the model (API 1.22, #466): a prompt in, text out, through the route core picks. Throws
   * unless I allowed this pack (`ai().text`), when it asks for the large model and I allowed only the
   * small one, and once today's dollars are spent. Each call is logged by cost, never by content.
   */
  complete(p: PackCompleteAsk): Promise<{ text: string; cost: number }>;
  /** Its agent turns (API 1.23, #467): what it may start, starting one, how it went, and landing its commits. */
  agent: PackAgent;
  /**
   * Its MCP calls (API 1.34, #488): exact calls to the server its manifest names (`ai.mcp`), each
   * tool's own result handed back. Off until I allow it; local only; logged by cost, never by content.
   */
  mcp: PackMcp;
};

// ── What packs share with the packs that require them (#326) ──
// The shapes core reads itself are defined here. Any other share is its pack's own (#478): the
// pack that shares it ships the type and a reader that narrows, and core passes it along unread.

/** Where an item on My list stands. */
export type ListState = "doing" | "next" | "waiting" | "done";
/** An item on My list (#393). `parent`: the initiative it's a step of; `due`: YYYY-MM-DD. */
export type ListItem = { id: number; parent: number | null; title: string; notes: string; state: ListState; due: string | null; doneAt: number | null };
/** My list (the todo pack), as Bino, search and New work read and add to it (#393). */
export type ListShare = {
  /** Every item, in the list's order. */
  items(): Promise<ListItem[]>;
  get(id: number): Promise<ListItem | undefined>;
  /** Adds an item at the end (under `parent`'s initiative: one level); open pages show it. */
  add(t: { title: string; parent?: number | null; notes?: string; state?: ListState; due?: string | null }): Promise<ListItem | undefined>;
  /** Where an item is shown. */
  href(id: number): string;
};

/**
 * Where the agents pack's pages are (#394). Packs that link to them read this through
 * `ctx.required("agents", "agent")` and leave the link out while it's off; core reads it too.
 */
export type AgentShare = {
  /** The page that starts an agent, filled in with a prompt and where it runs (`repo`: a checkout's folder). Plain, it's where a start form posts. */
  start(o?: { prompt?: string; repo?: string }): string;
  /** A session's page. */
  session(sid: string): string;
  /** A run's page, while it has no session yet. */
  run(id: string): string;
};

/** The shares core reads itself, by name. A pack may share more under names of its own (`Pack.shares`). */
export type PackShares = {
  agent?: AgentShare;
  list?: ListShare;
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
  /**
   * Whether a repo (`owner/name`, or an owner alone) is one of the owners', any case: the
   * check before a pack reads or links something by a repo's name.
   */
  owns(repo: string): boolean;
  /** What I did since a day (YYYY-MM-DD). Absent: this forge doesn't say. */
  work?(since: string): Promise<ForgeWork>;
  /** How many of my PRs merged since a time (ISO). Absent: this forge doesn't say. */
  merged?(since: string): Promise<number>;
  /** The owners' repos that aren't archived (`owner/name`), kept a few minutes. Absent: this forge doesn't say. */
  repos?(): Promise<string[]>;
  /** Each of the owners' repos with open issues that have no assignee and no label, and how many (API 1.20, #447); repos with none are left out. Kept a few minutes. Absent: this forge doesn't say. */
  untriaged?(): Promise<Record<string, number>>;
  /**
   * One file's text on a repo's default branch (a peak.yaml, say), kept a few minutes; undefined
   * when there's none. With `at`, a full commit SHA (a PR's head), the file at that commit
   * instead. Only the owners' repos and plain relative paths: anything else throws.
   * Absent: this forge doesn't say.
   */
  file?(repo: string, path: string, at?: string): Promise<string | undefined>;
  /**
   * Every one of the owners' repos (not archived, 100 per owner) with its files at `paths` (1 to 6
   * plain relative paths) on the default branch, in one call per owner, where `file` is one per
   * repo and path (#294). Kept for every isolate up to `maxAgeMs` (default a few minutes, 24 h at
   * most; 0 reads it now). `at` says when it was read. Absent: this forge doesn't say.
   */
  everyRepo?(paths: string[], o?: { maxAgeMs?: number }): Promise<EveryRepo>;
  /**
   * One of the owners' PRs (API 1.21): its head and base (branch and full SHA) and the paths it
   * changes with their status (300 at most), kept a minute; undefined when it isn't one.
   * Absent: this forge doesn't say.
   */
  pr?(repo: string, n: number): Promise<ForgePr | undefined>;
  /** The files directly in a folder of one of the owners' repos at a full commit SHA (API 1.21; "" is the root), as repo paths. Absent: this forge doesn't say. */
  dir?(repo: string, path: string, at: string): Promise<string[]>;
  /**
   * Opens a PR changing one file in one of the owners' repos, or up to five in `files` (API 1.17):
   * a branch off the default branch, a commit per file, the PR (dovre#203). `kind` is one of the pack's `writes`, so it shows on Settings → Writes
   * and its page asks through a `Confirm` of kind `<id>.<kind>`. `expect` is the text the pack saw
   * (null: no file), per file: when one says something else now, nothing is written. Logged either way.
   * Absent: this forge doesn't say.
   */
  propose?(p: PackProposal): Promise<Proposed>;
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
 * Build one with `dovre/packs/acts.ts` (`writeAct`, or a tracker's comment, create, assign and
 * status shapes): it draws the inputs, re-checks, and logs every outcome.
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

/** One argument of a lookup: a line of text (an issue key, a search). */
export type LookupField = { name: string; about: string; required?: boolean; /** Longest it may be (default 200, 1000 at most). */ max?: number };

/**
 * Something Bino may read from this app when the user's question needs it ("what's ENG-12 about?"):
 * read-only, run as soon as Bino asks, no card. Bino writes a block of kind `<pack id>.<kind>`; the
 * core checks its fields as for an act, runs it (8 s at most), and hands Bino the text for that
 * conversation only: it's never stored with the conversation nor fed to Bino's memory, and the log
 * keeps the kind and the fields' names, never what came back. The user asked, so it may say more
 * than `bino` does (an issue's description), still through the pack's own filter: nothing that
 * isn't the user's to hand a model (a token, a customer's address). The same lookups are tools for
 * the agent turns Dovre starts (`<id>_<kind>` on /mcp, unless `tools` has that name).
 */
export type LookupKind = {
  /** A lowercase word. */
  kind: string;
  /** For Bino: what it finds and when to use it, a sentence or two. */
  when: string;
  /** Its arguments (none: it needs nothing, "my open issues"). */
  fields: LookupField[];
  /** What it found, as plain text for a model (4000 characters are kept), or a sentence saying why not. Its fields are the model's: treat them as hostile. */
  run(args: Record<string, string>, ctx: PackContext): Promise<string> | string;
};

/**
 * A pack's pulse, from memory: how many of its things work for me and wait on me, and what's
 * wrong, if anything (a storm, or a fire). `why` is a short line of counts ("2 red signals"),
 * never what a thing says; `href` one of its own pages. Core sums them (PackContext.pulse) for any
 * pack that shows how things are (a picture of me: busy while anything works, rain in a storm).
 */
export type PulseFeed = { working?: number; asking?: number; trouble?: { level: "storm" | "fire"; why: string; href?: string }; /** I'm on duty (an on-call rota). */ onDuty?: boolean };
/** The packs' pulses summed (PackContext.pulse): counts kept to 0–99, a line per trouble. */
export type Pulse = { working: number; asking: number; trouble: { level: "storm" | "fire"; why: string; href?: string }[]; /** A pack says I'm on duty. */ onDuty?: boolean; /** Something has me at work: a pack's thing working, or Bino answering. */ busy: boolean };

export type ScheduledEvent = { cron: string; scheduledTime: number };
/** A Worker's waitUntil, for work that finishes after the handler returns. */
export type Defer = (p: Promise<unknown>) => void;

/** What a pack keeps for itself (`ctx.store`). */
export type PackStore = { kv: PackKv };
/**
 * A pack's values by key (`ctx.store.kv`): JSON, 256 000 characters a value, 1000 keys and
 * 4 000 000 characters a pack. A key is letters, digits and `_ . : / -`, 200 at most. A bad key, a
 * value that isn't JSON, and one over a cap throw: nothing is cut to fit.
 */
export type PackKv = {
  /** What's kept under the key; undefined when nothing is, or its time ran out. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Keeps a value, in place of the last; with `ttlMs`, only that long. */
  set(key: string, value: unknown, o?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Its keys that start with `prefix` (all of them without one), in order. */
  list(prefix?: string): Promise<string[]>;
};

/** What `ctx.logged` takes: the write's `kind` (one word), what it was done to (300 characters kept), and a line about it (200). */
export type PackLogged = { kind: string; target: string; detail?: string; ok: boolean; error?: string };

/**
 * What `ctx.run` takes besides the program and its arguments. `env`: changes to Dovre's own
 * environment for the program (null removes a variable). `input`: its stdin. `onStdout`: what it
 * writes, as it writes it (the whole still comes back in `stdout`).
 */
export type PackRunOpts = { cwd?: string; timeoutMs?: number; input?: string; maxBuffer?: number; env?: Record<string, string | null>; signal?: AbortSignal; onStdout?: (chunk: string) => void };
/** How a program `ctx.run` started ended. */
export type PackRan = { code: number | null; stdout: string; stderr: string };

/** A kind of write a pack makes: a lowercase word (dashes allowed), and what Settings calls it. */
export type PackWrite = {
  kind: string;
  label: string;
};

/**
 * A pack's WebAssembly kept out of the Worker bundle (Pack.wasm), for large modules (128 MB at most).
 * Locally, core calls `load` on the first request and serves the bytes if their SHA-256 starts with
 * `sha256`. Hosted, `node ../dovre/src/packs/assets.ts` (the wrangler `build` step) calls it under
 * Node, checks it the same way, and writes the module into the Worker's static assets; the Worker
 * never calls it. One over 25 MB goes to R2 instead (`assets.ts --r2 <bucket>`, read from
 * `PACK_FILES`). A pack's build script writes `sha256` beside the file; `load` may fetch a pinned
 * release, since the hash is checked.
 */
export type WasmFile = {
  /** The first 16 hex digits of the module's SHA-256. */
  sha256: string;
  /** The module's bytes, under Node only: e.g. `readFileSync(new URL("./x.wasm", import.meta.url))`. */
  load(): Uint8Array | Promise<Uint8Array>;
};

/**
 * A script or stylesheet kept out of the Worker bundle (Pack.files): checked and served like a
 * WasmFile. `wasm`: a script that compiles WebAssembly it carries inside (Graphviz's build has no
 * separate .wasm), so pages' CSP adds `'wasm-unsafe-eval'` as for Pack.wasm.
 */
export type PackFile = WasmFile & { wasm?: boolean };

/** What `ctx.call` answers. */
export type PackCalled = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Code a pack runs on the server, apart from the app (API 2.1, #304): for WebAssembly a Worker
 * can't compile at run time (formatters, parsers, Rust), and for work long enough to stall pages.
 * Called through `ctx.call(fn, input)`. Locally a worker thread with no environment runs it;
 * hosted, a Worker of its own that `node ../dovre/src/packs/servers.ts` writes and deploys, with
 * no bindings. Either way it reaches nothing of Dovre's: what it needs comes in the input.
 */
export type PackServer = {
  /**
   * One ES module with no imports (bundle it), as a file like a WasmFile: it exports
   * `call(fn, input, wasm)`, where `wasm` holds the modules below compiled
   * (`WebAssembly.Module`, for wasm-bindgen's `initSync({ module })` or `new WebAssembly.Instance`).
   * What it returns goes back as JSON; what it throws, as the error.
   */
  script: WasmFile;
  /** Names from its `wasm` that the script gets. */
  wasm?: string[];
  /** The functions `ctx.call` may name: camelCase. */
  calls: string[];
  /** How long one call may take, in ms: 10 s by default, 30 s at most. Hosted it's also the Worker's CPU limit. */
  ms?: number;
};

export type Pack = {
  manifest: PackManifest;
  /**
   * A forge it brings (GitLab): used for PRs, notifications, movement and deploys instead of GitHub
   * when FORGE is its id. Picked at start, before the pack's own checks or init (src/forge/pick.ts).
   */
  forge?: ForgeDecl;
  /** Runs here? Called after the manifest's checks (bindings, binaries); default yes. */
  available?(ctx: PackContext): boolean;
  /**
   * API 1.35: its own tables, as SQL core runs (#476). Append-only, one statement each: every entry
   * runs once, in order, before `init`, and is remembered (`_migrations`, as `pack:<id>:<n>`). Never
   * edit or reorder one that has shipped: add another. One that fails keeps the pack off, saying
   * why. Name each table after the pack (`<id>` with dashes as underscores, then `_…`):
   * `assertTables` in the pack's tests fails on one that isn't.
   */
  migrations?: string[];
  init?(ctx: PackContext): Promise<void> | void;
  /**
   * Re-reads what its pages show, into memory (or its own storage), then publishes what changed.
   * The core calls it on its schedule; pages and cards never wait for it. `asked` (API 1.8): I
   * pressed a refresh button (Stats' Gather again), so read again even if it isn't due. API 1.40
   * (#479): `soon`, the pack asked for this one (`ctx.soon`), so it can do only the cheap part;
   * `agent`, one of its agent turns (`ctx.agent.start`) ended, as `ctx.agent.result` gives it:
   * told once, when it ends while Dovre is running (a sandbox run's once its commits are home).
   * A turn that ended while Dovre was down isn't told, so look at open turns in a plain refresh too.
   */
  refresh?(ctx: PackContext, o?: { asked?: boolean; soon?: boolean; agent?: PackAgentRun }): Promise<void>;
  dispose?(): Promise<void> | void;
  /**
   * Its kinds of write to its own app (dovre#104), listed on Settings → Writes under its name. Its
   * Confirms pass `kind: "<pack id>.<kind>"`: those take one click unless I set that kind to ask twice.
   */
  writes?: PackWrite[];
  /**
   * What it shares with the packs that require it (#326): read through their `ctx.required`.
   * Beside core's names (`PackShares`) it may share under names of its own (API 1.38).
   */
  shares?(ctx: PackContext): PackShares & { [name: string]: unknown };
  /**
   * CSS for its own classes, served beside the core's and linked from every page. A selector is
   * kept only when the element it styles, or an ancestor, has a class of the pack's own: one that
   * restyles core (`body`, `:root`, `.panel`) is left out and logged (src/packs/guard.ts).
   */
  styles?: string;
  /**
   * Plain JS for its own pages and slots, served as a file of its own (in a try, so a throw stops only it) beside the core's script (CSP `script-src 'self'`)
   * and run on every page while the pack is on, in a block of its own. Like the core's, it's an
   * enhancement: what it adds works without it. It hears what the hub said changed through
   * `dovreOn(topics, fn, { notes })` (src/ui/on.js.ts: only those topics, merged while a call is out
   * or the tab is hidden), never by listening to `dovre:change` itself: every open tab hears every
   * change, and a script that does isn't served. On `document` it may hear `dovre:swap` (detail:
   * { from, to }, a live region about to be swapped for a fresh one, so it can carry over what it shows).
   * `dovreFiles` holds its `files`' paths (name → path, as `ctx.file` gives) on every page. It may
   * draw core's Markdown fences and math in place (`pre.code[data-lang]`, `code[data-tex]`, src/ui/markdown.ts: Bino's answers,
   * PR and issue bodies), the source staying as it is where it doesn't.
   */
  script?: string;
  /**
   * WebAssembly for its script to run in the browser, each served at a hashed path that
   * `ctx.wasm(name)` gives. Name → either the module's bytes (`\0asm…`, 8 MB at most; they go in
   * the Worker bundle, so keep these small) or a `WasmFile`: a `.wasm` file beside the pack, kept
   * out of the bundle. Names are lowercase, 32 characters at most. One that breaks a rule isn't
   * served (logged). While a pack with any is on, pages' CSP adds `'wasm-unsafe-eval'` to
   * `script-src`: compiling WebAssembly, still only from scripts this app serves.
   */
  wasm?: Record<string, Uint8Array | WasmFile>;
  /**
   * A browser library too big for the bundle (mermaid): scripts and stylesheets kept out of the
   * Worker bundle like a `WasmFile`, each served at a hashed path that `ctx.file(name)` gives. The
   * name says its kind: lowercase, 32 characters at most before `.js` or `.css` (`mermaid.js`).
   * 25 MB at most; locally `load` is called on the first request and the bytes are served only if
   * their SHA-256 matches; hosted, the wrangler `build` step writes them into the static assets.
   * Only the pack's own script loads them (`import()` or a `<script src>`): CSP stays `'self'`
   * (plus `'wasm-unsafe-eval'` for a file marked `wasm`).
   */
  files?: Record<string, PackFile>;
  /** API 2.1: code it runs on the server, apart from the app, through `ctx.call` (#304). */
  server?: PackServer;
  nav?(ctx: PackContext): NavItem[];
  /** Its setup page's steps (API 1.16), for the ids `manifest.onboard` declares: without this, it has no setup page. */
  setup?: PackSetup;
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
   * awaited. Without it, Bino hears what the pack shows on Today (glance, needs, pulse, the last day's
   * feed), unless the pack is `private`. States and counts ("3 open signals: …", "12 trials, 2 end this week"); never a
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
   * (a session's title and status, never what was said). It may read its app first (what the page
   * would show): Bino waits 2 s at most. Undefined: "a page of <pack name>", with its needs that
   * point at that page.
   */
  about?(ctx: PackContext, path: string): string | undefined | Promise<string | undefined>;
  /** What Bino may propose that this pack carries out (see ActKind); local only. */
  acts?(ctx: PackContext): ActKind[];
  /** What Bino may look up in this app when a question needs it (see LookupKind); local and hosted, and agent turns' tools. */
  lookups?(ctx: PackContext): LookupKind[];
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
